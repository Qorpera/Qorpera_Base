#!/usr/bin/python3
# Migration helpers for moving a node role from its versioned launcher and stacked drop-ins onto the node agent's
# fixed launcher and a new clean unit (phase B.1/B.6 of the node auto-update plan). Run as root on the node. Nothing
# here starts, stops or enables a unit; the agent's `switch` command does that.
#   unit --old <unit> --new <unit> --exec <python launcher path> --role <role>
#       prints the new unit: the old unit's effective settings (fragment + drop-ins with systemd's reset rules),
#       ExecStart replaced by the fixed launcher, Conflicts=<old unit> added
#   show-diff --old <unit> --new <unit>
#       compares `systemctl show --all` of both; prints the keys that differ outside the expected set, no values
#   role --launcher <old launcher> --release-keys K,K,... --unit <new unit> [--env-file <path>]
#       prints the node.json role entry derived from the old launcher's pinned values (no secrets)
#   split-env --source <env json> --dest <path> --release-keys K,K,...
#       writes the env file without the per-release keys, same owner, group and mode; values are never printed
#   compare --old-launcher <path> --role <role> --unit <old unit> [--release-keys K,...]
#       runs the old and the new launcher as the unit's user with no capabilities and NoNewPrivs, with execve
#       captured instead of executed, and prints per key whether argv and env agree (never the values)
import ast
import json
import os
import re
import subprocess
import sys

LIST_KEYS = {
    'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload', 'ExecCondition',
    'Environment', 'EnvironmentFile', 'UnsetEnvironment', 'PassEnvironment', 'After', 'Before', 'Wants', 'Requires',
    'Requisite', 'BindsTo', 'PartOf', 'Conflicts', 'WantedBy', 'RequiredBy', 'Also', 'SupplementaryGroups',
    'ReadWritePaths', 'ReadOnlyPaths', 'InaccessiblePaths', 'ExecPaths', 'NoExecPaths', 'BindPaths',
    'BindReadOnlyPaths', 'LoadCredential', 'LoadCredentialEncrypted', 'SetCredential', 'SetCredentialEncrypted',
    'TemporaryFileSystem', 'SystemCallFilter', 'RestrictAddressFamilies', 'CapabilityBoundingSet',
    'AmbientCapabilities', 'DeviceAllow', 'IPAddressAllow', 'IPAddressDeny',
}
# `systemctl show` keys that legitimately differ between the old unit and its replacement.
EXPECTED_DIFFERENT = {
    'Id', 'Names', 'FragmentPath', 'DropInPaths', 'SourcePath', 'Description', 'Conflicts', 'ConflictedBy',
    'UnitFileState', 'UnitFilePreset', 'LoadState', 'ActiveState', 'SubState', 'FreezerState', 'Result',
    'MainPID', 'ExecMainPID', 'ExecMainStatus', 'ExecMainCode', 'ControlPID', 'InvocationID', 'NRestarts',
    'StatusText', 'StatusErrno', 'NeedDaemonReload', 'ControlGroup', 'ControlGroupId', 'Triggers', 'TriggeredBy',
    'CanStart', 'CanStop', 'CanReload', 'CanIsolate', 'CanFreeze', 'CanClean', 'Job', 'Following',
}
EXPECTED_PATTERNS = [
    re.compile(r'.*Timestamp(Monotonic)?$'), re.compile(r'^ExecStart(Ex)?$'), re.compile(r'^ExecMain.*'),
    re.compile(r'^(CPU|Memory|IO|IP|Tasks|Effective)[A-Za-z]*(Current|Bytes|Packets|NSec|Peak|Available|Operations|CPUs|MemoryNodes)$'),
    re.compile(r'^(Memory|Tasks|CPU)(Current|Peak|Available|SwapCurrent|SwapPeak|ZSwapCurrent)$'),
]


def need(ok, message):
    if not ok:
        raise SystemExit(message)


def parse_cat(text):
    """Splits `systemctl cat` output into (path, [(section, key, value)]) blocks in load order."""
    blocks, path, section = [], None, None
    for line in text.splitlines():
        if line.startswith('# /'):
            path = line[2:]
            blocks.append((path, []))
            section = None
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith(('#', ';')):
            continue
        header = re.fullmatch(r'\[([A-Za-z]+)\]', stripped)
        if header:
            section = header.group(1)
            continue
        match = re.fullmatch(r'([A-Za-z][A-Za-z0-9]*)=(.*)', stripped)
        need(match is not None and section is not None and blocks, f'unparsed unit line: {stripped[:40]}')
        blocks[-1][1].append((section, match.group(1), match.group(2)))
    return blocks


def effective_settings(blocks):
    """Applies fragment and drop-ins in order. A list key appends, and an empty assignment resets it; the reset is
    kept (written back as `Key=`) because an explicitly empty list is not the default: `CapabilityBoundingSet=`
    means no capabilities, leaving it out means all. Other keys override, and an empty assignment restores the
    default."""
    settings = {}
    for _, entries in blocks:
        for section, key, value in entries:
            current = settings.setdefault(section, {})
            if key in LIST_KEYS:
                if value == '':
                    current[key] = ['']
                elif current.get(key) == ['']:
                    current[key] = [value]
                else:
                    current.setdefault(key, []).append(value)
            elif value == '':
                current.pop(key, None)
            else:
                current[key] = [value]
    return settings


def unit_text(settings, old_unit, launcher, role):
    settings = {section: dict(values) for section, values in settings.items()}
    old_start = [command for command in settings['Service'].get('ExecStart', []) if command]
    need(len(old_start) == 1, 'the old unit has not exactly one effective ExecStart')
    # Keep the clean-environment prefix of today's ExecStart; replace only the launcher it runs.
    prefix = re.fullmatch(r'(.*?/usr/bin/python3 -I )\S+\.py', old_start[0])
    need(prefix is not None, 'the old ExecStart does not end in a python launcher')
    settings['Service']['ExecStart'] = [f'{prefix.group(1)}{launcher} {role}']
    # A hard dependency on another node role would restart this role with it, for example the orchestrator with the
    # provider in the middle of a pause.
    for key in ['Requires', 'Requisite', 'BindsTo', 'PartOf']:
        tied = [unit for value in settings.get('Unit', {}).get(key, []) for unit in value.split() if 'qorpera-' in unit]
        need(not tied, f'the old unit has {key}= on {", ".join(tied)}; remove it before migrating')
    settings.setdefault('Unit', {})['Conflicts'] = [old_unit]
    lines = [f'# Generated by qorpera-node-migrate from {old_unit}; ExecStart runs the fixed node launcher.']
    for section in ['Unit', 'Service', 'Install']:
        if section not in settings:
            continue
        lines.append(f'\n[{section}]')
        for key, values in settings[section].items():
            lines.extend(f'{key}={value}' for value in values)
    return '\n'.join(lines) + '\n'


def show(unit):
    output = subprocess.run(['/usr/bin/systemctl', 'show', '--all', unit], check=True, capture_output=True,
                            text=True).stdout
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def show_diff(old, new):
    differing = []
    for key in sorted(set(old) | set(new)):
        if key in EXPECTED_DIFFERENT or any(pattern.fullmatch(key) for pattern in EXPECTED_PATTERNS):
            continue
        if old.get(key) != new.get(key):
            differing.append(key)
    return differing


def literal(source, name):
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    return None


def role_entry(source, release_keys, unit, env_file):
    """The node.json role entry for a versioned launcher: its pinned values minus the per-release ones."""
    fixed = literal(source, 'FIXED')
    need(isinstance(fixed, dict), 'the launcher pins no FIXED values')
    secrets = sorted(set(literal(source, 'MISSING') or literal(source, 'VARIABLE') or []))
    need(secrets, 'the launcher names no secret keys')
    base = re.search(r"BASE=Path\('([^']+)'\)", source)
    env_name = re.search(r"read\(BASE/'([^']+\.json)',0o440", source)
    need(base is not None and env_name is not None, 'the launcher names no env file')
    project = re.search(r"\['projectRef'\]=='([a-z0-9]+)'", source)
    schema = re.search(r"\['schema'\]=='([^']+)'", source)

    def names(pattern):
        found = set()
        for group in re.findall(r"for k in \[([^\]]+)\]:need\(re\.fullmatch\('" + pattern + r"',env\[k\]\)\)", source):
            found.update(re.findall(r"'(QORPERA_[A-Z0-9_]+)'", group))
        found.update(re.findall(r"need\(re\.fullmatch\('" + pattern + r"',env\['(QORPERA_[A-Z0-9_]+)'\]\)\)", source))
        return sorted(found)

    jwt = dict(re.findall(r"\('(QORPERA_[A-Z0-9_]+)','(service_role|anon)'\)", source))
    for key in re.findall(r"env\['(QORPERA_[A-Z0-9_]+)'\]\.split\('\.'\)", source):
        role = re.search(r"claims\.get\('role'\)=='(service_role|anon)'", source)
        jwt.setdefault(key, role.group(1) if role else 'anon')
    denied = {}
    for key, value in re.findall(r"need\(env\['(QORPERA_[A-Z0-9_]+)'\]!='([0-9a-f]{64})'\)", source):
        denied.setdefault(key, []).append(value)
    execve = re.search(r"os\.execve\('([^']+)',\[([^\]]+)\]", source)
    need(execve is not None, 'the launcher execs nothing')
    argv = [part.strip().strip("'") for part in execve.group(2).split(',')]
    need(argv[-1] == 'str(BUNDLE)' and argv[0] == execve.group(1), 'the launcher does not exec its bundle last')
    state_dirs = []
    loop = re.search(r"for n in \[([^\]]+)\]:\s*path=Path\('([^']+)'\)/n", source)
    if loop:
        state_dirs += [f"{loop.group(2)}/{name.strip().strip(chr(39))}" for name in loop.group(1).split(',')]
    state_dirs += re.findall(r"p=Path\('([^']+)'\);s=p\.lstat\(\)", source)
    home = re.search(r"'HOME':'([^']+)'", source)
    home_value = home.group(1) if home else (state_dirs[0] if "'HOME':str(p)" in source and state_dirs else None)
    need(home_value is not None and state_dirs, 'the launcher names no home or state folder')
    release = set(release_keys)
    health = [f"http://127.0.0.1:{fixed[key]}/healthz" for key in
              ['QORPERA_LXD_LOGIN_GATEWAY_PORT', 'QORPERA_RUNNER_PROVIDER_PORT'] if key in fixed]
    return {
        'unit': unit,
        'envFile': env_file or f"{base.group(1)}/{env_name.group(1)}",
        'envSchema': schema.group(1) if schema else None,
        'projectRef': project.group(1) if project else None,
        'fixed': {key: value for key, value in fixed.items() if key not in release},
        'secretKeys': [key for key in secrets if key not in release],
        'releaseKeys': sorted(release),
        'tokenKeys': names(r'\[A-Za-z0-9_-\]\{43\}'),
        'sha256Keys': names(r'\[0-9a-f\]\{64\}'),
        'jwtKeys': jwt,
        'deniedValues': denied,
        'maxProgramBytes': 1048576,
        'stateDirs': state_dirs,
        'home': home_value,
        'exec': argv[:-1],
        'noSupplementaryGroups': 'os.getgroups()' in source,
        'health': health,
    }


def split_env(source, dest, release_keys):
    info = os.stat(source)
    with open(source, 'rb') as handle:
        document = json.load(handle)
    missing = [key for key in release_keys if key not in document['env']]
    need(not missing, f'the env file lacks release keys: {missing}')
    document['env'] = {key: value for key, value in document['env'].items() if key not in set(release_keys)}
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(document, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.chown(dest, info.st_uid, info.st_gid)
    os.chmod(dest, info.st_mode & 0o7777)
    return {'written': dest, 'keys': len(document['env']), 'mode': oct(info.st_mode & 0o7777)}


CAPTURE = r'''
import hashlib, json, os, runpy, sys
def capture(path, argv, env):
    sys.stdout.write(json.dumps({"argv": argv, "env": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in env.items()}}))
    sys.stdout.flush()
    os._exit(0)
os.execve = capture
sys.argv = json.loads(os.environ.pop("QORPERA_CAPTURE_ARGV"))
runpy.run_path(sys.argv[0], run_name="__main__")
'''


def capture(unit, argv):
    props = show(unit)
    groups = props.get('SupplementaryGroups', '').split()
    command = ['/usr/bin/setpriv', f"--reuid={props['User']}", f"--regid={props['Group']}",
               f"--groups={','.join(groups)}" if groups else '--clear-groups', '--bounding-set=-all',
               '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
               'LANG=C', 'LC_ALL=C', f'QORPERA_CAPTURE_ARGV={json.dumps(argv)}', '/usr/bin/python3', '-I', '-c', CAPTURE]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    need(result.returncode == 0 and result.stdout, f'launcher refused: {result.stderr.strip()[:200]}')
    return json.loads(result.stdout)


def compare(old, new, release_keys):
    """Compares two captured launches. The program path and per-release path values may differ; nothing else."""
    report = {'argvPrefixEqual': old['argv'][:-1] == new['argv'][:-1], 'programs': [old['argv'][-1], new['argv'][-1]],
              'keysOnlyOld': sorted(set(old['env']) - set(new['env'])),
              'keysOnlyNew': sorted(set(new['env']) - set(old['env'])), 'differing': []}
    for key in sorted(set(old['env']) & set(new['env'])):
        if old['env'][key] != new['env'][key]:
            report['differing'].append(key)
    report['unexpected'] = [key for key in report['differing'] if key not in set(release_keys)]
    report['equivalent'] = (report['argvPrefixEqual'] and not report['keysOnlyOld'] and not report['keysOnlyNew']
                            and not report['unexpected'])
    return report


def main(argv):
    command, options = argv[1], dict(zip(argv[2::2], argv[3::2]))
    keys = [key for key in options.get('--release-keys', '').split(',') if key]
    if command == 'unit':
        cat = subprocess.run(['/usr/bin/systemctl', 'cat', options['--old']], check=True, capture_output=True,
                             text=True).stdout
        sys.stdout.write(unit_text(effective_settings(parse_cat(cat)), options['--old'], options['--exec'],
                                   options['--role']))
    elif command == 'show-diff':
        differing = show_diff(show(options['--old']), show(options['--new']))
        print(json.dumps({'unexpectedDifferences': differing, 'equivalent': not differing}))
    elif command == 'role':
        with open(options['--launcher']) as handle:
            print(json.dumps(role_entry(handle.read(), keys, options['--unit'], options.get('--env-file')), indent=2))
    elif command == 'split-env':
        print(json.dumps(split_env(options['--source'], options['--dest'], keys)))
    elif command == 'compare':
        old = capture(options['--unit'], [options['--old-launcher']])
        new = capture(options['--unit'], ['/usr/local/libexec/qorpera-node/qorpera-node-launch.py', options['--role']])
        print(json.dumps(compare(old, new, keys)))
    else:
        raise SystemExit('usage: qorpera-node-migrate unit|show-diff|role|split-env|compare ...')


if __name__ == '__main__':
    main(sys.argv)
