// smoke.mjs — 优化后的冒烟测试（全部只读，不发交易）
import * as P from './protocol.js';

const W = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const BASE = 'http://127.0.0.1:8787';
const t0 = Date.now();

// 1. RPC 健康 + 故障切换
const h1 = await P.rpcHealth();
console.log(`RPC        : ${h1.url}  block=${h1.block}  ${h1.ms}ms  缓存=${P.rpcInfo().cached ? 'yes' : 'no'}`);

// 2. 桥
const html = await (await fetch(BASE + '/')).text();
const token = html.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/)[1];
const health = await (await fetch(BASE + '/api/health')).json();
console.log(`bridge     : cli=${health.cliVersion} session=${health.session} wallet=${health.wallet.slice(0, 8)}…`);

// 3. BNCB 内盘
const t1 = Date.now();
const info = await P.resolveToken('0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777', W);
const st = await P.readStatus(info.probe, W);
const plan = await P.planBuy(info.probe, P.parseUnitsStrict('0.01', 18), 100, W);
const bal = await P.erc20Balance(info.quote, W);
console.log(`BNCB 池    : ${Date.now() - t1}ms  PHASE=${st.status.PHASE} BUY_OK=${st.status.BUY_OK} RULES_OK=${plan.RULES_OK}`);
console.log(`             余额 ${P.formatUnits(bal, 18)} BNCB → 0.01 买入得 ${P.formatUnits(plan.BUY_SHARES, 18)} 份（MIN ${P.formatUnits(plan.MIN_SHARES, 18)}）`);

// 4. four.meme BNC4 池识别
const t2 = Date.now();
const fm = await P.fourMemeInfo('0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff');
const qSym = await P.erc20Symbol(fm.quote);
console.log(`four.meme  : ${Date.now() - t2}ms  quote=${qSym} native=${fm.quote.toLowerCase() === P.WBNB.toLowerCase()} status=${fm.status}`);

// 5. 桥预览（预期因盘未开失败，但验证链路 + 错误透传）
const buy = P.buyData(info.market, P.parseUnitsStrict('0.01', 18), plan.MIN_SHARES);
const pv = await (await fetch(BASE + '/api/send', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token },
  body: JSON.stringify({ to: P.PORTAL, data: buy, value: '0', previewOnly: true }),
})).json();
console.log(`桥预览      : ok=${pv.ok} stage=${pv.stage || 'preview'} err=${(pv.error && (pv.error.message || pv.error.name)) || '-'}`);

console.log(`\n总耗时 ${Date.now() - t0}ms`);
