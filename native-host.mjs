import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { extensionId } from './native-install.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Local HTTP only, no proxy, wallet CLI invocation, authentication or session reads.
export function ready(port = 8787) {
  return new Promise(resolve => {
    const req = get({ hostname: '127.0.0.1', port, path: '/api/launcher-status', timeout: 700 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try { const data = JSON.parse(body); resolve(res.statusCode === 200 && data.app === 'baw-original-multi' && data.launcherProtocol === 1); }
        catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', () => reject(new Error('8787 端口已被占用，未停止任何程序。若为旧版 BAW，请先在旧启动窗口退出，再打开插件。')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export async function ensureStarted({ root, port = 8787 }) {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('仅支持 Mac 和 Windows');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请安装 Node.js 24，并重新运行安装器');
  if (await ready(port)) return { ok: true, status: 'running' };
  const options = JSON.parse(readFileSync(join(root, process.platform === 'win32' ? 'windows-options.json' : 'mac-options.json'), 'utf8'));
  if (options.port != null && options.port !== port) throw new Error('现有服务配置不是 8787，未修改配置。此扩展使用 8787，请先核对地址配置。');
  const lock = join(root, '.native-start.lock');
  let owned = false;
  try {
    for (let i = 0; i < 80; i++) {
      try { const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); owned = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await ready(port)) return { ok: true, status: 'running' };
        try {
          const pid = Number(readFileSync(lock, 'utf8'));
          if (statSync(lock).mtimeMs < Date.now() - 30000 && Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') unlinkSync(lock); }
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await pause(200);
      }
    }
    if (!owned) throw new Error('另一个窗口正在启动 BAW，请稍后重试');
    if (await ready(port)) return { ok: true, status: 'running' };
    await freePort(port);
    const env = { ...process.env, PORT: String(port), BAW_NODE: process.execPath, BAW_BACKGROUND: '1', PATH: dirname(process.execPath) + delimiter + (process.env.PATH || '') };
    const child = spawn(process.execPath, [join(root, process.platform === 'win32' ? 'windows-launch.mjs' : 'mac-launch.mjs')], {
      cwd: root, env, detached: true, windowsHide: true, stdio: 'ignore',
    });
    let failed = false;
    child.on('error', () => { failed = true; }); child.on('exit', () => { failed = true; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (await ready(port)) return { ok: true, status: 'started', pid: child.pid };
      if (failed) throw new Error('后台启动失败：请检查 Node.js 24 和 Binance Agentic Wallet CLI 1.11.0 是否已安装；更新 Node 路径后需重新运行安装器。');
      await pause(200);
    }
    throw new Error('BAW 启动超时，请稍后点击重试；未重复启动或停止其他进程');
  } finally { if (owned) unlinkSync(lock); }
}
function readMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('启动请求超时')), 5000);
    const finish = (error, value) => {
      clearTimeout(timer); process.stdin.removeAllListeners(); process.stdin.pause();
      if (error) reject(error); else resolve(value);
    };
    process.stdin.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE();
      if (!size || size > 4096 || buffer.length > size + 4) return finish(new Error('无效启动请求'));
      if (buffer.length === size + 4) {
        try { finish(null, JSON.parse(buffer.subarray(4).toString('utf8'))); }
        catch { finish(new Error('无效启动请求')); }
      }
    });
    process.stdin.on('end', () => finish(new Error('启动请求不完整')));
    process.stdin.on('error', () => finish(new Error('无法读取启动请求')));
  });
}
function reply(value) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
const root = dirname(fileURLToPath(import.meta.url));
try {
  if (process.argv[2] !== 'chrome-extension://' + extensionId(root) + '/') throw new Error('不允许此扩展调用启动组件');
  const message = await readMessage();
  if (!message || message.action !== 'ensureStarted' || Object.keys(message).length !== 1) throw new Error('启动组件仅接受启动 BAW 请求');
  reply(await ensureStarted({ root }));
} catch (error) { reply({ ok: false, error: error.message }); }

}
