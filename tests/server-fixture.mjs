import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
export async function startFixture() {
 const dir=mkdtempSync(join(tmpdir(),'baw-http-test-'));
 const pkg=join(dir,'fake-wallet');mkdirSync(join(pkg,'dist'),{recursive:true});
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@binance/agentic-wallet',version:'1.11.0',type:'module'}));
 const cli=join(pkg,'dist/index.js');
 writeFileSync(cli,`import {createHash} from 'node:crypto';
 const args=process.argv.slice(2),addr='0x'+createHash('sha256').update(process.env.BAW_ISOLATED_ID||'original').digest('hex').slice(0,40);
 if(args[0]==='--version')console.log('FAKE-TEST-CLI');
 else if(args[0]==='wallet'&&args[1]==='address')console.log(JSON.stringify({success:true,data:{addresses:[{binanceChainId:56,address:addr}]}}));
 else if(args[0]==='wallet'&&args[1]==='status')console.log(JSON.stringify({success:true,data:{status:'CONNECTED'}}));
 else if(args[0]==='auth'&&args[1]==='signin')console.log(JSON.stringify({success:true,data:{pairingCode:'TEST-ONLY',qrCodeId:'fake',urlForWeb:'https://www.binance.com/test-only'}}));
 else if(args[0]==='auth'&&args[1]==='verify')console.log(JSON.stringify({success:true,data:{status:'SUCCESS'}}));
 else{console.log(JSON.stringify({success:false,error:{message:'TEST_FIXTURE_FORBIDS_ALL_TRADING'}}));process.exitCode=1;}
 `);
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const app=fileURLToPath(new URL('../baw-oneclick/',import.meta.url));
 const child=spawn(process.execPath,[join(app,'serve.mjs')],{cwd:app,env:{...process.env,PORT:String(port),BAW_CLI:cli,BAW_NODE:process.execPath,BAW_DATA_DIR:join(dir,'data'),BRIDGE_TOKEN:'test-only-token'},stdio:['ignore','pipe','pipe']});
 let output='';await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Fixture server failed: '+output)),10000);child.stdout.on('data',d=>{output+=d;if(output.includes('127.0.0.1:')){clearTimeout(t);resolve();}});child.stderr.on('data',d=>output+=d);child.once('exit',code=>{clearTimeout(t);reject(new Error('Fixture exited '+code+': '+output));});});
 return {url:'http://127.0.0.1:'+port,dir,child,async close(){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}};
}
