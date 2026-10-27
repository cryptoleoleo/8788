import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('original protocol, preset monitors, defaults, and transaction functions remain intact',()=>{
 const baseline=JSON.parse(readFileSync(root+'original-sha256.json'));
 const modified=new Set(['baw-oneclick/index.html','baw-oneclick/serve.mjs','baw-oneclick/gang-buy.mjs']);let count=0;
 for(const [path,hash] of Object.entries(baseline)){if(modified.has(path))continue;assert.equal(createHash('sha256').update(readFileSync(root+path)).digest('hex'),hash,path);count++;}
 assert.equal(count,1881);
 const old=readFileSync(root+'tests/fixtures/original-index.html','utf8'),next=readFileSync(root+'baw-oneclick/index.html','utf8');
 const funcs=['onBuy','onBuyWithBnb','onSell','fmBuy','fmSell','dexBuy','dexSellGeneric','buyGang','gangSell','prepareBuyForGross','executeSell','bridgeSend'];
 for(const name of funcs){const re=new RegExp('async function '+name+'\\([^]*?(?=\\n(?:async )?function |\\n/\\*|$)');assert.equal(next.match(re)?.[0],old.match(re)?.[0],name);assert.ok(old.match(re),name+' baseline exists');}
 for(const name of ['DEFAULT_BUY_PRESETS','DEFAULT_SELL_PRESETS']){const re=new RegExp('const '+name+' = .*;');assert.equal(next.match(re)[0],old.match(re)[0]);}
});
