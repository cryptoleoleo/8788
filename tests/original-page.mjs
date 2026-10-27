// Exercise original connect/resolve/uniBuy/dexBuy, with all chain/trade I/O mocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { startFixture } from './server-fixture.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(process.env.BAW_TEST_PLAYWRIGHT || process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const {chromium}=playwright;
const f=await startFixture();let browser;
try {
 const api=async(path,body)=>(await fetch(f.url+'/api/multi/'+path,{method:body?'POST':'GET',headers:{'x-bridge-token':'test-only-token','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})).json();
 await api('wallets/check',{id:'original'});const w=(await api('wallets/create',{name:'Original integration 02',groupId:'g_default'})).wallet;await api('wallets/check',{id:w.id});
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:430,height:1000}}),calls=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),send=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   if(u.origin!==f.url){errors.push('Blocked unexpected external request: '+u.origin);return route.abort();}
   if(u.pathname==='/'){
     const response=await route.fetch();let body=await response.text();
     body=body.replace(/'\.\/protocol\.js[^']*'/,"'/test-protocol.js'");
     const pos=body.lastIndexOf('</script>');body=body.slice(0,pos)+`\nwindow.integration={state,multi,uniBuy};\n`+body.slice(pos);
     return route.fulfill({response,body});
   }
   if(u.pathname==='/test-protocol.js')return route.fulfill({contentType:'text/javascript',body:`
     export * from '/protocol.js';
     export const nativeBalance=async()=>1000000000000000000n;
     export const erc20Balance=async()=>0n;
     export const fourMemeInfo=async()=>null;
     export const resolveToken=async()=>{throw Error('没有注册 Probe');};
   `});
   if(u.pathname==='/api/gang/detect')return send({ok:false,error:'fixture no Gang route'});
   if(u.pathname==='/api/token-overview')return send({ok:true});
   if(u.pathname==='/api/token-pnl')return send({ok:true,balanceText:'0',totalBuyBnb:'0',totalSellBnb:'0'});
   if(u.pathname==='/api/dex-buy/quote'){
     calls.push({kind:'quote',headers:req.headers(),body:req.postDataJSON()});
     return send({ok:true,quote:{toCoinSymbol:'TEST',toCoinAmount:'1',slippage:'0.01'}});
   }
   if(u.pathname==='/api/dex-buy'){
     calls.push({kind:'submit-mock',headers:req.headers(),body:req.postDataJSON()});
     return send({ok:true,orderId:'FIXTURE-ONLY',order:{toTokenSymbol:'TEST',toTokenActualQty:'1'}});
   }
   return route.continue();
 });
 await page.goto(f.url);await page.locator(`[data-mw-wallet="${w.id}"][data-kind="trade"]`).waitFor({state:'attached'});
 await page.locator('#ca').fill('0x'+'4'.repeat(40));
 await page.locator('#mw-wallet-select details').evaluate(el=>el.open=true);
 await page.locator('[data-mw-wallet="original"][data-kind="trade"]').check();await page.locator(`[data-mw-wallet="${w.id}"][data-kind="trade"]`).check();
 for(const dry of [true,false]){
   calls.length=0;
   await page.evaluate(dry=>{document.querySelector('#dryRun').checked=dry;window.finished=false;window.failure=null;integration.uniBuy('0.05').catch(e=>window.failure=e.message).finally(()=>window.finished=true);},dry);
   await page.locator('#mw-dialog').waitFor({state:'visible'});await page.locator('#mw-dialog [data-accept]').click();await page.waitForFunction(()=>window.finished);
   assert.equal(await page.evaluate(()=>window.failure),null);
   assert.equal(await page.evaluate(()=>integration.state.account),null);
   assert.match(await page.locator('#walletPill').innerText(),/未连接/);
   const status=await page.locator('.mw-status').first().innerText();
   assert.equal((status.match(new RegExp(dry?'预演流程完成':'原版流程结束','g'))||[]).length,2,'expected route probe misses must not mark successful DEX flows failed: '+status);
   const orders=calls.filter(c=>c.kind==='submit-mock');
   if(dry){assert.equal(orders.length,0);const q=calls.filter(c=>c.body.amount==='0.05');assert.equal(q.length,2);assert.deepEqual(q.map(x=>x.headers['x-baw-wallet']),['original',w.id]);assert.ok(q.every(x=>x.headers['x-baw-preview-only']==='1'));}
   else {assert.equal(orders.length,2);assert.deepEqual(orders.map(x=>x.headers['x-baw-wallet']),['original',w.id]);assert.ok(orders.every(x=>x.body.amount==='0.05'));}
 }
 assert.deepEqual(errors,[]);
 writeFileSync(new URL('../verification/original-page-results.json',import.meta.url),JSON.stringify({passed:true,checks:['actual original connect/resolve/uniBuy/dexBuy callbacks','preview quotes only','per-wallet headers and amounts','original wallet display restored'],network:'All blockchain and trade responses mocked; no signing'},null,2));
 console.log('PASS original page integration (all blockchain/trade I/O mocked).');
} finally {await browser?.close();await f.close();}
