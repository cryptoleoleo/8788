// serve.mjs — 本地桥：静态页面 + 用「币安 Agentic 钱包」签名
//
// 为什么需要桥：这类内盘要求签名方是币安 Agentic 钱包（Market 侧有 Agent 校验），
// 普通 EOA（MetaMask 等）连上去也买不了。浏览器拿不到 Agentic 钱包的私钥，
// 所以由本地 Node 调 `baw` CLI 的 dev-mode contract-call preview/execute 来签名。
//
// 安全约束：只监听 127.0.0.1；只允许白名单 (to, selector)；
// value 恒为 0；页面从服务端注入的 token 才能调用 /api。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { presetWatch } from './preset-watch.mjs';
import { presetAutoBuyer } from './preset-autobuy.mjs';
import { detectGang, quoteGang, buyGang, quoteGangSell, sellGang, gangBusy } from './gang-buy.mjs';
import { walletRuntime, multiApi, requestWalletScope, copyFeed } from './multi-service.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.BRIDGE_TOKEN || randomBytes(9).toString('hex');

const NODE = process.env.BAW_NODE || process.execPath;
// baw CLI 定位顺序：环境变量 BAW_CLI → PATH 里的 baw
const CLI = process.env.BAW_CLI || null;
const CHAIN = '56';

// BNB 自动换汇：只允许 BNB → 已知计价币。新增计价币请加到这里，
// 或用 BAW_SWAP_QUOTES="0x地址:符号,0x地址:符号" 明确扩展白名单。
const BNB_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const BNB_TOKEN_LC = BNB_TOKEN.toLowerCase();
const SWAP_GAS_RESERVE = 2000000000000000n; // 0.002 BNB，换汇后还要留 gas 买入
const KNOWN_QUOTES = new Map([
  ['0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'NVDAB'],
  ['0x205812cdbed920aff76c6580abd681a46d11efc7', 'QQQB'],
  ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', 'BNCB'],
  ['0x7c8d5502b544ddaf8852fc46d1174e34876d545c', 'BNC4'],
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0xce24439f2d9c6a2289f741120fe202248b666666', 'U'],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1'],
]);
for (const entry of String(process.env.BAW_SWAP_QUOTES || '').split(',')) {
  const m = entry.trim().match(/^(0x[0-9a-fA-F]{40})(?::([A-Za-z0-9_]+))?$/);
  if (m) KNOWN_QUOTES.set(m[1].toLowerCase(), m[2] || 'QUOTE');
}

const PORTAL = '0x49387d2e6cbF8fefE856e3FBc3E98a01aC3af062'.toLowerCase();
const FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e'.toLowerCase();
const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const ALLOWED = new Map([
  // buyWithQuote（ERC20 池）/ buy（原生 BNB 池，带 value）/ sellBps
  [PORTAL, new Set(['0xa7c893c4', '0xcce7ec13', '0x2f9d7c27'])],
]);
// QUOTE 代币的 approve 单独放行，但 spender 必须是 Factory 注册过的 Market
const APPROVE_SELECTOR = '0x095ea7b3';
const CLAIM_SELECTOR = '0x4e71d92d';
const IS_MARKET_SELECTOR = '0x6ec934da';
const NATIVE_BUY = '0xcce7ec13';
const FOUR_ROUTER = '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3';
const FOUR_BUY = '0x995ee6da';
ALLOWED.set(FOUR_ROUTER, new Set([FOUR_BUY, '0x8bfc7764'])); // four.meme buy / sell

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

async function rpcCall(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const marketCache = new Map();
async function isRegisteredMarket(addr) {
  const a = String(addr).toLowerCase();
  if (marketCache.has(a)) return marketCache.get(a);
  const word = await rpcCall(FACTORY, IS_MARKET_SELECTOR + a.replace(/^0x/, '').padStart(64, '0'));
  const ok = BigInt(word) === 1n;
  marketCache.set(a, ok);
  return ok;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function bawSpec() {
  // BAW_CLI 指向 dist/index.js 时用 node 直接跑；否则退回 PATH 里的 baw
  return CLI
    ? { file: NODE, args: [CLI] }
    : { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'baw'] };
}

function runBaw(args, timeout = 180000) {
  if (walletRuntime.current()) return walletRuntime.run(args, timeout);
  const spec = bawSpec();
  return new Promise((resolve) => {
    execFile(spec.file, [...spec.args, ...args], { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const raw = String(stdout || '').trim();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* 非 JSON */ }
      resolve({ err, json, stdout: raw, stderr: String(stderr || '').trim() });
    });
  });
}

let walletCache = null;
async function getWallet() {
  if (walletRuntime.current()) return walletRuntime.address();
  if (walletCache) return walletCache;
  const { json } = await runBaw(['wallet', 'address', '--json'], 60000);
  if (!json || !json.success) throw new Error('读不到 Agentic 钱包地址：' + JSON.stringify(json));
  const list = json.data.addresses || [];
  const evm = list.find((a) => a.binanceChainId === CHAIN) || list.find((a) => String(a.address).startsWith('0x'));
  if (!evm) throw new Error('钱包里没有 BSC 地址');
  walletCache = evm.address;
  return walletCache;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/* ---------------- BNB 自动换汇 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseBnbAmount(raw) {
  const s = String(raw ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(s)) {
    throw new Error('amount 必须是正的 BNB 数量（最多 18 位小数，不接受科学计数法）');
  }
  const [i, f = ''] = s.split('.');
  const raw18 = BigInt(i) * 10n ** 18n + BigInt((f.padEnd(18, '0') || '0'));
  if (raw18 <= 0n) throw new Error('amount 必须大于 0');
  return { text: s, raw: raw18 };
}

async function validateSwapRequest(body, { checkBalance = false } = {}) {
  const from = String(body.fromToken || BNB_TOKEN).toLowerCase();
  if (from !== BNB_TOKEN_LC) {
    return { code: 403, error: `白名单只允许 BNB 作为换出币（收到 ${from}）` };
  }
  const toToken = String(body.toToken || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(toToken)) {
    return { code: 400, error: 'toToken 格式不对（需要 0x + 40 位十六进制）' };
  }
  const symbol = KNOWN_QUOTES.get(toToken);
  if (!symbol) {
    return { code: 403, error: `白名单只允许 BNB 换成已知计价币；${toToken} 未登记` };
  }
  let amount;
  try {
    amount = parseBnbAmount(body.amount);
  } catch (e) {
    return { code: 400, error: e.message };
  }
  if (checkBalance) {
    const wallet = await getWallet();
    const bal = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
    if (amount.raw + SWAP_GAS_RESERVE > bal) {
      return {
        code: 400,
        error: `BNB 不足：换汇 ${amount.text} + 预留 gas 0.002 超过余额 ${(Number(bal) / 1e18).toFixed(6)}`,
      };
    }
  }
  return { toToken, symbol, amount: amount.text, amountRaw: amount.raw };
}

function cliError(out) {
  if (out && out.json && out.json.error) return out.json.error;
  return {
    name: 'CLI_ERROR',
    message: (out && (out.stderr || out.stdout)) || 'baw 调用失败（无输出）',
  };
}

function tradeOrderArgs(body = {}) {
  const args = [];
  const slip = String(body.slippage ?? '').trim();
  if (slip === 'auto' || (/^\d+(?:\.\d+)?$/.test(slip) && Number(slip) >= 0 && Number(slip) <= 100)) {
    args.push('--slippage', slip);
  }
  const mev = body.mev;
  if (mev === true || mev === false) args.push('--mev', mev ? 'true' : 'false');
  else if (mev === 'true' || mev === 'false') args.push('--mev', mev);
  const gas = String(body.gasLevel || '').toUpperCase();
  if (['LOW', 'MEDIUM', 'HIGH'].includes(gas)) args.push('--gasLevel', gas);
  return args;
}

function swapArgs(action, v, opts = []) {
  return [
    'market-order', action,
    '--fromTokenQty', v.amount,
    '--fromToken', BNB_TOKEN,
    '--toToken', v.toToken,
    '--binanceChainId', CHAIN,
    ...opts,
    '--json',
  ];
}

async function apiSwapQuote(req, res) {
  const body = await readBody(req);
  const v = await validateSwapRequest(body, { checkBalance: false });
  if (v.error) return json(res, v.code, { ok: false, error: v.error });

  const out = await runBaw(swapArgs('quote', v), 90000);
  if (!out.json || !out.json.success) {
    return json(res, 200, {
      ok: false,
      stage: 'quote',
      error: cliError(out),
      cli: out.json || null,
    });
  }
  json(res, 200, {
    ok: true,
    fromToken: BNB_TOKEN,
    toToken: v.toToken,
    symbol: v.symbol,
    quote: out.json.data,
  });
}

async function waitForSwapReceipt(txHash, timeoutMs = 60000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const rc = await rpc('eth_getTransactionReceipt', [txHash]);
      if (rc) {
        return {
          ok: rc.status === '0x1',
          status: rc.status,
          blockNumber: rc.blockNumber ? Number(BigInt(rc.blockNumber)) : null,
          transactionHash: rc.transactionHash || txHash,
        };
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1200);
  }
  return { timeout: true, error: lastErr ? lastErr.message : '等待收据超时' };
}

let swapInFlight = false;
async function apiSwap(req, res) {
  if (swapInFlight) {
    return json(res, 409, { ok: false, error: '另一个换汇订单正在处理中，请等它结束' });
  }
  swapInFlight = true;
  try {
    const body = await readBody(req);
    const v = await validateSwapRequest(body, { checkBalance: true });
    if (v.error) return json(res, v.code, { ok: false, error: v.error });

    const sub = await runBaw(swapArgs('swap', v, tradeOrderArgs(body)), 180000);
    if (!sub.json || !sub.json.success) {
      // 关键：ORDER_API_ERROR 等 CLI 错误原样放在 error 里，不重试。
      return json(res, 200, {
        ok: false,
        stage: 'submit',
        error: cliError(sub),
        cli: sub.json || null,
      });
    }
    const orderId = String((sub.json.data && sub.json.data.orderId) || '');
    if (!orderId) {
      return json(res, 200, {
        ok: false,
        stage: 'submit',
        error: { name: 'NO_ORDER_ID', message: 'market-order swap 返回成功但没有 orderId' },
        cli: sub.json,
      });
    }

    // 只轮询，不重新提交；PENDING 不是终态。
    let order = null;
    let lastListErr = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const listed = await runBaw(['market-order', 'list', '--orderId', orderId, '--json'], 60000);
      if (listed.json && listed.json.success) {
        const rows = (listed.json.data && Array.isArray(listed.json.data.list)) ? listed.json.data.list : [];
        order = rows.find((o) => String(o.orderId) === orderId) || (rows.length === 1 ? rows[0] : null);
        if (order) {
          const status = String(order.status || '').toUpperCase();
          if (status === 'FINISHED') break;
          if (status === 'FAILED') {
            return json(res, 200, {
              ok: false,
              stage: 'order',
              status: 'FAILED',
              orderId,
              order,
              error: {
                name: 'SWAP_FAILED',
                message: `换汇订单 ${orderId} 状态为 FAILED`,
                data: order,
              },
              cli: listed.json,
            });
          }
        }
      } else {
        lastListErr = cliError(listed);
      }
      await sleep(1200);
    }

    const status = order ? String(order.status || '').toUpperCase() : 'UNKNOWN';
    if (!order || status !== 'FINISHED') {
      return json(res, 200, {
        ok: false,
        stage: 'poll',
        status: order ? status : 'UNKNOWN',
        orderId,
        order: order || null,
        error: {
          name: 'SWAP_PENDING',
          message: order
            ? `换汇订单 ${orderId} 在 120s 内仍是 ${status}，未买入`
            : `换汇订单 ${orderId} 在 120s 内查不到状态，未买入`,
          data: lastListErr || undefined,
        },
      });
    }

    const txHash = order.txHash;
    if (!txHash) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        error: { name: 'NO_TX_HASH', message: `换汇订单 ${orderId} 已 FINISHED，但没有 txHash` },
      });
    }

    // 订单 FINISHED 之外再等链上收据，避免把“已提交”误当成“已到账”。
    const receipt = await waitForSwapReceipt(txHash, 60000);
    if (receipt.timeout) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        error: { name: 'RECEIPT_TIMEOUT', message: `换汇交易 ${txHash} 等待链上收据超时: ${receipt.error}` },
      });
    }
    if (!receipt.ok) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
        error: { name: 'SWAP_REVERTED', message: `换汇交易 ${txHash} 链上回滚` },
      });
    }

    json(res, 200, {
      ok: true,
      stage: 'finished',
      status: 'FINISHED',
      orderId,
      order,
      txHash,
      receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
      quoteToken: v.symbol,
      expectedReceived: order.toTokenActualQty || null,
    });
  } finally {
    swapInFlight = false;
  }
}

/* ---------------- 任意 ERC20 -> BNB（DEX 市价卖出） ---------------- */
function parseTokenAmount(raw, decimals) {
  const s = String(raw ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) {
    throw new Error('amount 必须是正数（不接受科学计数法）');
  }
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`小数位超过代币 decimals=${decimals}`);
  const rawAmt = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f.padEnd(decimals, '0') || '0'));
  if (rawAmt <= 0n) throw new Error('amount 必须大于 0');
  return { text: s, raw: rawAmt };
}

async function readTokenMeta(token, wallet) {
  const [decHex, balHex] = await Promise.all([
    rpcCall(token, '0x313ce567'),
    rpcCall(token, '0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0')),
  ]);
  if (!decHex || decHex === '0x') throw new Error('代币 decimals 读取失败');
  if (!balHex || balHex === '0x') throw new Error('代币余额读取失败');
  const decimals = Number(BigInt(decHex));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('代币 decimals 不合法');
  return { decimals, balance: BigInt(balHex) };
}

async function validateDexSellRequest(body) {
  const token = String(body.token || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { code: 400, error: 'token 格式不对（需要 0x + 40 位十六进制）' };
  if (token === BNB_TOKEN_LC) return { code: 400, error: 'BNB 是原生币，不需要用 DEX 卖出接口' };

  const wallet = await getWallet();
  let meta;
  try {
    meta = await readTokenMeta(token, wallet);
  } catch (e) {
    return { code: 400, error: `读取代币信息失败：${e.message}` };
  }
  let amount;
  try {
    amount = parseTokenAmount(body.amount, meta.decimals);
  } catch (e) {
    return { code: 400, error: e.message };
  }
  if (amount.raw > meta.balance) {
    return {
      code: 400,
      error: `余额不足：需要 ${amount.text}，当前 ${formatUnits(meta.balance, meta.decimals)}`,
    };
  }
  return { token, wallet, decimals: meta.decimals, balance: meta.balance, amount: amount.text, amountRaw: amount.raw };
}

function dexSellArgs(action, v, opts = []) {
  return [
    'market-order', action,
    '--fromTokenQty', v.amount,
    '--fromToken', v.token,
    '--toToken', BNB_TOKEN,
    '--binanceChainId', CHAIN,
    ...opts,
    '--json',
  ];
}

function formatUnits(v, decimals) {
  const base = 10n ** BigInt(decimals);
  const i = v / base;
  const f = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : `${i}`;
}

async function apiDexSellQuote(req, res) {
  const body = await readBody(req);
  const v = await validateDexSellRequest(body);
  if (v.error) return json(res, v.code, { ok: false, error: v.error });

  const out = await runBaw(dexSellArgs('quote', v), 90000);
  if (!out.json || !out.json.success) {
    return json(res, 200, { ok: false, stage: 'quote', error: cliError(out), cli: out.json || null });
  }
  json(res, 200, {
    ok: true,
    fromToken: v.token,
    toToken: BNB_TOKEN,
    decimals: v.decimals,
    amount: v.amount,
    balance: v.balance.toString(),
    quote: out.json.data,
  });
}

async function apiDexSell(req, res) {
  if (swapInFlight) {
    return json(res, 409, { ok: false, error: '另一个换汇/卖出订单正在处理中，请等它结束' });
  }
  swapInFlight = true;
  try {
    const body = await readBody(req);
    const v = await validateDexSellRequest(body);
    if (v.error) return json(res, v.code, { ok: false, error: v.error });

    const sub = await runBaw(dexSellArgs('swap', v, tradeOrderArgs(body)), 180000);
    if (!sub.json || !sub.json.success) {
      // ORDER_API_ERROR 等 CLI 错误原样透传；不重试。
      return json(res, 200, { ok: false, stage: 'submit', error: cliError(sub), cli: sub.json || null });
    }
    const orderId = String((sub.json.data && sub.json.data.orderId) || '');
    if (!orderId) {
      return json(res, 200, {
        ok: false,
        stage: 'submit',
        error: { name: 'NO_ORDER_ID', message: 'market-order swap 返回成功但没有 orderId' },
        cli: sub.json,
      });
    }

    let order = null;
    let lastListErr = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const listed = await runBaw(['market-order', 'list', '--orderId', orderId, '--json'], 60000);
      if (listed.json && listed.json.success) {
        const rows = (listed.json.data && Array.isArray(listed.json.data.list)) ? listed.json.data.list : [];
        order = rows.find((o) => String(o.orderId) === orderId) || (rows.length === 1 ? rows[0] : null);
        if (order) {
          const status = String(order.status || '').toUpperCase();
          if (status === 'FINISHED') break;
          if (status === 'FAILED') {
            return json(res, 200, {
              ok: false,
              stage: 'order',
              status: 'FAILED',
              orderId,
              order,
              error: { name: 'SWAP_FAILED', message: `DEX 卖出订单 ${orderId} 状态为 FAILED`, data: order },
              cli: listed.json,
            });
          }
        }
      } else {
        lastListErr = cliError(listed);
      }
      await sleep(1200);
    }

    const status = order ? String(order.status || '').toUpperCase() : 'UNKNOWN';
    if (!order || status !== 'FINISHED') {
      return json(res, 200, {
        ok: false,
        stage: 'poll',
        status: order ? status : 'UNKNOWN',
        orderId,
        order: order || null,
        error: {
          name: 'SWAP_PENDING',
          message: order
            ? `DEX 卖出订单 ${orderId} 在 120s 内仍是 ${status}`
            : `DEX 卖出订单 ${orderId} 在 120s 内查不到状态`,
          data: lastListErr || undefined,
        },
      });
    }

    const txHash = order.txHash;
    if (!txHash) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        error: { name: 'NO_TX_HASH', message: `DEX 卖出订单 ${orderId} 已 FINISHED，但没有 txHash` },
      });
    }
    const receipt = await waitForSwapReceipt(txHash, 60000);
    if (receipt.timeout) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        error: { name: 'RECEIPT_TIMEOUT', message: `DEX 卖出交易 ${txHash} 等待链上收据超时: ${receipt.error}` },
      });
    }
    if (!receipt.ok) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
        error: { name: 'SWAP_REVERTED', message: `DEX 卖出交易 ${txHash} 链上回滚` },
      });
    }

    json(res, 200, {
      ok: true,
      stage: 'finished',
      status: 'FINISHED',
      orderId,
      order,
      txHash,
      receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
      fromToken: v.token,
      amount: v.amount,
      expectedReceived: order.toTokenActualQty || null,
    });
  } finally {
    swapInFlight = false;
  }
}

/* ---------------- BNB -> 任意 ERC20（DEX 市价买入） ---------------- */
const WBNB_TOKEN_LC = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

async function validateDexBuyRequest(body, { checkBalance = false } = {}) {
  const toToken = String(body.toToken || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(toToken)) return { code: 400, error: 'toToken 格式不对（需要 0x + 40 位十六进制）' };
  if (toToken === BNB_TOKEN_LC || toToken === WBNB_TOKEN_LC) {
    return { code: 400, error: 'BNB/WBNB 不需要用 DEX 买入接口' };
  }
  let code;
  try {
    code = await rpc('eth_getCode', [toToken, 'latest']);
  } catch (e) {
    return { code: 500, error: '读取目标代币合约失败：' + e.message };
  }
  if (!code || code === '0x') return { code: 400, error: '目标地址不是合约' };
  let amount;
  try {
    amount = parseBnbAmount(body.amount);
  } catch (e) {
    return { code: 400, error: e.message };
  }
  if (checkBalance) {
    const wallet = await getWallet();
    const bal = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
    if (amount.raw + SWAP_GAS_RESERVE > bal) {
      return {
        code: 400,
        error: `BNB 不足：买入 ${amount.text} + 预留 gas 0.002 超过余额 ${(Number(bal) / 1e18).toFixed(6)}`,
      };
    }
  }
  return { toToken, amount: amount.text, amountRaw: amount.raw };
}

function dexBuyArgs(action, v, opts = []) {
  return [
    'market-order', action,
    '--fromTokenQty', v.amount,
    '--fromToken', BNB_TOKEN,
    '--toToken', v.toToken,
    '--binanceChainId', CHAIN,
    ...opts,
    '--json',
  ];
}

async function apiDexBuyQuote(req, res) {
  const body = await readBody(req);
  const v = await validateDexBuyRequest(body, { checkBalance: false });
  if (v.error) return json(res, v.code, { ok: false, error: v.error });
  const out = await runBaw(dexBuyArgs('quote', v), 90000);
  if (!out.json || !out.json.success) {
    return json(res, 200, { ok: false, stage: 'quote', error: cliError(out), cli: out.json || null });
  }
  json(res, 200, {
    ok: true,
    fromToken: BNB_TOKEN,
    toToken: v.toToken,
    amount: v.amount,
    quote: out.json.data,
  });
}

async function apiDexBuy(req, res) {
  if (swapInFlight) {
    return json(res, 409, { ok: false, error: '另一个换汇/买入订单正在处理中，请等它结束' });
  }
  swapInFlight = true;
  try {
    const body = await readBody(req);
    const v = await validateDexBuyRequest(body, { checkBalance: true });
    if (v.error) return json(res, v.code, { ok: false, error: v.error });

    const sub = await runBaw(dexBuyArgs('swap', v, tradeOrderArgs(body)), 180000);
    if (!sub.json || !sub.json.success) {
      return json(res, 200, { ok: false, stage: 'submit', error: cliError(sub), cli: sub.json || null });
    }
    const orderId = String((sub.json.data && sub.json.data.orderId) || '');
    if (!orderId) {
      return json(res, 200, {
        ok: false,
        stage: 'submit',
        error: { name: 'NO_ORDER_ID', message: 'market-order swap 返回成功但没有 orderId' },
        cli: sub.json,
      });
    }

    let order = null;
    let lastListErr = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const listed = await runBaw(['market-order', 'list', '--orderId', orderId, '--json'], 60000);
      if (listed.json && listed.json.success) {
        const rows = (listed.json.data && Array.isArray(listed.json.data.list)) ? listed.json.data.list : [];
        order = rows.find((o) => String(o.orderId) === orderId) || (rows.length === 1 ? rows[0] : null);
        if (order) {
          const status = String(order.status || '').toUpperCase();
          if (status === 'FINISHED') break;
          if (status === 'FAILED') {
            return json(res, 200, {
              ok: false,
              stage: 'order',
              status: 'FAILED',
              orderId,
              order,
              error: { name: 'SWAP_FAILED', message: `DEX 买入订单 ${orderId} 状态为 FAILED`, data: order },
              cli: listed.json,
            });
          }
        }
      } else {
        lastListErr = cliError(listed);
      }
      await sleep(1200);
    }

    const status = order ? String(order.status || '').toUpperCase() : 'UNKNOWN';
    if (!order || status !== 'FINISHED') {
      return json(res, 200, {
        ok: false,
        stage: 'poll',
        status: order ? status : 'UNKNOWN',
        orderId,
        order: order || null,
        error: {
          name: 'SWAP_PENDING',
          message: order
            ? `DEX 买入订单 ${orderId} 在 120s 内仍是 ${status}`
            : `DEX 买入订单 ${orderId} 在 120s 内查不到状态`,
          data: lastListErr || undefined,
        },
      });
    }

    const txHash = order.txHash;
    if (!txHash) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        error: { name: 'NO_TX_HASH', message: `DEX 买入订单 ${orderId} 已 FINISHED，但没有 txHash` },
      });
    }
    const receipt = await waitForSwapReceipt(txHash, 60000);
    if (receipt.timeout) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        error: { name: 'RECEIPT_TIMEOUT', message: `DEX 买入交易 ${txHash} 等待链上收据超时: ${receipt.error}` },
      });
    }
    if (!receipt.ok) {
      return json(res, 200, {
        ok: false,
        stage: 'receipt',
        status: 'FINISHED',
        orderId,
        order,
        txHash,
        receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
        error: { name: 'SWAP_REVERTED', message: `DEX 买入交易 ${txHash} 链上回滚` },
      });
    }

    json(res, 200, {
      ok: true,
      stage: 'finished',
      status: 'FINISHED',
      orderId,
      order,
      txHash,
      receipt: { blockNumber: receipt.blockNumber, status: receipt.status },
      toToken: v.toToken,
      amount: v.amount,
      expectedReceived: order.toTokenActualQty || null,
    });
  } finally {
    swapInFlight = false;
  }
}

/* ---------------- API ---------------- */
async function apiHealth(req, res) {
  const [ver, wallet] = await Promise.all([
    runBaw(['--version'], 30000),
    getWallet().catch((e) => ({ __err: e.message })),
  ]);
  if (typeof wallet === 'object' && wallet.__err) return json(res, 500, { ok: false, error: wallet.__err });
  const { json: st } = await runBaw(['wallet', 'status', '--json'], 60000);
  json(res, 200, {
    ok: true,
    chain: CHAIN,
    cliVersion: String(ver.stdout || '').trim() || 'unknown',
    wallet,
    session: st && st.success ? st.data.status : 'UNKNOWN',
    portal: PORTAL,
  });
}

const tokenOverviewCache = new Map();

async function fetchJson(url, timeout = 12000, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; BAW-8788/1.0)', accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function apiTokenOverview(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ca = String(url.searchParams.get('ca') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return json(res, 400, { ok: false, error: 'bad ca' });
  const hit = tokenOverviewCache.get(ca);
  if (hit && Date.now() - hit.ts < (hit.ttl || 20000)) return json(res, 200, hit.data);

  let pair = null;
  let pairs = [];
  let dexError = null;
  let sec = null;
  let secError = null;

  const [dexOut, secOut] = await Promise.allSettled([
    fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${ca}`),
    fetchJson(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${ca}`),
  ]);

  if (dexOut.status === 'fulfilled') {
    pairs = Array.isArray(dexOut.value?.pairs) ? dexOut.value.pairs : [];
    pair = pairs
      .filter((p) => p && String(p.chainId).toLowerCase() === 'bsc')
      .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0] || null;
  } else dexError = dexOut.reason?.message || String(dexOut.reason);

  if (secOut.status === 'fulfilled') {
    const result = secOut.value?.result || {};
    sec = result[ca] || result[ca.toUpperCase()] || Object.values(result)[0] || null;
  } else secError = secOut.reason?.message || String(secOut.reason);

  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const holders = Array.isArray(sec?.holders) ? sec.holders : [];
  const top10Pct = holders.slice(0, 10).reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;
  const lpLockedPct = (Array.isArray(sec?.lp_holders) ? sec.lp_holders : [])
    .filter((h) => String(h.is_locked) === '1' || h.is_locked === true)
    .reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;

  const ageHours = pair?.pairCreatedAt ? (Date.now() - Number(pair.pairCreatedAt)) / 3600000 : null;
  const data = {
    ok: true,
    ca,
    symbol: pair?.baseToken?.symbol || sec?.token_symbol || null,
    name: pair?.baseToken?.name || sec?.token_name || null,
    priceUsd: num(pair?.priceUsd),
    priceNative: num(pair?.priceNative),
    change24h: num(pair?.priceChange?.h24),
    change1h: num(pair?.priceChange?.h1),
    marketCap: num(pair?.marketCap),
    fdv: num(pair?.fdv),
    liquidityUsd: num(pair?.liquidity?.usd),
    volume24h: num(pair?.volume?.h24),
    txns24h: pair?.txns?.h24 || null,
    pairAddress: pair?.pairAddress || null,
    dexId: pair?.dexId || null,
    pairLabels: pair?.labels || [],
    pairUrl: pair?.url || null,
    chartUrl: pair?.pairAddress
      ? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}?embed=1&theme=dark&trades=0&info=0`
      : null,
    gmgnUrl: `https://gmgn.ai/bsc/token/${ca}`,
    bscscanUrl: `https://bscscan.com/token/${ca}`,
    ageHours,
    launchpad: sec?.launchpad_token?.launchpad_name || null,
    security: sec ? {
      honeypot: String(sec.is_honeypot) === '1',
      buyTaxPct: Number(sec.buy_tax || 0) * 100,
      sellTaxPct: Number(sec.sell_tax || 0) * 100,
      transferTaxPct: Number(sec.transfer_tax || 0) * 100,
      mintable: String(sec.is_mintable) === '1',
      openSource: String(sec.is_open_source) === '1',
      hiddenOwner: String(sec.hidden_owner) === '1',
      canTakeBackOwnership: String(sec.can_take_back_ownership) === '1',
      ownerRenounced: !sec.owner_address || /^0x0{40}$/i.test(sec.owner_address),
      holderCount: Number(sec.holder_count || 0),
      top10Pct,
      lpLockedPct,
      lpHolderCount: Number(sec.lp_holder_count || 0),
    } : null,
    dexError,
    securityError: secError,
    ts: Date.now(),
  };
  tokenOverviewCache.set(ca, { ts: Date.now(), ttl: data.pairAddress && data.security ? 20000 : 5000, data });
  if (tokenOverviewCache.size > 200) tokenOverviewCache.delete(tokenOverviewCache.keys().next().value);
  json(res, 200, data);
}

const tokenPnlCache = new Map();

function pnlAmountMap(list) {
  const out = Object.create(null);
  for (const x of list || []) {
    const a = String(x?.tokenInfo?.contractAddress || '').toLowerCase();
    const v = Number(x?.amount || 0);
    if (!a || !Number.isFinite(v)) continue;
    out[a] = (out[a] || 0) + v;
  }
  return out;
}

async function apiTokenPnl(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ca = String(url.searchParams.get('ca') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return json(res, 400, { ok: false, error: 'bad ca' });
  const cacheKey = walletRuntime.current() ? `${walletRuntime.current().id}:${ca}` : ca;
  const hit = tokenPnlCache.get(cacheKey);
  const fresh = url.searchParams.get('fresh') === '1';
  if (!fresh && hit && Date.now() - hit.ts < 10000) return json(res, 200, hit.data);

  const out = await runBaw(['wallet', 'tx-history', '--binanceChainId', CHAIN, '--size', '100', '--json'], 120000);
  if (!out.json || !out.json.success) return json(res, 200, { ok: false, error: '读取交易历史失败' });
  const txs = Array.isArray(out.json.data?.transactions) ? out.json.data.transactions : [];
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  const bnbToToken = [];
  const tokenToBnb = [];
  const flows = [];
  let symbol = null;
  let decimals = 18;

  for (const tx of txs) {
    for (const h of tx.txHashList || []) {
      const ins = h.instructions || {};
      const sent = pnlAmountMap(ins.send);
      const received = pnlAmountMap(ins.receive);
      const bnbSent = (sent[NATIVE] || 0) + (sent[WBNB] || 0);
      const bnbRecv = (received[NATIVE] || 0) + (received[WBNB] || 0);
      const time = tx.txTime || null;
      for (const [a, v] of Object.entries(received)) {
        if (a === NATIVE || a === WBNB || !v) continue;
        if (bnbSent > 0) bnbToToken.push({ token: a, quote: v, bnb: bnbSent, time, txHash: tx.txHash });
      }
      for (const [a, v] of Object.entries(sent)) {
        if (a === NATIVE || a === WBNB || !v) continue;
        if (bnbRecv > 0) tokenToBnb.push({ token: a, quote: v, bnb: bnbRecv, time, txHash: tx.txHash });
      }
      if (sent[ca] || received[ca]) {
        const ti = (ins.send || []).concat(ins.receive || []).find((x) => String(x?.tokenInfo?.contractAddress || '').toLowerCase() === ca)?.tokenInfo;
        if (ti) { symbol = symbol || ti.symbol || null; decimals = Number.isFinite(Number(ti.decimals)) ? Number(ti.decimals) : decimals; }
        flows.push({ time, txHash: tx.txHash, sent, received, bnbSent, bnbRecv });
      }
    }
  }

  const otherMax = (map, exclude) => {
    let best = null;
    for (const [a, v] of Object.entries(map)) {
      if (a === exclude || a === NATIVE || a === WBNB || !v) continue;
      if (!best || v > best.v) best = { a, v };
    }
    return best;
  };
  const costOfQuote = (quote, amount) => {
    const cands = bnbToToken.filter((e) => e.token === quote && e.quote >= amount * 0.995)
      .sort((a, b) => Math.abs(a.quote - amount) - Math.abs(b.quote - amount));
    if (!cands.length) return null;
    const e = cands[0];
    return e.bnb * (amount / e.quote);
  };
  const proceedsOfQuote = (quote, amount) => {
    const cands = tokenToBnb.filter((e) => e.token === quote && e.quote >= amount * 0.995)
      .sort((a, b) => Math.abs(a.quote - amount) - Math.abs(b.quote - amount));
    if (!cands.length) return null;
    const e = cands[0];
    return e.bnb * (amount / e.quote);
  };

  const trades = [];
  for (const f of flows.sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0))) {
    const tin = f.sent[ca] || 0;
    const tout = f.received[ca] || 0;
    if (tout > tin) {
      const amount = tout - tin;
      let cost = f.bnbSent > 0 ? f.bnbSent : null;
      if (cost == null) {
        const q = otherMax(f.sent, ca);
        if (q) cost = costOfQuote(q.a, q.v);
      }
      trades.push({ time: f.time, side: 'buy', tokenAmount: amount, bnb: cost, txHash: f.txHash });
    } else if (tin > tout) {
      const amount = tin - tout;
      let proceeds = f.bnbRecv > 0 ? f.bnbRecv : null;
      if (proceeds == null) {
        const q = otherMax(f.received, ca);
        if (q) proceeds = proceedsOfQuote(q.a, q.v);
      }
      trades.push({ time: f.time, side: 'sell', tokenAmount: amount, bnb: proceeds, txHash: f.txHash });
    }
  }

  let held = 0n;
  let basis = 0;
  let realized = 0;
  let totalBuy = 0;
  let totalSell = 0;
  let buyCount = 0;
  let sellCount = 0;
  let unknown = 0;
  const dec = Number.isFinite(decimals) ? decimals : 18;
  const scale = 10 ** Math.min(dec, 30);
  for (const t of trades) {
    if (t.bnb == null) { unknown++; continue; }
    const raw = BigInt(Math.max(0, Math.round(t.tokenAmount * scale)));
    if (t.side === 'buy') {
      held += raw; basis += t.bnb; totalBuy += t.bnb; buyCount++;
    } else {
      const costSold = held > 0n ? basis * Number(raw < held ? raw : held) / Number(held) : 0;
      realized += t.bnb - costSold;
      basis = Math.max(0, basis - costSold);
      held = raw < held ? held - raw : 0n;
      totalSell += t.bnb; sellCount++;
    }
  }

  const wallet = await getWallet();
  let balanceRaw = 0n;
  try {
    const word = await rpcCall(ca, '0x70a08231' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0'));
    balanceRaw = BigInt(word);
  } catch { /* not erc20 / no code */ }
  const balance = Number(balanceRaw) / scale;
  const knownBuys = trades.filter((t) => t.side === 'buy' && t.bnb != null);
  const boughtTokens = knownBuys.reduce((a, t) => a + t.tokenAmount, 0);
  const avgCost = knownBuys.length && boughtTokens > 0 ? totalBuy / boughtTokens : null;
  const positionCost = avgCost != null ? avgCost * balance : null;
  const data = {
    ok: true,
    ca,
    symbol,
    decimals: dec,
    balance,
    balanceText: (balanceRaw / BigInt(Math.round(scale))).toString() + (balanceRaw % BigInt(Math.round(scale)) ? '.' + String(balanceRaw % BigInt(Math.round(scale))).padStart(dec, '0').replace(/0+$/, '') : ''),
    totalBuyBnb: totalBuy,
    totalSellBnb: totalSell,
    realizedPnlBnb: realized,
    avgCostBnb: avgCost,
    positionCostBnb: positionCost,
    buyCount,
    sellCount,
    unknownCount: unknown,
    trades: trades.slice(-50),
    note: '基于 BAW 钱包最近 100 笔交易历史；总利润为已实现利润，未计未实现和 gas',
    ts: Date.now(),
  };
  tokenPnlCache.set(cacheKey, { ts: Date.now(), data });
  if (tokenPnlCache.size > 100) tokenPnlCache.delete(tokenPnlCache.keys().next().value);
  json(res, 200, data);
}

const gangSiteCache = { ts: 0, data: null };

async function apiGangSiteTokens(req, res) {
  if (gangSiteCache.data && Date.now() - gangSiteCache.ts < 60000) {
    return json(res, 200, gangSiteCache.data);
  }
  const items = [];
  const seen = new Set();
  let capped = false;
  const add = (rows, source) => {
    for (const t of rows || []) {
      const address = String(t?.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address) || seen.has(address)) continue;
      seen.add(address);
      items.push({
        address,
        name: t.name || '',
        symbol: t.symbol || '',
        source,
        graduated: !!t.graduated,
        progressPct: Number(t.progressPct || 0),
        priceBnb: t.priceBnb || null,
        priceUsd: t.priceUsd ?? null,
        holders: t.holders ?? null,
        volume24hUsd: t.volume24hUsd ?? null,
        creatorHandle: t.creatorHandle || null,
      });
    }
  };
  try {
    for (let page = 0; page < 10; page++) {
      const offset = page * 200;
      const r = await fetch(`https://gang.fun/api/tokens?sort=hot&limit=200&offset=${offset}`, {
        headers: { accept: 'application/json', 'user-agent': '8788-local/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`gang.fun tokens HTTP ${r.status}`);
      const j = await r.json();
      add(j.items, 'tokens');
      if (!j.hasMore) break;
      if (page === 9) capped = true;
    }
    for (let page = 0; page < 3; page++) {
      const offset = page * 100;
      const r = await fetch(`https://gang.fun/api/stocks/tokens?limit=100&offset=${offset}`, {
        headers: { accept: 'application/json', 'user-agent': '8788-local/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) break;
      const j = await r.json();
      const rows = Array.isArray(j) ? j : (j.items || []);
      add(rows, 'stocks');
      if (Array.isArray(j) || !j.hasMore) break;
    }
    const data = { ok: true, count: items.length, capped, items, ts: Date.now() };
    gangSiteCache.ts = Date.now();
    gangSiteCache.data = data;
    json(res, 200, data);
  } catch (e) {
    json(res, 200, { ok: false, error: e.message || String(e), count: 0, items: [] });
  }
}

async function apiSend(req, res) {
  const body = await readBody(req);
  const to = String(body.to || '').toLowerCase();
  const data = String(body.data || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return json(res, 400, { ok: false, error: 'bad to' });
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 10) return json(res, 400, { ok: false, error: 'bad data' });

  const selector = data.slice(0, 10).toLowerCase();
  const allowed = ALLOWED.get(to);
  const isApprove = selector === APPROVE_SELECTOR && to !== PORTAL;
  const isClaim = selector === CLAIM_SELECTOR && await isRegisteredMarket(to);
  if (!(allowed && allowed.has(selector)) && !isApprove && !isClaim) {
    return json(res, 403, { ok: false, error: `拒绝：${to} + ${selector} 不在白名单` });
  }

  const isFourMeme = to === FOUR_ROUTER;

  // 额外校验：Portal/Probe 盘的 approve spender / market 必须是 Factory 注册过的 Market；
  // four.meme 路由的参数是 token，不做 Market 校验，只允许它自己的 buy/sell/approve
  if (!isFourMeme && !isClaim) {
    const firstArg = '0x' + data.slice(10, 74).slice(-40);
    const okSpender = firstArg.toLowerCase() === FOUR_ROUTER || (await isRegisteredMarket(firstArg));
    if (!okSpender) {
      return json(res, 403, { ok: false, error: `拒绝：${firstArg} 既不是已注册 Market 也不是 four.meme 路由` });
    }
  }

  // value：只允许原生 BNB 买入（Portal.buy 或 four.meme buy），且不得超过钱包余额
  let value = 0n;
  try {
    value = BigInt(body.value ?? '0');
  } catch {
    return json(res, 400, { ok: false, error: 'bad value' });
  }
  if (value < 0n) return json(res, 400, { ok: false, error: 'bad value' });
  if (value > 0n) {
    if (selector !== NATIVE_BUY && selector !== FOUR_BUY) {
      return json(res, 403, { ok: false, error: '这个调用不允许带 value' });
    }
    const bal = BigInt(await rpc('eth_getBalance', [await getWallet(), 'latest']));
    if (value > bal) return json(res, 400, { ok: false, error: 'value 超过钱包 BNB 余额' });
  }

  const wallet = await getWallet();
  const previewArgs = [
    'contract-call', 'preview',
    '--binanceChainId', CHAIN,
    '--from', wallet,
    '--to', to,
    '--value', value.toString(),
    '--inputData', data,
    '--json',
  ];
  let preview = await runBaw(previewArgs);
  // 网络抖动导致拿不到 JSON 时，自动重试一次
  if (!preview.json) {
    await new Promise((r) => setTimeout(r, 350));
    preview = await runBaw(previewArgs);
  }
  if (preview.json && preview.json.error && Number(preview.json.error.code) === 10003002) {
    return json(res, 200, {
      ok: false,
      stage: 'session',
      error: { code: 10003002, name: 'SESSION_EXPIRED', message: 'Agentic 钱包会话已过期，请重新登录（baw auth signin）' },
    });
  }
  if (!preview.json || !preview.json.success) {
    return json(res, 200, {
      ok: false,
      stage: 'preview',
      error: (preview.json && preview.json.error) || { message: preview.stderr || preview.stdout || 'preview failed' },
    });
  }
  const pdata = preview.json.data;
  const previewOnly = body.previewOnly === true;
  if (previewOnly) {
    return json(res, 200, {
      ok: true,
      previewOnly: true,
      requestId: pdata.requestId,
      requireConfirmation: pdata.requireConfirmation,
      preview: {
        parsedTx: pdata.parsedTx,
        balanceChanges: pdata.simulationResult && pdata.simulationResult.balanceChanges,
        risks: pdata.risks && pdata.risks.riskDetails,
        tokenInfos: pdata.tokenInfos,
      },
    });
  }

  const exec = await runBaw(['contract-call', 'execute', '--requestId', pdata.requestId, '--json']);
  const okExec = exec.json && exec.json.success;
  json(res, 200, {
    ok: !!okExec,
    stage: 'execute',
    requestId: pdata.requestId,
    requireConfirmation: pdata.requireConfirmation,
    preview: {
      parsedTx: pdata.parsedTx,
      balanceChanges: pdata.simulationResult && pdata.simulationResult.balanceChanges,
      risks: pdata.risks && pdata.risks.riskDetails,
    },
    result: okExec ? exec.json.data : null,
    error: okExec ? null : (exec.json && exec.json.error) || { message: exec.stderr || exec.stdout },
  });
}


/* ---------------- 本地私钥直签 ---------------- */
async function apiSendKey(req, res) {
  const body = await readBody(req);
  const to = String(body.to || '').toLowerCase();
  const data = String(body.data || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return json(res, 400, { ok: false, error: 'bad to' });
  if (!/^0x[0-9a-fA-F]+$/.test(data) || data.length < 10) return json(res, 400, { ok: false, error: 'bad data' });

  const selector = data.slice(0, 10).toLowerCase();
  const allowed = ALLOWED.get(to);
  const isApprove = selector === APPROVE_SELECTOR && to !== PORTAL;
  const isClaim = selector === CLAIM_SELECTOR && await isRegisteredMarket(to);
  if (!(allowed && allowed.has(selector)) && !isApprove && !isClaim) {
    return json(res, 403, { ok: false, error: `拒绝：${to} + ${selector} 不在白名单` });
  }
  if (to !== FOUR_ROUTER && !isClaim) {
    const firstArg = '0x' + data.slice(10, 74).slice(-40);
    const okSpender = firstArg.toLowerCase() === FOUR_ROUTER || (await isRegisteredMarket(firstArg));
    if (!okSpender) return json(res, 403, { ok: false, error: `拒绝：${firstArg} 既不是 Market 也不是 four.meme 路由` });
  }

  let value = 0n;
  try { value = BigInt(body.value ?? '0'); } catch { return json(res, 400, { ok: false, error: 'bad value' }); }
  if (value < 0n) return json(res, 400, { ok: false, error: 'bad value' });
  if (value > 0n && selector !== NATIVE_BUY && selector !== FOUR_BUY) {
    return json(res, 403, { ok: false, error: '这个调用不允许带 value' });
  }

  const pk = String(body.privateKey || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return json(res, 400, { ok: false, error: '私钥格式不对（0x + 64 位十六进制）' });

  let ethers;
  try { ethers = await import('ethers'); }
  catch { return json(res, 500, { ok: false, error: '本机未安装 ethers，先在目录里跑 pnpm i' }); }

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(pk);
  const from = wallet.address;

  let nonce, fee, gas = null;
  const fixedGas = body.gasLimit ? BigInt(body.gasLimit) : null;
  try {
    const jobs = [
      provider.getTransactionCount(from, 'pending'),
      provider.getFeeData(),
    ];
    if (fixedGas === null) jobs.push(provider.estimateGas({ from, to, data, value }));
    const out = await Promise.all(jobs);
    nonce = out[0]; fee = out[1]; gas = out[2] ?? null;
  } catch (e) {
    return json(res, 200, { ok: false, stage: 'estimate', error: { message: (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message } });
  }

  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 1000000000n;
  const gasLimit = fixedGas !== null ? fixedGas : (gas * 130n) / 100n;
  let raw;
  try {
    raw = await wallet.signTransaction({ to, data, value, nonce, gasLimit, gasPrice, chainId: 56, type: 0 });
  } catch (e) {
    return json(res, 500, { ok: false, stage: 'sign', error: { message: e.shortMessage || e.message } });
  }
  const hash = ethers.keccak256(raw);
  const meta = { from, nonce, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), hash };

  if (body.dryRun === true) return json(res, 200, { ok: true, dryRun: true, recovered: ethers.Transaction.from(raw).from, rawLen: raw.length, ...meta });

  try {
    await provider.broadcastTransaction(raw);
  } catch (e) {
    return json(res, 200, { ok: false, stage: 'broadcast', error: { message: (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message }, ...meta });
  }
  json(res, 200, { ok: true, ...meta });
}

/* ---------------- 由私钥推导地址（本地计算，不广播） ---------------- */
async function apiAddr(req, res) {
  const body = await readBody(req);
  const pk = String(body.privateKey || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return json(res, 400, { ok: false, error: '私钥格式不对（0x + 64 位十六进制）' });
  try {
    const ethers = await import('ethers');
    const w = new ethers.Wallet(pk);
    json(res, 200, { ok: true, address: w.address });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
}
/* ---------------- server ---------------- */
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health') return await apiHealth(req, res);

    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-bridge-token'] !== TOKEN) return json(res, 401, { ok: false, error: 'bad token' });
      if (url.pathname.startsWith('/api/multi/')) return await multiApi(req, res, url.pathname, readBody, json);
      if (url.pathname === '/api/token-overview' && req.method === 'GET') return await apiTokenOverview(req, res);
      if (url.pathname === '/api/token-pnl' && req.method === 'GET') return await apiTokenPnl(req, res);
      if (url.pathname === '/api/swap/quote' && req.method === 'POST') return await apiSwapQuote(req, res);
      if (url.pathname === '/api/swap' && req.method === 'POST') return await apiSwap(req, res);
      if (url.pathname === '/api/dex-sell/quote' && req.method === 'POST') return await apiDexSellQuote(req, res);
      if (url.pathname === '/api/dex-sell' && req.method === 'POST') return await apiDexSell(req, res);
      if (url.pathname === '/api/dex-buy/quote' && req.method === 'POST') return await apiDexBuyQuote(req, res);
      if (url.pathname === '/api/dex-buy' && req.method === 'POST') return await apiDexBuy(req, res);
      if (url.pathname === '/api/gang/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, ...gangBusy() });
      }
      if (url.pathname === '/api/gang/site-tokens' && req.method === 'GET') {
        return await apiGangSiteTokens(req, res);
      }
      if (url.pathname === '/api/gang/detect' && req.method === 'POST') {
        try { return json(res, 200, await detectGang(await readBody(req))); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/gang/quote' && req.method === 'POST') {
        try { return json(res, 200, await quoteGang(await readBody(req))); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/gang/buy' && req.method === 'POST') {
        try { return json(res, 200, await buyGang(await readBody(req))); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/gang/sell/quote' && req.method === 'POST') {
        try { return json(res, 200, await quoteGangSell(await readBody(req))); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/gang/sell' && req.method === 'POST') {
        try { return json(res, 200, await sellGang(await readBody(req))); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/preset-watch/status' && req.method === 'GET') return json(res, 200, presetWatch.status());
      if (url.pathname === '/api/preset-watch/start' && req.method === 'POST') return json(res, 200, await presetWatch.start());
      if (url.pathname === '/api/preset-watch/stop' && req.method === 'POST') {
        presetAutoBuyer.disarm('监听停止');
        return json(res, 200, presetWatch.stop());
      }
      if (url.pathname === '/api/preset-autobuy/status' && req.method === 'GET') return json(res, 200, presetAutoBuyer.status());
      if (url.pathname === '/api/preset-autobuy/check' && req.method === 'GET') {
        try { return json(res, 200, await presetAutoBuyer.check()); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/preset-autobuy/arm' && req.method === 'POST') {
        try { return json(res, 200, await presetAutoBuyer.arm()); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/preset-autobuy/disarm' && req.method === 'POST') return json(res, 200, presetAutoBuyer.disarm());
      if (url.pathname === '/api/send' && req.method === 'POST') return await apiSend(req, res);
      if (url.pathname === '/api/send-key' && req.method === 'POST') return await apiSendKey(req, res);
      if (url.pathname === '/api/addr' && req.method === 'POST') return await apiAddr(req, res);
      return json(res, 404, { ok: false, error: 'not found' });
    }

    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const full = normalize(join(ROOT, path));
    if (!full.startsWith(normalize(ROOT))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let body = await readFile(full);
    let type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream';
    if (full.endsWith('index.html')) {
      body = Buffer.from(body.toString('utf8').replace(/__BRIDGE_TOKEN__/g, TOKEN), 'utf8');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    try { json(res, 500, { ok: false, error: e.message }); } catch { res.end('error'); }
  }
}
createServer((req, res) => {
  // Scoped identity selection is authenticated, including /api/health. The legacy path is unchanged.
  if ((req.headers['x-baw-wallet'] || req.headers['x-baw-copy-job'] || req.headers['x-baw-preview-only']) && req.headers['x-bridge-token'] !== TOKEN) {
    return json(res, 401, { ok: false, error: 'bad token' });
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.headers['x-baw-wallet'] && (pathname.startsWith('/api/preset-') || ['/api/send-key', '/api/addr'].includes(pathname))) {
    return json(res, 400, { ok: false, error: '此原版功能只使用原有身份，不接受多钱包上下文' });
  }
  Promise.resolve().then(() => requestWalletScope(req, () => handleRequest(req, res)))
    .catch(e => { if (!res.headersSent) json(res, 400, { ok: false, error: e.message }); else res.end(); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`内盘一键买卖（Agentic 钱包签名）→ http://127.0.0.1:${PORT}`);
  console.log(`CLI: ${CLI}`);
  console.log(`BNB 自动换汇白名单: ${[...KNOWN_QUOTES.values()].join(', ')}`);
});
process.once('exit', () => copyFeed.close());
