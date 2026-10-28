// Original BAW service started by the native launch path, with a forbidden fake wallet CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ensureStarted } from '../native-host.mjs';
if (process.platform !== 'darwin') throw Error('Mac verification only');
const root=mkdtempSync(join(tmpdir(),'BAW Mac native service ')); let pid;
const before={BAW_CLI:process.env.BAW_CLI,BAW_DATA_DIR:process.env.BAW_DATA_DIR};
try {
 const probe=createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 for(const name of ['mac-launch.mjs','mac-network.mjs'])copyFileSync(new URL('../'+name,import.meta.url),join(root,name));
 symlinkSync(fileURLToPath(new URL('../baw-oneclick',import.meta.url)),join(root,'baw-oneclick'));
 const cli=join(root,'fake CLI/dist/index.js');mkdirSync(dirname(cli),{recursive:true});
 writeFileSync(join(cli,'../../package.json'),JSON.stringify({name:'@binance/agentic-wallet',version:'1.11.0',type:'module'}));
 writeFileSync(cli,"throw Error('TEST_FORBIDS_WALLET_ACCESS');");
 process.env.BAW_CLI=cli;process.env.BAW_DATA_DIR=join(root,'fake-data');
 writeFileSync(join(root,'mac-options.json'),JSON.stringify({port}));
 const result=await ensureStarted({root,port});pid=result.pid;assert.equal(result.status,'started');
 assert.equal((await (await fetch('http://127.0.0.1:'+port+'/api/launcher-status')).json()).launcherProtocol,1);
 assert.equal((await ensureStarted({root,port})).status,'running');
 console.log('PASS Mac native launch -> original HTTP service -> reuse, without wallet CLI execution or Terminal.');
}finally{
 if(pid)process.kill(-pid,'SIGTERM');
 for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await new Promise(r=>setTimeout(r,200));rmSync(root,{recursive:true,force:true});
}
