import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MultiStore } from '../baw-oneclick/multi-store.mjs';
import { WalletRuntime } from '../baw-oneclick/wallet-runtime.mjs';
import { CopyFeed, decodeBuy, eventAmount, subscriptions } from '../baw-oneclick/copy-feed.mjs';
import { decimalTotal } from '../baw-oneclick/wallet-features.js';
import { Interface, parseEther, AbiCoder, id } from '../baw-oneclick/node_modules/ethers/lib.esm/index.js';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40),TOKEN='0x'+'4'.repeat(40),TX='0x'+'a'.repeat(64);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'baw-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return new MultiStore(dir);}
function taskFor(store){store.bindAddress('original',A);return store.saveTask({name:'test',walletIds:['original'],leaders:[B],venues:['gang','flap','four'],amount:'0.05',mode:'fixed',minLeader:'0',cooldown:60,slippage:1,dryRun:true});}
class FakeSocket extends EventTarget {constructor(){super();this.readyState=1;this.sent=[];}send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}

test('exact decimal totals and validation avoid binary rounding and scientific notation',()=>{
 assert.equal(decimalTotal('0.1',3),'0.3');assert.equal(decimalTotal('0.000000000000000001',30),'0.00000000000000003');
 assert.throws(()=>decimalTotal('1e2',3));
});
test('wallet metadata persists independently, prevents duplicate/rebound identities, never stores sessions',t=>{
 const s=fixture(t),g=s.createGroup('试单组'),w=s.createWallet('wallet 2',g.id);
 s.bindAddress('original',A);s.bindAddress(w.id,B);s.updateWallet(w.id,{groupId:'g_default'});
 assert.throws(()=>s.bindAddress(w.id,A));assert.throws(()=>s.wallet('../session.json'));
 const reloaded=new MultiStore(s.directory);assert.equal(reloaded.wallet(w.id).address,B);assert.equal(reloaded.wallet(w.id).groupId,'g_default');
 assert.doesNotMatch(readFileSync(s.file,'utf8'),/sessionId|privateKey|mnemonic|qrCodeId/);
});
test('keychain adapter namespaces independent identities and never falls back to the legacy service',t=>{
 const s=fixture(t),fixtureDir=join(s.directory,'fake-cli');mkdirSync(join(fixtureDir,'node_modules/@github/keytar'),{recursive:true});
 writeFileSync(join(fixtureDir,'node_modules/@github/keytar/package.json'),JSON.stringify({type:'module',main:'index.js'}));
 writeFileSync(join(fixtureDir,'node_modules/@github/keytar/index.js'),`export default {getPassword:async(s,a)=>s+':'+a,setPassword:async(s,a,v)=>{if(s==='baw')throw Error('legacy touched');return s},deletePassword:async(s,a)=>s};`);
 const entry=join(fixtureDir,'cli.mjs');writeFileSync(entry,`const m=await import('@github/keytar');console.log(await m.default.getPassword('baw','agentSessionId'));console.log(await m.default.setPassword('baw','agentSessionId','FAKE_TEST_VALUE'));`);
 const loader=new URL('../baw-oneclick/profile-bootstrap.mjs',import.meta.url).href;
 for(const n of ['a','b']){const walletId='w_'+n.repeat(24);const out=execFileSync(process.execPath,['--import',loader,entry],{env:{...process.env,BAW_ISOLATED_ID:walletId},encoding:'utf8'});assert.ok(out.includes('baw-original-multi.'+walletId+':agentSessionId'));assert.ok(!out.includes('FAKE_TEST_VALUE'));}
});
test('scoped CLI isolation handles concurrent wallets, binds from, and blocks a changed identity before execute',async t=>{
 const s=fixture(t),w=s.createWallet('wallet2','g_default');s.bindAddress('original',A);s.bindAddress(w.id,B);
 const calls=[],addresses={original:A,[w.id]:B};
 const r=new WalletRuntime(s,{run:async(id,args)=>{calls.push({id,args});await new Promise(resolve=>setTimeout(resolve,1));return {json:{success:true,data:args[0]==='wallet'?{addresses:[{binanceChainId:56,address:addresses[id]}]}:{requestId:'fake'}}};}});
 await Promise.all(['original',w.id].map(id=>r.scope(id,()=>r.run(['contract-call','preview','--from',addresses[id]],100))));
 assert.equal(calls.filter(c=>c.args[0]==='contract-call').length,2);
 await assert.rejects(r.scope(w.id,()=>r.run(['contract-call','preview','--from',A],100)),/from/);
 addresses[w.id]=C;await assert.rejects(r.scope(w.id,()=>r.run(['contract-call','execute','--requestId','fake'],100)),/不匹配/);
 assert.equal(calls.filter(c=>c.args[1]==='execute').length,0);
});
test('Gang quote amounts cannot masquerade as BNB; malformed/removed logs are ignored',()=>{
 const abi=new Interface(['event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)']);
 const log=abi.encodeEventLog(abi.getEvent('Buy'),[TOKEN,B,parseEther('100'),0,0,1,0]);
 const event=decodeBuy({...log,address:'0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e',transactionHash:TX,logIndex:'0x1',blockNumber:'0x9'});
 assert.equal(event.spentWei,null);assert.equal(event.buyer,B);
 const task={leaders:[B],venues:['gang'],amount:'0.05',mode:'fixed',minLeader:'0'};
 assert.equal(eventAmount(task,event),'0.05');assert.throws(()=>eventAmount({...task,mode:'mirror'},event),/非 BNB/);
 assert.equal(decodeBuy({...log,address:'0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e',transactionHash:TX,logIndex:'0x1',removed:true}),null);
 assert.equal(decodeBuy({...log,address:A,transactionHash:TX,logIndex:'0x1'}),null);
});
test('subscription chunking and exact capped amounts match reference semantics',()=>{
 const leaders=Array.from({length:51},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
 assert.equal(subscriptions({leaders,venues:['gang','flap','four']}).length,8);
 assert.equal(eventAmount({leaders:[B],venues:['four'],amount:'0.1',mode:'mirror',minLeader:'0'}, {buyer:B,venue:'four',spentWei:parseEther('0.2')}),'0.1');
});
test('Four and Flap quote amounts are not assumed to be BNB',()=>{
 const common={transactionHash:TX,logIndex:'0x2'};
 const four=decodeBuy({...common,address:'0x5c952063c7fc8610ffdb798152d69f0b9550762b',topics:[id('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)')],data:AbiCoder.defaultAbiCoder().encode(['address','address','uint256','uint256','uint256','uint256','uint256','uint256'],[TOKEN,B,1,2,parseEther('100'),0,0,0])});
 const flap=decodeBuy({...common,address:'0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',topics:[id('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)')],data:AbiCoder.defaultAbiCoder().encode(['uint256','address','address','uint256','uint256','uint256','uint256'],[1,TOKEN,B,2,parseEther('100'),0,0])});
 for(const ev of [four,flap]){assert.equal(ev.buyer,B);assert.equal(ev.token,TOKEN);assert.equal(ev.spentWei,null);assert.throws(()=>eventAmount({leaders:[B],venues:['four','flap'],mode:'mirror',amount:'0.05',minLeader:'0'},ev),/无法确认为 BNB/);}
});
test('websocket subscription responses decode actual event data once; constructor failure stops cleanly',t=>{
 const s=fixture(t),task=taskFor(s),c=new CopyFeed(s,{Socket:FakeSocket});t.after(()=>c.close());const client='00000000-0000-0000-0000-000000000000';
 c.start(task.id,client);const r=c.running.get(task.id),ws=r.socket;ws.dispatchEvent(new Event('open'));
 const first=ws.sent[0];ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:first.id,result:'sub-1'})}));
 const abi=new Interface(['event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 fee,uint256 tokensOut,uint256 realBnb)']);
 const log={...abi.encodeEventLog(abi.getEvent('Buy'),[TOKEN,B,parseEther('0.2'),0,1,0]),address:'0x4e6f13c8a453c1b8b4e20b590082bb233a5b80d7',transactionHash:TX,logIndex:'0x1'};
 for(let n=0;n<2;n++)ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'eth_subscription',params:{subscription:'sub-1',result:log}})}));
 assert.equal(c.jobs.size,1);assert.equal(c.claim(client).amount,'0.05');
 const bad=new CopyFeed(s,{Socket:class{constructor(){throw Error('offline');}}});assert.throws(()=>bad.start(task.id,client),/无法创建/);assert.equal(bad.running.size,0);
});
test('manual multi-wallet preview blocks execute/swap at runtime even when an original route tries to submit',async t=>{
 const s=fixture(t);s.bindAddress('original',A);const calls=[];
 const r=new WalletRuntime(s,{run:async(id,args)=>{calls.push(args);return {json:{success:true,data:{addresses:[{binanceChainId:56,address:A}]}}};}});
 await assert.rejects(r.scope('original',()=>r.run(['market-order','swap'],100),null,true),/预演禁止/);
 await assert.rejects(r.scope('original',()=>r.run(['contract-call','execute'],100),null,true),/预演禁止/);
 assert.equal(calls.length,0);
});
test('copy signals are deduplicated, claimed once, dry-run guarded, stopped, and never replayed after restart',t=>{
 const s=fixture(t),task=taskFor(s);let now=100000;const c=new CopyFeed(s,{Socket:FakeSocket,now:()=>now});t.after(()=>c.close());
 const client='a'.repeat(8)+'-'+'b'.repeat(4)+'-'+'c'.repeat(4)+'-'+'d'.repeat(4)+'-'+'e'.repeat(12);c.start(task.id,client);
 const ev={venue:'gang',token:TOKEN,buyer:B,spentWei:parseEther('0.2'),txHash:TX,eventId:TX+':1'};
 c.ingest(task.id,ev);c.ingest(task.id,{...ev,eventId:TX+':2'});assert.equal(c.jobs.size,1);
 const j=c.claim(client);assert.ok(j);assert.equal(c.claim(client),null);
 assert.throws(()=>c.permit({jobId:j.id,claim:j.claim,walletId:'original'},['contract-call','execute']),/预演/);
 c.permit({jobId:j.id,claim:j.claim,walletId:'original'},['contract-call','preview']);
 c.stop(task.id);assert.throws(()=>c.permit({jobId:j.id,claim:j.claim,walletId:'original'},[]),/停止/);
 const other=new CopyFeed(s,{Socket:FakeSocket,now:()=>now});t.after(()=>other.close());other.start(task.id,client);other.ingest(task.id,ev);assert.equal(other.jobs.size,0);
 now+=25000;other.ingest(task.id,{...ev,txHash:'0x'+'b'.repeat(64)});assert.equal(other.jobs.size,0,'offline clients receive no events');
});
test('old queued signals expire without execution and duplicate results cannot be committed',t=>{
 const s=fixture(t),task=taskFor(s);let now=100000;const c=new CopyFeed(s,{Socket:FakeSocket,now:()=>now});t.after(()=>c.close());const client='00000000-0000-0000-0000-000000000000';
 c.start(task.id,client);c.ingest(task.id,{venue:'four',token:TOKEN,buyer:B,spentWei:parseEther('0.2'),txHash:TX});
 now+=21000;assert.equal(c.claim(client),null);assert.equal([...c.jobs.values()][0].status,'expired');
 now+=60000;c.touch(client);c.ingest(task.id,{venue:'four',token:TOKEN,buyer:B,spentWei:parseEther('0.2'),txHash:'0x'+'c'.repeat(64)});
 const j=c.claim(client);c.result({jobId:j.id,claim:j.claim,walletId:'original',status:'completed'});
 assert.throws(()=>c.result({jobId:j.id,claim:j.claim,walletId:'original',status:'completed'}));
});
