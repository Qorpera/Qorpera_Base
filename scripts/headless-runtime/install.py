#!/usr/bin/env python3
"""Install only reviewed local tarballs, then call their public runtime exports.

Does not pack/build shared source or obtain credentials. Input pins must come
from the independently frozen build; this tool does not establish provenance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile

MAX_TOTAL = 200 * 1024 * 1024
MAX_FILES = 30000
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
NAME = re.compile(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+\Z")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect_tarball(path, expected_sha):
    if not HEX64.fullmatch(expected_sha) or path.is_symlink() or not path.is_file():
        raise ValueError("Invalid tarball identity")
    if path.stat().st_size > MAX_TOTAL or sha(path.read_bytes()) != expected_sha:
        raise ValueError("Tarball digest/size mismatch")
    files = {}
    total = 0
    with tarfile.open(path, "r:gz") as archive:
        for item in archive:
            p = PurePosixPath(item.name)
            if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] != 'package':
                raise ValueError("Unsafe tarball path")
            if item.isdir():
                continue
            if not item.isfile() or len(p.parts) < 2 or 'node_modules' in p.parts:
                raise ValueError("Unsafe tarball member")
            relative = str(PurePosixPath(*p.parts[1:]))
            if relative in files:
                raise ValueError("Duplicate tarball member")
            total += item.size
            if total > MAX_TOTAL or len(files) >= MAX_FILES:
                raise ValueError("Tarball expansion bound exceeded")
            data = archive.extractfile(item).read()
            files[relative] = sha(data)
            if relative == 'package.json':
                manifest = json.loads(data)
    if 'package.json' not in files:
        raise ValueError("Missing package manifest")
    if not NAME.fullmatch(manifest.get('name', '')):
        raise ValueError("Invalid package name")
    if not isinstance(manifest.get('version'), str):
        raise ValueError("Missing package version")
    return {'name': manifest['name'], 'version': manifest['version'], 'manifest': manifest,
            'files': files, 'expandedBytes': total, 'path': str(path), 'sha256': expected_sha}


def validate_input(document):
    if document.get('schema') != 'qorpera.external-runtime-input/v1':
        raise ValueError("Invalid input schema")
    if not re.fullmatch(r'[0-9a-f]{40}', document.get('sourceCommit', '')):
        raise ValueError("Missing exact source commit")
    for key in ('runtimeBundleSha256', 'modelPolicySha256', 'nativeBinarySha256'):
        if not HEX64.fullmatch(document.get(key, '')):
            raise ValueError("Missing exact runtime pins")
    entries = document.get('tarballs')
    if not isinstance(entries, list) or not 4 <= len(entries) <= 100:
        raise ValueError("Expected complete bounded tarball closure")
    packages = {}
    for entry in entries:
        path = Path(entry['path'])
        if not path.is_absolute():
            raise ValueError("Tarball paths must be absolute")
        package = inspect_tarball(path, entry['sha256'])
        if package['name'] in packages:
            raise ValueError("Duplicate package version/name")
        packages[package['name']] = package
    if not {'@qorpera/runtime', '@qorpera/contracts', '@qorpera/company', '@qorpera/cloud-client'} <= packages.keys():
        raise ValueError("Missing public runtime/client packages")
    if sum(p['expandedBytes'] for p in packages.values()) > MAX_TOTAL:
        raise ValueError("Closure expansion bound exceeded")
    for package in packages.values():
        for section in ('dependencies', 'optionalDependencies', 'peerDependencies'):
            for name, version in package['manifest'].get(section, {}).items():
                if (section == 'peerDependencies' and name not in packages and
                    package['manifest'].get('peerDependenciesMeta', {}).get(name, {}).get('optional') is True):
                    continue
                if name not in packages or not isinstance(version, str) or version.startswith(('file:', 'link:', 'workspace:', 'http:', 'https:', 'git')):
                    raise ValueError("Dependency closure missing or contains non-version reference")
    return packages


def verify_install(consumer, packages):
    modules = consumer / 'node_modules'
    for package in packages.values():
        folder = modules / package['name']
        if folder.is_symlink() or not folder.is_dir():
            raise ValueError("Package missing or symlinked")
        expected = package['files']
        actual = {}
        for path in folder.rglob('*'):
            if path.is_symlink():
                raise ValueError("Installed package contains a symlink")
            if path.is_file():
                actual[str(path.relative_to(folder))] = sha(path.read_bytes())
        if actual != expected:
            raise ValueError("Installed package differs from reviewed tarball: " + package['name'])
    lock = json.loads((consumer / 'package-lock.json').read_text())
    locked = lock.get('packages', {})
    if set(locked) != {''} | {'node_modules/' + name for name in packages}:
        raise ValueError("Unexpected nested or additional installed dependency")
    for name in packages:
        if locked['node_modules/' + name].get('link'):
            raise ValueError("Linked dependency refused")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--npm', required=True, type=Path)
    args = parser.parse_args()
    document = json.loads(args.input.read_text())
    packages = validate_input(document)
    target = args.out.absolute()
    if target.exists() or target.is_symlink() or not target.parent.is_dir():
        raise ValueError("Output must be a new directory under an existing parent")
    if shutil.disk_usage(target.parent).free < 600 * 1024 * 1024:
        raise ValueError("Insufficient bounded scratch space")
    node = args.node.resolve(strict=True)
    npm = args.npm.resolve(strict=True)
    target.mkdir(mode=0o700)
    consumer = target / 'consumer'
    consumer.mkdir(mode=0o700)
    (target / 'home').mkdir(mode=0o700)
    (target / 'tmp').mkdir(mode=0o700)
    (target / 'empty-user.npmrc').write_text('')
    (target / 'empty-global.npmrc').write_text('')
    environment = {'PATH': str(args.node.parent) + ':/usr/bin:/bin', 'HOME': str(target / 'home'),
                   'TMPDIR': str(target / 'tmp'), 'CI': 'true',
                   'npm_config_userconfig': str(target / 'empty-user.npmrc'),
                   'npm_config_globalconfig': str(target / 'empty-global.npmrc'),
                   'npm_config_update_notifier': 'false'}
    (target / 'INPUT.json').write_text(json.dumps(document, indent=2) + '\n')
    (consumer / 'package.json').write_text(json.dumps({'name': 'qorpera-external-runtime-proof',
        'version': '1.0.0', 'private': True, 'type': 'module',
        'dependencies': {name: 'file:' + p['path'] for name, p in packages.items()}}, indent=2) + '\n')
    shutil.copyfile(Path(__file__).with_name('consumer.mjs'), consumer / 'consumer.mjs')
    (consumer / 'EXPECTED.json').write_text(json.dumps(document) + '\n')
    # Offline guarantees no registry fallback. Lifecycle scripts stay disabled.
    command = [str(node), str(npm), 'install', '--offline', '--ignore-scripts', '--omit=dev',
               '--no-audit', '--no-fund', '--cache', str(target / 'cache')]
    with (target / 'INSTALL.log').open('xb') as log:
        subprocess.run(command, cwd=consumer, env=environment, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=120)
    verify_install(consumer, packages)
    with (target / 'CALL.log').open('xb') as log:
        subprocess.run([str(node), 'consumer.mjs'], cwd=consumer, env=environment,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
    verify_install(consumer, packages)
    result = {'schema': 'qorpera.external-runtime-proof/v1', 'passed': True,
              'sourceCommit': document['sourceCommit'], 'runtimeBundleSha256': document['runtimeBundleSha256'],
              'liveAcceptance': False, 'frozenSourceProvenanceIndependentlyRequired': True,
              'inputSha256': sha(args.input.read_bytes()),
              'nodeSha256': sha(node.read_bytes()), 'npmEntrySha256': sha(npm.read_bytes()),
              'callResultSha256': sha((consumer / 'CALL-RESULT.json').read_bytes()),
              'packages': {name: {key: p[key] for key in ('version', 'sha256', 'expandedBytes')} for name, p in packages.items()}}
    (target / 'RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'result': str(target / 'RESULT.json')}))


if __name__ == '__main__':
    main()
