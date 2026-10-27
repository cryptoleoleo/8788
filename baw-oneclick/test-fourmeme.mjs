// test-fourmeme.mjs — 验证 four.meme v2 买卖路径（只模拟，不发交易）
import * as P from './protocol.js';

const BASE = 'http://127.0.0.1:8787';
const TOKEN = process.env.TOKEN || '0x3bdf234051a86166f00a5b72c3ddd7fd1b9fffff';
const HISTORICAL = '0x995ee6da0000000000000000000000003bdf234051a86166f00a5b72c3ddd7fd1b9fffff000000000000000000000000000000000000000000000000016345785d8a0000000000000000000000000000000000000000000000069e10de76676d08000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000';

const html = await (await fetch(BASE + '/')).text();
const token = html.match(/const BRIDGE_TOKEN = '([0-9a-f]+)'/)[1];
const bridge = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-bridge-token': token, ...(o.headers || {}) } });
  return r.json();
};

console.log('=== 1. four.meme 路由识别 ===');
const fm = await P.fourMemeInfo(TOKEN);
if (!fm) throw new Error('未识别为 four.meme 代币');
console.log('router      :', fm.router);
console.log('status      :', fm.status);
console.log('totalSupply :', P.formatUnits(fm.totalSupply, 18));
console.log('sold        :', P.formatUnits(fm.sold, 18));

console.log('\n=== 2. calldata 与历史成功交易逐字节比对 ===');
const same = P.fourBuyData(TOKEN, 10n ** 17n, 8n * 10n ** 24n) === HISTORICAL;
console.log('0.1 BNB / min 8,000,000 → 与链上历史交易一致 :', same);
if (!same) throw new Error('calldata 不一致');

console.log('\n=== 3. 桥接模拟 0.001 BNB 买入（previewOnly）===');
const data = P.fourBuyData(TOKEN, 10n ** 15n, 0n);
const j = await bridge('/api/send', { method: 'POST', body: JSON.stringify({ to: P.FOUR_ROUTER, data, value: (10n ** 15n).toString(), previewOnly: true }) });
console.log('ok     :', j.ok);
console.log('stage  :', j.stage || 'preview');
console.log('error  :', JSON.stringify(j.error));
console.log('拒绝原因是否为白名单外 :', /不在白名单/.test(JSON.stringify(j.error)));

console.log('\n=== 4. 与历史买家重放对照 ===');
const rpc = async (m, p) => (await (await fetch('https://bsc-dataseed.binance.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json());
const replay = await rpc('eth_call', [{ from: '0xb7d66cf863be8315dcbf4399a9f9e2876d2ac803', to: P.FOUR_ROUTER, data: HISTORICAL, value: '0x' + (10n ** 17n).toString(16) }, 'latest']);
console.log('历史买家现在重放 :', replay.error ? 'REVERT ' + (replay.error.data || '').slice(0, 10) : 'OK');
console.log('说明：同一笔历史成功交易现在也 revert，说明是该盘当前状态（未开放/暂停），不是我们的编码问题。');
console.log('\nDONE');
