import { spawn, execFileSync } from 'node:child_process';
import { realpathSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macNetworkEnvironment } from './mac-network.mjs';
import { createServer } from 'node:net';

// Configure original environment hooks; keep the original default port and UI entry.
function resolveBawEntry(env) {
  if (env.BAW_CLI) {
    if (!isAbsolute(env.BAW_CLI)) throw new Error('BAW_CLI 请使用钱包 CLI JavaScript 入口的绝对路径。');
    accessSync(env.BAW_CLI, constants.R_OK);
    return env.BAW_CLI;
  }
  const candidates = [];
  try {
    const command = execFileSync('/usr/bin/which', ['baw'], { env, encoding:'utf8', timeout:3000 }).trim();
    const actual = realpathSync(command);
    const head = readFileSync(actual).subarray(0, 160).toString('utf8');
    if (/\.[cm]?js$/.test(actual) || /^#![^\n]*\bnode\b/.test(head)) return actual;
  } catch {}
  try {
    const root = execFileSync('npm', ['root', '-g'], { env, encoding:'utf8', timeout:10000 }).trim();
    candidates.push(join(root, '@binance', 'agentic-wallet', 'dist', 'index.js'));
  } catch {}
  for (const file of candidates) {
    try { accessSync(file, constants.R_OK); return file; } catch {}
  }
  throw new Error('未找到 baw 钱包 CLI。请先执行 npm install -g @binance/agentic-wallet@1.11.0，再重新启动。新增身份在钱包页逐个配对。');
}
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 必须为 1 至 65535 的整数'); process.exit(1); }
try {
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
} catch {
  console.error(`端口 ${port} 已被占用或无法使用。请先辨认原服务，并在它自己的终端窗口按 Control+C 停止。未终止任何其他进程，也未自动更换端口。`);
  process.exit(1);
}
let env;
try {
  env = macNetworkEnvironment();
  env.BAW_CLI = resolveBawEntry(env);
  env.BAW_NODE = env.BAW_NODE || process.execPath;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const cwd = fileURLToPath(new URL('./baw-oneclick/', import.meta.url));
console.log('启动 BAW 原程序多钱包增强版。保留此窗口，按 Control+C 停止。');
console.log('本包没有原 Chrome 扩展；已有原扩展可继续使用其原入口。地址以服务下方输出为准。');
if (env.NODE_USE_ENV_PROXY === '1') console.log('网络：沿用已配置的 HTTP/HTTPS 代理，本机连接保持直连。');
const child = spawn(process.execPath, ['serve.mjs'], { cwd, env, stdio:'inherit' });
let ended = false;
child.on('error', error => { ended = true; console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { ended = true; if (code) process.exitCode = code; });
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) {
  process.on(signal, () => { if (!ended) child.kill('SIGTERM'); });
}
