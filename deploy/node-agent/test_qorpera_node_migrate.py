import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('migrate', HERE / 'qorpera-node-migrate.py')
migrate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migrate)

RELEASE_KEYS = [
    'QORPERA_LXD_IMAGE_FINGERPRINT', 'QORPERA_LXD_IMAGE_PROVENANCE', 'QORPERA_LXD_IMAGE_PROVENANCE_PUBLIC_KEY',
    'QORPERA_LXD_GUEST_PACKAGE_MANIFEST_SHA256', 'QORPERA_EPHEMERAL_RUNNER_VERSION',
    'QORPERA_RUNNER_PROVIDER_SOFTWARE_VERSION', 'QORPERA_NATIVE_CODEX_FENCE_SHA256',
]
FIXED_UNIT = '''# /etc/systemd/system/qorpera-native25-phql-provider.service
[Unit]
Description=Isolated native25 phql provider and login gateway
After=network-online.target snap.lxd.daemon.service

[Service]
Type=simple
User=qn25-phql-provider
Group=qn25-phql-provider
SupplementaryGroups=lxd
Environment=NODE_ENV=production
ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/x LANG=C LC_ALL=C /usr/bin/python3 -I /opt/x/provider-launch.py
NoNewPrivileges=yes
CapabilityBoundingSet=
RuntimeMaxSec=86400
Restart=on-failure

# /etc/systemd/system/qorpera-native25-phql-provider.service.d/zzzz-native01.conf
[Service]
ExecStart=
ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/x LANG=C LC_ALL=C /usr/bin/python3 -I /opt/x/provider-launch-v01.py

# /etc/systemd/system/qorpera-native25-phql-provider.service.d/restart.conf
[Service]
RuntimeMaxSec=infinity
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target

# /etc/systemd/system/qorpera-native25-phql-provider.service.d/zzzz-native63.conf
[Service]
ExecStart=
ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/x LANG=C LC_ALL=C /usr/bin/python3 -I /opt/x/provider-launch-v63.py
'''


class RoleEntryTest(unittest.TestCase):
    def test_provider_launcher_splits_node_constants_secrets_and_release_values(self):
        entry = migrate.role_entry((HERE / 'fixtures' / 'provider-launch-v63.py').read_text(), RELEASE_KEYS,
                                   'qorpera-node-provider.service', '/etc/qorpera-node/provider.env.json')
        self.assertEqual(entry['envFile'], '/etc/qorpera-node/provider.env.json')
        self.assertEqual(entry['envSchema'], 'qorpera.native36-provider-env/v1')
        self.assertEqual(entry['projectRef'], 'fixtureprojectref0001')
        self.assertEqual(entry['secretKeys'], ['QORPERA_LXD_CLOUD_SECRET_CA_SHA256', 'QORPERA_RUNNER_PROVIDER_TOKEN',
                                               'QORPERA_SUPABASE_PUBLISHABLE_KEY', 'QORPERA_SUPABASE_SERVICE_KEY'])
        self.assertEqual(entry['releaseKeys'], sorted(RELEASE_KEYS))
        self.assertFalse(set(entry['fixed']) & set(RELEASE_KEYS))
        self.assertEqual(len(entry['fixed']), 49)
        self.assertEqual(entry['tokenKeys'], ['QORPERA_RUNNER_PROVIDER_TOKEN'])
        self.assertEqual(entry['sha256Keys'], ['QORPERA_LXD_CLOUD_SECRET_CA_SHA256', 'QORPERA_LXD_IMAGE_FINGERPRINT'])
        self.assertEqual(entry['jwtKeys'], {'QORPERA_SUPABASE_SERVICE_KEY': 'service_role',
                                            'QORPERA_SUPABASE_PUBLISHABLE_KEY': 'anon'})
        self.assertEqual(list(entry['deniedValues']), ['QORPERA_LXD_IMAGE_FINGERPRINT'])
        self.assertEqual(entry['stateDirs'], ['/var/lib/qorpera-native25-phql-a1/provider-runs-v36',
                                              '/var/lib/qorpera-native25-phql-a1/provider-logins-v26'])
        self.assertEqual(entry['home'], '/var/lib/qorpera-native25-phql-a1/provider-runs-v36')
        self.assertEqual(entry['exec'], ['/usr/bin/node', '--jitless'])
        self.assertFalse(entry['noSupplementaryGroups'])
        self.assertEqual(entry['health'], ['http://127.0.0.1:18447/healthz', 'http://127.0.0.1:18450/healthz'])

    def test_orchestrator_launcher_keeps_its_env_file_and_group_rule(self):
        entry = migrate.role_entry((HERE / 'fixtures' / 'orchestrator-hour-launch-v70.py').read_text(), [],
                                   'qorpera-node-orchestrator.service', None)
        self.assertEqual(entry['envFile'], '/etc/qorpera-native25-phql-a1/orchestrator-env.json')
        self.assertIsNone(entry['envSchema'])
        self.assertEqual(entry['secretKeys'], ['QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN',
                                               'QORPERA_RUNNER_PROVIDER_TOKEN', 'QORPERA_SUPABASE_PUBLISHABLE_KEY'])
        self.assertEqual(len(entry['fixed']), 7)
        self.assertEqual(entry['tokenKeys'], ['QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN',
                                              'QORPERA_RUNNER_PROVIDER_TOKEN'])
        self.assertEqual(entry['jwtKeys'], {'QORPERA_SUPABASE_PUBLISHABLE_KEY': 'anon'})
        self.assertEqual(entry['stateDirs'], ['/var/lib/qorpera-native25-phql-a1/orchestrator'])
        self.assertEqual(entry['home'], '/var/lib/qorpera-native25-phql-a1/orchestrator')
        self.assertTrue(entry['noSupplementaryGroups'])
        self.assertEqual(entry['health'], [])


class UnitTest(unittest.TestCase):
    def test_new_unit_keeps_every_effective_setting_and_replaces_only_the_launcher(self):
        settings = migrate.effective_settings(migrate.parse_cat(FIXED_UNIT))
        self.assertEqual(settings['Service']['CapabilityBoundingSet'], [''])
        self.assertEqual(settings['Service']['ExecStart'], [
            '/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/x LANG=C LC_ALL=C /usr/bin/python3 -I '
            '/opt/x/provider-launch-v63.py'])
        text = migrate.unit_text(settings, 'qorpera-native25-phql-provider.service',
                                 '/usr/local/libexec/qorpera-node/qorpera-node-launch.py', 'provider')
        lines = text.splitlines()
        self.assertIn('Conflicts=qorpera-native25-phql-provider.service', lines)
        self.assertIn('ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/x LANG=C LC_ALL=C /usr/bin/python3 -I '
                      '/usr/local/libexec/qorpera-node/qorpera-node-launch.py provider', lines)
        self.assertEqual([line for line in lines if line.startswith('ExecStart=')].__len__(), 1)
        for expected in ['RuntimeMaxSec=infinity', 'Restart=always', 'RestartSec=5', 'WantedBy=multi-user.target',
                         'SupplementaryGroups=lxd', 'Environment=NODE_ENV=production', 'CapabilityBoundingSet=',
                         'After=network-online.target snap.lxd.daemon.service']:
            self.assertIn(expected, lines)

    def test_refuses_an_old_unit_that_does_not_run_a_python_launcher(self):
        settings = migrate.effective_settings(migrate.parse_cat(FIXED_UNIT.replace('-I /opt/x/provider-launch-v63.py',
                                                                                   '/opt/x/run')))
        with self.assertRaises(SystemExit):
            migrate.unit_text(settings, 'old.service', '/l.py', 'provider')

    def test_show_diff_ignores_identity_and_runtime_state_only(self):
        old = {'Id': 'a.service', 'User': 'u', 'MainPID': '5', 'CPUUsageNSec': '1', 'ExecStart': 'x',
               'ActiveEnterTimestamp': 't', 'ProtectSystem': 'strict'}
        same = {**old, 'Id': 'b.service', 'MainPID': '0', 'CPUUsageNSec': '0', 'ExecStart': 'y',
                'ActiveEnterTimestamp': ''}
        self.assertEqual(migrate.show_diff(old, same), [])
        self.assertEqual(migrate.show_diff(old, {**same, 'User': 'root', 'ProtectSystem': 'no'}),
                         ['ProtectSystem', 'User'])


class CompareTest(unittest.TestCase):
    def launch(self, program, **env):
        return {'argv': ['/usr/bin/node', '--jitless', program], 'env': {'PATH': 'p', 'A': '1', **env}}

    def test_equivalent_when_only_the_program_and_release_values_move(self):
        report = migrate.compare(self.launch('/opt/old.mjs', QORPERA_LXD_IMAGE_PROVENANCE='old'),
                                 self.launch('/opt/new.mjs', QORPERA_LXD_IMAGE_PROVENANCE='new'), RELEASE_KEYS)
        self.assertTrue(report['equivalent'])
        self.assertEqual(report['differing'], ['QORPERA_LXD_IMAGE_PROVENANCE'])

    def test_not_equivalent_when_anything_else_differs(self):
        self.assertFalse(migrate.compare(self.launch('/o'), self.launch('/n', A='2'), RELEASE_KEYS)['equivalent'])
        self.assertFalse(migrate.compare(self.launch('/o', B='1'), self.launch('/n'), RELEASE_KEYS)['equivalent'])
        other = self.launch('/n')
        other['argv'] = ['/usr/bin/node', '/n']
        self.assertFalse(migrate.compare(self.launch('/o'), other, RELEASE_KEYS)['equivalent'])


class SplitEnvTest(unittest.TestCase):
    def test_writes_the_env_without_release_values_with_the_same_mode_once(self):
        with tempfile.TemporaryDirectory() as folder:
            source, dest = Path(folder) / 'env.json', Path(folder) / 'new.json'
            source.write_text(json.dumps({'schema': 's', 'projectRef': 'p', 'env': {
                'A': '1', 'QORPERA_LXD_IMAGE_FINGERPRINT': 'f', 'QORPERA_LXD_IMAGE_PROVENANCE': 'x'}}))
            os.chmod(source, 0o640)
            result = migrate.split_env(str(source), str(dest), ['QORPERA_LXD_IMAGE_FINGERPRINT',
                                                                'QORPERA_LXD_IMAGE_PROVENANCE'])
            self.assertEqual(result['keys'], 1)
            self.assertEqual(json.loads(dest.read_text())['env'], {'A': '1'})
            self.assertEqual(os.stat(dest).st_mode & 0o7777, 0o640)
            with self.assertRaises(FileExistsError):
                migrate.split_env(str(source), str(dest), ['QORPERA_LXD_IMAGE_FINGERPRINT'])
            with self.assertRaises(SystemExit):
                migrate.split_env(str(source), str(Path(folder) / 'other.json'), ['QORPERA_MISSING'])


if __name__ == '__main__':
    unittest.main()
