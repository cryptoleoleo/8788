// native-test.mjs — 验证原生 BNB 池：解析 + 桥模拟（不发送）
import * as P from './protocol.js';

const BASE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const WALLET = process.env.WALLET || '0x0000000000000000000000000000000000000000';

const html = await (await fetch(BASE + '/')).text();
const token = html.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/)[1];
const bridge = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-bridge-token': token, ...(o.headers || {}) } });
  return r.json();
};

console.log('=== 1. 解析原生池代币（已发射的 native token）===');
const nativeToken = '0x7832c85c1910945d54494424f606e90c92cf7777';
const info = await P.resolveToken(nativeToken, WALLET);
console.log('probe  =', info.probe);
console.log('market =', info.market);
console.log('quote  =', info.quote, '(原生 BNB)' , 'decimals=' + info.decimals);
const st = await P.readStatus(info.probe, WALLET);
console.log('PHASE  =', st.status.PHASE, 'BUY_OK =', st.status.BUY_OK);

console.log('\n=== 2. 打开中的原生池：读计划 ===');
const market = '0xef77eb3f3c185076d77d928465bc265d436512a9';
const probe = '0x' + (await P.rpc('eth_call', [{ to: P.FACTORY, data: '0xf2881e63' + market.slice(2).padStart(64, '0') }, 'latest'])).slice(-40);
const gross = P.parseUnitsStrict('0.001', 18);
const status = await P.probe(probe, P.SEL.actionStatusProbe, [], WALLET);
console.log('market =', market);
console.log('probe  =', probe);
console.log('PHASE  =', status.PHASE, 'BUY_OK =', status.BUY_OK);
const plan = await P.planBuy(probe, gross, 100, WALLET);
console.log('plan   : BUY_SHARES=' + P.formatUnits(plan.BUY_SHARES, 18) + ' MIN_SHARES=' + P.formatUnits(plan.MIN_SHARES, 18));

console.log('\n=== 3. 桥模拟原生买入（previewOnly，value=0.001 BNB）===');
const data = P.buyNativeData(market, plan.MIN_SHARES);
const j = await bridge('/api/send', { method: 'POST', body: JSON.stringify({ to: P.PORTAL, data, value: gross.toString(), previewOnly: true }) });
console.log('ok       =', j.ok);
console.log('preview  =', JSON.stringify(j.preview && j.preview.balanceChanges));
console.log('parsedTx =', JSON.stringify(j.preview && j.preview.parsedTx));

console.log('\n=== 4. 安全校验：非原生买入带 value 应被拒 ===');
const sellData = P.sellData(market, 10000, 0);
const bad = await bridge('/api/send', { method: 'POST', body: JSON.stringify({ to: P.PORTAL, data: sellData, value: '1000', previewOnly: true }) });
console.log('rejected =', bad.ok === false, '|', bad.error && bad.error.message);

console.log('\nDONE');
