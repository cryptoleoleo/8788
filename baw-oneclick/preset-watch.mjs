// Read-only watcher for the Four.meme "Binance Agent ID Exclusive" preset.
// It never signs or sends transactions. Auto-buy is intentionally not here.
import { Interface, id, toBeHex } from 'ethers';

export const PRESET_ID = '1778027615735';
export const PRESET_NAME = 'Binance Agent ID Exclusive';
const CORE = '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3';
const HTTP_RPC = process.env.PRESET_WATCH_HTTP || 'https://bsc-rpc.publicnode.com';
const WS_URL = process.env.PRESET_WATCH_WS || 'wss://bsc-rpc.publicnode.com';

const tokenCreated = new Interface([
  'event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)',
]);
const topic0 = tokenCreated.getEvent('TokenCreated').topicHash;
const presetTopic = toBeHex(BigInt(PRESET_ID), 32);
const QUOTES = new Map([
  ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'WBNB'],
  ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', 'BNCB'],
  ['0x7c8d5502b544ddaf8852fc46d1174e34876d545c', 'BNC4'],
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0xce24439f2d9c6a2289f741120fe202248b666666', 'U'],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1'],
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');

async function rpcHttp(method, params, timeoutMs = 10000) {
  const res = await fetch(HTTP_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

class PresetWatch {
  constructor() {
    this.active = false;
    this.connecting = false;
    this.subscription = null;
    this.ws = null;
    this.reconnectTimer = null;
    this.queue = [];
    this.processing = false;
    this.seen = new Set();
    this.events = [];
    this.lastHead = null;
    this.lastEventAt = null;
    this.startedAt = null;
    this.lastError = null;
    this.lastConnectedAt = null;
    this.listeners = new Set();
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status() {
    return {
      ok: true,
      presetId: PRESET_ID,
      presetName: PRESET_NAME,
      autoBuy: false,
      running: this.active,
      connected: !!this.subscription,
      connecting: this.connecting,
      lastHead: this.lastHead,
      lastEventAt: this.lastEventAt,
      startedAt: this.startedAt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      events: this.events,
    };
  }

  async start() {
    if (this.active) return this.status();
    this.active = true;
    this.startedAt = Date.now();
    this.lastError = null;
    this.events = [];
    this.seen.clear();
    try {
      await this.seed();
    } catch (e) {
      this.lastError = '历史回填失败：' + e.message;
    }
    this.connect();
    return this.status();
  }

  stop() {
    this.active = false;
    this.connecting = false;
    this.subscription = null;
    this.queue = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    return this.status();
  }

  async seed() {
    const head = Number(BigInt(await rpcHttp('eth_blockNumber', [])));
    const from = Math.max(0, head - 50);
    const logs = await rpcHttp('eth_getLogs', [{
      address: CORE,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + head.toString(16),
      topics: [topic0, presetTopic],
    }]);
    this.lastHead = head;
    for (const log of logs || []) this.addLog(log);
    this.lastError = null;
  }

  connect() {
    if (!this.active) return;
    this.connecting = true;
    let ws;
    try {
      ws = this.ws = new WebSocket(WS_URL);
    } catch (e) {
      this.connecting = false;
      this.lastError = 'WSS 创建失败：' + e.message;
      this.scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      this.lastConnectedAt = Date.now();
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
      } catch (e) {
        this.lastError = 'WSS 订阅发送失败：' + e.message;
        this.connecting = false;
      }
    });
    ws.addEventListener('message', (event) => {
      let m;
      try { m = JSON.parse(event.data); } catch { return; }
      if (m.id === 1) {
        if (m.error) {
          this.connecting = false;
          this.lastError = 'WSS 订阅失败：' + (m.error.message || JSON.stringify(m.error));
        } else if (typeof m.result === 'string') {
          this.subscription = m.result;
          this.connecting = false;
          this.lastError = null;
        }
        return;
      }
      if (m.method === 'eth_subscription' && m.params?.subscription === this.subscription) {
        this.onHead(m.params.result);
      }
    });
    ws.addEventListener('error', () => {
      this.lastError = 'WSS 连接错误';
    });
    ws.addEventListener('close', () => {
      this.connecting = false;
      this.subscription = null;
      if (this.ws === ws) this.ws = null;
      if (this.active) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  onHead(head) {
    if (!this.active || !head?.hash || !head?.number) return;
    this.lastHead = Number(BigInt(head.number));
    this.queue.push(head);
    if (this.queue.length > 20) this.queue.splice(0, this.queue.length - 20);
    this.drain();
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.active && this.queue.length) {
        const head = this.queue.shift();
        await this.processHead(head);
      }
    } finally {
      this.processing = false;
    }
  }

  async processHead(head) {
    let logs = null;
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        logs = await rpcHttp('eth_getLogs', [{ blockHash: head.hash, address: CORE, topics: [topic0, presetTopic] }]);
        break;
      } catch (e) {
        lastErr = e;
        if (!/block not found/i.test(String(e.message))) break;
        await sleep(250);
      }
    }
    if (!Array.isArray(logs)) {
      if (lastErr) this.lastError = '区块日志读取失败：' + lastErr.message;
      return;
    }
    for (const log of logs) this.addLog(log);
    this.lastError = null;
  }

  addLog(log) {
    if (log.removed) return;
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (this.seen.has(key)) return;
    let parsed;
    try {
      parsed = tokenCreated.parseLog(log);
    } catch {
      return;
    }
    if (!parsed || String(parsed.args.presetId) !== PRESET_ID) return;
    this.seen.add(key);
    const quote = String(parsed.args.quoteAsset).toLowerCase();
    const item = {
      token: parsed.args.token,
      name: parsed.args.name,
      symbol: parsed.args.symbol,
      creator: parsed.args.creator,
      quote,
      quoteSymbol: QUOTES.get(quote) || short(quote),
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      at: new Date().toISOString(),
    };
    this.events.unshift(item);
    if (this.events.length > 50) this.events.length = 50;
    this.lastEventAt = item.at;
    for (const fn of this.listeners) {
      try { fn(item); } catch { /* listener must not break the watcher */ }
    }
  }
}

export const presetWatch = new PresetWatch();
