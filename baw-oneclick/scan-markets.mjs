// scan-markets.mjs — 枚举 Factory 里所有 market，找出 QUOTE=0（原生 BNB）的池子
import * as P from './protocol.js';

const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';
const FACTORY = P.FACTORY;

const pad = (n) => BigInt(n).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function call(to, data) {
  return P.rpc('eth_call', [{ to, data }, 'latest']);
}

const countWord = await call(FACTORY, '0xec979082');
const count = Number(BigInt(countWord));
console.log('marketCount =', count);

const markets = [];
for (let i = 0; i < count; i++) {
  const w = await call(FACTORY, '0xb1283e77' + pad(i));
  markets.push('0x' + w.slice(-40));
}
console.log('enumerated  =', markets.length);

const rows = [];
for (const market of markets) {
  try {
    const w = await call(FACTORY, '0xf2881e63' + padAddr(market));
    const probe = '0x' + w.slice(-40);
    if (probe === P.ZERO_ADDRESS) continue;
    const a = await P.probe(probe, P.SEL.assetProbe, [], WALLET);
    rows.push({ market, probe, quote: a.QUOTE, decimals: a.DECIMALS, marketReported: a.MARKET });
  } catch (e) {
    rows.push({ market, error: e.message });
  }
}

const native = rows.filter((r) => r.quote && /^0x0{40}$/i.test(r.quote));
console.log('total probes =', rows.length, ' native(QUOTE=0) =', native.length);
console.log('\n--- native markets ---');
for (const r of native) console.log(`${r.market}  probe=${r.probe}  decimals=${r.decimals}`);

const erc20 = rows.filter((r) => r.quote && !/^0x0{40}$/i.test(r.quote));
console.log('\n--- erc20 markets (前 5) ---');
for (const r of erc20.slice(0, 5)) console.log(`${r.market}  quote=${r.quote}`);
console.log('\nDONE');
