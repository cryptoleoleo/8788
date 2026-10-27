import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

export function requireNode24(version = process.versions.node) {
  if (Number(version.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本，请先安装 Node.js 24 LTS。');
}
export function readWindowsOptions(root) {
  const file = path.join(root, 'windows-options.json');
  const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('windows-options.json 格式错误');
  if (value.cliPath != null && (typeof value.cliPath !== 'string' || !path.isAbsolute(value.cliPath))) throw new Error('cliPath 需要 CLI JavaScript 入口的绝对路径，或 null');
  return value;
}
export function selectedPort(options = {}, env = process.env) {
  const port = Number(env.PORT || options.port || 8787);
  if ((options.port != null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1 至 65535 的整数');
  return port;
}
export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`端口 ${port} 已被占用或不可用。请先辨认原服务并在其窗口按 Ctrl+C 停止；不会自动结束其他进程或更换端口。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
export function globalCliCandidates(env, node, p = path) {
  const pathValue = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] || '';
  const prefixes = [env.NPM_CONFIG_PREFIX, env.APPDATA && p.join(env.APPDATA, 'npm'), p.dirname(node), ...pathValue.split(p.delimiter)];
  return [...new Set(prefixes.filter(Boolean).map(prefix => p.join(prefix, 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js')))];
}
export function validateCli(file) {
  if (!path.isAbsolute(file) || !/\.[cm]?js$/i.test(file)) throw new Error('BAW_CLI / cliPath 必须指向 CLI 的绝对 JavaScript 路径，不能填 baw.cmd');
  accessSync(file, constants.R_OK);
  const actual = realpathSync(file);
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(actual), '..', 'package.json'), 'utf8'));
  if (pkg.name !== '@binance/agentic-wallet' || pkg.version !== '1.11.0') throw new Error('此版独立身份适配需要 @binance/agentic-wallet 1.11.0');
  return actual;
}
export function resolveWindowsCli(env, options = {}, node = process.execPath) {
  const explicit = env.BAW_CLI || options.cliPath;
  if (explicit) return validateCli(explicit);
  for (const candidate of globalCliCandidates(env, node)) if (existsSync(candidate)) return validateCli(candidate);
  // Execute npm's JS entry with Node, avoiding the Windows .cmd shell boundary.
  const npm = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npm)) {
    let root;
    try { root = execFileSync(node, [npm, 'root', '-g'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch {}
    if (root && path.isAbsolute(root)) {
      const candidate = path.join(root, '@binance', 'agentic-wallet', 'dist', 'index.js');
      if (existsSync(candidate)) return validateCli(candidate);
    }
  }
  throw new Error('未找到钱包 CLI。请在 Windows 终端运行 npm install -g @binance/agentic-wallet@1.11.0，再重新启动。');
}
