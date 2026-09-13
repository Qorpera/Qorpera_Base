import hashlib, json, pathlib, platform, subprocess

root = pathlib.Path.cwd()
fixture = root / 'scripts/linux-delete-metadata-proof'
candidate = '1a903000b3826059c611cd9c9628172c45ce3cd0'
results = []
for name in ['probe', 'full']:
    manifest = json.loads((fixture / (name + '-source-manifest.json')).read_text())
    assert manifest['sourceCommit'] == candidate
    assert hashlib.sha256((root / manifest['outfile']).read_bytes()).hexdigest() == manifest['sha256']
    for item in manifest['inputs']:
        path = root / item['path']
        assert path.is_relative_to(root) and path.is_file(), item['path']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], item['path']
        if item['kind'] == 'candidate-source':
            original = subprocess.check_output(['git', 'show', candidate + ':' + item['path']])
            assert hashlib.sha256(original).hexdigest() == item['sha256'], item['path']
    results.append({'bundle': name, 'sourceInputs': len(manifest['inputs']), 'sha256': manifest['sha256'], 'passed': True})
print(json.dumps({'candidateCommit': candidate, 'validationCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'kernel': platform.release(), 'node': subprocess.check_output(['node', '--version'], text=True).strip(), 'results': results}, indent=2))
