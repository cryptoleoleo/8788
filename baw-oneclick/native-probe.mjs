// native-probe.mjs — 读一个 QUOTE=0（原生 BNB）市场的 Probe 读数
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const MARKET = process.env.MARKET || '0xaacb16af918a1d63b666109eb6b89090412f4968';
const GROSS = process.env.GROSS || '1000000000000000'; // 0.001 BNB
const SLIP = process.env.SLIP || '100';

const w = await P.rpc('eth_call', [{ to: P.FACTORY, data: '0xf2881e63' + MARKET.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest']);
const probe = '0x' + w.slice(-40);
console.log('market =', MARKET);
console.log('probe  =', probe);

const asset = await P.probe(probe, P.SEL.assetProbe, [], WALLET);
console.log('asset  :', JSON.stringify(asset));

const st = await P.probe(probe, P.SEL.actionStatusProbe, [], WALLET);
console.log('status :', JSON.stringify(st));

const cap = await P.probe(probe, P.SEL.buyCapacityProbe, [], WALLET);
console.log('cap    :', JSON.stringify(cap));

const fund = await P.probe(probe, P.SEL.quoteFundingProbe, [BigInt(GROSS)], WALLET);
console.log('fund   :', JSON.stringify(fund));

try {
  const plan = await P.probe(probe, P.SEL.buyPlanProbe, [BigInt(GROSS), BigInt(SLIP)], WALLET);
  console.log('plan   :', JSON.stringify(plan));
  const data = '0xcce7ec13'
    + MARKET.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    + BigInt(plan.MIN_SHARES).toString(16).padStart(64, '0');
  console.log('BUY_DATA(buy(market,minShares)) =', data);
  console.log('MIN_SHARES =', plan.MIN_SHARES);
  console.log('BUY_SHARES =', plan.BUY_SHARES);
} catch (e) {
  console.log('plan ERR:', e.message);
}

const pos = await P.probe(probe, P.SEL.positionProbe, [], WALLET);
console.log('position:', JSON.stringify(pos));
