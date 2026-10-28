#!/usr/bin/env python3
"""Check the native installer in throwaway directories; do not start a real wallet."""
import hashlib, json, os, shutil, socket, subprocess, tempfile, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
metadata = json.loads((root / 'verification/package-stage.json').read_text())
bundle, app, program = (Path(metadata[x]) for x in ['bundle', 'app', 'program'])
binary = app / 'Contents/MacOS/BAWInstaller'
expected = json.loads((bundle / '开发与验证/program-sha256.json').read_text())
def hashes(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.rglob('*') if p.is_file()}
def install(destination):
    return subprocess.run([str(binary), '--install-only', str(destination)], capture_output=True, text=True)
with tempfile.TemporaryDirectory(prefix='BAW Multi installer QA ') as temporary:
    base = Path(temporary)
    destination = base / 'Applications with spaces/BAW-Original-Multi'
    result = install(destination)
    assert result.returncode == 0, result.stderr
    assert hashes(destination) == expected, 'Copied file contents differ'
    assert os.access(destination / '启动原版服务.command', os.X_OK)
    unrelated = base / 'unrelated-existing'
    unrelated.mkdir(); (unrelated / 'keep.txt').write_text('preserve')
    result = install(unrelated)
    assert result.returncode != 0 and (unrelated / 'keep.txt').read_text() == 'preserve'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen()
        port = listener.getsockname()[1]
        (destination / 'mac-options.json').write_text(json.dumps({'port': port}))
        before = hashes(destination)
        assert install(destination).returncode != 0
        assert hashes(destination) == before, 'Busy installation was changed'
        result = subprocess.run([os.environ.get('BAW_QA_NODE', '/Users/rich/.nvm/versions/node/v24.13.0/bin/node'), str(destination / 'mac-launch.mjs')], env={**os.environ, 'PORT': str(port), 'BAW_CLI': '/nonexistent/NO_WALLET_CLI'}, capture_output=True, text=True)
        assert result.returncode != 0 and '未终止任何其他进程' in result.stderr, result.stderr
    result = install(destination)
    assert result.returncode == 0, result.stderr
    assert hashes(destination) == expected
    backups = list(destination.parent.glob('BAW-Original-Multi-backup-*'))
    assert len(backups) == 1 and hashes(backups[0]) == before

result = {'passed': True, 'programFiles': len(expected), 'checks': [
    'native install into path with spaces; exact file hash match',
    'refuses unrelated existing directory', 'busy-port install leaves old files unchanged',
    'busy-port launch exits before wallet CLI access', 'upgrade backs up old installation',
    'universal arm64/x86_64 compiled; executed on arm64 only',
], 'walletAccess': 'No real CLI, wallet data, browser profile, or chain access'}
(root / 'verification/package-results.json').write_text(json.dumps(result, indent=2))
shutil.copy2(root / 'verification/package-results.json', bundle / '开发与验证/verification/package-results.json')
shutil.copy2(Path(__file__), bundle / '开发与验证/verify-package.py')
output = Path.home() / 'Downloads' / (bundle.name + '.zip')
if output.exists(): raise RuntimeError('Refusing to overwrite an existing release: ' + str(output))
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for p in sorted(bundle.rglob('*')):
        if p.is_file():
            assert not p.is_symlink()
            archive.write(p, str(Path(bundle.name) / p.relative_to(bundle)))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    prefix = bundle.name + '/' + app.name + '/Contents/Resources/program/'
    actual = {n[len(prefix):]: hashlib.sha256(archive.read(n)).hexdigest() for n in archive.namelist() if n.startswith(prefix)}
    assert actual == expected, 'ZIP program differs from tested installer payload'
    forbidden = {'.DS_Store', 'session.json', 'cookies', '.env', 'settings.json', 'copy-seen.json'}
    assert not any(any(part.lower() in forbidden for part in Path(n).parts) for n in archive.namelist()), 'Unexpected runtime/personal data filename'
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
print(json.dumps({'zip': str(output), 'bytes': output.stat().st_size, 'sha256': checksum, **result}, ensure_ascii=False))
