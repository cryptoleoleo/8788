// native-cycle.mjs — 原生 BNB 池：真实买 0.001 BNB，然后立刻全卖，验证买卖两端
import * as P from './protocol.js';

const BASE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const MARKET = process.env.MARKET || '0xef77eb3f3c185076d77d928465bc265d436512a9';
const AMOUNT = process.env.AMOUNT || '0.001';
const SLIP = Number(process.env.SLIP || '100');

const html = await (await fetch(BASE + '/')).text();
const token = html.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/)[1];
const bridge = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-bridge-token': token, ...(o.headers || {}) } });
  return r.json();
};

async function send(to, data, label, value = 0n) {
  const j = await bridge('/api/send', { method: 'POST', body: JSON.stringify({ to, data, value: value.toString() }) });
  if (!j.ok) {
    console.log(`${label} FAILED:`, JSON.stringify(j.error));
    throw new Error(label + ' failed');
  }
  console.log(`${label}: tx=${j.result.txHash} requireConfirmation=${j.requireConfirmation}`);
  const rc = await P.waitReceipt(j.result.txHash);
  console.log(`${label}: status=${rc.ok ? 'OK' : 'REVERT'} block=${rc.blockNumber} gasUsed=${Number(BigInt(rc.gasUsed))}`);
  if (!rc.ok) throw new Error(label + ' reverted');
  return rc;
}

const probe = '0x' + (await P.rpc('eth_call', [{ to: P.FACTORY, data: '0xf2881e63' + MARKET.slice(2).padStart(64, '0') }, 'latest'])).slice(-40);
console.log('market =', MARKET, '\nprobe  =', probe);
const status = await P.probe(probe, P.SEL.actionStatusProbe, [], WALLET);
console.log('PHASE  =', status.PHASE, 'BUY_OK =', status.BUY_OK);
if (status.PHASE !== '1' || status.BUY_OK !== '1') throw new Error('状态不允许买入');

const bnb0 = await P.nativeBalance(WALLET);
const gross = P.parseUnitsStrict(AMOUNT, 18);
console.log('BNB 余额 =', P.formatUnits(bnb0, 18), ' 本次买入 =', AMOUNT);

const plan = await P.planBuy(probe, gross, SLIP, WALLET);
console.log('plan: BUY_SHARES=' + P.formatUnits(plan.BUY_SHARES, 18) + ' MIN_SHARES=' + P.formatUnits(plan.MIN_SHARES, 18));

await send(P.PORTAL, P.buyNativeData(MARKET, plan.MIN_SHARES), 'BUY (native)', gross);

const pos = await P.probe(probe, P.SEL.positionProbe, [], WALLET);
console.log('after buy: HELD_SHARES=' + pos.HELD_SHARES + ' SELL_OK=' + pos.SELL_OK + ' PHASE=' + pos.PHASE);
const bnb1 = await P.nativeBalance(WALLET);
console.log('BNB 余额 =', P.formatUnits(bnb1, 18));

if (BigInt(pos.HELD_SHARES) === 0n) { console.log('没有拿到份额，停止'); process.exit(1); }

const sellPlan = await P.planSell(probe, 10000, SLIP, WALLET);
const out = sellPlan.OUT_RAW ?? sellPlan.OUT_WEI;
const min = sellPlan.MIN_RAW ?? sellPlan.MIN_WEI;
console.log('sell plan: SHARES=' + P.formatUnits(sellPlan.SHARES, 18) + ' OUT=' + P.formatUnits(out, 18) + ' MIN=' + P.formatUnits(min, 18));

await send(P.PORTAL, P.sellData(MARKET, 10000, min), 'SELL (native)');

const pos2 = await P.probe(probe, P.SEL.positionProbe, [], WALLET);
const bnb2 = await P.nativeBalance(WALLET);
console.log('after sell: HELD_SHARES=' + pos2.HELD_SHARES);
console.log('BNB 余额 =', P.formatUnits(bnb2, 18), '(净变化 ' + P.formatUnits(bnb2 - bnb0, 18) + ')');
console.log('DONE');
