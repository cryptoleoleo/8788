import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFixture } from './server-fixture.mjs';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(process.env.BAW_TEST_PLAYWRIGHT || process.env.HOME+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const f=await startFixture(); let browser;
try {
 browser=await playwright.chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage(),calls=[],errors=[];let paired=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin!==f.url){errors.push('Unexpected external request');return route.abort();}
  if(u.pathname==='/'){
   const response=await route.fetch();const body=(await response.text()).replace(/'\.\/protocol\.js[^']*'/,"'/test-protocol.js'");return route.fulfill({response,body});
  }
  if(u.pathname==='/test-protocol.js')return route.fulfill({contentType:'text/javascript',body:"export * from '/protocol.js';export const nativeBalance=async()=>0n;"});
  if(u.pathname==='/api/health'&&!paired)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'NOT_LOGGED_IN: Not logged in'})});
  if(u.pathname==='/api/multi/wallets/signin'||u.pathname==='/api/multi/wallets/verify'){
   calls.push({path:u.pathname,body:req.postDataJSON()});const response=await route.fetch();
   if(u.pathname.endsWith('/verify'))paired=true;return route.fulfill({response});
  }
  if(req.method()==='POST'&&!u.pathname.startsWith('/api/multi/'))throw Error('Unexpected mutation: '+u.pathname);
  return route.continue();
 });
 await page.goto(f.url);await page.locator('#mw-wallet-select').waitFor();
 assert.equal(calls.length,0,'Opening page must not initiate login');
 await page.locator('#btnConnect').click();await page.locator('#mw-dialog[open]').waitFor();
 assert.equal(await page.locator('#mw-dialog a').getAttribute('href'),'https://www.binance.com/test-only');
 assert.equal(calls[0].body.id,'original');
 await page.locator('#mw-dialog [data-cancel]').first().click();
 await page.waitForFunction(()=>!document.querySelector('#btnConnect').disabled);
 assert.equal(calls.filter(c=>c.path.endsWith('/verify')).length,0);
 await page.locator('#btnConnect').click();await page.locator('#mw-dialog[open]').waitFor();
 await page.locator('#mw-dialog [data-accept]').click();
 await page.waitForFunction(()=>document.querySelector('#sessionPill').textContent.includes('CONNECTED'));
 await page.waitForFunction(()=>!document.querySelector('#btnConnect').disabled);
 assert.equal(calls.filter(c=>c.path.endsWith('/verify')).length,1);
 const count=calls.length;await page.locator('#btnConnect').click();await page.waitForFunction(()=>!document.querySelector('#btnConnect').disabled);
 assert.equal(calls.length,count,'Already connected does not trigger another pairing');
 assert.deepEqual(errors,[]);
 console.log('PASS explicit top Connect -> original identity pairing -> cancel/retry -> verified connection. Fake CLI only; no external login, wallet or trading.');
}finally{await browser?.close();await f.close();}
