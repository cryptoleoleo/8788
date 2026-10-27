// Buy-event signatures and emitting contracts from the supplied gang-copytrade.zip.
// Execution deliberately returns to the original BAW trade functions, not a second trading engine.
import { Interface, AbiCoder, id, zeroPadValue, parseEther, formatEther } from 'ethers';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from './multi-store.mjs';

const soft = '0x4e6f13c8a453c1b8b4e20b590082bb233a5b80d7';
const gang = [soft, '0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e', '0xf81c4e51c48466c6025b0165b1ea0f6978c712cb', '0x60aee38576035e757ded30ff8db8a8da476430c1'];
const flap = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
const four = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const softAbi = new Interface(['event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 fee,uint256 tokensOut,uint256 realBnb)']);
const v2Abi = new Interface(['event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)']);
const flapTopic = id('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)');
const fourTopic = id('TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)');
export function subscriptions(task) {
  const out = [];
  if (task.venues.includes('gang')) for (let i = 0; i < task.leaders.length; i += 25) {
    const buyers = task.leaders.slice(i, i + 25).map(a => zeroPadValue(a, 32));
    out.push({ address: [soft], topics: [softAbi.getEvent('Buy').topicHash, null, buyers] });
    out.push({ address: gang.slice(1), topics: [v2Abi.getEvent('Buy').topicHash, null, buyers] });
  }
  if (task.venues.includes('flap')) out.push({ address: [flap], topics: [flapTopic] });
  if (task.venues.includes('four')) out.push({ address: [four], topics: [fourTopic] });
  return out;
}
export function decodeBuy(log) {
  if (log?.removed || !/^0x[0-9a-fA-F]{64}$/.test(log?.transactionHash || '') || log.logIndex == null) return null;
  const address = String(log.address).toLowerCase(), topic = log.topics?.[0];
  let venue, token, buyer, spentWei = null;
  try {
    if (gang.includes(address)) {
      const abi = address === soft ? softAbi : v2Abi;
      if (topic !== abi.getEvent('Buy').topicHash) return null;
      const a = abi.parseLog(log).args;
      venue = 'gang'; token = a.token; buyer = a.buyer;
      if (address === soft) spentWei = a.bnbIn;
      // LaunchpadV2/U/S quoteIn is NOT a BNB quantity. Never mirror it as BNB.
    } else if (address === flap && topic === flapTopic) {
      const a = AbiCoder.defaultAbiCoder().decode(['uint256','address','address','uint256','uint256','uint256','uint256'], log.data);
      venue = 'flap'; token = a[1]; buyer = a[2];
    } else if (address === four && topic === fourTopic) {
      const a = AbiCoder.defaultAbiCoder().decode(['address','address','uint256','uint256','uint256','uint256','uint256','uint256'], log.data);
      venue = 'four'; token = a[0]; buyer = a[1];
      // Cost alone does not identify the quote asset. Fixed BNB is supported;
      // mirroring requires a proven BNB-denominated event, not an assumption.
    } else return null;
    return { venue, token: token.toLowerCase(), buyer: buyer.toLowerCase(), spentWei, txHash: log.transactionHash.toLowerCase(), eventId: `${log.transactionHash.toLowerCase()}:${BigInt(log.logIndex)}`, blockNumber: log.blockNumber };
  } catch { return null; }
}
export function eventAmount(task, event) {
  if (!task.leaders.includes(event.buyer) || !task.venues.includes(event.venue)) return null;
  const cap = parseEther(task.amount), min = parseEther(task.minLeader);
  if (event.spentWei === null && (task.mode === 'mirror' || min > 0n)) throw new Error('此事件的金额无法确认为 BNB（可能为非 BNB 计价），不能按 BNB 镜像或过滤，已跳过');
  if (event.spentWei !== null && event.spentWei < min) return null;
  const spend = task.mode === 'mirror' ? (event.spentWei < cap ? event.spentWei : cap) : cap;
  return spend > 0n ? formatEther(spend) : null;
}
export class CopyFeed {
  constructor(store, { Socket = globalThis.WebSocket, now = Date.now, url = process.env.BAW_COPY_WSS || 'wss://bsc-rpc.publicnode.com' } = {}) {
    this.store = store; this.Socket = Socket; this.now = now; this.url = url;
    this.running = new Map(); this.jobs = new Map(); this.logs = []; this.clients = new Map();
    this.journal = join(store.directory, 'copy-seen.json');
    this.seen = new Map(existsSync(this.journal) ? JSON.parse(readFileSync(this.journal, 'utf8')) : []);
  }
  log(taskId, message) { this.logs.unshift({ at: this.now(), taskId, message: String(message).slice(0, 500) }); this.logs.length = Math.min(this.logs.length, 150); }
  remember(key) {
    this.seen.set(key, this.now());
    while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.journal + '.tmp', JSON.stringify([...this.seen]), { mode: 0o600 }); renameSync(this.journal + '.tmp', this.journal);
  }
  touch(client) { if (!/^[a-f0-9-]{36}$/.test(client || '')) throw new Error('执行器 ID 无效'); this.clients.set(client, this.now()); }
  liveClient(client) { return this.now() - (this.clients.get(client) ?? -Infinity) < 12000; }
  start(taskId, client, liveAcknowledged = false) {
    const task = this.store.data.tasks.find(t => t.id === taskId); if (!task) throw new Error('任务不存在');
    if (!task.dryRun && !liveAcknowledged) throw new Error('需要明确确认启动真实跟单');
    if (this.running.has(taskId)) throw new Error('任务已启动');
    this.touch(client);
    const url = new URL(this.url); if (url.protocol !== 'wss:') throw new Error('跟单节点必须使用 WSS');
    const run = { task: structuredClone(task), client, active: true, socket: null, timer: null, heartbeat: null, cooldown: new Map(), state: 'connecting', retries: 0 };
    this.running.set(taskId, run); this.connect(run); this.log(taskId, '监听启动；仅此面板在线时执行，重启服务后不会自动恢复');
  }
  connect(run) {
    if (!run.active) return;
    if (!this.liveClient(run.client)) { this.stop(run.task.id); this.log(run.task.id, '执行面板离线，已停止；不会补买历史信号'); return; }
    let socket;
    try { socket = new this.Socket(this.url); } catch { this.stop(run.task.id); this.log(run.task.id, '无法创建 WSS 连接，任务已停止'); throw new Error('无法创建跟单连接'); }
    run.socket = socket;
    const subscriptionsById = new Set(), pending = new Set(); let requestId = 0;
    let lastResponse = this.now();
    run.heartbeat = setInterval(() => {
      if (!this.liveClient(run.client)) { this.stop(run.task.id); this.log(run.task.id, '执行面板离线，监听已停止'); return; }
      if (this.now() - lastResponse > 30000) { this.log(run.task.id, 'WSS 节点超过 30 秒无响应，任务已停止'); this.stop(run.task.id); return; }
      if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'eth_blockNumber', params: [] }));
    }, 5000); run.heartbeat.unref?.();
    socket.addEventListener('open', () => {
      if (!run.active) { socket.close(); return; }
      run.state = 'subscribing';
      for (const filter of subscriptions(run.task)) { const id = ++requestId; pending.add(id); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', filter] })); }
    });
    socket.addEventListener('message', ({ data }) => {
      if (!run.active) return;
      let message; try { message = JSON.parse(String(data)); } catch { return; }
      lastResponse = this.now();
      if (pending.has(message.id)) {
        pending.delete(message.id);
        if (message.error || typeof message.result !== 'string') { this.log(run.task.id, '节点拒绝订阅，任务已停止'); this.stop(run.task.id); return; }
        subscriptionsById.add(message.result); if (!pending.size) { run.state = 'listening'; run.retries = 0; } return;
      }
      if (message.method !== 'eth_subscription' || !subscriptionsById.has(message.params?.subscription)) return;
      const event = decodeBuy(message.params?.result); if (event) this.ingest(run.task.id, event);
    });
    socket.addEventListener('error', () => { this.log(run.task.id, 'WSS 连接异常，等待重新连接'); try { socket.close(); } catch {} });
    socket.addEventListener('close', () => {
      clearInterval(run.heartbeat); if (!run.active) return;
      run.state = 'reconnecting'; run.timer = setTimeout(() => this.connect(run), Math.min(1000 * 2 ** run.retries++, 30000)); run.timer.unref?.();
    });
  }
  stop(taskId) {
    const r = this.running.get(taskId); if (!r) return;
    r.active = false; clearTimeout(r.timer); clearInterval(r.heartbeat); r.socket?.close(); this.running.delete(taskId);
    for (const j of this.jobs.values()) if (j.taskId === taskId && ['pending', 'claimed'].includes(j.status)) j.status = j.status === 'pending' ? 'cancelled' : 'stopping';
  }
  ingest(taskId, event) {
    const r = this.running.get(taskId); if (!r?.active || !this.liveClient(r.client)) return;
    let quantity; try { quantity = eventAmount(r.task, event); } catch (e) { this.log(taskId, e.message); return; }
    if (!quantity) return;
    // One decision per leader transaction + token, even if it emits several Buy logs.
    const key = `${taskId}:${event.txHash}:${event.token}`;
    if (this.seen.has(key)) return;
    this.remember(key);
    const cool = `${event.venue}:${event.token}`;
    if (this.now() - (r.cooldown.get(cool) ?? -Infinity) < r.task.cooldown * 1000) { this.log(taskId, '同币冷却中，已跳过'); return; }
    if ([...this.jobs.values()].filter(j => ['pending', 'claimed'].includes(j.status)).length >= 20) { this.log(taskId, '队列繁忙，跳过信号'); return; }
    r.cooldown.set(cool, this.now());
    const job = { id: newId('j'), taskId, client: r.client, status: 'pending', createdAt: this.now(), token: event.token, leader: event.buyer, txHash: event.txHash, venue: event.venue, amount: quantity, walletIds: [...r.task.walletIds], slippage: r.task.slippage, dryRun: r.task.dryRun, results: [] };
    this.jobs.set(job.id, job); this.log(taskId, `${event.venue} 买入信号，${job.walletIds.length} 个执行钱包，每钱包 ${quantity} BNB`);
    while (this.jobs.size > 150) { const old = [...this.jobs.values()].find(j => !['pending', 'claimed', 'stopping'].includes(j.status)); if (!old) break; this.jobs.delete(old.id); }
  }
  claim(client) {
    this.touch(client);
    for (const job of this.jobs.values()) {
      if (job.status !== 'pending') continue;
      if (this.now() - job.createdAt > 20000) { job.status = 'expired'; continue; }
      if (job.client !== client || !this.running.has(job.taskId)) continue;
      job.status = 'claimed'; job.claim = randomBytes(24).toString('hex'); return structuredClone(job);
    }
    return null;
  }
  permit({ jobId, claim, walletId }, args = []) {
    const job = this.jobs.get(jobId);
    if (!job || job.claim !== claim || job.status !== 'claimed' || !job.walletIds.includes(walletId) || !this.running.has(job.taskId) || !this.liveClient(job.client)) throw new Error('跟单任务已停止或执行面板离线，阻止新交易');
    if (job.results.some(r => r.walletId === walletId)) throw new Error('该钱包已完成此信号，不重复执行');
    if (job.dryRun && ((args[0] === 'contract-call' && args[1] === 'execute') || (args[0] === 'market-order' && args[1] === 'swap'))) throw new Error('预演任务禁止签名执行');
    return job;
  }
  result(input) {
    const j = this.jobs.get(input.jobId);
    if (!j || j.claim !== input.claim || !['claimed', 'stopping'].includes(j.status)) throw new Error('执行记录无效');
    if (!j.walletIds.includes(input.walletId) || j.results.some(r => r.walletId === input.walletId)) throw new Error('钱包结果无效或重复');
    j.results.push({ walletId: input.walletId, status: input.status === 'completed' ? 'completed' : 'failed', message: String(input.message || '').slice(0, 350) });
    if (j.results.length === j.walletIds.length) { j.status = 'done'; delete j.claim; }
  }
  snapshot() { return { running: [...this.running.values()].map(r => ({ taskId: r.task.id, state: r.state, dryRun: r.task.dryRun, executorOnline: this.liveClient(r.client) })), jobs: [...this.jobs.values()].slice(-30).map(({ claim, client, ...j }) => j), logs: this.logs }; }
  close() { for (const id of [...this.running.keys()]) this.stop(id); }
}
