import fcntl
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

    def test_refuses_to_drop_a_value_pin_that_is_not_a_release_key(self):
        source = (HERE / 'fixtures' / 'provider-launch-v63.py').read_text()
        keys = [key for key in RELEASE_KEYS if key != 'QORPERA_LXD_IMAGE_FINGERPRINT']
        with self.assertRaisesRegex(SystemExit, 'QORPERA_LXD_IMAGE_FINGERPRINT'):
            migrate.role_entry(source, keys, 'qorpera-node-provider.service', None)

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

    def settings(self, unit=FIXED_UNIT):
        return migrate.effective_settings(migrate.parse_cat(unit))

    def test_refuses_any_tie_to_another_node_unit_but_ordering_and_conflicts(self):
        for key in ['Requires', 'BindsTo', 'PartOf', 'Wants', 'Upholds', 'OnFailure', 'Requisite']:
            unit = FIXED_UNIT.replace('After=network-online.target snap.lxd.daemon.service',
                                      f'After=network-online.target\n{key}=qorpera-native25-phql-provider.service')
            with self.assertRaisesRegex(SystemExit, key):
                migrate.unit_text(self.settings(unit), 'qorpera-x.service', '/l.py', 'orchestrator')
        unit = FIXED_UNIT.replace('WantedBy=multi-user.target', 'WantedBy=multi-user.target\nAlso=qorpera-y.timer')
        with self.assertRaisesRegex(SystemExit, 'Also'):
            migrate.unit_text(self.settings(unit), 'qorpera-x.service', '/l.py', 'provider')
        ordered = FIXED_UNIT.replace('After=network-online.target snap.lxd.daemon.service',
                                     'After=qorpera-native25-phql-provider.service')
        migrate.unit_text(self.settings(ordered), 'qorpera-x.service', '/l.py', 'orchestrator')

    def test_adds_the_old_unit_to_the_conflicts_it_already_has(self):
        unit = FIXED_UNIT.replace('After=network-online.target snap.lxd.daemon.service',
                                  'After=network-online.target\nConflicts=qorpera-other.service')
        lines = migrate.unit_text(self.settings(unit), 'qorpera-native25-phql-provider.service', '/l.py',
                                  'provider').splitlines()
        self.assertEqual([line for line in lines if line.startswith('Conflicts=')],
                         ['Conflicts=qorpera-other.service', 'Conflicts=qorpera-native25-phql-provider.service'])

    def test_replays_every_key_so_accumulating_keys_keep_every_value(self):
        unit = FIXED_UNIT + (
            '\n# /etc/systemd/system/qorpera-native25-phql-provider.service.d/state.conf\n[Unit]\n'
            'ConditionPathExists=/a\nConditionPathExists=\nConditionPathExists=/b\nAssertPathExists=/c\n'
            '[Service]\nStateDirectory=one\nStateDirectory=two\nSuccessExitStatus=3\nSuccessExitStatus=4\n'
            'SystemCallArchitectures=native\n')
        settings = self.settings(unit)
        self.assertEqual(settings['Unit']['ConditionPathExists'], ['/b'])
        self.assertEqual(settings['Service']['StateDirectory'], ['one', 'two'])
        self.assertEqual(settings['Service']['SuccessExitStatus'], ['3', '4'])
        # A single-value key keeps each assignment in order; systemd reads the last one, as it did for the old unit.
        self.assertEqual(settings['Service']['RuntimeMaxSec'], ['86400', 'infinity'])

    def test_refuses_shared_drop_ins_and_lane_files_beside_the_old_units(self):
        name = 'qorpera-native25-phql-provider.service'
        migrate.check_sources(migrate.parse_cat(FIXED_UNIT), name, unit_dirs=[])
        shared = FIXED_UNIT + f'\n# /etc/systemd/system/qorpera-.service.d/x.conf\n[Service]\nNice=1\n'
        with self.assertRaisesRegex(SystemExit, 'shared drop-in'):
            migrate.check_sources(migrate.parse_cat(shared), name, unit_dirs=[])
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / f'{name}.d').mkdir()
            (Path(folder) / f'{name}.d' / 'zzzz-native64.conf').write_text('')
            migrate.check_sources(migrate.parse_cat(FIXED_UNIT), name, unit_dirs=[folder])
            for stray in ['zzzz-native90.conf.prepared', 'zzzz-native63.conf.disabled']:
                (Path(folder) / f'{name}.d' / stray).write_text('')
                with self.assertRaisesRegex(SystemExit, stray):
                    migrate.check_sources(migrate.parse_cat(FIXED_UNIT), name, unit_dirs=[folder])
                (Path(folder) / f'{name}.d' / stray).unlink()

    def test_refuses_while_a_lane_holds_the_node_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'qorpera-node-update.lock')
            with self.assertRaisesRegex(SystemExit, 'NODE_LOCK_UNSAFE'):
                migrate.node_lock(path, owner=0 if os.getuid() else 1)
            held = os.open(path, os.O_RDWR)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(SystemExit, 'NODE_LOCK_HELD'):
                migrate.node_lock(path, owner=os.getuid())
            os.close(held)
            os.close(migrate.node_lock(path, owner=os.getuid()))

    def test_refuses_an_old_unit_that_does_not_run_a_python_launcher(self):
        settings = migrate.effective_settings(migrate.parse_cat(FIXED_UNIT.replace('-I /opt/x/provider-launch-v63.py',
                                                                                   '/opt/x/run')))
        with self.assertRaises(SystemExit):
            migrate.unit_text(settings, 'old.service', '/l.py', 'provider')

    def shows(self):
        start = ('{ path=/usr/bin/env ; argv[]=/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -I %s ; '
                 'ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }')
        old = {'Id': 'qorpera-native25-phql-provider.service', 'LoadState': 'loaded', 'NeedDaemonReload': 'no',
               'User': 'u', 'MainPID': '5', 'CPUUsageNSec': '1', 'ActiveEnterTimestamp': 't', 'ProtectSystem': 'strict',
               'UnitFileState': 'enabled', 'Conflicts': 'shutdown.target', 'ConflictedBy': 'qorpera-node-provider.service',
               'WantedBy': 'multi-user.target', 'Before': 'shutdown.target multi-user.target', 'Triggers': '',
               'ExecStart': start % '/opt/x/provider-launch-v64.py'}
        new = {**old, 'Id': 'qorpera-node-provider.service', 'MainPID': '0', 'CPUUsageNSec': '0',
               'ActiveEnterTimestamp': '', 'UnitFileState': 'disabled', 'ConflictedBy': '',
               'Conflicts': 'qorpera-native25-phql-provider.service shutdown.target', 'WantedBy': '',
               'Before': 'shutdown.target',
               'ExecStart': start % '/usr/local/libexec/qorpera-node/qorpera-node-launch.py provider'}
        return old, new

    def diff(self, old, new):
        return migrate.show_diff(old, new, 'qorpera-native25-phql-provider.service', 'qorpera-node-provider.service')

    def test_show_diff_allows_identity_runtime_state_the_conflict_and_the_pending_enable(self):
        old, new = self.shows()
        self.assertEqual(self.diff(old, new), {'unexpectedDifferences': [], 'pendingEnable': ['multi-user.target'],
                                               'equivalent': True})
        self.assertEqual(self.diff(old, {**new, 'User': 'root', 'ProtectSystem': 'no'})['unexpectedDifferences'],
                         ['ProtectSystem', 'User'])

    def test_show_diff_refuses_what_the_switch_depends_on(self):
        old, new = self.shows()
        cases = {
            'Conflicts': {'Conflicts': 'qorpera-native25-phql-provider.service'},
            'Triggers': {'Triggers': 'qorpera-node-provider.timer'},
            'qorpera-node-provider.service:LoadState/NeedDaemonReload': {'NeedDaemonReload': 'yes'},
            'WantedBy': {'UnitFileState': 'enabled'},
            'Before': {'Before': ''},
            'ExecStart': {'ExecStart': old['ExecStart'].replace('-I ', '')},
        }
        for key, change in cases.items():
            self.assertIn(key, self.diff(old, {**new, **change})['unexpectedDifferences'], key)
        self.assertIn('qorpera-native25-phql-provider.service:LoadState/NeedDaemonReload',
                      self.diff({**old, 'LoadState': 'not-found'}, new)['unexpectedDifferences'])


class CompareTest(unittest.TestCase):
    FILES = {'/opt/old.mjs': 'p', '/opt/new.mjs': 'p', '/opt/other.mjs': 'q', '/opt/old-prov.json': 'v',
             '/r/0/image-provenance.json': 'v', '/r/0/other.json': 'w'}
    PATH_KEYS = ['QORPERA_LXD_IMAGE_PROVENANCE']

    def launch(self, program, provenance='/opt/old-prov.json', **env):
        return {'argv': ['/usr/bin/node', '--jitless', program],
                'env': {'PATH': 'p', 'A': '1', 'QORPERA_LXD_IMAGE_FINGERPRINT': 'f',
                        'QORPERA_LXD_IMAGE_PROVENANCE': f'h({provenance})', **env},
                'paths': {'QORPERA_LXD_IMAGE_PROVENANCE': provenance}}

    def compare(self, old, new):
        return migrate.compare(old, new, self.PATH_KEYS, digest=self.FILES.get)

    def test_equivalent_when_only_the_program_path_and_release_paths_move_to_the_same_bytes(self):
        report = self.compare(self.launch('/opt/old.mjs'), self.launch('/opt/new.mjs', '/r/0/image-provenance.json'))
        self.assertTrue(report['equivalent'])
        self.assertEqual(report['differing'], ['QORPERA_LXD_IMAGE_PROVENANCE'])

    def test_not_equivalent_when_anything_else_differs(self):
        old = self.launch('/opt/old.mjs')
        for new in [self.launch('/opt/new.mjs', A='2'), self.launch('/opt/new.mjs', QORPERA_LXD_IMAGE_FINGERPRINT='g'),
                    self.launch('/opt/new.mjs', '/r/0/other.json'), self.launch('/opt/new.mjs', '/r/0/missing.json'),
                    self.launch('/opt/other.mjs'), self.launch('/opt/missing.mjs')]:
            self.assertFalse(self.compare(old, new)['equivalent'], new)
        self.assertFalse(self.compare(self.launch('/opt/old.mjs', B='1'), self.launch('/opt/new.mjs'))['equivalent'])
        other = self.launch('/opt/new.mjs')
        other['argv'] = ['/usr/bin/node', '/opt/new.mjs']
        self.assertFalse(self.compare(old, other)['equivalent'])

    def test_path_keys_are_the_release_values_written_under_the_release_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            release = Path(folder) / 'releases' / '0'
            release.mkdir(parents=True)
            (Path(folder) / 'roles').mkdir()
            (Path(folder) / 'roles' / 'provider').symlink_to('../releases/0')
            (release / 'release.json').write_text(json.dumps({'roles': {'provider': {'env': {
                'QORPERA_LXD_IMAGE_FINGERPRINT': 'f' * 64, 'QORPERA_LXD_IMAGE_PROVENANCE': '${release}/p.json'}}}}))
            self.assertEqual(migrate.release_path_keys(folder, 'provider'), ['QORPERA_LXD_IMAGE_PROVENANCE'])


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
