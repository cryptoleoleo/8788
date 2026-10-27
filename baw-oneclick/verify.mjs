// verify.mjs — 用 plugin 的 protocol.js 走一遍完整流程（只读 + 生成 calldata），
// 输出的 calldata 再交给钱包做一次真实模拟（preview），用来验证插件编码正确。
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const TOKEN = process.env.TOKEN || '0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777';
const AMOUNT = process.env.AMOUNT || '0.5';
const SLIP = Number(process.env.SLIP || '100');

const out = (k, v) => console.log(`${k.padEnd(14)}: ${v}`);

console.log('=== 1. 解析（只给 CA） ===');
const info = await P.resolveToken(TOKEN, WALLET);
out('token', info.token);
out('probe', info.probe);
out('market', info.market);
out('quote', `${info.quote} (${info.decimals} 位)`);

console.log('\n=== 2. 状态 ===');
const st = await P.readStatus(info.probe, WALLET);
out('PHASE', st.status.PHASE);
out('BUY_OK', st.status.BUY_OK);
out('SELL_OK', st.pos.SELL_OK);
out('HELD_SHARES', P.formatUnits(st.pos.HELD_SHARES, 18));
out('ROOM_SHARES', P.formatUnits(st.cap.ROOM_SHARES, 18));
if (st.status.PHASE !== '1') throw new Error('PHASE != 1');
if (st.status.BUY_OK !== '1') throw new Error('BUY_OK != 1');

console.log('\n=== 3. 资金 + 计划 ===');
const gross = P.parseUnitsStrict(AMOUNT, info.decimals);
out('grossRaw', gross.toString());
const fund = await P.readFunding(info.probe, gross, WALLET);
out('BALANCE_OK', fund.BALANCE_OK);
out('ALLOWANCE_OK', fund.ALLOWANCE_OK);
if (fund.BALANCE_OK !== '1') throw new Error('余额不足');
const plan = await P.planBuy(info.probe, gross, SLIP, WALLET);
out('RULES_OK', plan.RULES_OK);
out('BUY_SHARES', P.formatUnits(plan.BUY_SHARES, 18));
out('MIN_SHARES', P.formatUnits(plan.MIN_SHARES, 18));

console.log('\n=== 4. 插件生成的 calldata ===');
const approve = P.approveData(info.market, gross);
const buy = P.buyData(info.market, gross, plan.MIN_SHARES);
out('approve', approve);
out('buy', buy);

console.log('\nAPPROVE_DATA=' + approve);
console.log('BUY_DATA=' + buy);
console.log('MARKET=' + info.market);
console.log('QUOTE=' + info.quote);
console.log('MIN_SHARES=' + plan.MIN_SHARES.toString());
console.log('DONE');
