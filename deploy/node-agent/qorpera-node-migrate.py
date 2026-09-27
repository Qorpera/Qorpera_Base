#!/usr/bin/python3
# Migration helpers for moving a node role from its versioned launcher and stacked drop-ins onto the node agent's
# fixed launcher and a new clean unit (phase B.1/B.6 of the node auto-update plan). Run as root on the node. Nothing
# here starts, stops or enables a unit; the agent's `switch` command does that.
#   unit --old <unit> --new <unit> --exec <python launcher path> --role <role>
#       prints the new unit: the old unit's effective settings (fragment + drop-ins with systemd's reset rules),
#       ExecStart replaced by the fixed launcher, the old unit added to Conflicts=. Holds the node update lock while
#       it reads, and refuses while a cut lane holds it or has staged (.prepared) or parked (.disabled) drop-ins
#   show-diff --old <unit> --new <unit>
#       compares `systemctl show --all` of both; prints the keys that differ outside the expected set, no values
#   role --launcher <old launcher> --release-keys K,K,... --unit <new unit> [--env-file <path>]
#       prints the node.json role entry derived from the old launcher's pinned values (no secrets)
#   split-env --source <env json> --dest <path> --release-keys K,K,...
#       writes the env file without the per-release keys, same owner, group and mode; values are never printed
#   compare --old-launcher <path> --role <role> --unit <old unit>
#       runs the old and the new launcher as the unit's user with no capabilities and NoNewPrivs, with execve
#       captured instead of executed, and prints per key whether argv and env agree (never the values). Only the
#       program path and the release's ${release} path values may differ, and the files they name must be the same
#       bytes. It runs outside the unit's sandbox: a launcher that refuses here stops the migration (fail safe), and
#       one that passes here but refuses under the sandbox is caught by the agent's switch, which switches back.
import ast
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

NODE_LOCK = '/run/lock/qorpera-node-update.lock'
UNIT_DIRS = ['/etc/systemd/system', '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']
# Runtime unit folders: anything there for the old unit is a temporary override the new unit would make permanent.
RUNTIME_DIRS = ['/run/systemd/system', '/run/systemd/system.control', '/run/systemd/transient', '/run/systemd/generator',
                '/run/systemd/generator.early', '/run/systemd/generator.late']
# [Unit]/[Install] keys that may name another qorpera unit. Anything else that names one (Wants=, Requires=, BindsTo=,
# PartOf=, Upholds=, OnFailure=, Alias=, Also=, …) would start, stop or restart the other node role with this one,
# for example the orchestrator with the provider in the middle of a pause, or start an old unit that conflicts with
# its replacement.
UNIT_REFERENCE_OK = {'After', 'Before', 'Conflicts'}
QORPERA_UNIT = re.compile(r'qorpera-[A-Za-z0-9@_.-]*\.(service|socket|timer|path|target|mount|slice|scope)')
# `systemctl show` keys that legitimately differ between the old unit and its replacement.
# Identity and runtime state, by exact name. User=, Group= and DynamicUser= are not here: they must be equal.
EXPECTED_DIFFERENT = {
    'Id', 'Names', 'FragmentPath', 'DropInPaths', 'SourcePath', 'Description', 'UnitFileState', 'UnitFilePreset',
    'ActiveState', 'SubState', 'FreezerState', 'Result', 'MainPID', 'ExecMainPID', 'ExecMainStatus', 'ExecMainCode',
    'ControlPID', 'InvocationID', 'NRestarts', 'StatusText', 'StatusErrno', 'ControlGroup', 'ControlGroupId',
    'CanStart', 'CanStop', 'CanReload', 'CanIsolate', 'CanFreeze', 'CanClean', 'Job', 'Following',
    'ConditionResult', 'AssertResult', 'UID', 'GID', 'OOMKills', 'ManagedOOMKills',
}
# Lists of units, compared as sets (systemd's order is not stable). Every other key is compared as an ordered value.
DEPENDENCY_KEYS = {
    'After', 'Before', 'Requires', 'Wants', 'Requisite', 'BindsTo', 'PartOf', 'Upholds', 'Conflicts', 'ConflictedBy',
    'WantedBy', 'RequiredBy', 'Triggers', 'TriggeredBy', 'OnFailure',
}
# Keys whose values show_diff may print when they differ: unit names and states, never settings that could hold secrets.
PRINTABLE = DEPENDENCY_KEYS | {'WatchdogUSec', 'LoadState', 'NeedDaemonReload', 'UnitFileState'}
# Their own rules in show_diff.
RULED = {'Conflicts', 'ConflictedBy', 'WantedBy', 'Before', 'ExecStart', 'ExecStartEx', 'LoadState', 'NeedDaemonReload',
         'WatchdogUSec'}
EXPECTED_PATTERNS = [
    re.compile(r'.*Timestamp(Monotonic)?$'), re.compile(r'^ExecMain.*'),
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
    """Replays fragment and drop-ins in order, for every key: the new unit then reads exactly as systemd read the old
    one, with no list of which keys accumulate (StateDirectory=, Condition*=, SuccessExitStatus=, …) to get wrong.
    An empty assignment drops what came before it and is kept (written back as `Key=`): for a list key that is
    systemd's reset, and an explicitly empty list is not the default (`CapabilityBoundingSet=` means no
    capabilities, leaving it out means all); for a single-value key the later assignment wins anyway."""
    settings = {}
    for _, entries in blocks:
        for section, key, value in entries:
            # Not a reset there: systemd ignores an empty After=/Wants=, and an empty Condition*=/Assert*= drops every
            # condition, which `systemctl show` may not list.
            need(value != '' or section not in ('Unit', 'Install'),
                 f'the old unit has an empty {key}= in [{section}]; remove it before migrating')
            current = settings.setdefault(section, {})
            if value == '' or current.get(key) == ['']:
                current[key] = [value]
            else:
                current.setdefault(key, []).append(value)
    return settings


def check_sources(blocks, old_unit, unit_dirs=UNIT_DIRS, runtime_dirs=RUNTIME_DIRS):
    """The old unit is its fragment plus its own .conf drop-ins, and no lane has files staged or parked beside them.
    A drop-in shared by prefix or type (qorpera-.service.d, service.d) would apply to the new unit a second time, and a
    runtime file under /run would turn a temporary override into a permanent one."""
    need(blocks and blocks[0][0].endswith(f'/{old_unit}'), 'the old unit has no fragment of its own')
    for path, _ in blocks:
        need(not path.startswith('/run/'), f'the old unit loads a runtime file: {path}')
    for path, _ in blocks[1:]:
        need(f'/{old_unit}.d/' in path and path.endswith('.conf'), f'the old unit loads a shared drop-in: {path}')
    for folder in runtime_dirs:
        for name in [old_unit, f'{old_unit}.d']:
            need(not os.path.lexists(f'{folder}/{name}'), f'a runtime override exists: {folder}/{name}')
    for folder in unit_dirs:
        try:
            names = os.listdir(f'{folder}/{old_unit}.d')
        except FileNotFoundError:
            continue
        stray = sorted(name for name in names if not name.endswith('.conf'))
        need(not stray, f'a lane has drop-ins staged or parked for {old_unit}: {", ".join(stray)}')


def node_lock(path=NODE_LOCK, owner=0):
    """Takes the node update lock (the agent's and the cut lanes') without waiting; the descriptor holds it."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    ok = stat.S_ISREG(info.st_mode) and info.st_uid == owner and not info.st_mode & 0o022 and info.st_nlink == 1
    if not ok:
        os.close(fd)
        raise SystemExit('NODE_LOCK_UNSAFE')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise SystemExit('NODE_LOCK_HELD: a cut lane or the agent holds the node; migrate outside its window')
    return fd


def unit_text(settings, old_unit, launcher, role):
    settings = {section: dict(values) for section, values in settings.items()}
    old_start = [command for command in settings['Service'].get('ExecStart', []) if command]
    need(len(old_start) == 1, 'the old unit has not exactly one effective ExecStart')
    # Keep the clean-environment prefix of today's ExecStart; replace only the launcher it runs.
    prefix = re.fullmatch(r'(.*?/usr/bin/python3 -I )\S+\.py', old_start[0])
    need(prefix is not None, 'the old ExecStart does not end in a python launcher')
    settings['Service']['ExecStart'] = [f'{prefix.group(1)}{launcher} {role}']
    for section in ['Unit', 'Install']:
        for key, values in settings.get(section, {}).items():
            tied = sorted({match.group(0) for value in values for match in QORPERA_UNIT.finditer(value)})
            need(key in UNIT_REFERENCE_OK or not tied,
                 f'the old unit has {key}= on {", ".join(tied)}; remove it before migrating')
    conflicts = settings.setdefault('Unit', {}).setdefault('Conflicts', [])
    if conflicts == ['']:
        conflicts.clear()
    conflicts.append(old_unit)
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


def exec_argv(value):
    commands = re.findall(r'argv\[\]=(.*?) ;', value or '')
    return commands[0].split() if len(commands) == 1 else None


def words(props, key):
    return set(props.get(key, '').split())


def show_diff(old, new, old_unit, new_unit, watchdog_set=False):
    """`systemctl show` of the old unit and its replacement, before or after the switch. Beyond identity and runtime
    state, only these may differ:
    - Conflicts= gains the old unit, and the old unit may list the new one in ConflictedBy=;
    - the ExecStart argv keeps its prefix and runs the fixed launcher with the role the new unit is named after;
    - the targets that want only the enabled one of the two (WantedBy=, and the Before= they imply);
    - WatchdogUSec 0 against infinity, when the unit reading infinity has not started since systemd loaded it and
      neither unit sets WatchdogSec=. systemd reports infinity until a service starts, and it unloads a stopped,
      disabled unit: before the switch that is the new unit, after it the old one."""
    unexpected = []
    for unit, props in [(old_unit, old), (new_unit, new)]:
        if props.get('LoadState') != 'loaded' or props.get('NeedDaemonReload') != 'no':
            unexpected.append(f'{unit}:LoadState/NeedDaemonReload')
    for key in sorted(set(old) | set(new)):
        if key in EXPECTED_DIFFERENT or key in RULED or any(pattern.fullmatch(key) for pattern in EXPECTED_PATTERNS):
            continue
        same = words(old, key) == words(new, key) if key in DEPENDENCY_KEYS else old.get(key) == new.get(key)
        if not same:
            unexpected.append(key)
    if words(new, 'Conflicts') != words(old, 'Conflicts') | {old_unit}:
        unexpected.append('Conflicts')
    if words(old, 'ConflictedBy') - {new_unit} != words(new, 'ConflictedBy'):
        unexpected.append('ConflictedBy')
    role = re.fullmatch(r'qorpera-node-([a-z0-9-]+)\.service', new_unit)
    old_argv, new_argv = exec_argv(old.get('ExecStart')), exec_argv(new.get('ExecStart'))
    if (not role or not old_argv or not new_argv or new_argv[:-2] != old_argv[:-1]
            or not new_argv[-2].endswith('/qorpera-node-launch.py') or new_argv[-1] != role.group(1)):
        unexpected.append('ExecStart')
    enabled = [name for name, props in [('old', old), ('new', new)] if props.get('UnitFileState') == 'enabled']
    wanting, other = (old, new) if enabled == ['old'] else (new, old) if enabled == ['new'] else (old, new)
    moved = words(wanting, 'WantedBy') - words(other, 'WantedBy') if len(enabled) == 1 else set()
    if (words(other, 'WantedBy') | moved != words(wanting, 'WantedBy')
            or not all(unit.endswith('.target') for unit in moved)):
        unexpected.append('WantedBy')
    if words(other, 'Before') != words(wanting, 'Before') - moved:
        unexpected.append('Before')
    if old.get('WatchdogUSec') != new.get('WatchdogUSec'):
        unset = [props for props in (old, new) if props.get('WatchdogUSec') == 'infinity']
        other = [props for props in (old, new) if props.get('WatchdogUSec') == '0']
        fresh = len(unset) == 1 and len(other) == 1 and (
            unset[0].get('ActiveEnterTimestampMonotonic') == '0' or not unset[0].get('InvocationID'))
        if not fresh or watchdog_set:
            unexpected.append('WatchdogUSec')
    values = {key: [old.get(key), new.get(key)] for key in unexpected if key in PRINTABLE}
    return {'unexpectedDifferences': unexpected, 'values': values, 'enabled': enabled,
            'wantedByEnabledOnly': sorted(moved), 'equivalent': not unexpected}


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
    pinned = set(re.findall(r"env\['(QORPERA_[A-Z0-9_]+)'\]==", source))
    dropped = sorted(pinned - set(fixed) - release)
    need(not dropped, f'the launcher pins {", ".join(dropped)} by value outside FIXED; list it in --release-keys')
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
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(source_fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        document = json.load(handle)
    missing = [key for key in release_keys if key not in document['env']]
    need(not missing, f'the env file lacks release keys: {missing}')
    document['env'] = {key: value for key, value in document['env'].items() if key not in set(release_keys)}
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(document, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fchown(handle.fileno(), info.st_uid, info.st_gid)
        os.fchmod(handle.fileno(), info.st_mode & 0o7777)
        os.fsync(handle.fileno())
    folder = os.open(os.path.dirname(os.path.abspath(dest)), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)
    return {'written': dest, 'keys': len(document['env']), 'mode': oct(info.st_mode & 0o7777)}


CAPTURE = r'''
import hashlib, json, os, runpy, sys
PATH_KEYS = json.loads(os.environ.pop("QORPERA_CAPTURE_PATH_KEYS"))
def capture(path, argv, env):
    digests = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in env.items()}
    sys.stdout.write(json.dumps({"argv": argv, "env": digests, "paths": {k: env[k] for k in PATH_KEYS if k in env}}))
    sys.stdout.flush()
    os._exit(0)
os.execve = capture
sys.argv = json.loads(os.environ.pop("QORPERA_CAPTURE_ARGV"))
runpy.run_path(sys.argv[0], run_name="__main__")
'''


def capture(unit, argv, path_keys):
    props = show(unit)
    groups = props.get('SupplementaryGroups', '').split()
    command = ['/usr/bin/setpriv', f"--reuid={props['User']}", f"--regid={props['Group']}",
               f"--groups={','.join(groups)}" if groups else '--clear-groups', '--bounding-set=-all',
               '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
               'LANG=C', 'LC_ALL=C', f'QORPERA_CAPTURE_ARGV={json.dumps(argv)}',
               f'QORPERA_CAPTURE_PATH_KEYS={json.dumps(sorted(path_keys))}', '/usr/bin/python3', '-I', '-c', CAPTURE]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    need(result.returncode == 0 and result.stdout, f'launcher refused: {result.stderr.strip()[:200]}')
    return json.loads(result.stdout)


def file_digest(path):
    """sha256 of a regular file's bytes, read as root outside any sandbox; None if it cannot be read."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(fd, 'rb') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            return None
        return hashlib.sha256(handle.read()).hexdigest()


def release_path_keys(node_root, role):
    """The keys whose value the role's release writes as a ${release} path: the only values allowed to change."""
    with open(os.path.join(node_root, 'roles', role, 'release.json'), 'rb') as handle:
        env = json.load(handle)['roles'][role]['env']
    return sorted(key for key, value in env.items() if '${release}' in value)


def compare(old, new, path_keys, digest=file_digest):
    """Compares two captured launches. Everything must be equal, the per-release values included (release 0 was built
    from what runs now), except the program path and the ${release} path values: those may move, but the files they
    name must hold the same bytes."""
    programs = [digest(old['argv'][-1]), digest(new['argv'][-1])]
    report = {'argvPrefixEqual': old['argv'][:-1] == new['argv'][:-1],
              'programBytesEqual': programs[0] is not None and programs[0] == programs[1],
              'keysOnlyOld': sorted(set(old['env']) - set(new['env'])),
              'keysOnlyNew': sorted(set(new['env']) - set(old['env'])), 'differing': [], 'pathKeys': sorted(path_keys)}
    for key in sorted(set(old['env']) & set(new['env'])):
        if old['env'][key] != new['env'][key]:
            report['differing'].append(key)
    moved = []
    for key in report['differing']:
        if key not in path_keys:
            continue
        before, after = digest(old.get('paths', {}).get(key, '')), digest(new.get('paths', {}).get(key, ''))
        if before is not None and before == after:
            moved.append(key)
    report['unexpected'] = [key for key in report['differing'] if key not in moved]
    report['equivalent'] = (report['argvPrefixEqual'] and report['programBytesEqual'] and not report['keysOnlyOld']
                            and not report['keysOnlyNew'] and not report['unexpected'])
    return report


def main(argv):
    command, options = argv[1], dict(zip(argv[2::2], argv[3::2]))
    keys = [key for key in options.get('--release-keys', '').split(',') if key]
    if command == 'unit':
        lock = node_lock()
        try:
            cat = subprocess.run(['/usr/bin/systemctl', 'cat', options['--old']], check=True, capture_output=True,
                                 text=True).stdout
            blocks = parse_cat(cat)
            check_sources(blocks, options['--old'])
            sys.stdout.write(unit_text(effective_settings(blocks), options['--old'], options['--exec'],
                                       options['--role']))
        finally:
            os.close(lock)
    elif command == 'show-diff':
        old, new = show(options['--old']), show(options['--new'])
        cats = [subprocess.run(['/usr/bin/systemctl', 'cat', unit], check=True, capture_output=True, text=True).stdout
                for unit in [options['--old'], options['--new']]]
        watchdog_set = any(re.match(r'\s*WatchdogSec=', line) for cat in cats for line in cat.splitlines())
        print(json.dumps(show_diff(old, new, options['--old'], options['--new'], watchdog_set)))
    elif command == 'role':
        with open(options['--launcher']) as handle:
            print(json.dumps(role_entry(handle.read(), keys, options['--unit'], options.get('--env-file')), indent=2))
    elif command == 'split-env':
        print(json.dumps(split_env(options['--source'], options['--dest'], keys)))
    elif command == 'compare':
        path_keys = release_path_keys(options.get('--node-root', '/opt/qorpera-node'), options['--role'])
        old = capture(options['--unit'], [options['--old-launcher']], path_keys)
        new = capture(options['--unit'], ['/usr/local/libexec/qorpera-node/qorpera-node-launch.py', options['--role']],
                      path_keys)
        print(json.dumps(compare(old, new, path_keys)))
    else:
        raise SystemExit('usage: qorpera-node-migrate unit|show-diff|role|split-env|compare ...')


if __name__ == '__main__':
    main(sys.argv)
