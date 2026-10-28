#!/usr/bin/env python3
"""Package the existing collaborator extension from a static file allowlist."""
import hashlib
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / 'chrome-extension'
version = json.loads((source / 'manifest.json').read_text())['version']
name = '8788-GMGN-Debot-SidePanel-' + version
output = root / 'releases' / (name + '.zip')
files = ['manifest.json', 'service-worker.js', 'token-url.js', 'gmgn-content.js',
         'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'README.md', 'LICENSE',
         'Open-BAW-Chrome-Extension.cmd']
if output.exists():
    raise RuntimeError('Refusing to overwrite an existing release: ' + str(output))
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for relative in files:
        path = source / relative
        assert path.is_file() and not path.is_symlink(), relative
        archive.write(path, name + '/' + relative)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    for relative in files:
        assert archive.read(name + '/' + relative) == (source / relative).read_bytes()
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum + '  ' + output.name + '\n')
print(json.dumps({'zip': str(output), 'sha256': checksum, 'files': len(files)}))
