// test-protocol.mjs — 用同一份 protocol.js 在 Node 里跑只读流程，验证 ABI/解码是否正确。
// 只做 eth_call，不发任何交易。
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const TOKEN = process.env.TOKEN || '0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777';

const ok = (s) => console.log('  ✔ ' + s);

console.log('wallet =', WALLET);
console.log('token  =', TOKEN);

const info = await P.resolveToken(TOKEN, WALLET);
ok(`probe  = ${info.probe}`);
ok(`market = ${info.market}`);
ok(`quote  = ${info.quote} (decimals=${info.decimals})`);

const st = await P.readStatus(info.probe, WALLET);
ok(`PHASE=${st.status.PHASE} BUY_OK=${st.status.BUY_OK}`);
ok(`HELD_SHARES=${st.pos.HELD_SHARES} SELL_OK=${st.pos.SELL_OK}`);
ok(`ROOM_SHARES=${P.formatUnits(st.cap.ROOM_SHARES, 18)}  ID=${st.cap.ID}`);

const gross = P.parseUnitsStrict('0.5', info.decimals);
const fund = await P.readFunding(info.probe, gross, WALLET);
ok(`quoteFundingProbe(0.5) → BALANCE_OK=${fund.BALANCE_OK} ALLOWANCE_OK=${fund.ALLOWANCE_OK} BLOCK=${fund.BLOCK}`);

const buyPlan = await P.planBuy(info.probe, gross, 100, WALLET);
ok(`buyPlan → BUY_SHARES=${P.formatUnits(buyPlan.BUY_SHARES, 18)} MIN_SHARES=${P.formatUnits(buyPlan.MIN_SHARES, 18)}`);

if (BigInt(st.pos.HELD_SHARES) > 0n) {
  const sellPlan = await P.planSell(info.probe, 10000, 100, WALLET);
  ok(`sellPlan → OUT=${P.formatUnits(sellPlan.OUT_RAW, info.decimals)} MIN=${P.formatUnits(sellPlan.MIN_RAW, info.decimals)}`);
} else {
  console.log('  · 无持仓，跳过 sellPlanCustomProbe');
}

console.log('\ncalldata 样例（不发送）:');
console.log('  approve :', P.approveData(info.market, gross));
console.log('  buy     :', P.buyData(info.market, gross, buyPlan.MIN_SHARES));
console.log('  sell    :', P.sellData(info.market, 10000, '0'));
console.log('\n全部只读探测通过。');
