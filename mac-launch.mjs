import { spawn, execFileSync } from 'node:child_process';
import { realpathSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macNetworkEnvironment } from './mac-network.mjs';

// Only configure the original application's existing environment hooks.
// No application file is patched, no port is forced, and no browser UI is added.
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
  throw new Error('未找到 baw 钱包 CLI。请先执行 npm install -g @binance/agentic-wallet，再用 baw auth signin 登录自己的钱包。');
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
console.log('启动原版服务。保留此窗口，按 Control+C 停止。');
console.log('请继续使用原来的侧边栏入口；连接端口以原服务下方输出为准。');
if (env.NODE_USE_ENV_PROXY === '1') console.log('网络：沿用已配置的 HTTP/HTTPS 代理，本机连接保持直连。');
const child = spawn(process.execPath, ['serve.mjs'], { cwd, env, stdio:'inherit' });
let ended = false;
child.on('error', error => { ended = true; console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { ended = true; if (code) process.exitCode = code; });
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) {
  process.on(signal, () => { if (!ended) child.kill('SIGTERM'); });
}
