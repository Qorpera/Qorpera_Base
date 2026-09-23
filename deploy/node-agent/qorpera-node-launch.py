#!/usr/bin/python3
# Fixed launcher for the node roles (phase B of the node auto-update plan). One file serves every role and every
# release, in place of the versioned provider-launch-vNN.py / orchestrator-hour-launch-vNN.py files:
#   /etc/qorpera-node/node.json            per-role settings: fixed values, secret keys, state folders, exec (root, 0444)
#   the role's env file                    node constants and secrets, as today (root:<role group>, 0440)
#   /opt/qorpera-node/current -> releases/<revision>
#   releases/<revision>/release.json      the signed release the agent verified and staged: per-release values and
#                                          the program's sha256 (root, 0444, in a 0555 root folder)
# It keeps the guards of the launchers it replaces and execs `<exec...> <program>` with the same clean environment.
# Usage (systemd ExecStart, under `env -i`): /usr/bin/python3 -I /usr/local/libexec/qorpera-node/qorpera-node-launch.py <role>
import base64
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

NODE_CONFIG = Path('/etc/qorpera-node/node.json')
NODE_ROOT = Path('/opt/qorpera-node')
ROLE = re.compile(r'[a-z][a-z0-9-]{0,31}')
REVISION = re.compile(r'0|[1-9][0-9]{0,8}')
ENV_KEY = re.compile(r'[A-Z][A-Z0-9_]{0,127}')


def need(ok):
    if not ok:
        raise RuntimeError('admission refused')


class Launcher:
    """The checks, with the owner and group made explicit so tests can run them unprivileged."""

    def __init__(self, node_config=NODE_CONFIG, node_root=NODE_ROOT, owner=0, uid=None, gid=None, trusted_above=None):
        self.node_config = node_config
        self.node_root = node_root
        self.owner = owner
        self.uid = os.getuid() if uid is None else uid
        self.gid = os.getgid() if gid is None else gid
        # Tests only: parents above this folder are not checked. On a node every parent up to / is checked.
        self.trusted_above = trusted_above

    def read(self, path, mode, limit):
        need(path.is_absolute() and path.resolve() == path)
        for parent in path.parents:
            if self.trusted_above is not None and parent in self.trusted_above.parents:
                continue
            s = parent.lstat()
            need(stat.S_ISDIR(s.st_mode) and s.st_uid == self.owner and not s.st_mode & 0o6022)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as f:
            s = os.fstat(f.fileno())
            need(stat.S_ISREG(s.st_mode) and s.st_uid == self.owner and s.st_nlink == 1)
            need(stat.S_IMODE(s.st_mode) == mode and 0 < s.st_size <= limit)
            if mode == 0o440:
                need(s.st_gid == self.gid)
            return f.read()

    def release_folder(self):
        link = self.node_root / 'current'
        s = link.lstat()
        need(stat.S_ISLNK(s.st_mode) and s.st_uid == self.owner)
        target = os.readlink(link)
        need(target.startswith('releases/') and REVISION.fullmatch(target[len('releases/'):]) is not None)
        folder = self.node_root / target
        s = folder.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == self.owner and stat.S_IMODE(s.st_mode) == 0o555)
        return folder, int(target[len('releases/'):])

    def plan(self, role):
        """Returns (argv, env) for the role, or raises."""
        need(ROLE.fullmatch(role) is not None)
        config = json.loads(self.read(self.node_config, 0o444, 65536))
        need(config.get('schema') == 'qorpera.node/v1')
        settings = config['roles'][role]
        folder, revision = self.release_folder()
        release = json.loads(self.read(folder / 'release.json', 0o444, 1048576))
        need(release.get('schema') == 'qorpera.node-release/v1' and release.get('revision') == revision)
        role_release = release['roles'][role]

        document = json.loads(self.read(Path(settings['envFile']), 0o440, 32768))
        expected = {'projectRef', 'env'} | ({'schema'} if settings.get('envSchema') else set())
        need(set(document) == expected and document['projectRef'] == settings['projectRef'])
        if settings.get('envSchema'):
            need(document['schema'] == settings['envSchema'])
        release_env = {key: value.replace('${release}', str(folder)) for key, value in role_release['env'].items()}
        need(not set(document['env']) & set(release_env))
        need(set(release_env) == set(settings['releaseKeys']))
        env = {**document['env'], **release_env}
        fixed = settings['fixed']
        need(set(env) == set(fixed) | set(settings['secretKeys']) | set(settings['releaseKeys']))
        need(all(env[key] == value for key, value in fixed.items()))
        need(all(ENV_KEY.fullmatch(key) and isinstance(value, str) and value and '\0' not in value and '\n' not in value
                 for key, value in env.items()))
        for key in settings.get('tokenKeys', []):
            need(re.fullmatch('[A-Za-z0-9_-]{43}', env[key]) is not None)
        for key in settings.get('sha256Keys', []):
            need(re.fullmatch('[0-9a-f]{64}', env[key]) is not None)
        for key, claim_role in settings.get('jwtKeys', {}).items():
            parts = env[key].split('.')
            need(len(parts) == 3)
            claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * ((4 - len(parts[1]) % 4) % 4)))
            need(claims.get('ref') == document['projectRef'] and claims.get('role') == claim_role)
        for key, denied in settings.get('deniedValues', {}).items():
            need(env[key] not in denied)

        component = role_release['component']
        entry = [file for file in release['files'] if file['name'] == component]
        need(len(entry) == 1 and '/' not in component)
        program = folder / component
        digest = hashlib.sha256(self.read(program, 0o444, settings['maxProgramBytes'])).hexdigest()
        need(digest == entry[0]['sha256'])

        for name in settings['stateDirs']:
            path = Path(name)
            s = path.lstat()
            need(path.resolve() == path and stat.S_ISDIR(s.st_mode) and s.st_uid == self.uid and s.st_gid == self.gid)
            need(stat.S_IMODE(s.st_mode) == 0o700)

        executable = settings['exec']
        need(len(executable) >= 1 and executable[0].startswith('/'))
        clean = {'PATH': '/usr/bin:/bin', 'HOME': settings['home'], 'LANG': 'C', 'LC_ALL': 'C', **env}
        return [*executable, str(program)], clean


def guard_process(no_supplementary_groups):
    need(sys.platform == 'linux' and os.geteuid() != 0 and os.geteuid() == os.getuid() and os.getegid() == os.getgid())
    status = Path('/proc/self/status').read_text()
    for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']:
        need(re.search('^' + key + r':\s+0+$', status, re.M))
    need(re.search(r'^NoNewPrivs:\s+1$', status, re.M))
    if no_supplementary_groups:
        need(set(os.getgroups()) <= {os.getgid()})


def main(argv):
    need(len(argv) == 2)
    launcher = Launcher()
    settings = json.loads(launcher.read(NODE_CONFIG, 0o444, 65536))['roles'][argv[1]]
    guard_process(settings.get('noSupplementaryGroups', False))
    executable, env = launcher.plan(argv[1])
    os.execve(executable[0], executable, env)


if __name__ == '__main__':
    try:
        main(sys.argv)
    except Exception:
        sys.stderr.write('QORPERA_NODE_ROLE_START_REFUSED\n')
        sys.exit(1)
