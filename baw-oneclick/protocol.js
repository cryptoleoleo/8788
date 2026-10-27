// protocol.js — BNCB 内盘（Portal / Probe）只读解析 + calldata 构造
// 纯 ESM，无依赖：浏览器与 Node 18+ 均可直接 import。
//
// 关键设计：*Probe 系列方法全部是 nonpayable 且“故意 revert”，
// 返回值通过 Error(string) 传递 —— 因此必须走 eth_call 并解析 error.data，
// 绝对不要对这些方法发交易。

export const CHAIN_ID = 56;
export const CHAIN_ID_HEX = '0x38';

export const RPC_URLS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://1rpc.io/bnb',
];

export const FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e';
export const PORTAL = '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062';
export const READER = '0x18Aa6C93f1887a243fdc348C9A77F5136555174a';

// four.meme v2 交易路由（buy/sell 都走它）
export const FOUR_ROUTER = '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const SEL = {
  // READER / FACTORY 解析
  probeOfToken: '0x2b2fe672',
  marketOfToken: '0x73c170b5',
  probeOfMarket: '0xf2881e63',
  marketCount: '0xec979082',
  // PROBE（revert-string 读数）
  market: '0x80f55605',
  assetProbe: '0x80c8c302',
  pingProbe: '0x62dedb93',
  actionStatusProbe: '0x331e21da',
  buyCapacityProbe: '0x593d2a74',
  quoteFundingProbe: '0x5403449d',
  buyPlanProbe: '0x0f803438',
  quoteBuyProbe: '0xd620e44d',
  positionProbe: '0x68036cac',
  sharesProbe: '0x0ef4fec1',
  sellPlanCustomProbe: '0xcceb5cad',
  // PORTAL
  buyWithQuote: '0xa7c893c4',
  buyNative: '0xcce7ec13',
  sellBps: '0x2f9d7c27',
  // ERC20
  approve: '0x095ea7b3',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  // four.meme v2 router
  fourTokens: '0xe4860339',
  fourBuy: '0x995ee6da',
  fourSell: '0x8bfc7764',
};

/* ---------------- 编码 ---------------- */

export function padUint(value) {
  const v = BigInt(value);
  if (v < 0n) throw new Error('负数不合法');
  return v.toString(16).padStart(64, '0');
}

export function padAddr(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('地址格式错误: ' + addr);
  return addr.toLowerCase().slice(2).padStart(64, '0');
}

export function encodeCall(selector, args = []) {
  return selector + args.map((a) => (a && a.__addr ? padAddr(a.v) : padUint(a))).join('');
}

const A = (v) => ({ __addr: true, v });
const U = (v) => BigInt(v);

export function approveData(spender, amount) {
  return encodeCall(SEL.approve, [A(spender), U(amount)]);
}

export function buyData(market, grossQuote, minShares) {
  return encodeCall(SEL.buyWithQuote, [A(market), U(grossQuote), U(minShares)]);
}

// 原生 BNB 池：buy(market, minShares) 且 msg.value = gross（单位 wei）
export function buyNativeData(market, minShares) {
  return encodeCall(SEL.buyNative, [A(market), U(minShares)]);
}

export function sellData(market, shareBps, minOut) {
  return encodeCall(SEL.sellBps, [A(market), U(shareBps), U(minOut)]);
}

/* ---------------- 数值 ---------------- */

export function parseUnitsStrict(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金额格式错误（只能是正数）');
  const [intPart, fracRaw = ''] = s.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`小数位超过 ${decimals}（拒绝四舍五入，请自己截断）`);
  }
  const frac = fracRaw.padEnd(decimals, '0');
  const v = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  if (v <= 0n) throw new Error('金额必须大于 0');
  return v;
}

export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

/* ---------------- RPC ---------------- */

// 记住最近一次成功的节点，后续优先用它；带超时 + 自动换节点
let goodRpc = null;
let lastRpcInfo = { url: null, ms: null };

async function postOne(url, method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // JSON-RPC 业务错误（revert 等）不是节点问题，直接返回，不再换节点
    if (json.error) return { error: json.error, url, ms: Date.now() - started };
    return { result: json.result, url, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function rpcRaw(method, params, { timeoutMs = 9000 } = {}) {
  const order = goodRpc ? [goodRpc, ...RPC_URLS.filter((u) => u !== goodRpc)] : RPC_URLS;
  let lastErr;
  for (const url of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await postOne(url, method, params, timeoutMs);
        goodRpc = url;
        lastRpcInfo = { url, ms: out.ms };
        return out;
      } catch (e) {
        lastErr = e;
        if (e && e.name === 'AbortError') lastErr = new Error('RPC 超时 ' + timeoutMs + 'ms');
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }
  throw new Error('所有 RPC 都失败: ' + (lastErr && lastErr.message));
}

export function rpcInfo() {
  return { ...lastRpcInfo, cached: goodRpc };
}

export async function rpcHealth() {
  const t0 = Date.now();
  const block = await rpc('eth_blockNumber', []);
  return { block: BigInt(block), ms: Date.now() - t0, url: lastRpcInfo.url };
}

export async function rpc(method, params) {
  const { result, error } = await rpcRaw(method, params);
  if (error) throw new Error(error.message || JSON.stringify(error));
  return result;
}

export async function ethCall(to, data, from) {
  const call = { to, data };
  if (from) call.from = from;
  const { result, error } = await rpcRaw('eth_call', [call, 'latest']);
  if (error) throw new Error(error.message || JSON.stringify(error));
  return result;
}

/* ---------------- revert-string 解码 ---------------- */

export function decodeRevertData(err) {
  let hex = err && err.data;
  if (hex && typeof hex === 'object') hex = hex.data ?? hex.result ?? null;
  if (typeof hex === 'string' && hex.startsWith('0x')) {
    const b = hex.slice(2);
    if (b.slice(0, 8).toLowerCase() === '08c379a0') {
      const len = parseInt(b.slice(72, 136), 16);
      return BufferLike.utf8(b.slice(136, 136 + len * 2));
    }
    if (b.slice(0, 8).toLowerCase() === '4e487b71') return 'PANIC:0x' + b.slice(8);
    return null;
  }
  // 部分 RPC 把 reason 塞在 message 里： "execution reverted: XXX"
  const msg = err && err.message ? String(err.message) : '';
  const m = msg.match(/execution reverted:\s*(.+)$/);
  if (m) return m[1].trim();
  return null;
}

const BufferLike = {
  utf8(hex) {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    try {
      return decodeURIComponent(escape(out));
    } catch {
      return out;
    }
  },
};

export function parseReading(text, requiredFields = []) {
  if (!text || typeof text !== 'string') throw new Error('读数不可读（空）');
  if (text.includes('MARKET_NOT_OPEN')) throw new Error('内盘已关闭（MARKET_NOT_OPEN），不能从内盘买入/卖出');
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts[parts.length - 1] !== 'END') throw new Error('读数不完整（缺少 ;END）: ' + text);
  const out = {};
  for (const p of parts.slice(0, -1)) {
    const i = p.indexOf('=');
    if (i < 0) throw new Error('字段格式错误: ' + p);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  for (const f of requiredFields) {
    if (out[f] === undefined) throw new Error(`读数缺少字段 ${f}: ${text}`);
  }
  return out;
}

/* ---------------- Probe 读取 ---------------- */

export async function probe(probeAddr, selector, args = [], from) {
  const data = encodeCall(selector, args);
  const call = { to: probeAddr, data, value: '0x0' };
  if (from) call.from = from;
  const { result, error } = await rpcRaw('eth_call', [call, 'latest']);
  if (!error) throw new Error('Probe 意外正常返回（应为 revert 字符串）: ' + result);
  const text = decodeRevertData(error);
  if (!text) throw new Error('无法解码 Probe revert: ' + JSON.stringify(error));
  return parseReading(text);
}

/* ---------------- 业务步骤 ---------------- */

export async function resolveToken(tokenCA, wallet) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenCA)) throw new Error('代币 CA 格式错误');

  // 两个解析请求并发，省一个 RTT
  const [probeWord, marketWord] = await Promise.all([
    ethCall(READER, encodeCall(SEL.probeOfToken, [A(tokenCA)])),
    ethCall(FACTORY, encodeCall(SEL.marketOfToken, [A(tokenCA)])),
  ]);
  const probeAddr = '0x' + probeWord.slice(-40);
  const marketAddr = '0x' + marketWord.slice(-40);
  if (probeAddr === ZERO_ADDRESS) throw new Error('这个 CA 没有注册 Probe（不是内盘代币，或还没创建市场）');
  if (marketAddr === ZERO_ADDRESS) throw new Error('这个 CA 没有绑定 Market');

  // 绑定校验：Probe.market() 必须等于 Market，assetProbe 必须一致 —— 防钓鱼
  const [probeMarketWord, asset] = await Promise.all([
    ethCall(probeAddr, SEL.market),
    probe(probeAddr, SEL.assetProbe, [], wallet),
  ]);
  if ('0x' + probeMarketWord.slice(-40) !== marketAddr) throw new Error('绑定校验失败：Probe.market() != Market');
  if (asset.MARKET.toLowerCase() !== marketAddr.toLowerCase()) throw new Error('assetProbe.MARKET 不匹配');
  const native = asset.QUOTE === ZERO_ADDRESS;
  const decimals = Number(asset.DECIMALS);
  if (!Number.isFinite(decimals)) throw new Error('DECIMALS 不可读');

  return { token: tokenCA, probe: probeAddr, market: marketAddr, quote: asset.QUOTE, decimals, native };
}

export async function readStatus(probeAddr, wallet) {
  const [status, cap, pos, shares] = await Promise.all([
    probe(probeAddr, SEL.actionStatusProbe, [], wallet),
    probe(probeAddr, SEL.buyCapacityProbe, [], wallet),
    probe(probeAddr, SEL.positionProbe, [], wallet),
    probe(probeAddr, SEL.sharesProbe, [], wallet),
  ]);
  return { status, cap, pos, shares };
}

export async function readFunding(probeAddr, grossRaw, wallet) {
  return probe(probeAddr, SEL.quoteFundingProbe, [U(grossRaw)], wallet);
}

export async function planBuy(probeAddr, grossRaw, slippageBps, wallet) {
  const plan = await probe(probeAddr, SEL.buyPlanProbe, [U(grossRaw), U(slippageBps)], wallet);
  for (const f of ['MIN_SHARES', 'BUY_SHARES', 'RULES_OK', 'BLOCK']) {
    if (plan[f] === undefined) throw new Error('买计划缺字段 ' + f);
  }
  if (plan.RULES_OK !== '1') throw new Error('RULES_OK != 1：' + JSON.stringify(plan));
  return plan;
}

export async function planSell(probeAddr, shareBps, slippageBps, wallet) {
  const plan = await probe(probeAddr, SEL.sellPlanCustomProbe, [U(shareBps), U(slippageBps)], wallet);
  if (plan.SHARES === undefined || plan.BLOCK === undefined) throw new Error('卖计划缺字段');
  if (plan.OUT_RAW === undefined && plan.OUT_WEI === undefined) throw new Error('卖计划缺 OUT');
  if (plan.MIN_RAW === undefined && plan.MIN_WEI === undefined) throw new Error('卖计划缺 MIN');
  return plan;
}

export async function erc20Symbol(token) {
  try {
    const b = (await ethCall(token, SEL.symbol)).slice(2);
    if (b.length < 128) return null;
    const len = parseInt(b.slice(64, 128), 16);
    if (!len || len > 32) return null;
    return BufferLike.utf8(b.slice(128, 128 + len * 2));
  } catch {
    return null;
  }
}

export async function nativeBalance(addr) {
  return BigInt(await rpc('eth_getBalance', [addr, 'latest']));
}

/* ---------------- four.meme v2 ---------------- */
// 读 router.tokens(token) 判断是否由 four.meme v2 路由托管
export async function fourMemeInfo(token) {
  const w = (await ethCall(FOUR_ROUTER, encodeCall(SEL.fourTokens, [A(token)]))).replace(/^0x/, '');
  const words = w.match(/.{64}/g) || [];
  if (words.length < 4) return null;
  const status = Number(BigInt('0x' + words[0]));
  const listedToken = '0x' + words[3].slice(24);
  if (listedToken.toLowerCase() !== token.toLowerCase()) return null;
  const totalSupply = BigInt('0x' + words[6]);
  const sold = BigInt('0x' + words[7]);
  const creator = '0x' + words[1].slice(24);
  const quote = '0x' + words[9].slice(24);
  const createdAt = BigInt('0x' + words[2]);
  return { status, totalSupply, sold, creator, createdAt, quote, router: FOUR_ROUTER };
}

// buy(address token,uint256 funds,uint256 minAmount,uint256,bytes)
export function fourBuyData(token, funds, minAmount) {
  return '0x995ee6da'
    + padAddr(token) + padUint(funds) + padUint(minAmount)
    + padUint(0) + padUint(0xa0) + padUint(0);
}

// sell(address token,uint256 amount,uint256 minFunds,uint256,bytes)
export function fourSellData(token, amount, minFunds) {
  return '0x8bfc7764'
    + padAddr(token) + padUint(amount) + padUint(minFunds)
    + padUint(0) + padUint(0xa0) + padUint(0);
}

export async function erc20Balance(token, owner) {
  const w = await ethCall(token, encodeCall(SEL.balanceOf, [A(owner)]));
  return BigInt(w);
}

export async function erc20Allowance(token, owner, spender) {
  const w = await ethCall(token, encodeCall(SEL.allowance, [A(owner), A(spender)]));
  return BigInt(w);
}

export async function waitReceipt(txHash, { timeoutMs = 120000, intervalMs = 2500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rc = await rpc('eth_getTransactionReceipt', [txHash]);
    if (rc && rc.status) {
      return { ...rc, ok: rc.status === '0x1', blockNumber: Number(BigInt(rc.blockNumber)) };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('等待收据超时: ' + txHash);
}
