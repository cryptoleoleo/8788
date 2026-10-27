// Gang.fun LaunchpadV2 buy: BNB -> GANG (DEX), approve GANG, then
// LaunchpadV2.buy(token, quoteIn, minTokensOut). Never retries automatically.
import { execFile } from 'node:child_process';
import { Interface, parseEther, parseUnits, formatUnits } from 'ethers';
import { walletRuntime } from './multi-service.mjs';

const PAD = '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E';
const GANG = '0x0c6302401aa5325C2E36F170f52C00B1d220B405';
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CHAIN = '56';
const RPC = process.env.GANG_RPC || process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const CLI = process.env.BAW_CLI || null;
const NODE = process.env.BAW_NODE || process.execPath;
const ZERO = '0x0000000000000000000000000000000000000000';
const VIRTUAL_TOKEN = 1066666666666666666666666667n;
const BPS = 10000n;
const FEE_BPS = 100n;

const padABI = new Interface([
  'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
  'function isAgent(address) view returns(bool)',
  'function walletRoom(address,address) view returns(uint256)',
  'function MAX_PER_WALLET() view returns(uint256)',
  'function buy(address,uint256,uint256) returns(uint256)',
  'function sell(address,uint256,uint256) returns(uint256)',
]);
const ercABI = new Interface([
  'function symbol() view returns(string)',
  'function name() view returns(string)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ceilDiv = (a, b) => (b === 0n ? 0n : (a + b - 1n) / b);
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');

let walletCache = null;
let busy = false;
let busySince = 0;
let busyAction = '';

function beginBusy(action) {
  busy = true;
  busySince = Date.now();
  busyAction = action;
}

function endBusy() {
  busy = false;
  busySince = 0;
  busyAction = '';
}

function gangBusy() {
  return {
    busy,
    action: busyAction || null,
    since: busySince || null,
    elapsedMs: busy ? Date.now() - busySince : 0,
  };
}

function bawSpec() {
  return CLI
    ? { file: NODE, args: [CLI] }
    : { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'baw'] };
}

function gangSlipBps(body = {}, fallback = 100) {
  const pct = Number(body.slippage);
  if (!Number.isFinite(pct) || pct < 0.1 || pct > 50) return fallback;
  return Math.round(pct * 100);
}

function gangOrderOpts(body = {}) {
  const opts = [];
  const slip = String(body.slippage ?? '').trim();
  if (slip === 'auto' || (/^\d+(?:\.\d+)?$/.test(slip) && Number(slip) >= 0 && Number(slip) <= 100)) {
    opts.push('--slippage', slip);
  }
  if (body.mev === true || body.mev === false) opts.push('--mev', body.mev ? 'true' : 'false');
  else if (body.mev === 'true' || body.mev === 'false') opts.push('--mev', body.mev);
  const gas = String(body.gasLevel || '').toUpperCase();
  if (['LOW', 'MEDIUM', 'HIGH'].includes(gas)) opts.push('--gasLevel', gas);
  return opts;
}

function runBaw(args, timeout = 120000) {
  if (walletRuntime.current()) return walletRuntime.run(args, timeout);
  const spec = bawSpec();
  return new Promise((resolve) => {
    execFile(spec.file, [...spec.args, ...args], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const raw = String(stdout || '').trim();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not JSON */ }
      resolve({ err, json, stdout: raw, stderr: String(stderr || '').trim() });
    });
  });
}

function cliError(out) {
  return (out && out.json && out.json.error) || {
    name: 'CLI_ERROR',
    message: (out && (out.stderr || out.stdout)) || 'baw 调用失败',
  };
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function call(to, iface, fn, args = []) {
  const data = iface.encodeFunctionData(fn, args);
  return iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to, data }, 'latest']));
}

async function getWallet() {
  if (walletRuntime.current()) return walletRuntime.address();
  if (walletCache) return walletCache;
  const out = await runBaw(['wallet', 'address', '--json'], 60000);
  if (!out.json || !out.json.success) throw new Error('读不到 Agentic 钱包地址');
  const evm = (out.json.data.addresses || []).find((a) => String(a.binanceChainId) === CHAIN);
  if (!evm) throw new Error('钱包没有 BSC 地址');
  walletCache = evm.address;
  return walletCache;
}

async function waitReceipt(txHash, timeoutMs = 90000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const rc = await rpc('eth_getTransactionReceipt', [txHash]);
      if (rc) {
        if (rc.status !== '0x1') throw new Error('交易链上回滚：' + txHash);
        return rc;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(2000);
  }
  throw new Error(`等待收据超时：${txHash}${lastErr ? '（' + lastErr.message + '）' : ''}`);
}

function curveQuoteTokens(curve, quoteIn, room = null) {
  const vq = BigInt(curve.virtualQuote);
  const sold = BigInt(curve.sold);
  const raised = BigInt(curve.realQuote);
  const gradAmt = BigInt(curve.gradAmt);
  const tokensOutOf = (net) => {
    const k = vq * VIRTUAL_TOKEN;
    const qReserve = vq + raised;
    const tReserve = VIRTUAL_TOKEN - sold;
    return tReserve - ceilDiv(k, qReserve + net);
  };
  const quoteInFor = (tokensOut) => {
    const k = vq * VIRTUAL_TOKEN;
    const qReserve = vq + raised;
    const tReserve = VIRTUAL_TOKEN - sold;
    return ceilDiv(k, tReserve - tokensOut) - qReserve;
  };
  const recomputeFee = (gross, netIn) => {
    let spentGross = ceilDiv(netIn * BPS, BPS - FEE_BPS);
    if (spentGross > gross) spentGross = gross;
    const fee = (spentGross * FEE_BPS) / BPS;
    return { fee, net: spentGross - fee, refund: gross - spentGross };
  };
  let fee = (quoteIn * FEE_BPS) / BPS;
  let net = quoteIn - fee;
  const remaining = gradAmt > raised ? gradAmt - raised : 0n;
  if (net > remaining) {
    net = remaining;
    ({ fee, net } = recomputeFee(quoteIn, net));
    if (net > remaining) net = remaining;
  }
  let tokensOut = tokensOutOf(net);
  if (room != null && tokensOut > room) {
    tokensOut = room;
    net = quoteInFor(room);
    ({ fee, net } = recomputeFee(quoteIn, net));
  }
  return { tokensOut, fee, net, refund: quoteIn - net - fee };
}

function curveQuoteSell(curve, tokensIn) {
  const vq = BigInt(curve.virtualQuote);
  const sold = BigInt(curve.sold);
  const raised = BigInt(curve.realQuote);
  const k = vq * VIRTUAL_TOKEN;
  const qReserve = vq + raised;
  const tReserve = VIRTUAL_TOKEN - sold;
  const newQ = ceilDiv(k, tReserve + tokensIn);
  const quoteOut = qReserve - newQ;
  const fee = (quoteOut * FEE_BPS) / BPS;
  return { quoteOut: quoteOut - fee, fee };
}

async function readQuoteMeta(quote, wallet) {
  const addr = String(quote || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error(`Gang 计价币地址异常：${quote}`);
  const [symbol, decimals] = await Promise.all([
    call(addr, ercABI, 'symbol').then((v) => String(v[0])).catch(() => 'QUOTE'),
    call(addr, ercABI, 'decimals').then((v) => Number(v[0])).catch(() => 18),
  ]);
  return { address: addr, symbol: symbol || 'QUOTE', decimals: Number.isFinite(decimals) ? decimals : 18 };
}

async function readToken(token, wallet) {
  const curve = await call(PAD, padABI, 'curves', [token]);
  if (!curve.creator || same(curve.creator, ZERO)) throw new Error('不是 Gang Launchpad 代币');
  if (curve.graduated) throw new Error('代币已毕业，需在 PancakeSwap 买入');
  const quote = await readQuoteMeta(curve.quote, wallet);
  const [symbol, decimals, eligible, room, maxWallet] = await Promise.all([
    call(token, ercABI, 'symbol').then((v) => String(v[0])).catch(() => 'TOKEN'),
    call(token, ercABI, 'decimals').then((v) => Number(v[0])).catch(() => 18),
    call(PAD, padABI, 'isAgent', [wallet]).then((v) => !!v[0]),
    call(PAD, padABI, 'walletRoom', [token, wallet]).then((v) => v[0]),
    call(PAD, padABI, 'MAX_PER_WALLET').then((v) => v[0]).catch(() => 0n),
  ]);
  return { curve, symbol, decimals, quote, eligible, room, maxWallet };
}

async function detectGang(body) {
  const token = String(body.token || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: 'token 格式不对' };
  const supplied = String(body.wallet || '').toLowerCase();
  const wallet = /^0x[0-9a-f]{40}$/.test(supplied) ? supplied : await getWallet();
  const info = await readToken(token, wallet);
  const progressPct = BigInt(info.curve.gradAmt) > 0n
    ? Number(BigInt(info.curve.realQuote) * 10000n / BigInt(info.curve.gradAmt)) / 100
    : 0;
  return {
    ok: true,
    token,
    symbol: info.symbol,
    quote: info.quote.symbol,
    quoteAddress: info.quote.address,
    quoteDecimals: info.quote.decimals,
    eligible: info.eligible,
    taxed: !!info.curve.taxed,
    progressPct,
    room: formatUnits(info.room, info.decimals),
    maxPerWallet: formatUnits(info.maxWallet, info.decimals),
  };
}

async function quoteGang(body) {
  const token = String(body.token || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: 'token 格式不对' };
  let bnb;
  try { bnb = parseEther(String(body.amount ?? '').trim()); } catch { return { ok: false, error: 'amount 必须是 BNB 数量' }; }
  if (bnb <= 0n) return { ok: false, error: 'amount 必须大于 0' };
  const wallet = await getWallet();
  const info = await readToken(token, wallet);
  if (!info.eligible) return { ok: false, error: '钱包没有 Agent ID（isAgent=false），不能在内盘买入' };

  const q = await runBaw([
    'market-order', 'quote',
    '--fromTokenQty', formatUnits(bnb, 18),
    '--fromToken', BNB,
    '--toToken', info.quote.address,
    '--binanceChainId', CHAIN,
    '--json',
  ], 90000);
  if (!q.json || !q.json.success) return { ok: false, stage: 'quote', error: cliError(q), cli: q.json || null };
  const quoteAmount = parseUnits(String(q.json.data.toCoinAmount), info.quote.decimals);
  const curveQ = curveQuoteTokens(info.curve, quoteAmount, info.room);
  const slipBps = gangSlipBps(body);
  const minTokens = curveQ.tokensOut * BigInt(10000 - slipBps) / 10000n;
  const progressBps = BigInt(info.curve.gradAmt) > 0n
    ? Number(BigInt(info.curve.realQuote) * 10000n / BigInt(info.curve.gradAmt)) / 100
    : 0;
  return {
    ok: true,
    token,
    symbol: info.symbol,
    quote: info.quote.symbol,
    quoteAddress: info.quote.address,
    quoteDecimals: info.quote.decimals,
    bnb: formatUnits(bnb, 18),
    quoteAmount: formatUnits(quoteAmount, info.quote.decimals),
    gangAmount: formatUnits(quoteAmount, info.quote.decimals),
    tokensOut: formatUnits(curveQ.tokensOut, info.decimals),
    minTokensOut: formatUnits(minTokens, info.decimals),
    feeGang: formatUnits(curveQ.fee, info.quote.decimals),
    refundGang: formatUnits(curveQ.refund, info.quote.decimals),
    progressPct: progressBps,
    taxed: !!info.curve.taxed,
    eligible: info.eligible,
    room: formatUnits(info.room, info.decimals),
    maxPerWallet: formatUnits(info.maxWallet, info.decimals),
    slippagePct: slipBps / 100,
    warning: info.curve.taxed ? '该代币是 taxed 盘，毕业后仍有 1% 税' : '',
  };
}

async function bawContractCall(to, data, value, label, opts = {}) {
  const wallet = await getWallet();
  const preview = await runBaw([
    'contract-call', 'preview',
    '--binanceChainId', CHAIN,
    '--from', wallet,
    '--to', to,
    '--value', value.toString(),
    '--inputData', data,
    '--json',
  ], 120000);
  if (!preview.json || !preview.json.success) throw new Error(`${label}预演失败：${JSON.stringify(cliError(preview))}`);
  const p = preview.json.data || {};
  if (p.requireConfirmation && !opts.allowPending) throw new Error(`${label}需要 Binance App 确认，自动流程停止`);
  if (!p.requestId) throw new Error(`${label}预演没有 requestId`);
  const exec = await runBaw(['contract-call', 'execute', '--requestId', p.requestId, '--json'], 180000);
  if (!exec.json || !exec.json.success) throw new Error(`${label}执行失败：${JSON.stringify(cliError(exec))}`);
  const r = exec.json.data || {};
  if (r.txHash) {
    await waitReceipt(r.txHash);
    return r;
  }
  if (String(r.status).toUpperCase() === 'PENDING_CONFIRMATION') {
    if (!opts.allowPending) throw new Error(`${label}需要 Binance App 确认，自动流程停止`);
    return { ...r, pendingConfirmation: true, requestId: p.requestId };
  }
  return r;
}

async function waitTokenBalanceBelow(token, before, wallet, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await call(token, ercABI, 'balanceOf', [wallet]).then((v) => v[0]).catch(() => null);
    if (bal != null && bal < before) return true;
    await sleep(3000);
  }
  return false;
}

async function waitTokenBalanceAbove(token, before, wallet, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await call(token, ercABI, 'balanceOf', [wallet]).then((v) => v[0]).catch(() => null);
    if (bal != null && bal > before) return true;
    await sleep(3000);
  }
  return false;
}

async function waitAllowanceAtLeast(token, spender, wallet, needed, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const allowed = await call(token, ercABI, 'allowance', [wallet, spender]).then((v) => v[0]).catch(() => null);
    if (allowed != null && allowed >= needed) return true;
    await sleep(3000);
  }
  return false;
}

async function marketSwapToQuote(bnb, quote, body = {}) {
  const wallet = await getWallet();
  const before = await call(quote.address, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
  const sub = await runBaw([
    'market-order', 'swap',
    '--fromTokenQty', formatUnits(bnb, 18),
    '--fromToken', BNB,
    '--toToken', quote.address,
    '--binanceChainId', CHAIN,
    ...gangOrderOpts(body),
    '--json',
  ], 180000);
  if (!sub.json || !sub.json.success) return { ok: false, stage: 'swap', error: cliError(sub), cli: sub.json || null };
  const orderId = String(sub.json.data?.orderId || '');
  if (!orderId) return { ok: false, stage: 'swap', error: { name: 'NO_ORDER_ID', message: '换汇没有 orderId' } };
  let order = null;
  let lastListErr = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const listed = await runBaw(['market-order', 'list', '--orderId', orderId, '--json'], 60000);
    if (listed.json && listed.json.success) {
      const rows = listed.json.data?.list || [];
      order = rows.find((o) => String(o.orderId) === orderId) || (rows.length === 1 ? rows[0] : null);
      if (order) {
        const status = String(order.status || '').toUpperCase();
        if (status === 'FINISHED') break;
        if (status === 'FAILED') return { ok: false, stage: 'swap', orderId, order, error: { name: 'SWAP_FAILED', message: `BNB→${quote.symbol} 换汇 FAILED` } };
      }
    } else lastListErr = cliError(listed);
    await sleep(2000);
  }
  if (!order || String(order.status).toUpperCase() !== 'FINISHED') {
    return { ok: false, stage: 'swap', orderId, order, error: { name: 'SWAP_PENDING', message: `BNB→${quote.symbol} 换汇未确认`, data: lastListErr || undefined } };
  }
  if (order.txHash) await waitReceipt(order.txHash);
  const after = await call(quote.address, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
  let received = after > before ? after - before : 0n;
  if (received === 0n && order.toTokenActualQty) {
    try { received = parseUnits(String(order.toTokenActualQty), quote.decimals); } catch { /* */ }
  }
  if (received <= 0n) return { ok: false, stage: 'swap', orderId, order, error: { name: 'ZERO_QUOTE', message: `换汇完成但未收到 ${quote.symbol}` } };
  return { ok: true, orderId, order, received };
}

async function buyGang(body) {
  if (busy) return { ok: false, busy: true, error: '另一个 Gang 交易正在处理中', detail: gangBusy() };
  beginBusy('买入');
  try {
    const q = await quoteGang(body);
    if (!q.ok) return q;
    const bnb = parseEther(String(body.amount).trim());
    const wallet = await getWallet();
    const bal = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
    if (bal < bnb + parseEther('0.005')) return { ok: false, error: 'BNB 不足，需预留 0.005 gas' };

    let receivedQuote = null;
    const quote = { address: q.quoteAddress, symbol: q.quote, decimals: q.quoteDecimals };
    let swap;
    try {
      swap = await marketSwapToQuote(bnb, quote, body);
    } catch (e) {
      return { ok: false, stage: 'swap', error: { name: 'SWAP_ERROR', message: e.message } };
    }
    if (!swap.ok) return swap;
    receivedQuote = swap.received;

    let fresh;
    try {
      fresh = await readToken(q.token, wallet);
      const curveQ = curveQuoteTokens(fresh.curve, receivedQuote, fresh.room);
      if (curveQ.tokensOut <= 0n) throw new Error(`${quote.symbol} 数量不足以买入`);
      const minTokens = curveQ.tokensOut * BigInt(10000 - gangSlipBps(body)) / 10000n;
      const allowance = await call(quote.address, ercABI, 'allowance', [wallet, PAD]).then((v) => v[0]);
      if (allowance < receivedQuote) {
        const approveData = ercABI.encodeFunctionData('approve', [PAD, receivedQuote]);
        const approveResult = await bawContractCall(quote.address, approveData, 0n, `${quote.symbol} 授权`, { allowPending: true });
        if (approveResult?.pendingConfirmation) {
          const ok = await waitAllowanceAtLeast(quote.address, PAD, wallet, receivedQuote, 300000);
          if (!ok) throw new Error(`${quote.symbol} 授权等待 App 确认超时`);
        }
      }
      const buyData = padABI.encodeFunctionData('buy', [q.token, receivedQuote, minTokens]);
      const beforeToken = await call(q.token, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
      const result = await bawContractCall(PAD, buyData, 0n, 'Gang 买入', { allowPending: true });
      if (result?.pendingConfirmation) {
        const ok = await waitTokenBalanceAbove(q.token, beforeToken, wallet, 300000);
        if (!ok) {
          return {
            ok: false,
            stage: 'confirm',
            token: q.token,
            symbol: q.symbol,
            quoteSymbol: quote.symbol,
            quoteSpent: formatUnits(receivedQuote, quote.decimals),
            error: { name: 'BUY_CONFIRM_TIMEOUT', message: '买入已提交 Binance App 确认，但等待超时；请确认后重试' },
          };
        }
      }
      return {
        ok: true,
        stage: 'finished',
        token: q.token,
        symbol: q.symbol,
        quoteSymbol: quote.symbol,
        bnb: formatUnits(bnb, 18),
        quoteSpent: formatUnits(receivedQuote, quote.decimals),
        gangSpent: formatUnits(receivedQuote, quote.decimals),
        minTokensOut: formatUnits(minTokens, fresh.decimals),
        swapOrderId: swap.orderId,
        swapTxHash: swap.order.txHash,
        buyTxHash: result.txHash || null,
        buyStatus: result.status || 'SUBMITTED',
      };
    } catch (e) {
      return {
        ok: false,
        stage: 'buy',
        token: q.token,
        symbol: q.symbol,
        quoteSymbol: quote.symbol,
        receivedQuote: formatUnits(receivedQuote, quote.decimals),
        receivedGang: formatUnits(receivedQuote, quote.decimals),
        swapOrderId: swap.orderId,
        swapTxHash: swap.order.txHash,
        error: { name: 'GANG_BUY_FAILED', message: e.message },
      };
    }
  } finally {
    endBusy();
  }
}

async function marketSwapQuoteToBnb(quote, amountRaw, body = {}) {
  const wallet = await getWallet();
  const before = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
  const sub = await runBaw([
    'market-order', 'swap',
    '--fromTokenQty', formatUnits(amountRaw, quote.decimals),
    '--fromToken', quote.address,
    '--toToken', BNB,
    '--binanceChainId', CHAIN,
    ...gangOrderOpts(body),
    '--json',
  ], 180000);
  if (!sub.json || !sub.json.success) return { ok: false, error: cliError(sub), cli: sub.json || null };
  const orderId = String(sub.json.data?.orderId || '');
  if (!orderId) return { ok: false, error: { name: 'NO_ORDER_ID', message: `${quote.symbol}→BNB 换汇没有 orderId` } };
  let order = null;
  let lastListErr = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const listed = await runBaw(['market-order', 'list', '--orderId', orderId, '--json'], 60000);
    if (listed.json && listed.json.success) {
      const rows = listed.json.data?.list || [];
      order = rows.find((o) => String(o.orderId) === orderId) || (rows.length === 1 ? rows[0] : null);
      if (order) {
        const status = String(order.status || '').toUpperCase();
        if (status === 'FINISHED') break;
        if (status === 'FAILED') return { ok: false, orderId, order, error: { name: 'SWAP_FAILED', message: `${quote.symbol}→BNB 换汇 FAILED` } };
      }
    } else lastListErr = cliError(listed);
    await sleep(2000);
  }
  if (!order || String(order.status).toUpperCase() !== 'FINISHED') {
    return { ok: false, orderId, order, error: { name: 'SWAP_PENDING', message: `${quote.symbol}→BNB 换汇未确认`, data: lastListErr || undefined } };
  }
  if (order.txHash) await waitReceipt(order.txHash);
  const after = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
  let received = after > before ? after - before : 0n;
  if (received === 0n && order.toTokenActualQty) {
    try { received = parseUnits(String(order.toTokenActualQty), 18); } catch { /* */ }
  }
  if (received <= 0n) return { ok: false, orderId, order, error: { name: 'ZERO_BNB', message: '换汇完成但未收到 BNB' } };
  return { ok: true, orderId, order, received };
}

async function quoteGangSell(body) {
  const token = String(body.token || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: 'token 格式不对' };
  const pct = Number(body.pct ?? 100);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { ok: false, error: '卖出比例需要 1–100 的整数' };
  const wallet = await getWallet();
  const info = await readToken(token, wallet);
  if (info.curve.graduated) return { ok: false, error: '代币已毕业，请用 DEX 卖出' };
  const bal = await call(token, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
  if (bal <= 0n) return { ok: false, error: '代币余额为 0' };
  const amountRaw = (bal * BigInt(pct)) / 100n;
  if (amountRaw <= 0n) return { ok: false, error: '该比例下卖出数量为 0' };
  const q = curveQuoteSell(info.curve, amountRaw);
  const minGang = q.quoteOut * BigInt(10000 - gangSlipBps(body)) / 10000n;
  return {
    ok: true,
    token,
    symbol: info.symbol,
    quote: info.quote.symbol,
    quoteAddress: info.quote.address,
    quoteDecimals: info.quote.decimals,
    pct,
    tokensIn: formatUnits(amountRaw, info.decimals),
    quoteOut: formatUnits(q.quoteOut, info.quote.decimals),
    gangOut: formatUnits(q.quoteOut, info.quote.decimals),
    minQuoteOut: formatUnits(minGang, info.quote.decimals),
    minGangOut: formatUnits(minGang, info.quote.decimals),
    feeGang: formatUnits(q.fee, info.quote.decimals),
    progressPct: BigInt(info.curve.gradAmt) > 0n
      ? Number(BigInt(info.curve.realQuote) * 10000n / BigInt(info.curve.gradAmt)) / 100
      : 0,
    taxed: !!info.curve.taxed,
    note: `卖出得到 ${info.quote.symbol} 后会自动换成 BNB`,
  };
}

async function sellGang(body) {
  if (busy) return { ok: false, busy: true, error: '另一个 Gang 交易正在处理中', detail: gangBusy() };
  beginBusy('卖出');
  try {
    const token = String(body.token || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: 'token 格式不对' };
    const pct = Number(body.pct ?? 100);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { ok: false, error: '卖出比例需要 1–100 的整数' };
    const wallet = await getWallet();
    const info = await readToken(token, wallet);
    if (info.curve.graduated) return { ok: false, error: '代币已毕业，请用 DEX 卖出' };
    const bal = await call(token, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
    if (bal <= 0n) return { ok: false, error: '代币余额为 0' };
    const amountRaw = (bal * BigInt(pct)) / 100n;
    if (amountRaw <= 0n) return { ok: false, error: '该比例下卖出数量为 0' };
    const q = curveQuoteSell(info.curve, amountRaw);
    if (q.quoteOut <= 0n) return { ok: false, error: '卖出报价为 0' };
    const minGang = q.quoteOut * BigInt(10000 - gangSlipBps(body)) / 10000n;
    const quote = info.quote;
    const beforeGang = await call(quote.address, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
    let sold = false;
    let sellResult = null;
    try {
      const allowance = await call(token, ercABI, 'allowance', [wallet, PAD]).then((v) => v[0]);
      if (allowance < amountRaw) {
        const approveData = ercABI.encodeFunctionData('approve', [PAD, amountRaw]);
        const approveResult = await bawContractCall(token, approveData, 0n, '代币授权', { allowPending: true });
        if (approveResult?.pendingConfirmation) {
          const ok = await waitAllowanceAtLeast(token, PAD, wallet, amountRaw, 300000);
          if (!ok) return { ok: false, stage: 'confirm', token, symbol: info.symbol, pct, error: { name: 'APPROVE_CONFIRM_TIMEOUT', message: '代币授权已提交 App 确认，但等待超时；请确认后重试' } };
        }
      }
      const sellData = padABI.encodeFunctionData('sell', [token, amountRaw, minGang]);
      sellResult = await bawContractCall(PAD, sellData, 0n, 'Gang 卖出', { allowPending: true });
      sold = true;
    } catch (e) {
      return { ok: false, stage: 'sell', token, symbol: info.symbol, pct, error: { name: 'GANG_SELL_FAILED', message: e.message } };
    }
    if (sellResult?.pendingConfirmation) {
      const confirmed = await waitTokenBalanceBelow(token, bal, wallet, 300000);
      if (!confirmed) {
        return {
          ok: false,
          stage: 'confirm',
          token,
          symbol: info.symbol,
          pct,
          orderId: sellResult.orderId || null,
          requestId: sellResult.requestId || null,
          error: { name: 'APP_CONFIRM_TIMEOUT', message: '已提交 Binance App 确认，但等待超时；请确认后在面板重试，未卖出不会扣币' },
        };
      }
    }
    const afterGang = await call(quote.address, ercABI, 'balanceOf', [wallet]).then((v) => v[0]);
    const gangReceived = afterGang > beforeGang ? afterGang - beforeGang : q.quoteOut;
    let swap;
    try {
      swap = await marketSwapQuoteToBnb(quote, gangReceived, body);
    } catch (e) {
      return {
        ok: false,
        stage: 'swap',
        token,
        symbol: info.symbol,
        quoteSymbol: quote.symbol,
        pct,
        soldTokens: formatUnits(amountRaw, info.decimals),
        gangReceived: formatUnits(gangReceived, quote.decimals),
        error: { name: 'GANG_BNB_SWAP_FAILED', message: e.message },
      };
    }
    if (!swap.ok) {
      return {
        ok: false,
        stage: 'swap',
        token,
        symbol: info.symbol,
        quoteSymbol: quote.symbol,
        pct,
        soldTokens: formatUnits(amountRaw, info.decimals),
        gangReceived: formatUnits(gangReceived, quote.decimals),
        sellTxHash: sellResult?.txHash || null,
        error: swap.error,
        swapOrderId: swap.orderId || null,
      };
    }
    return {
      ok: true,
      stage: 'finished',
      token,
      symbol: info.symbol,
      quoteSymbol: quote.symbol,
      pct,
      soldTokens: formatUnits(amountRaw, info.decimals),
      gangReceived: formatUnits(gangReceived, quote.decimals),
      quoteReceived: formatUnits(gangReceived, quote.decimals),
      bnbReceived: formatUnits(swap.received, 18),
      swapOrderId: swap.orderId,
      swapTxHash: swap.order.txHash,
      sellTxHash: sellResult?.txHash || null,
      sold,
    };
  } finally {
    endBusy();
  }
}

export { detectGang, quoteGang, buyGang, quoteGangSell, sellGang, gangBusy };
