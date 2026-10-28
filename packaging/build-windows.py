#!/usr/bin/env python3
"""Package static, allowlisted source plus original dependencies. Never copy installed identities."""
import hashlib, json, shutil, tempfile, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
name = 'BAW-Original-Multiwallet-Windows-1.0.0-rc5'
output = Path.home() / 'Downloads' / (name + '.zip')
if output.exists(): raise RuntimeError('Refusing to overwrite an existing release: ' + str(output))
baseline = json.loads((root / 'original-sha256.json').read_text())
shared = ['ca-input.mjs', 'copy-feed.mjs', 'multi-service.mjs', 'multi-store.mjs', 'profile-bootstrap.mjs', 'profile-keytar.mjs', 'wallet-features.css', 'wallet-features.js', 'wallet-runtime.mjs']
windows = ['Start-BAW.cmd', 'windows-launch.mjs', 'windows-runtime.mjs', 'windows-network.mjs', 'windows-install.mjs', 'windows-options.json']
with tempfile.TemporaryDirectory(prefix='baw-windows-package-') as temporary:
    bundle = Path(temporary) / name
    program = bundle / 'program'
    extension_files = ['manifest.json', 'service-worker.js', 'token-url.js', 'gmgn-content.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'README.md', 'LICENSE']
    paths = list(baseline) + ['baw-oneclick/' + f for f in shared] + windows + ['native-host.mjs', 'native-install.mjs'] + ['chrome-extension/' + f for f in extension_files]
    manifest = {}
    for relative in paths:
        source = root / relative
        assert source.is_file() and not source.is_symlink(), relative
        target = program / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[relative] = hashlib.sha256(target.read_bytes()).hexdigest()
    unchanged = [p for p, h in baseline.items() if manifest[p] == h]
    assert len(unchanged) == 1881
    marker = '.baw-original-multi-windows-package'
    (program / marker).write_text('BAW-Original-Multi-Windows\n')
    manifest[marker] = hashlib.sha256((program / marker).read_bytes()).hexdigest()
    (program / 'windows-payload.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copy2(root / 'Install-Windows.cmd', bundle / 'Install-Windows.cmd')
    shutil.copy2(root / 'packaging/Windows-先读我.txt', bundle / 'Windows-先读我.txt')
    for f in [bundle / 'Install-Windows.cmd', program / 'Start-BAW.cmd']:
        assert b'\r\n' in f.read_bytes() and b'\n' not in f.read_bytes().replace(b'\r\n', b'')
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(bundle.rglob('*')):
            if f.is_file(): z.write(f, str(Path(name) / f.relative_to(bundle)))
with zipfile.ZipFile(output) as z:
    assert z.testzip() is None
    for p, h in manifest.items(): assert hashlib.sha256(z.read(name + '/program/' + p)).hexdigest() == h
    assert not any(any(part.lower() in {'.env', 'session.json', 'settings.json', 'copy-seen.json', 'identities', '.ds_store'} for part in Path(n).parts) for n in z.namelist())
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
print(json.dumps({'zip': str(output), 'sha256': checksum, 'bytes': output.stat().st_size, 'unchangedOriginalFiles': len(unchanged), 'payloadFiles': len(manifest) + 1}))
