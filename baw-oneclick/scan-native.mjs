// scan-native.mjs — 找 QUOTE=0 且 PHASE=1（内盘开放）的 market
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const pad = (n) => BigInt(n).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const call = (to, data) => P.rpc('eth_call', [{ to, data }, 'latest']);

const count = Number(BigInt(await call(P.FACTORY, '0xec979082')));
const markets = [];
for (let i = 0; i < count; i++) markets.push('0x' + (await call(P.FACTORY, '0xb1283e77' + pad(i))).slice(-40));

const out = [];
for (const market of markets) {
  try {
    const probe = '0x' + (await call(P.FACTORY, '0xf2881e63' + padAddr(market))).slice(-40);
    if (probe === P.ZERO_ADDRESS) continue;
    const a = await P.probe(probe, P.SEL.assetProbe, [], WALLET);
    if (!/^0x0{40}$/i.test(a.QUOTE)) continue;
    const st = await P.probe(probe, P.SEL.actionStatusProbe, [], WALLET);
    out.push({ market, probe, phase: st.PHASE, buyOk: st.BUY_OK, token: st.TOKEN });
  } catch (e) {
    out.push({ market, error: e.message });
  }
}

console.log('native markets =', out.length);
for (const r of out) {
  console.log(`${r.market}  probe=${r.probe}  PHASE=${r.phase}  BUY_OK=${r.buyOk}  TOKEN=${r.token}`);
}
const open = out.filter((r) => r.phase === '1');
console.log('\nopen (PHASE=1) native =', open.length);
for (const r of open) console.log('  OPEN:', r.market, r.probe, 'BUY_OK=' + r.buyOk);
