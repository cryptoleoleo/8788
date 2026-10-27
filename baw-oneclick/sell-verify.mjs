// sell-verify.mjs — 用 protocol.js 生成全量卖出的 calldata（MIN_RAW 取自新鲜计划）
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const TOKEN = process.env.TOKEN || '0x7E200C5E723F84edbCf5Cd8D76A0dbF2A8127777';
const BPS = Number(process.env.BPS || '10000');
const SLIP = Number(process.env.SLIP || '100');

const info = await P.resolveToken(TOKEN, WALLET);
const pos = await P.probe(info.probe, P.SEL.positionProbe, [], WALLET);
console.log('HELD_SHARES   :', pos.HELD_SHARES);
console.log('SELL_OK       :', pos.SELL_OK, 'PHASE:', pos.PHASE);
if (pos.PHASE !== '1') throw new Error('PHASE != 1');
if (pos.SELL_OK !== '1') throw new Error('SELL_OK != 1');
if (BigInt(pos.HELD_SHARES) === 0n) throw new Error('份额为 0');

const plan = await P.planSell(info.probe, BPS, SLIP, WALLET);
console.log('SHARES        :', plan.SHARES);
console.log('OUT_RAW       :', plan.OUT_RAW, '(', P.formatUnits(plan.OUT_RAW, info.decimals), 'BNCB )');
console.log('MIN_RAW       :', plan.MIN_RAW, '(', P.formatUnits(plan.MIN_RAW, info.decimals), 'BNCB )');
console.log('BLOCK         :', plan.BLOCK);

const data = P.sellData(info.market, BPS, plan.MIN_RAW);
console.log('SELL_DATA=' + data);
console.log('MARKET=' + info.market);
console.log('DONE');
