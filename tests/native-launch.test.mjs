import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { installNative, extensionId } from '../native-install.mjs';
import { ensureStarted, ready } from '../native-host.mjs';
const fixture = () => mkdtempSync(join(tmpdir(), 'BAW Native 中文 & spaces '));
const source = new URL('../', import.meta.url);
function addExtension(root) {
  mkdirSync(join(root, 'chrome-extension'));
  copyFileSync(new URL('chrome-extension/manifest.json', source), join(root, 'chrome-extension/manifest.json'));
}
async function killOwned(pid) {
  if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGTERM');
}
test('native registration pins only the distributed extension and quotes spaced paths', () => {
  const dir = fixture();
  try {
    addExtension(dir);
    const mac = installNative(dir, { platform: 'darwin', home: join(dir, 'fake home') });
    const manifest = JSON.parse(readFileSync(mac.manifestFile));
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + extensionId(dir) + '/']);
    assert.match(readFileSync(mac.wrapper, 'utf8'), /exec '/);
    const win = installNative(dir, { platform: 'win32', register: false });
    assert.match(readFileSync(win.wrapper, 'utf8'), /DisableDelayedExpansion/);
    assert.match(readFileSync(win.wrapper, 'utf8'), /chcp 65001 >nul/);
    assert.ok(readFileSync(win.wrapper, 'utf8').includes(process.execPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('concurrent native requests start one detached background service and then reuse it', async () => {
  const dir = fixture(); let pid;
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  try {
    for (const platform of ['mac', 'windows']) {
      writeFileSync(join(dir, platform + '-options.json'), JSON.stringify({ port }));
      writeFileSync(join(dir, platform + '-launch.mjs'), `import{createServer}from'node:http';import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(join(dir,'starts'))},'start\\n');createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({app:'baw-original-multi',launcherProtocol:1}));}).listen(process.env.PORT,'127.0.0.1');`);
    }
    const results = await Promise.all([ensureStarted({ root: dir, port }), ensureStarted({ root: dir, port })]);
    pid = results.find(r => r.status === 'started').pid;
    assert.equal(results.filter(r => r.status === 'started').length, 1);
    assert.equal(readFileSync(join(dir, 'starts'), 'utf8'), 'start\n');
    assert.equal(await ready(port), true);
    assert.equal((await ensureStarted({ root: dir, port })).status, 'running');
  } finally { if (pid) await killOwned(pid); await new Promise(r => setTimeout(r, 200)); rmSync(dir, { recursive: true, force: true }); }
});
test('unrelated occupied port is left running and no launcher is invoked', async () => {
  const dir = fixture(); const server = createServer((q,s) => s.end('unrelated'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  try {
    for (const platform of ['mac', 'windows']) writeFileSync(join(dir, platform + '-options.json'), JSON.stringify({ port }));
    await assert.rejects(ensureStarted({ root: dir, port }), /端口已被占用/);
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'unrelated');
  } finally { await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
test('native framing handles split UTF-8 input and rejects commands and untrusted callers', async () => {
  const dir = fixture();
  try {
    addExtension(dir);
    for (const file of ['native-host.mjs','native-install.mjs']) copyFileSync(new URL(file, source), join(dir,file));
    for (const [origin, message] of [['chrome-extension://' + extensionId(dir) + '/', { action: 'execute', text: '中文' }], ['chrome-extension://' + 'a'.repeat(32) + '/', { action: 'ensureStarted' }]]) {
      const child = spawn(process.execPath, [join(dir,'native-host.mjs'),origin], { stdio: ['pipe','pipe','pipe'] });
      const chunks = []; child.stdout.on('data', b => chunks.push(b)); child.stdin.on('error', () => {});
      const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      child.stdin.write(header.subarray(0,2)); child.stdin.end(Buffer.concat([header.subarray(2),body]));
      await new Promise(r => child.once('exit',r)); const output = Buffer.concat(chunks);
      assert.equal(output.readUInt32LE(), output.length-4);
      const result = JSON.parse(output.subarray(4)); assert.equal(result.ok,false); assert.match(result.error,/仅接受|不允许/);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
