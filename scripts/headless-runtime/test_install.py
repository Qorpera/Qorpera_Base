import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('proof', Path(__file__).with_name('install.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class TarballBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def package(self, name='@qorpera/runtime', extra=None, dependencies=None, source=None, peers=None):
        manifest = {'name': name, 'version': '0.83.0', 'dependencies': dependencies or {}}
        if peers is not None:
            manifest.update(peers)
        if source is not None:
            manifest.update({'type': 'module', 'main': './dist/index.js'})
        path = self.root / (name.replace('/', '_') + '.tgz')
        with tarfile.open(path, 'w:gz') as tar:
            for member, data in [('package/package.json', json.dumps(manifest).encode()),
                                 ('package/dist/index.js', source if source is not None else b'export const marker = 1;')]:
                entry = tarfile.TarInfo(member)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
            if extra:
                entry, data = extra
                tar.addfile(entry, io.BytesIO(data))
        return path, proof.sha(path.read_bytes())

    def document(self):
        entries = []
        for name in ('runtime', 'contracts', 'company', 'cloud-client'):
            path, digest = self.package('@qorpera/' + name)
            entries.append({'path': str(path), 'sha256': digest})
        return {'schema': 'qorpera.external-runtime-input/v1', 'sourceCommit': 'a' * 40,
                'runtimeBundleSha256': 'b' * 64, 'modelPolicySha256': 'c' * 64,
                'nativeBinarySha256': 'd' * 64, 'tarballs': entries}

    def test_valid_closed_fixture_tarball_inventory(self):
        packages = proof.validate_input(self.document())
        self.assertEqual(len(packages), 4)
        self.assertEqual(set(packages['@qorpera/runtime']['files']), {'package.json', 'dist/index.js'})

    def test_digest_substitution_refused(self):
        path, _ = self.package()
        with self.assertRaisesRegex(ValueError, 'digest'):
            proof.inspect_tarball(path, '0' * 64)

    def test_parent_escape_refused(self):
        path, digest = self.package(extra=(tarfile.TarInfo('package/../../outside'), b''))
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            proof.inspect_tarball(path, digest)

    def test_symlink_archive_member_refused(self):
        entry = tarfile.TarInfo('package/dist/link.js')
        entry.type = tarfile.SYMTYPE
        entry.linkname = '/some/checkout/index.js'
        path, digest = self.package(extra=(entry, b''))
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            proof.inspect_tarball(path, digest)

    def test_duplicate_member_refused(self):
        path, digest = self.package(extra=(tarfile.TarInfo('package/dist/index.js'), b''))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            proof.inspect_tarball(path, digest)

    def test_missing_dependency_refused(self):
        doc = self.document()
        path, digest = self.package(dependencies={'unreviewed': '1.0.0'})
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        with self.assertRaisesRegex(ValueError, 'closure missing'):
            proof.validate_input(doc)

    def test_workspace_reference_refused(self):
        doc = self.document()
        path, digest = self.package(dependencies={'@qorpera/contracts': 'workspace:*'})
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        with self.assertRaisesRegex(ValueError, 'non-version'):
            proof.validate_input(doc)

    def test_absent_explicitly_optional_peer_allowed(self):
        doc = self.document()
        path, digest = self.package(peers={'peerDependencies': {'pg-native': '>=3.0.1'},
            'peerDependenciesMeta': {'pg-native': {'optional': True}}})
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        self.assertEqual(len(proof.validate_input(doc)), 4)

    def test_absent_required_peer_refused(self):
        doc = self.document()
        path, digest = self.package(peers={'peerDependencies': {'pg-native': '>=3.0.1'}})
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        with self.assertRaisesRegex(ValueError, 'closure missing'):
            proof.validate_input(doc)

    def test_absent_optional_dependency_still_refused(self):
        doc = self.document()
        path, digest = self.package(peers={'optionalDependencies': {'some-platform-package': '1.0.0'}})
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        with self.assertRaisesRegex(ValueError, 'closure missing'):
            proof.validate_input(doc)

    def test_installed_file_change_refused(self):
        doc = self.document()
        packages = proof.validate_input(doc)
        consumer = self.root / 'consumer'
        for package in packages.values():
            folder = consumer / 'node_modules' / package['name']
            (folder / 'dist').mkdir(parents=True)
            (folder / 'package.json').write_text(json.dumps(package['manifest']))
            (folder / 'dist/index.js').write_bytes(b'export const marker = 1;')
        lock = {'packages': {'': {}, **{'node_modules/' + name: {} for name in packages}}}
        (consumer / 'package-lock.json').write_text(json.dumps(lock))
        proof.verify_install(consumer, packages)
        (consumer / 'node_modules/@qorpera/runtime/dist/index.js').write_text('substitution')
        with self.assertRaisesRegex(ValueError, 'differs'):
            proof.verify_install(consumer, packages)

    def test_linked_installed_package_refused(self):
        packages = proof.validate_input(self.document())
        consumer = self.root / 'consumer'
        (consumer / 'node_modules/@qorpera').mkdir(parents=True)
        (consumer / 'node_modules/@qorpera/runtime').symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'symlinked'):
            proof.verify_install(consumer, packages)

    def test_unpinned_source_refused(self):
        doc = self.document()
        doc['sourceCommit'] = 'HEAD'
        with self.assertRaisesRegex(ValueError, 'exact source'):
            proof.validate_input(doc)

    def test_offline_install_then_transitive_checkout_escape_refused(self):
        node_path = os.environ.get('QORPERA_TEST_NODE') or shutil.which('node')
        npm_path = os.environ.get('QORPERA_TEST_NPM') or shutil.which('npm')
        self.assertTrue(node_path and npm_path, 'Node and npm are required for the actual offline-install test')
        node = Path(node_path).resolve(strict=True)
        npm = Path(npm_path).resolve(strict=True)
        doc = self.document()
        outside = self.root / 'checkout.mjs'
        outside.write_text("throw new Error('OUTSIDE_MODULE_MUST_NOT_EXECUTE');")
        path, digest = self.package(source=('import ' + json.dumps(outside.as_uri()) + ';').encode())
        doc['tarballs'][0] = {'path': str(path), 'sha256': digest}
        input_file = self.root / 'input.json'
        input_file.write_text(json.dumps(doc))
        target = self.root / 'attempt'
        completed = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('install.py')),
            '--input', str(input_file), '--out', str(target), '--node', str(node), '--npm', str(npm)],
            capture_output=True, timeout=40)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse((target / 'RESULT.json').exists())
        call_log = (target / 'CALL.log').read_text()
        self.assertIn('Dependency escaped installed consumer', call_log)
        self.assertNotIn('OUTSIDE_MODULE_MUST_NOT_EXECUTE', call_log)
        proof.verify_install(target / 'consumer', proof.validate_input(doc))


if __name__ == '__main__':
    unittest.main()
