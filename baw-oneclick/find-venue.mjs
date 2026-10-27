// find-venue.mjs — 通过 Transfer 日志找这个代币的真实交易场所（池子/曲线合约）
const RPC = 'https://bsc-dataseed.binance.org';
const TOKEN = '0x3bdf234051a86166f00a5b72c3ddd7fd1b9fffff';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
}

const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
console.log('latest block', latest);

const spans = [[latest - 2000, latest], [latest - 20000, latest - 2000]];
const counts = new Map();
let total = 0;
for (const [from, to] of spans) {
  try {
    const logs = await rpc('eth_getLogs', [{ address: TOKEN, topics: [TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    console.log(`blocks ${from}-${to}: ${logs.length} transfers`);
    for (const l of logs) {
      total++;
      for (const t of l.topics.slice(1, 3)) {
        const a = '0x' + t.slice(26).toLowerCase();
        if (/^0x0{40}$/.test(a)) continue;
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
  } catch (e) { console.log('range fail', from, to, e.message); }
}
console.log('total transfers', total, 'addresses', counts.size);

const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [addr, n] of top) {
  let size = 0;
  try { size = ((await rpc('eth_getCode', [addr, 'latest'])).length - 2) / 2; } catch {}
  console.log(`${addr}  transfers=${n}  code=${size}B`);
}
