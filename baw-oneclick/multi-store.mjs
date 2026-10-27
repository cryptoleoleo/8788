import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEther, formatEther } from 'ethers';

export const addressPattern = /^0x[0-9a-fA-F]{40}$/;
export function defaultDataDirectory(platform = process.platform, env = process.env, home = homedir()) {
  if (env.BAW_DATA_DIR) return env.BAW_DATA_DIR;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'BAW-Original-Multi', 'data');
  return posix.join(home, 'Library', 'Application Support', 'BAW-Original-Multi');
}
export const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
export const text = (s, max = 40) => {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > max) throw new Error('名称不能为空或过长');
  return s.trim();
};
export function amount(raw, allowZero = false) {
  const s = String(raw ?? '');
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(s)) throw new Error('金额需要十进制数，最多 18 位小数');
  const n = parseEther(s);
  if (n < 0n || (!allowZero && n === 0n) || n > parseEther('1000000')) throw new Error('金额超出范围');
  return formatEther(n);
}
export class MultiStore {
  constructor(directory = defaultDataDirectory()) {
    this.directory = resolve(directory);
    this.file = join(this.directory, 'settings.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      version: 1, groups: [{ id: 'g_default', name: '主力组' }],
      wallets: [{ id: 'original', name: '原有钱包', groupId: 'g_default', address: null }], tasks: [],
    };
    if (this.data.version !== 1 || !Array.isArray(this.data.wallets) || !Array.isArray(this.data.tasks)) throw new Error('多钱包配置版本或格式错误');
  }
  save() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(temp, 0o600); renameSync(temp, this.file);
  }
  wallet(id) {
    if (id !== 'original' && !/^w_[a-f0-9]{24}$/.test(id || '')) throw new Error('钱包 ID 无效');
    const w = this.data.wallets.find(w => w.id === id);
    if (!w) throw new Error('钱包不存在');
    return w;
  }
  group(id) { const g = this.data.groups.find(g => g.id === id); if (!g) throw new Error('分组不存在'); return g; }
  createGroup(name) { if (this.data.groups.length >= 30) throw new Error('最多 30 个分组'); const g = { id: newId('g'), name: text(name) }; this.data.groups.push(g); this.save(); return g; }
  renameGroup(id, name) { this.group(id).name = text(name); this.save(); }
  createWallet(name, groupId) {
    this.group(groupId); if (this.data.wallets.length >= 30) throw new Error('最多 30 个身份');
    const w = { id: newId('w'), name: text(name), groupId, address: null };
    this.data.wallets.push(w); this.save(); return w;
  }
  updateWallet(id, { name, groupId }) {
    const w = this.wallet(id); if (name !== undefined) w.name = text(name);
    if (groupId !== undefined) { this.group(groupId); w.groupId = groupId; }
    this.save(); return w;
  }
  bindAddress(id, address) {
    if (!addressPattern.test(address || '')) throw new Error('未取得 BSC 地址');
    const w = this.wallet(id);
    if (w.address && w.address.toLowerCase() !== address.toLowerCase()) throw new Error('钱包实际地址与绑定身份不同，已阻止执行；请新建独立身份');
    if (this.data.wallets.some(x => x.id !== id && x.address?.toLowerCase() === address.toLowerCase())) throw new Error('这个 BSC 地址已经绑定到另一个身份，不能重复添加');
    w.address = address; this.save(); return w;
  }
  validateTask(input) {
    const wallets = [...new Set(input.walletIds || [])];
    if (!wallets.length || wallets.length > 30) throw new Error('至少选择一个执行钱包');
    wallets.forEach(id => { if (!this.wallet(id).address) throw new Error('执行钱包尚未连接'); });
    const leaders = [...new Set((input.leaders || []).map(a => String(a).trim().toLowerCase()))];
    if (!leaders.length || leaders.length > 100 || leaders.some(a => !addressPattern.test(a))) throw new Error('请填写 1–100 个有效目标地址');
    if (wallets.some(id => leaders.includes(this.wallet(id).address.toLowerCase()))) throw new Error('执行钱包不能同时作为跟单目标');
    const venues = [...new Set(input.venues || [])];
    if (!venues.length || venues.some(v => !['gang', 'flap', 'four'].includes(v))) throw new Error('请选择支持的平台');
    const cooldown = Number(input.cooldown ?? 60), slippage = Number(input.slippage ?? 1);
    if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 86400) throw new Error('冷却时间需要 0–86400 秒整数');
    if (!Number.isFinite(slippage) || slippage < .1 || slippage > 50) throw new Error('跟单滑点范围为 0.1–50%');
    if (!['fixed', 'mirror'].includes(input.mode)) throw new Error('金额模式无效');
    return { id: input.id || newId('t'), name: text(input.name), walletIds: wallets, leaders, venues,
      amount: amount(input.amount), mode: input.mode, minLeader: amount(input.minLeader || '0', true),
      cooldown, slippage, dryRun: input.dryRun !== false };
  }
  saveTask(input) {
    const t = this.validateTask(input), i = this.data.tasks.findIndex(x => x.id === t.id);
    if (input.id && i < 0) throw new Error('任务不存在');
    if (i < 0 && this.data.tasks.length >= 20) throw new Error('最多 20 个任务');
    if (i >= 0) this.data.tasks[i] = t; else this.data.tasks.push(t);
    this.save(); return t;
  }
}
