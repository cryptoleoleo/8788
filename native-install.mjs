import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_NAME = 'com.baw.original_multi';
export function extensionId(root) {
  const { key } = JSON.parse(readFileSync(join(root, 'chrome-extension', 'manifest.json'), 'utf8'));
  if (!key) throw new Error('扩展缺少固定公钥，无法注册启动组件');
  return createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}
export function installNative(root, { platform = process.platform, home = homedir(), register = true } = {}) {
  root = resolve(root);
  if (!['darwin', 'win32'].includes(platform)) throw new Error('按需启动仅支持 Mac 和 Windows');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');
  const id = extensionId(root);
  const script = join(root, 'native-host.mjs');
  const wrapper = join(root, platform === 'win32' ? 'native-host.cmd' : 'native-host.command');
  // The Node path is recorded at installation; Chrome does not inherit an interactive shell's PATH.
  const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
  const cmdQuote = s => '"' + s.replace(/%/g, '%%') + '"';
  const launcher = platform === 'win32'
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' + cmdQuote(process.execPath) + ' ' + cmdQuote(script) + ' %*\r\n'
    : '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n';
  writeFileSync(wrapper, launcher, { mode: 0o700 });
  const manifest = { name: HOST_NAME, description: 'Start the installed BAW service on demand', path: wrapper, type: 'stdio', allowed_origins: ['chrome-extension://' + id + '/'] };
  const manifestFile = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', HOST_NAME + '.json')
    : join(root, HOST_NAME + '.json');
  mkdirSync(dirname(manifestFile), { recursive: true, mode: 0o700 });
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  if (platform === 'win32' && register) {
    execFileSync('reg.exe', ['ADD', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f', '/reg:32'], { windowsHide: true, stdio: 'pipe', timeout: 10000 });
  }
  return { id, manifestFile, wrapper, extensionDirectory: join(root, 'chrome-extension') };
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const result = installNative(dirname(fileURLToPath(import.meta.url)));
    console.log('按需启动已注册。Chrome 加载扩展目录：' + result.extensionDirectory);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
