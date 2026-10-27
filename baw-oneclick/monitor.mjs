// monitor.mjs — 监听 four.meme v2 路由的新盘（链上日志，不依赖前端页面）
//
// 用法:
//   node monitor.mjs --discover            # 扫最近 200 块，打印日志里出现的候选地址
//   node monitor.mjs --watch               # 常驻监听，发现新盘就打印
//   node monitor.mjs --watch --buy 0.01    # 发现即用私钥买（需要 PK 环境变量）
//
// 环境变量: PK=0x...（私钥，仅 --buy 时需要）  QUOTE_FILTER=BNB,BNCB,BNC4（默认全部）
import * as P from './protocol.js';
import { JsonRpcProvider, Wallet, keccak256 } from 'ethers';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const ROUTER = P.FOUR_ROUTER;
const BUY = has('--buy') ? val('--buy', null) : null;
const PK = process.env.PK || null;
const QUOTE_FILTER = (process.env.QUOTE_FILTER || '').split(',').filter(Boolean);

const provider = new JsonRpcProvider(RPC, 56, { staticNetwork: true });
const seen = new Set();
const t0 = Date.now();
const ts = () => new Date().toISOString().slice(11, 23);

async function tokenInfo(addr) {
  try { return await P.fourMemeInfo(addr); } catch { return null; }
}

// 从一条 log 里抽出所有「长得像地址」的 32 字节字
function candidatesOf(log) {
  const out = new Set();
  const words = [...(log.topics || []).slice(1), ...((log.data || '0x').slice(2).match(/.{64}/g) || [])];
  for (const w of words) {
    if (!w || w.length !== 64) continue;
    if (w.slice(0, 24) !== '0'.repeat(24)) continue; // 高 12 字节必须为 0
    const a = '0x' + w.slice(24);
    if (/^0x0{40}$/.test(a)) continue;
    out.add(a.toLowerCase());
  }
  return [...out];
}

async function scanBlock(n) {
  const logs = await provider.getLogs({ address: ROUTER, fromBlock: n, toBlock: n });
  const found = [];
  for (const log of logs) {
    for (const cand of candidatesOf(log)) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      const info = await tokenInfo(cand);
      if (info) {
        const qSym = await P.erc20Symbol(info.quote).catch(() => null);
        found.push({ token: cand, quote: qSym || '?', native: info.quote.toLowerCase() === P.WBNB.toLowerCase(), status: info.status, block: n });
      }
    }
  }
  return found;
}

async function buy(token, amountEth) {
  const w = new Wallet(PK, provider);
  const value = P.parseUnitsStrict(amountEth, 18);
  const data = P.fourBuyData(token, value, 0n);
  const [nonce, fee, gas] = await Promise.all([
    provider.getTransactionCount(w.address, 'pending'),
    provider.getFeeData(),
    provider.estimateGas({ from: w.address, to: ROUTER, data, value }),
  ]);
  const raw = await w.signTransaction({ to: ROUTER, data, value, nonce, gasLimit: (gas * 130n) / 100n, gasPrice: fee.gasPrice ?? 1000000000n, chainId: 56, type: 0 });
  const hash = keccak256(raw);
  await provider.broadcastTransaction(raw);
  return hash;
}

function report(list) {
  for (const it of list) {
    if (QUOTE_FILTER.length && !QUOTE_FILTER.includes(it.quote)) continue;
    console.log(`[${ts()}] 新盘 ${it.token}  quote=${it.quote}${it.native ? '(原生)' : ''}  status=${it.status}  block=${it.block}  +${Date.now() - t0}ms`);
    if (BUY && PK) {
      buy(it.token, BUY).then((h) => console.log(`[${ts()}] 买入 ${it.token} ${BUY} BNB → ${h}`)).catch((e) => console.log(`[${ts()}] 买入失败 ${it.token}: ${e.shortMessage || e.message}`));
    }
  }
}

const latest = await provider.getBlockNumber();
if (has('--discover')) {
  const span = Number(val('--blocks', '200'));
  console.log(`扫描 ${latest - span + 1}..${latest} 的路由日志…`);
  for (let n = latest - span + 1; n <= latest; n++) report(await scanBlock(n));
  console.log(`完成，候选地址 ${seen.size} 个`);
} else if (has('--watch')) {
  console.log(`监听 ${ROUTER} 新块（buy=${BUY || 'off'}）…`);
  let last = latest;
  setInterval(async () => {
    try {
      const now = await provider.getBlockNumber();
      for (let n = last + 1; n <= now; n++) report(await scanBlock(n));
      last = now;
    } catch (e) { console.error('loop:', e.shortMessage || e.message); }
  }, 1200);
} else {
  console.log('用法: node monitor.mjs --discover | --watch [--buy 0.01]');
}
