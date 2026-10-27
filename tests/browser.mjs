import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startFixture } from './server-fixture.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(process.env.BAW_TEST_PLAYWRIGHT || process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const {chromium}=playwright;
const f=await startFixture();let browser;
try{
 const api=async(path,body)=>{const r=await fetch(f.url+'/api/multi/'+path,{method:body?'POST':'GET',headers:{'x-bridge-token':'test-only-token','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return r.json();};
 await api('wallets/check',{id:'original'});const w=(await api('wallets/create',{name:'测试钱包 02',groupId:'g_default'})).wallet;await api('wallets/check',{id:w.id});
 const initial=await api('state');
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:430,height:1000}}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=route.request().url();if(u.startsWith(f.url))return route.continue();external.push(u);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({jsonrpc:'2.0',id:1,result:'0x0'})});});
 await page.goto(f.url);await page.locator('#mw-wallet-select').waitFor();
 await page.locator('[data-mw-tab="wallets"]').click();await page.locator('#mw-wallets').getByText('测试钱包 02',{exact:true}).waitFor();
 await page.getByRole('button',{name:'＋ 新建分组'}).click();await page.locator('#mw-new-name').fill('试单组');await page.locator('#mw-dialog [data-accept]').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-move-wallet] option').length===4);
 const newGroup=(await api('state')).groups.find(g=>g.name==='试单组');await page.locator(`[data-move-wallet="${w.id}"]`).selectOption(newGroup.id);
 await page.locator('[data-mw-tab="copy"]').click();await page.locator('#mw-task-name').fill('UI 测试任务');await page.locator('#mw-leaders').fill('0x'+'a'.repeat(40));
 await page.locator('#mw-copy-wallets [data-mw-wallet="original"]').check();await page.locator('#mw-copy-amount').fill('0.1');await page.locator('#mw-copy-amount').blur();
 await page.locator('[data-mw-action="save-task"]').click();await page.getByText('任务已保存，未自动启动',{exact:true}).first().waitFor();
 assert.equal((await api('state')).copy.running.length,0);
 const output=fileURLToPath(new URL('../verification/',import.meta.url));mkdirSync(output,{recursive:true});
 for(const width of [320,430,900]){await page.setViewportSize({width,height:1000});for(const tab of ['trade','copy','wallets']){await page.locator(`[data-mw-tab="${tab}"]`).click();await page.waitForTimeout(40);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width} ${tab} overflow`);if(width===430)await page.screenshot({path:output+`original-${tab}.png`,fullPage:true});}}
 assert.deepEqual(errors,[]);assert.equal(external.length,0,'initial page and management do not issue blockchain requests');
 // Deterministic batch harness: same feature module, real mock HTTP identity checks, stub trading callback.
 await page.route(f.url+'/test-harness',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/wallet-features.css"></head><body><div class="wrap"><div class="topbar">Original</div><section><input id="ca" value="0x${'4'.repeat(40)}"><select id="sigMode"><option value="bridge">bridge</option></select><div id="unifiedTradePanel"></div></section></div><button id="test-buy">Test buy</button><script type="module">
 import {installWalletFeatures} from '/wallet-features.js';
 window.calls=[];window.failFirst=false;let app;const state={account:null,busy:false,venue:null};let opts={dryRun:true,slipBps:100};
 const bridge=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'content-type':'application/json','x-bridge-token':'test-only-token',...app?.requestHeaders(path)}});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
 const trade=async(value)=>{calls.push({value,account:state.account,headers:app.requestHeaders('/api/dex-buy')});if(failFirst&&calls.length===1)throw Error('controlled failure');};
 app=installWalletFeatures({bridge,state,P:{},connect:async()=>{state.account=(await bridge('/api/health')).wallet;},resolve:async()=>{state.venue='dex';},log:()=>{},short:s=>s?.slice(0,8)||'',buy:trade,sell:trade,preview:async(kind,value)=>trade(value),getOptions:()=>opts,setOptions:o=>{opts=o;},pausePolling:()=>{},resumePolling:()=>{}});
 window.controller=app;window.state=state;document.querySelector('#test-buy').onclick=()=>app.buy('0.05');
 </script></body></html>`}));
 await page.goto(f.url+'/test-harness');await page.locator('[data-mw-wallet="original"][data-kind="trade"]').waitFor({state:'attached'});
 await page.locator('#mw-wallet-select details').evaluate(e=>e.open=true);
 await page.locator('[data-mw-wallet="original"][data-kind="trade"]').check();await page.locator(`[data-mw-wallet="${w.id}"][data-kind="trade"]`).check();
 await page.locator('#test-buy').click();assert.match(await page.locator('#mw-dialog').innerText(),/0.1 BNB/);await page.locator('#mw-dialog [data-accept]').click();
 await page.waitForFunction(()=>window.calls.length===2&&!document.querySelector('.topbar').inert);
 const calls=await page.evaluate(()=>window.calls);assert.equal(calls[0].account,initial.wallets[0].address);assert.equal(calls[1].account,initial.wallets[1].address);assert.notEqual(calls[0].account,calls[1].account);assert.ok(calls.every(c=>c.headers['x-baw-preview-only']==='1'));assert.equal(await page.evaluate(()=>window.state.account),null);
 await page.evaluate(()=>{window.calls=[];window.failFirst=true;});await page.locator('#test-buy').click();await page.locator('#mw-dialog [data-accept]').click();await page.waitForFunction(()=>window.calls.length===2&&!document.querySelector('.topbar').inert);assert.match(await page.locator('.mw-status').innerText(),/controlled failure/);assert.equal((await page.evaluate(()=>window.calls)).length,2,'no automatic retries');
 writeFileSync(output+'browser-results.json',JSON.stringify({passed:true,checks:['original DOM preserved','group creation/move','task save does not start','320/430/900 responsive','no external network','sequential identities','preview submission guard','partial failure no retry'],wallets:'synthetic fixtures only'},null,2));
 console.log('PASS browser: original UI, responsive layout, group/task actions, sequential per-wallet identity, dry-run headers, no retry, no external requests.');
}finally{await browser?.close();await f.close();}
