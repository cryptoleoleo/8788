// Real Windows native host wrapper and detached service; all wallet access is forbidden.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { installWindows } from '../windows-install.mjs';
import { installNative } from '../native-install.mjs';
if (process.platform !== 'win32') throw new Error('Windows runner required');
const root = mkdtempSync(join(tmpdir(), 'BAW Native 中文 & spaces '));
let pid;
try {
  const destination = join(root, 'program');
  await installWindows({ source: join(resolve(process.argv[2]), 'program'), destination });
  const cli = join(root, 'fake cli', 'dist', 'index.js'); mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(join(cli, '../../package.json'), JSON.stringify({ name: '@binance/agentic-wallet', version: '1.11.0', type: 'module' }));
  writeFileSync(cli, `throw Error('NATIVE_START_MUST_NOT_ACCESS_WALLET');`);
  const registered = installNative(destination);
  const registry = execFileSync('reg.exe', ['QUERY', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.baw.original_multi', '/ve', '/reg:32'], { encoding: 'utf8' });
  assert.ok(registry.includes('com.baw.original_multi.json'));
  const invoke = () => new Promise((resolveResult, reject) => {
    const child = spawn(process.env.ComSpec, ['/d','/s','/c', `""${registered.wrapper}" "chrome-extension://${registered.id}/""`], {
      windowsVerbatimArguments: true, windowsHide: true,
      env: { ...process.env, BAW_CLI: cli, BAW_DATA_DIR: join(root,'fake data'), BAW_SYSTEM_PROXY: '0' }, stdio: ['pipe','pipe','pipe'],
    });
    const timer = setTimeout(() => reject(Error('Native request timeout')), 40000);
    const chunks = []; let errors = ''; child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => errors += b);
    const body = Buffer.from(JSON.stringify({ action: 'ensureStarted' })), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([header,body]));
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); try { const output=Buffer.concat(chunks); assert.equal(output.readUInt32LE(),output.length-4,errors); resolveResult(JSON.parse(output.subarray(4))); } catch(e) { reject(e); } });
  });
  const started = await invoke(); assert.equal(started.ok,true,JSON.stringify(started)); assert.equal(started.status,'started'); pid=started.pid;
  await new Promise(r => setTimeout(r,500));
  assert.equal((await (await fetch('http://127.0.0.1:8787/api/launcher-status')).json()).launcherProtocol,1);
  assert.equal((await invoke()).status,'running');
  console.log('PASS Windows native host: per-user registration, binary stdio, hidden CMD wrapper, detached service survives host exit, second request reuses service. Fake CLI forbids wallet access.');
} finally {
  if(pid) execFileSync('taskkill.exe',['/pid',String(pid),'/t','/f'],{stdio:'ignore'});
  execFileSync('reg.exe',['DELETE','HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.baw.original_multi','/f','/reg:32'],{stdio:'ignore'});
  await new Promise(r=>setTimeout(r,300));
  rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
