import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPortFree, readWindowsOptions, requireNode24, selectedPort } from './windows-runtime.mjs';

const marker = '.baw-original-multi-windows-package';
export function validateWindowsPayload(source) {
  if (readFileSync(join(source, marker), 'utf8').trim() !== 'BAW-Original-Multi-Windows') throw new Error('不是有效的 BAW Windows 安装包');
  const manifest = JSON.parse(readFileSync(join(source, 'windows-payload.json'), 'utf8'));
  for (const required of [marker, 'Start-BAW.cmd', 'windows-launch.mjs', 'windows-runtime.mjs', 'windows-network.mjs', 'windows-options.json', 'baw-oneclick/serve.mjs', 'baw-oneclick/ca-input.mjs', 'baw-oneclick/wallet-runtime.mjs', 'baw-oneclick/node_modules/ethers/package.json']) {
    if (!manifest[required]) throw new Error('安装包缺少必要文件：' + required);
  }
  for (const [name, expected] of Object.entries(manifest)) {
    if (isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '..' || p === '.') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('安装文件清单格式错误');
    const file = join(source, ...name.split('/'));
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('安装包包含非普通文件：' + name);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) throw new Error('文件校验失败，请重新解压完整 ZIP：' + name);
  }
  return manifest;
}
export async function installWindows({ source, destination, env = process.env }) {
  source = resolve(source); destination = resolve(destination);
  const nested = relative(source, destination);
  if (source === destination || (nested && !nested.startsWith('..' + sep) && nested !== '..' && !isAbsolute(nested))) throw new Error('安装目录不能位于安装包内部');
  if (destination === dirname(destination) || destination === resolve(homedir())) throw new Error('请选择 BAW 专用目录');
  const manifest = validateWindowsPayload(source);
  const present = existsSync(destination);
  if (present) {
    if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory() || !existsSync(join(destination, marker)) || readFileSync(join(destination, marker), 'utf8').trim() !== 'BAW-Original-Multi-Windows') throw new Error('目标目录已有其他文件，未覆盖：' + destination);
    const oldOptions = readWindowsOptions(destination);
    for (const port of new Set([selectedPort(oldOptions, {}), selectedPort(oldOptions, env)])) await assertPortFree(port);
  }
  const parent = dirname(destination), stage = join(parent, '.baw-install-' + randomUUID());
  mkdirSync(parent, { recursive: true });
  let backup = null;
  try {
    mkdirSync(stage);
    // Copy only allowlisted static program files, never any runtime files in source.
    for (const name of [...Object.keys(manifest), 'windows-payload.json']) {
      const file = join(stage, ...name.split('/')); mkdirSync(dirname(file), { recursive: true });
      copyFileSync(join(source, ...name.split('/')), file);
    }
    validateWindowsPayload(stage);
    if (present) {
      copyFileSync(join(destination, 'windows-options.json'), join(stage, 'windows-options.json'));
      backup = join(parent, 'program-backup-' + randomUUID());
      renameSync(destination, backup);
    }
    try { renameSync(stage, destination); }
    catch (error) { if (backup) renameSync(backup, destination); throw error; }
    return { destination, backup };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.platform !== 'win32') throw new Error('此安装器用于 Windows；Mac 请使用 Mac 安装包。');
    requireNode24();
    let source = dirname(fileURLToPath(import.meta.url));
    let destination = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BAW-Original-Multi', 'program');
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--source', '--install-only'].includes(args[i]) || !args[i + 1] || !isAbsolute(args[i + 1])) throw new Error('参数需要 --source 或 --install-only，加绝对目录路径');
      if (args[i] === '--source') source = args[i + 1]; else destination = args[i + 1];
    }
    const result = await installWindows({ source, destination });
    console.log('安装完成：' + result.destination);
    console.log('请打开该目录，双击 Start-BAW.cmd。安装器没有启动服务或访问钱包。');
    if (result.backup) console.log('旧程序已备份：' + result.backup);
  } catch (error) { console.error('安装未完成：' + error.message); process.exitCode = 1; }
}
