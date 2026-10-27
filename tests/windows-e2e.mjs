// Run on a real Windows CI runner. Only this test's fake CLI and child processes are used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
if (process.platform !== 'win32') throw new Error('This verification requires a real Windows runner.');
const packageRoot = resolve(process.argv[2]);
const work = mkdtempSync(join(tmpdir(), 'BAW Windows 测试 & spaces '));
const destination = join(work, 'installed program');
const cli = join(work, 'fake CLI', 'dist', 'index.js');
mkdirSync(dirname(cli), { recursive: true });
writeFileSync(join(cli, '../../package.json'), JSON.stringify({ name: '@binance/agentic-wallet', version: '1.11.0', type: 'module' }));
writeFileSync(cli, `import {createHash} from 'node:crypto';
const a=process.argv.slice(2),address='0x'+createHash('sha256').update(process.env.BAW_ISOLATED_ID||'original').digest('hex').slice(0,40);
if(a[0]==='--version')console.log('FAKE-WINDOWS-CLI');
else if(a[0]==='wallet'&&a[1]==='address')console.log(JSON.stringify({success:true,data:{addresses:[{binanceChainId:56,address}]}}));
else if(a[0]==='wallet'&&a[1]==='status')console.log(JSON.stringify({success:true,data:{status:'CONNECTED'}}));
else{console.log(JSON.stringify({success:false,error:{message:'TEST_FORBIDS_ALL_TRADING'}}));process.exitCode=1;}`);
const env = { ...process.env, BAW_NODE: process.execPath, BAW_NONINTERACTIVE: '1', BAW_SYSTEM_PROXY: '0', BAW_CLI: cli, BAW_DATA_DIR: join(work, 'fake data'), BRIDGE_TOKEN: 'windows-test-only' };
const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
const command = (file, args = []) => ['/d', '/s', '/c', `""${file}" ${args.map(a => '"' + a + '"').join(' ')}"`];
let service;
try {
  const installed = execFileSync(cmd, command(join(packageRoot, 'Install-Windows.cmd'), ['--install-only', destination]), { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 60000 });
  assert.match(installed, /安装完成/);
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  writeFileSync(join(destination, 'windows-options.json'), JSON.stringify({ port, cliPath: null }));
  const checked = execFileSync(cmd, command(join(destination, 'Start-BAW.cmd'), ['--check']), { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000 });
  assert.match(checked, /CLI 1\.11\.0/);
  // Also exercise node.exe discovery through PATH, instead of explicit BAW_NODE.
  const discoveryEnv = { ...env }; delete discoveryEnv.BAW_NODE;
  assert.match(execFileSync(cmd, command(join(destination, 'Start-BAW.cmd'), ['--check']), { env: discoveryEnv, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000 }), /CLI 1\.11\.0/);
  service = spawn(cmd, command(join(destination, 'Start-BAW.cmd')), { env, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; service.stdout.on('data', b => output += b); service.stderr.on('data', b => output += b);
  const url = 'http://127.0.0.1:' + port;
  let html;
  for (let i = 0; i < 100; i++) {try { html = await (await fetch(url)).text(); if (html.includes('installWalletFeatures')) break; } catch {} await new Promise(r => setTimeout(r, 100));}
  assert.match(html || output, /installWalletFeatures/);
  assert.equal((await fetch(url + '/ca-input.mjs')).status, 200);
  const api = async (path, body, headers = {}) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'x-bridge-token': 'windows-test-only', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  const original = await api('/api/multi/wallets/check', { id: 'original' });
  const { wallet } = await api('/api/multi/wallets/create', { name: 'Windows test identity', groupId: 'g_default' });
  const independent = await api('/api/multi/wallets/check', { id: wallet.id });
  assert.notEqual(original.address, independent.address);
  const scoped = await api('/api/health', null, { 'x-baw-wallet': wallet.id });
  assert.equal(scoped.wallet, independent.address);
  assert.equal((await api('/api/multi/state')).copy.running.length, 0);
  console.log('PASS real Windows: CMD install/start/check, Chinese/spaced paths, PATH Node lookup, HTTP service, isolated CLI file-URL loader and fake BSC identities. No real wallet or transaction.');
} finally {
  if (service?.pid) {
    try { execFileSync('taskkill.exe', ['/pid', String(service.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
