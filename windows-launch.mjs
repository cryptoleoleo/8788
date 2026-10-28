import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortFree, readWindowsOptions, requireNode24, resolveWindowsCli, selectedPort } from './windows-runtime.mjs';
import { windowsNetworkEnvironment } from './windows-network.mjs';

try {
  if (process.platform !== 'win32') throw new Error('此入口用于 Windows；Mac 请使用“启动原版服务.command”。');
  requireNode24();
  const root = dirname(fileURLToPath(import.meta.url));
  process.chdir(root);
  const options = readWindowsOptions(root);
  const port = selectedPort(options);
  await assertPortFree(port);
  const env = windowsNetworkEnvironment();
  env.BAW_CLI = resolveWindowsCli(env, options);
  env.BAW_NODE = process.execPath;
  env.PORT = String(port);
  if (process.argv.includes('--check')) {
    console.log(`启动检查通过：Node ${process.versions.node}，CLI 1.11.0，端口 ${port} 可用。未访问钱包或启动服务。`);
  } else {
    console.log(`启动 BAW 原程序 Windows 多钱包版：http://127.0.0.1:${port}`);
    console.log('保留此窗口，Ctrl+C 停止。原 Chrome 扩展另行提供，本包没有替代扩展外壳。');
    if (env.NODE_USE_ENV_PROXY === '1') console.log('网络：沿用 HTTP/HTTPS 代理，本机连接直连。');
    const child = spawn(process.execPath, ['serve.mjs'], { cwd: join(root, 'baw-oneclick'), env, stdio: 'inherit', windowsHide: process.env.BAW_BACKGROUND === '1' });
    let ended = false;
    child.on('error', error => { ended = true; console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { ended = true; process.exitCode = code || 0; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!ended) child.kill('SIGTERM'); });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
