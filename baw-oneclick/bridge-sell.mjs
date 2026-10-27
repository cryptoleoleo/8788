// bridge-sell.mjs — 走本地桥（Agentic 钱包签名）全量卖出
import * as P from './protocol.js';

const BASE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const TOKEN_CA = process.env.TOKEN || '0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777';
const BPS = Number(process.env.BPS || '10000');
const SLIP = Number(process.env.SLIP || '100');

const t = await (await fetch(BASE + '/')).text();
const m = t.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/);
if (!m) throw new Error('页面里找不到 bridge token');
const TOKEN = m[1];

async function bridge(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN, ...(opts.headers || {}) },
  });
  const j = await res.json();
  if (!res.ok) throw new Error('bridge ' + res.status + ': ' + JSON.stringify(j.error));
  return j;
}

const health = await bridge('/api/health');
console.log('bridge   :', health.ok, '| session', health.session);
const WALLET = health.wallet;
console.log('wallet   :', WALLET);
if (health.session !== 'CONNECTED') throw new Error('会话不是 CONNECTED');

const info = await P.resolveToken(TOKEN_CA, WALLET);
const pos = await P.probe(info.probe, P.SEL.positionProbe, [], WALLET);
console.log('position : HELD_SHARES=' + pos.HELD_SHARES + ' SELL_OK=' + pos.SELL_OK + ' PHASE=' + pos.PHASE);
if (pos.PHASE !== '1' || pos.SELL_OK !== '1') throw new Error('状态不允许卖出');
if (BigInt(pos.HELD_SHARES) === 0n) throw new Error('份额为 0');

const plan = await P.planSell(info.probe, BPS, SLIP, WALLET);
console.log('plan     : SHARES=' + P.formatUnits(plan.SHARES, 18)
  + ' OUT=' + P.formatUnits(plan.OUT_RAW, info.decimals)
  + ' MIN=' + P.formatUnits(plan.MIN_RAW, info.decimals)
  + ' BLOCK=' + plan.BLOCK);

const j = await bridge('/api/send', {
  method: 'POST',
  body: JSON.stringify({ to: P.PORTAL, data: P.sellData(info.market, BPS, plan.MIN_RAW) }),
});
if (!j.ok) { console.log('SELL FAILED @' + j.stage + ':', JSON.stringify(j.error)); throw new Error('sell failed'); }
console.log('submit   : requestId=' + j.requestId + ' requireConfirmation=' + j.requireConfirmation + ' tx=' + (j.result && j.result.txHash));
if (j.preview && j.preview.balanceChanges) for (const b of j.preview.balanceChanges) console.log('           模拟变动 ' + b.contractAddress + ' ' + b.change);

const rc = await P.waitReceipt(j.result.txHash);
console.log('receipt  : status=' + (rc.ok ? 'OK' : 'REVERT') + ' block=' + rc.blockNumber + ' gasUsed=' + Number(BigInt(rc.gasUsed)));

const after = await P.probe(info.probe, P.SEL.positionProbe, [], WALLET);
console.log('after    : HELD_SHARES=' + after.HELD_SHARES + ' (' + P.formatUnits(after.HELD_SHARES, 18) + ')');
const bal = await P.erc20Balance(info.quote, WALLET);
console.log('balance  : ' + P.formatUnits(bal, info.decimals) + ' QUOTE');
console.log('DONE');
