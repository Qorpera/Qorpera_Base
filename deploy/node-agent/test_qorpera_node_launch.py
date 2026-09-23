import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('launch', Path(__file__).with_name('qorpera-node-launch.py'))
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)

PROGRAM = b'console.log("provider")\n'


def jwt(role):
    body = base64.urlsafe_b64encode(json.dumps({'ref': 'phqlfrkcvstmxlebljcj', 'role': role}).encode()).decode().rstrip('=')
    return f'eyJhbGciOiJIUzI1NiJ9.{body}.signature'


class NodeTree:
    """A node's launcher inputs in a private temp folder, with the modes the launcher requires."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.temp.name))
        self.node_root = self.root / 'opt-qorpera-node'
        self.etc = self.root / 'etc'
        self.state = self.root / 'state'
        for folder in [self.node_root, self.node_root / 'releases', self.etc]:
            folder.mkdir(mode=0o755)
        self.state.mkdir(mode=0o700)
        self.env_file = self.etc / 'provider.env.json'
        self.release(1)
        (self.node_root / 'current').symlink_to('releases/1')
        self.write(self.env_file, {
            'schema': 'qorpera.native36-provider-env/v1',
            'projectRef': 'phqlfrkcvstmxlebljcj',
            'env': {
                'QORPERA_RUNNER_PROVIDER_PORT': '18450',
                'QORPERA_RUNNER_PROVIDER_TOKEN': 't' * 43,
                'QORPERA_SUPABASE_SERVICE_KEY': jwt('service_role'),
            },
        }, 0o440)
        self.write(self.etc / 'node.json', self.node_config(), 0o444)
        self.gid = os.stat(self.env_file).st_gid

    def node_config(self, **overrides):
        provider = {
            'envFile': str(self.env_file),
            'envSchema': 'qorpera.native36-provider-env/v1',
            'projectRef': 'phqlfrkcvstmxlebljcj',
            'fixed': {'QORPERA_RUNNER_PROVIDER_PORT': '18450'},
            'secretKeys': ['QORPERA_RUNNER_PROVIDER_TOKEN', 'QORPERA_SUPABASE_SERVICE_KEY'],
            'releaseKeys': ['QORPERA_LXD_IMAGE_FINGERPRINT', 'QORPERA_LXD_IMAGE_PROVENANCE'],
            'tokenKeys': ['QORPERA_RUNNER_PROVIDER_TOKEN'],
            'sha256Keys': ['QORPERA_LXD_IMAGE_FINGERPRINT'],
            'jwtKeys': {'QORPERA_SUPABASE_SERVICE_KEY': 'service_role'},
            'deniedValues': {'QORPERA_LXD_IMAGE_FINGERPRINT': ['b' * 64]},
            'maxProgramBytes': 1048576,
            'stateDirs': [str(self.state)],
            'home': str(self.state),
            'exec': ['/usr/bin/node', '--jitless'],
            **overrides,
        }
        return {'schema': 'qorpera.node/v1', 'roles': {'provider': provider}}

    def release(self, revision, program=PROGRAM, env=None, digest=None):
        folder = self.node_root / 'releases' / str(revision)
        folder.mkdir(mode=0o755)
        (folder / 'qorpera-lxd-provider.mjs').write_bytes(program)
        os.chmod(folder / 'qorpera-lxd-provider.mjs', 0o444)
        self.write(folder / 'release.json', {
            'schema': 'qorpera.node-release/v1',
            'revision': revision,
            'files': [{'name': 'qorpera-lxd-provider.mjs', 'sha256': digest or hashlib.sha256(program).hexdigest(),
                       'bytes': len(program)}],
            'roles': {'provider': {'component': 'qorpera-lxd-provider.mjs', 'env': env or {
                'QORPERA_LXD_IMAGE_FINGERPRINT': 'a' * 64,
                'QORPERA_LXD_IMAGE_PROVENANCE': '${release}/image-provenance.json',
            }}},
        }, 0o444)
        os.chmod(folder, 0o555)
        return folder

    def write(self, path, value, mode):
        if path.exists():
            os.chmod(path, 0o644)
        path.write_text(json.dumps(value))
        os.chmod(path, mode)

    def launcher(self):
        return launch.Launcher(node_config=self.etc / 'node.json', node_root=self.node_root, owner=os.getuid(),
                               uid=os.getuid(), gid=self.gid, trusted_above=self.root)

    def close(self):
        for folder in (self.node_root / 'releases').iterdir():
            os.chmod(folder, 0o755)
        self.temp.cleanup()


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.node = NodeTree()

    def tearDown(self):
        self.node.close()

    def refused(self):
        with self.assertRaises(Exception):
            self.node.launcher().plan('provider')

    def test_execs_the_release_program_with_the_same_clean_environment(self):
        argv, env = self.node.launcher().plan('provider')
        release = self.node.node_root / 'releases' / '1'
        self.assertEqual(argv, ['/usr/bin/node', '--jitless', str(release / 'qorpera-lxd-provider.mjs')])
        self.assertEqual(env, {
            'PATH': '/usr/bin:/bin',
            'HOME': str(self.node.state),
            'LANG': 'C',
            'LC_ALL': 'C',
            'QORPERA_RUNNER_PROVIDER_PORT': '18450',
            'QORPERA_RUNNER_PROVIDER_TOKEN': 't' * 43,
            'QORPERA_SUPABASE_SERVICE_KEY': jwt('service_role'),
            'QORPERA_LXD_IMAGE_FINGERPRINT': 'a' * 64,
            'QORPERA_LXD_IMAGE_PROVENANCE': f'{release}/image-provenance.json',
        })

    def test_follows_current_to_a_new_release(self):
        folder = self.node.release(2, program=b'console.log("v2")\n')
        (self.node.node_root / 'current').unlink()
        (self.node.node_root / 'current').symlink_to('releases/2')
        argv, _ = self.node.launcher().plan('provider')
        self.assertEqual(argv[-1], str(folder / 'qorpera-lxd-provider.mjs'))

    def test_refuses_a_program_that_does_not_match_the_release(self):
        self.node.release(2, digest='0' * 64)
        (self.node.node_root / 'current').unlink()
        (self.node.node_root / 'current').symlink_to('releases/2')
        self.refused()

    def test_refuses_current_outside_the_releases(self):
        (self.node.node_root / 'current').unlink()
        (self.node.node_root / 'current').symlink_to(str(self.node.node_root / 'releases' / '1'))
        self.refused()

    def test_refuses_a_writable_release_folder(self):
        os.chmod(self.node.node_root / 'releases' / '1', 0o755)
        self.refused()

    def test_refuses_an_env_file_with_other_modes(self):
        os.chmod(self.node.env_file, 0o444)
        self.refused()

    def test_refuses_a_changed_fixed_value(self):
        self.node.write(self.node.etc / 'node.json',
                        self.node.node_config(fixed={'QORPERA_RUNNER_PROVIDER_PORT': '18451'}), 0o444)
        self.refused()

    def test_refuses_a_release_value_that_shadows_the_env_file(self):
        self.node.release(2, env={
            'QORPERA_LXD_IMAGE_FINGERPRINT': 'a' * 64,
            'QORPERA_LXD_IMAGE_PROVENANCE': 'x',
            'QORPERA_RUNNER_PROVIDER_PORT': '1',
        })
        (self.node.node_root / 'current').unlink()
        (self.node.node_root / 'current').symlink_to('releases/2')
        self.refused()

    def test_refuses_a_denied_or_malformed_release_value(self):
        for fingerprint in ['b' * 64, 'not-a-sha']:
            revision = 2 if fingerprint.startswith('b') else 3
            self.node.release(revision, env={
                'QORPERA_LXD_IMAGE_FINGERPRINT': fingerprint,
                'QORPERA_LXD_IMAGE_PROVENANCE': 'x',
            })
            (self.node.node_root / 'current').unlink()
            (self.node.node_root / 'current').symlink_to(f'releases/{revision}')
            self.refused()

    def test_refuses_a_key_for_the_wrong_role(self):
        document = json.loads(self.node.env_file.read_text())
        document['env']['QORPERA_SUPABASE_SERVICE_KEY'] = jwt('anon')
        self.node.write(self.node.env_file, document, 0o440)
        self.refused()

    def test_refuses_an_open_state_folder(self):
        os.chmod(self.node.state, 0o755)
        self.refused()


if __name__ == '__main__':
    unittest.main()
