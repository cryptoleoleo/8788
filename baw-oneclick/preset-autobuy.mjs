// Armed auto-buy for new non-WBNB tokens of the watched Four.meme preset.
// Default OFF. Fixed 0.1 BNB, 50% floor, one attempt per token, 10/day.
// It uses OpenFour Core buyByBudget with native zap (options=2), so BNB -> quote
// happens inside the same transaction. If the zap route is unavailable it skips.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Interface, parseEther } from 'ethers';
import { presetWatch, PRESET_ID } from './preset-watch.mjs';

const CORE = '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const NATIVE_BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const VERIFIED_ZAP = '0x5d38bc071eb460e0c8513d481a4c57c00efec697';
const HTTP_RPC = process.env.AUTO_RPC || 'https://bsc-dataseed.binance.org';
const BUDGET_BNB = '0.1';
const BUDGET = parseEther(BUDGET_BNB);
const SLIPPAGE_BPS = 5000;
const MAX_FEE_BPS = 500;
const MAX_DAILY = 10;
const MIN_GAS = parseEther('0.005');
const CLI = process.env.BAW_CLI || null;
const NODE = process.env.BAW_NODE || process.execPath;

const coreABI = new Interface(JSON.parse(readFileSync(new URL('./openfour-abi/IOpenFourCore.json', import.meta.url))));
const toolsABI = new Interface(JSON.parse(readFileSync(new URL('./openfour-abi/IOpenFourTools.json', import.meta.url))));
const viewABI = new Interface([
  'function openFourTool() view returns(address)',
  'function phase() view returns(uint8)',
]);
const SUPPORTED_QUOTES = new Map([
  ['0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'NVDAB'],
  ['0x205812cdbed920aff76c6580abd681a46d11efc7', 'QQQB'],
  ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', 'BNCB'],
  ['0x7c8d5502b544ddaf8852fc46d1174e34876d545c', 'BNC4'],
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0xce24439f2d9c6a2289f741120fe202248b666666', 'U'],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1'],
]);
const EXCLUDED_QUOTES = new Set([WBNB, NATIVE_BNB, ZERO]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

function bawSpec() {
  return CLI
    ? { file: NODE, args: [CLI] }
    : { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'baw'] };
}

function runBaw(args, timeout = 120000) {
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

async function bawData(args) {
  const out = await runBaw(args);
  if (!out.json || !out.json.success) {
    throw new Error((out.json && out.json.error && out.json.error.message) || out.stderr || out.stdout || 'baw 调用失败');
  }
  return out.json.data;
}

async function rpc(method, params) {
  const res = await fetch(HTTP_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function call(to, iface, fn, args = [], block = 'latest') {
  const data = iface.encodeFunctionData(fn, args);
  const result = await rpc('eth_call', [{ to, data }, block]);
  return iface.decodeFunctionResult(fn, result);
}

class PresetAutoBuyer {
  constructor() {
    this.armed = false;
    this.armedFromBlock = 0;
    this.queue = [];
    this.busy = false;
    this.tried = new Set();
    this.count = 0;
    this.day = dayKey();
    this.spentBnb = 0;
    this.lastError = null;
    this.lastResult = null;
    this.logs = [];
    this.wallet = null;
    presetWatch.onEvent((event) => this.onEvent(event));
  }

  status() {
    this.resetDay();
    return {
      ok: true,
      armed: this.armed,
      presetId: PRESET_ID,
      budgetBnb: BUDGET_BNB,
      slippageBps: SLIPPAGE_BPS,
      maxDaily: MAX_DAILY,
      maxFeeBps: MAX_FEE_BPS,
      count: this.count,
      spentBnb: this.spentBnb,
      queue: this.queue.length,
      armedFromBlock: this.armedFromBlock,
      quoteFilter: '仅非 WBNB/BNB 计价，含税综合费率 ≤5%',
      supportedQuotes: [...SUPPORTED_QUOTES.values()],
      lastError: this.lastError,
      lastResult: this.lastResult,
      logs: this.logs.slice(0, 30),
      autoBuy: this.armed,
    };
  }

  resetDay() {
    const d = dayKey();
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
      this.spentBnb = 0;
    }
  }

  addLog(message, cls = '') {
    this.logs.unshift({ at: new Date().toISOString(), message, cls });
    if (this.logs.length > 50) this.logs.length = 50;
  }

  async getWallet() {
    if (this.wallet) return this.wallet;
    const data = await bawData(['wallet', 'address', '--json']);
    const evm = (data.addresses || []).find((a) => String(a.binanceChainId) === '56');
    if (!evm) throw new Error('钱包没有 BSC 地址');
    this.wallet = evm.address;
    return this.wallet;
  }

  async arm() {
    this.resetDay();
    if (this.count >= MAX_DAILY) throw new Error(`今日已用满 ${MAX_DAILY} 笔自动买入`);
    const wallet = await this.getWallet();
    const status = await bawData(['wallet', 'status', '--json']);
    if (status.status !== 'CONNECTED') throw new Error('Agentic 钱包未连接');
    const bal = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
    if (bal < BUDGET + MIN_GAS) throw new Error('BNB 不足：需要 0.1 + gas 预留');
    if (!presetWatch.active) await presetWatch.start();
    this.armedFromBlock = Number(presetWatch.lastHead || 0);
    this.tried.clear();
    this.queue = [];
    this.armed = true;
    this.lastError = null;
    this.lastResult = null;
    this.addLog(`自动买入已启用：从区块 ${this.armedFromBlock} 之后，仅非 WBNB/BNB 计价且含税费率≤5%的新币`, 'ok');
    return this.status();
  }

  async check() {
    const wallet = await this.getWallet();
    const status = await bawData(['wallet', 'status', '--json']);
    const bal = BigInt(await rpc('eth_getBalance', [wallet, 'latest']));
    return {
      ok: status.status === 'CONNECTED' && bal >= BUDGET + MIN_GAS,
      wallet,
      session: status.status,
      balanceWei: bal.toString(),
      needWei: (BUDGET + MIN_GAS).toString(),
      budgetBnb: BUDGET_BNB,
      mockOnly: false,
    };
  }

  disarm(reason = '手动关闭') {
    this.armed = false;
    this.queue = [];
    this.addLog(`自动买入已关闭：${reason}`, 'warn');
    return this.status();
  }

  onEvent(event) {
    if (!this.armed) return;
    if (!event || !event.token) return;
    if (event.blockNumber <= this.armedFromBlock) return;
    const quote = String(event.quote || '').toLowerCase();
    if (EXCLUDED_QUOTES.has(quote)) return;
    if (!SUPPORTED_QUOTES.has(quote)) {
      this.addLog(`跳过 ${event.symbol || short(event.token)}：未知计价池 ${short(event.quote)}`, 'warn');
      return;
    }
    if (this.tried.has(event.token)) return;
    if (this.count >= MAX_DAILY) {
      this.addLog(`跳过 ${event.symbol || short(event.token)}：今日已达 ${MAX_DAILY} 笔上限`, 'warn');
      return;
    }
    this.tried.add(event.token);
    this.queue.push(event);
    this.drain();
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.armed && this.queue.length) {
        const event = this.queue.shift();
        await this.buy(event);
      }
    } finally {
      this.busy = false;
    }
  }

  async buy(event) {
    this.resetDay();
    const symbol = event.symbol || short(event.token);
    try {
      if (this.count >= MAX_DAILY) throw new Error(`今日已达 ${MAX_DAILY} 笔上限`);
      const wallet = await this.getWallet();
      const cfg = await call(CORE, coreABI, 'tokens', [event.token]);
      if (!cfg.exists || cfg.paused || String(cfg.presetId) !== PRESET_ID || !same(cfg.token, event.token)) {
        throw new Error('代币配置变化、暂停或 preset 不匹配');
      }
      const quote = String(cfg.quoteAsset).toLowerCase();
      if (EXCLUDED_QUOTES.has(quote)) throw new Error('WBNB/BNB 计价不在此自动买入范围');
      const quoteSymbol = SUPPORTED_QUOTES.get(quote);
      if (!quoteSymbol) throw new Error('未知计价池，跳过');

      let phase = 0;
      for (let i = 0; i < 90; i++) {
        const [p] = await call(cfg.vault, viewABI, 'phase');
        phase = Number(p);
        if (phase === 1) break;
        if (phase === 3) throw new Error('内盘已结束/已迁移');
        if (!this.armed) throw new Error('已关闭自动买入');
        await sleep(1000);
      }
      if (phase !== 1) throw new Error('等待开盘超时');

      const [zap] = await call(CORE, coreABI, 'zapRouter');
      if (!same(zap, VERIFIED_ZAP)) throw new Error('ZapRouter 未验证，跳过');
      const [zero] = await call(CORE, coreABI, 'registry');
      const [tools] = await call(zero, viewABI, 'openFourTool');
      const [estimate] = await call(tools, toolsABI, 'estimateBuyByBudget', [event.token, wallet, BUDGET, 2n, '0x']);
      if (estimate.tokenAmount <= 0n || estimate.userPays <= 0n || estimate.userPays > BUDGET) {
        throw new Error('报价不可执行或超过 0.1 BNB 预算');
      }
      if (estimate.curveQuote <= 0n) throw new Error('curveQuote 为 0，无法计算费率');
      const feeBps = Number(estimate.totalFee * 10000n / estimate.curveQuote);
      if (feeBps > MAX_FEE_BPS) {
        throw new Error(`含税综合费率 ${(feeBps / 100).toFixed(2)}% > 5%，跳过`);
      }
      const maxQuotePay = estimate.curveQuote + estimate.totalFee;
      if (maxQuotePay <= 0n) throw new Error('计价币额度无效');
      const minimum = estimate.tokenAmount * BigInt(10000 - SLIPPAGE_BPS) / 10000n;
      if (minimum <= 0n) throw new Error('最低到账量为 0');
      const data = coreABI.encodeFunctionData('buyByBudget', [event.token, maxQuotePay, minimum, 2n, '0x']);

      this.addLog(`准备买入 ${symbol}：0.1 BNB，计价 ${quoteSymbol}，含税费率 ${(feeBps / 100).toFixed(2)}%，zap 自动换汇，最低 ${minimum}`, 'warn');
      const preview = await runBaw([
        'contract-call', 'preview',
        '--binanceChainId', '56',
        '--from', wallet,
        '--to', CORE,
        '--value', BUDGET.toString(),
        '--inputData', data,
        '--json',
      ]);
      if (!preview.json || !preview.json.success) {
        throw new Error((preview.json && preview.json.error && preview.json.error.message) || preview.stderr || '预演失败');
      }
      const p = preview.json.data;
      if (p.requireConfirmation) throw new Error('钱包要求 App 确认；自动买入不执行');
      if (!p.requestId) throw new Error('预演没有 requestId');
      this.count++;
      this.spentBnb = this.count * 0.1;
      const exec = await runBaw(['contract-call', 'execute', '--requestId', p.requestId, '--json']);
      if (!exec.json || !exec.json.success) {
        throw new Error((exec.json && exec.json.error && exec.json.error.message) || exec.stderr || '执行失败');
      }
      const r = exec.json.data || {};
      this.lastResult = {
        token: event.token,
        symbol,
        quoteSymbol,
        feeBps,
        status: r.status || 'SUBMITTED',
        txHash: r.txHash || null,
        orderId: r.orderId || null,
        at: new Date().toISOString(),
      };
      this.addLog(`已提交 ${symbol} · ${r.status || 'SUBMITTED'} · ${r.txHash ? short(r.txHash) : '无 txHash'}`, 'ok');
    } catch (e) {
      this.lastError = `${symbol}: ${e.message}`;
      this.addLog(`买入失败 ${symbol}：${e.message}`, 'bad');
    }
  }
}

export const presetAutoBuyer = new PresetAutoBuyer();
