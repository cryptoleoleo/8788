// bridge-buy.mjs — 走本地桥（Agentic 钱包签名）跑一遍完整买入，用来验证网页链路
import * as P from './protocol.js';

const BASE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const TOKEN_CA = process.env.TOKEN || '0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777';
const AMOUNT = process.env.AMOUNT || '0.5';
const SLIP = Number(process.env.SLIP || '100');

async function html() {
  const r = await fetch(BASE + '/');
  const t = await r.text();
  const m = t.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/);
  if (!m) throw new Error('页面里找不到 bridge token');
  return m[1];
}
const TOKEN = await html();

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
console.log('bridge   :', health.ok, '| cli', health.cliVersion, '| session', health.session);
console.log('wallet   :', health.wallet);
if (health.session !== 'CONNECTED') throw new Error('Agentic 钱包会话不是 CONNECTED');
const WALLET = health.wallet;

const info = await P.resolveToken(TOKEN_CA, WALLET);
console.log('probe    :', info.probe);
console.log('market   :', info.market);
console.log('quote    :', info.quote, info.decimals);

const st = await P.readStatus(info.probe, WALLET);
console.log('status   : PHASE=' + st.status.PHASE + ' BUY_OK=' + st.status.BUY_OK + ' held=' + P.formatUnits(st.pos.HELD_SHARES, 18));
if (st.status.PHASE !== '1' || st.status.BUY_OK !== '1') throw new Error('状态不允许买入');

const gross = P.parseUnitsStrict(AMOUNT, info.decimals);
let fund = await P.readFunding(info.probe, gross, WALLET);
console.log('funding  : BALANCE_OK=' + fund.BALANCE_OK + ' ALLOWANCE_OK=' + fund.ALLOWANCE_OK);

async function send(to, data, label) {
  const j = await bridge('/api/send', { method: 'POST', body: JSON.stringify({ to, data }) });
  if (!j.ok) {
    console.log(`${label} FAILED @${j.stage}:`, JSON.stringify(j.error));
    throw new Error(label + ' failed');
  }
  console.log(`${label} : requestId=${j.requestId} requireConfirmation=${j.requireConfirmation}`);
  console.log(`${label} : tx=${j.result && j.result.txHash}`);
  if (j.preview && j.preview.balanceChanges) {
    for (const b of j.preview.balanceChanges) console.log(`          模拟变动 ${b.contractAddress} ${b.change}`);
  }
  const rc = await P.waitReceipt(j.result.txHash);
  console.log(`${label} : status=${rc.ok ? 'OK' : 'REVERT'} block=${rc.blockNumber} gasUsed=${Number(BigInt(rc.gasUsed))}`);
  if (!rc.ok) throw new Error(label + ' reverted');
  return j.result.txHash;
}

if (fund.ALLOWANCE_OK !== '1') {
  await send(info.quote, P.approveData(info.market, gross), 'approve');
  fund = await P.readFunding(info.probe, gross, WALLET);
  console.log('funding2 : BALANCE_OK=' + fund.BALANCE_OK + ' ALLOWANCE_OK=' + fund.ALLOWANCE_OK);
  if (fund.ALLOWANCE_OK !== '1') throw new Error('授权后仍未生效');
}

const plan = await P.planBuy(info.probe, gross, SLIP, WALLET);
console.log('plan     : BUY_SHARES=' + P.formatUnits(plan.BUY_SHARES, 18) + ' MIN_SHARES=' + P.formatUnits(plan.MIN_SHARES, 18));
await send(P.PORTAL, P.buyData(info.market, gross, plan.MIN_SHARES), 'buy');

const after = await P.readStatus(info.probe, WALLET);
console.log('after    : HELD_SHARES=' + after.pos.HELD_SHARES + ' (' + P.formatUnits(after.pos.HELD_SHARES, 18) + ')');
const bal = await P.erc20Balance(info.quote, WALLET);
console.log('balance  : ' + P.formatUnits(bal, info.decimals) + ' QUOTE');
console.log('DONE');
