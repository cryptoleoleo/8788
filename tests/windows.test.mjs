import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { defaultDataDirectory } from '../baw-oneclick/multi-store.mjs';
import { globalCliCandidates, selectedPort, resolveWindowsCli, requireNode24 } from '../windows-runtime.mjs';
import { parseWindowsProxy, windowsProxyEnvironment } from '../windows-network.mjs';
import { installWindows } from '../windows-install.mjs';

async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function payload(t){
 const root=mkdtempSync(join(tmpdir(),'BAW Windows 中文 & spaces '));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),destination=join(root,'installed','program'),port=await freePort();mkdirSync(source);
 const entries={'.baw-original-multi-windows-package':'BAW-Original-Multi-Windows\n','windows-options.json':JSON.stringify({port,cliPath:null})};
 for(const name of ['Start-BAW.cmd','windows-launch.mjs','windows-runtime.mjs','windows-network.mjs','baw-oneclick/serve.mjs','baw-oneclick/ca-input.mjs','baw-oneclick/wallet-runtime.mjs','baw-oneclick/node_modules/ethers/package.json'])entries[name]='static test payload';
 const manifest={};for(const [name,content] of Object.entries(entries)){const path=join(source,...name.split('/'));mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,content);manifest[name]=createHash('sha256').update(content).digest('hex');}
 writeFileSync(join(source,'windows-payload.json'),JSON.stringify(manifest));writeFileSync(join(source,'runtime-not-in-package.txt'),'FAKE_TEST_RUNTIME_DATA');
 return {root,source,destination,port};
}
test('Windows data and global CLI paths respect user folders, spaces and custom prefixes; Mac stays unchanged',()=>{
 assert.equal(defaultDataDirectory('win32',{LOCALAPPDATA:'C:\\Users\\测试 A\\AppData\\Local'},'C:\\Users\\测试 A'),'C:\\Users\\测试 A\\AppData\\Local\\BAW-Original-Multi\\data');
 assert.equal(defaultDataDirectory('win32',{BAW_DATA_DIR:'D:\\custom'},''),'D:\\custom');
 assert.equal(defaultDataDirectory('darwin',{},'/Users/example'),'/Users/example/Library/Application Support/BAW-Original-Multi');
 const paths=globalCliCandidates({APPDATA:'C:\\Users\\A B\\AppData\\Roaming',Path:'D:\\custom npm;C:\\Windows'},'C:\\Program Files\\nodejs\\node.exe',win32);
 assert.ok(paths.includes('D:\\custom npm\\node_modules\\@binance\\agentic-wallet\\dist\\index.js'));
 assert.ok(paths.includes('C:\\Users\\A B\\AppData\\Roaming\\npm\\node_modules\\@binance\\agentic-wallet\\dist\\index.js'));
 assert.equal(selectedPort({port:null},{}),8787);assert.equal(selectedPort({port:9999},{PORT:'12345'}),12345);assert.throws(()=>selectedPort({port:0},{}));assert.throws(()=>requireNode24('22.21.0'));
});
test('Windows proxy parsing preserves explicit proxy and loopback bypass without changing system settings',()=>{
 const settings=parseWindowsProxy('ProxyEnable    REG_DWORD    0x1','ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080');
 assert.deepEqual(settings,{http:'http://127.0.0.1:7890',https:'http://127.0.0.1:7891'});
 const env=windowsProxyEnvironment({HTTPS_PROXY:'http://example.test:8888'},settings);assert.equal(env.HTTPS_PROXY,'http://example.test:8888');assert.match(env.NO_PROXY,/127\.0\.0\.1/);assert.equal(env.NODE_USE_ENV_PROXY,'1');
 assert.deepEqual(parseWindowsProxy('ProxyEnable REG_DWORD 0x0','ProxyServer REG_SZ 127.0.0.1:7890'),{});
 assert.deepEqual(windowsProxyEnvironment({BAW_SYSTEM_PROXY:'0'},settings),{BAW_SYSTEM_PROXY:'0'});
});
test('Windows CLI lookup resolves JS entry in a spaced path and fails closed on unsupported version',async t=>{
 const p=await payload(t),prefix=join(p.root,'npm global'),cli=join(prefix,'node_modules/@binance/agentic-wallet/dist/index.js');mkdirSync(join(cli,'..'),{recursive:true});writeFileSync(cli,'// fake CLI; never executed');
 const pkg=join(cli,'../../package.json');writeFileSync(pkg,JSON.stringify({name:'@binance/agentic-wallet',version:'1.11.0'}));
 assert.equal(resolveWindowsCli({NPM_CONFIG_PREFIX:prefix}),realpathSync(cli));writeFileSync(pkg,JSON.stringify({name:'@binance/agentic-wallet',version:'9.0.0'}));assert.throws(()=>resolveWindowsCli({BAW_CLI:cli}),/1.11.0/);
});
test('Windows installer copies only manifest files, preserves external data and configuration, backs up updates',async t=>{
 const p=await payload(t);await installWindows({...p,env:{}});
 assert.equal(existsSync(join(p.destination,'runtime-not-in-package.txt')),false);
 const data=join(p.destination,'../data');mkdirSync(data);writeFileSync(join(data,'keep.txt'),'TEST_DATA_ONLY');
 const options={port:p.port,cliPath:join(p.root,'custom CLI','index.js')};writeFileSync(join(p.destination,'windows-options.json'),JSON.stringify(options));
 const update=await installWindows({...p,env:{}});assert.ok(update.backup);assert.equal(readFileSync(join(data,'keep.txt'),'utf8'),'TEST_DATA_ONLY');assert.deepEqual(JSON.parse(readFileSync(join(p.destination,'windows-options.json'))),options);
});
test('Windows installer rejects damaged payload, unrelated folder and running installation without replacing files',async t=>{
 const p=await payload(t);mkdirSync(p.destination,{recursive:true});writeFileSync(join(p.destination,'keep.txt'),'unchanged');
 await assert.rejects(installWindows({...p,env:{}}),/未覆盖/);assert.equal(readFileSync(join(p.destination,'keep.txt'),'utf8'),'unchanged');
 // Leave the unrelated folder intact; use a separate target for the running-install check.
 p.destination=join(p.root,'owned installation','program');
 await installWindows({...p,env:{}});const server=createServer();await new Promise(r=>server.listen(p.port,'127.0.0.1',r));
 try {await assert.rejects(installWindows({...p,env:{}}),/端口/);assert.ok(existsSync(join(p.destination,'Start-BAW.cmd')));}finally{await new Promise(r=>server.close(r));}
 writeFileSync(join(p.source,'baw-oneclick/serve.mjs'),'tampered');await assert.rejects(installWindows({...p,env:{}}),/文件校验失败/);
});
