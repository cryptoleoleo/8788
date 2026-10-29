import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { addressPattern } from './multi-store.mjs';

const bootstrap = new URL('./profile-bootstrap.mjs', import.meta.url).href;
export const walletContext = new AsyncLocalStorage();
export function parseCliJSON(raw) {
  try { return JSON.parse(raw); } catch {}
  for (const line of raw.trim().split('\n').reverse()) { try { return JSON.parse(line); } catch {} }
  return null;
}
export function bscAddress(out) {
  if (!out?.json?.success) throw new Error(out?.json?.error?.message || '无法读取钱包地址，请完成登录');
  const row = out.json.data?.addresses?.find(x => String(x.binanceChainId) === '56');
  if (!addressPattern.test(row?.address || '')) throw new Error('钱包没有有效 BSC 地址');
  return row.address;
}
export class WalletRuntime {
  constructor(store, { run, env = process.env } = {}) {
    this.store = store; this.env = env; this.runner = run || this.exec.bind(this); this.runnerInjectedForTests = Boolean(run); this.statuses = new Map();
    this.pairings = new Map(); this.locks = new Map(); this.permission = () => {};
  }
  current() { return walletContext.getStore(); }
  scope(id, fn, permit = null, previewOnly = false) {
    if (!id) return walletContext.run(null, fn);
    this.store.wallet(id);
    return walletContext.run({ id, permit, previewOnly }, fn);
  }
  spec(id) {
    mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
    const cli = this.env.BAW_CLI;
    if (!cli || !isAbsolute(cli)) throw new Error('多钱包需要 BAW_CLI 指向钱包 CLI 的绝对路径，请使用对应系统的启动器');
    const env = { ...this.env };
    const args = [];
    if (id !== 'original') {
      this.store.wallet(id);
      // Fail closed on unreviewed upstream versions: keychain storage is version-dependent.
      if (!this.runnerInjectedForTests) {
        const pkg = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'));
        if (pkg.name !== '@binance/agentic-wallet' || pkg.version !== '1.11.0') throw new Error('独立身份适配当前仅验证 BAW CLI 1.11.0，请勿用未验证版本签名');
      }
      const dir = join(this.store.directory, 'identities', id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      env.BINANCE_BAW_DIR = dir; env.BAW_ISOLATED_ID = id;
      delete env.NODE_OPTIONS; delete env.BAW_KEYTAR_MODULE;
      args.push('--import', bootstrap);
    }
    return { file: this.env.BAW_NODE || process.execPath, args: [...args, cli], env };
  }
  exec(id, args, timeout = 180000) {
    const spec = this.spec(id);
    return new Promise(resolve => execFile(spec.file, [...spec.args, ...args], {
      env: spec.env, cwd: this.store.directory, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => resolve({ err, json: parseCliJSON(String(stdout || '')), stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })));
  }
  async serialized(id, fn) {
    const prior = this.locks.get(id) || Promise.resolve();
    const operation = prior.catch(() => {}).then(fn); this.locks.set(id, operation);
    try { return await operation; } finally { if (this.locks.get(id) === operation) this.locks.delete(id); }
  }
  async inspect(id) {
    const out = await this.runner(id, ['wallet', 'address', '--json'], 60000);
    const address = bscAddress(out); this.store.bindAddress(id, address);
    const st = await this.runner(id, ['wallet', 'status', '--json'], 60000);
    const status = st.json?.success ? st.json.data?.status : 'UNKNOWN';
    this.statuses.set(id, { status, checkedAt: Date.now() });
    return { address, status };
  }
  async assertIdentity(id) {
    const w = this.store.wallet(id);
    if (!w.address) throw new Error('身份尚未绑定钱包地址');
    const actual = bscAddress(await this.runner(id, ['wallet', 'address', '--json'], 60000));
    if (actual.toLowerCase() !== w.address.toLowerCase()) { this.statuses.set(id, { status: 'IDENTITY_MISMATCH', checkedAt: Date.now() }); throw new Error('签名钱包地址不匹配，已阻止交易'); }
    return actual;
  }
  async run(args, timeout) {
    const ctx = this.current(); if (!ctx) throw new Error('Missing scoped wallet');
    return this.serialized(ctx.id, async () => {
      this.permission(ctx, args);
      if (ctx.previewOnly && ((args[0] === 'contract-call' && args[1] === 'execute') || (args[0] === 'market-order' && args[1] === 'swap'))) throw new Error('分组预演禁止签名或提交交易');
      if (['contract-call', 'market-order'].includes(args[0])) {
        const address = await this.assertIdentity(ctx.id);
        const i = args.indexOf('--from');
        if (i >= 0 && args[i + 1]?.toLowerCase() !== address.toLowerCase()) throw new Error('交易 from 与当前身份不同');
        this.permission(ctx, args);
      }
      return this.runner(ctx.id, args, timeout);
    });
  }
  async address() { const c = this.current(); return c ? this.assertIdentity(c.id) : null; }
  async signin(id) {
    this.store.wallet(id); // Original identity uses its existing CLI context; new identities stay isolated.
    if (this.locks.has(id)) throw new Error('此钱包正忙');
    const r = await this.serialized(id, () => this.runner(id, ['auth', 'signin', '--json'], 60000));
    const d = r.json?.success && r.json.data;
    if (!d) throw new Error(r.json?.error?.message || '登录请求失败');
    if (d.status === 'ALREADY_CONNECTED') return { alreadyConnected: true, ...await this.inspect(id) };
    let u; try { u = new URL(d.urlForWeb); } catch { throw new Error('CLI 未返回有效登录链接'); }
    if (u.protocol !== 'https:' || (u.hostname !== 'binance.com' && !u.hostname.endsWith('.binance.com'))) throw new Error('CLI 返回了非 Binance 登录地址');
    if (!d.qrCodeId || !d.pairingCode) throw new Error('登录配对信息不完整');
    this.pairings.set(id, { qrCodeId: String(d.qrCodeId), until: Date.now() + 300000 });
    return { urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, expireAt: d.expireAt };
  }
  async verify(id) {
    const p = this.pairings.get(id); if (!p || p.until < Date.now()) throw new Error('配对已过期，请重新发起登录');
    const r = await this.serialized(id, () => this.runner(id, ['auth', 'verify', '--qrCodeId', p.qrCodeId, '--json'], 310000));
    this.pairings.delete(id);
    if (!r.json?.success) throw new Error(r.json?.error?.message || '登录未完成');
    return this.inspect(id);
  }
}
