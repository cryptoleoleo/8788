#!/usr/bin/env python3
"""Build only from the supplied static source allowlist, never installed wallet data."""
import hashlib, json, plistlib, shutil, subprocess, tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
stage = Path(tempfile.mkdtemp(prefix='baw-multi-dist-'))
bundle = stage / 'BAW-Original-Multiwallet-Mac-1.0.0-rc5'
app = bundle / '安装 BAW 多钱包增强版.app'
contents = app / 'Contents'
program = contents / 'Resources/program'
macos = contents / 'MacOS'
macos.mkdir(parents=True)
baseline = json.loads((root / 'original-sha256.json').read_text())
additions = ['ca-input.mjs', 'copy-feed.mjs', 'multi-service.mjs', 'multi-store.mjs', 'profile-bootstrap.mjs',
             'profile-keytar.mjs', 'wallet-features.css', 'wallet-features.js', 'wallet-runtime.mjs']
outer = ['mac-launch.mjs', 'mac-network.mjs', 'runtime.zsh', 'mac-options.json', '启动原版服务.command']
extension_files = ['manifest.json', 'service-worker.js', 'token-url.js', 'gmgn-content.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'README.md', 'LICENSE']
paths = list(baseline) + ['baw-oneclick/' + name for name in additions] + outer + ['native-host.mjs', 'native-install.mjs'] + ['chrome-extension/' + f for f in extension_files]
for relative in paths:
    source = root / relative
    assert source.is_file() and not source.is_symlink(), relative
    target = program / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
(program / '.baw-original-multi-package').write_text('BAW Original Multi 1.0.0-rc5\n')
(program / '启动原版服务.command').chmod(0o755)
for name in ['先读我.txt', '改动与验收.txt']:
    shutil.copy2(root / 'packaging' / name, bundle / name)
dev = bundle / '开发与验证'
dev.mkdir()
shutil.copytree(root / 'tests', dev / 'tests', ignore=shutil.ignore_patterns('__pycache__', 'windows*.mjs', 'native-launch.test.mjs', 'extension-url.test.mjs'))
shutil.copy2(root / 'original-sha256.json', dev / 'original-sha256.json')
shutil.copy2(root / 'packaging/Installer.swift', dev / 'Installer.swift')
shutil.copy2(root / 'packaging/build.py', dev / 'build.py')
shutil.copytree(root / 'verification', dev / 'verification', ignore=shutil.ignore_patterns('package-stage.json', 'package-results.json'))
diff = subprocess.check_output(['git', 'diff', 'd5309e2', '--', 'baw-oneclick/index.html', 'baw-oneclick/serve.mjs', 'baw-oneclick/gang-buy.mjs', 'runtime.zsh', 'mac-launch.mjs', '启动原版服务.command'], cwd=root)
(dev / 'original-integration.diff').write_bytes(diff)
for arch in ['arm64', 'x86_64']:
    subprocess.run(['/usr/bin/swiftc', '-parse-as-library', '-target', arch + '-apple-macos13.5', str(root / 'packaging/Installer.swift'), '-framework', 'AppKit', '-o', str(stage / arch)], check=True)
subprocess.run(['/usr/bin/lipo', '-create', str(stage / 'arm64'), str(stage / 'x86_64'), '-output', str(macos / 'BAWInstaller')], check=True)
(contents / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': 'local.baw.originalmulti.installer', 'CFBundleName': '安装 BAW 多钱包增强版',
    'CFBundleExecutable': 'BAWInstaller', 'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '1.0.0', 'CFBundleVersion': '5',
    'LSMinimumSystemVersion': '13.5', 'NSHighResolutionCapable': True,
}))
subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
manifest = {str(p.relative_to(program)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(program.rglob('*')) if p.is_file()}
(dev / 'program-sha256.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
result = {'stage': str(stage), 'bundle': str(bundle), 'app': str(app), 'program': str(program), 'programFiles': len(manifest)}
(root / 'verification/package-stage.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, ensure_ascii=False))
