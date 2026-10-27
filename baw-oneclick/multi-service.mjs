import { MultiStore } from './multi-store.mjs';
import { WalletRuntime } from './wallet-runtime.mjs';
import { CopyFeed } from './copy-feed.mjs';

export const multiStore = new MultiStore();
export const walletRuntime = new WalletRuntime(multiStore);
export const copyFeed = new CopyFeed(multiStore);
walletRuntime.permission = (context, args) => {
  if (context.permit) copyFeed.permit({ ...context.permit, walletId: context.id }, args);
};
export async function multiApi(req, res, pathname, readBody, send) {
  const reply = data => send(res, 200, { ok: true, ...data });
  if (pathname === '/api/multi/state' && req.method === 'GET') return reply({
    ...multiStore.data, wallets: multiStore.data.wallets.map(w => ({ ...w, ...(walletRuntime.statuses.get(w.id) || { status: 'UNCHECKED' }) })), copy: copyFeed.snapshot(),
  });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
  const body = await readBody(req);
  const busyWallet = id => [...copyFeed.running.values()].some(r => r.task.walletIds.includes(id));
  switch (pathname) {
    case '/api/multi/groups/create': return reply({ group: multiStore.createGroup(body.name) });
    case '/api/multi/groups/rename': multiStore.renameGroup(body.id, body.name); return reply({});
    case '/api/multi/wallets/create': return reply({ wallet: multiStore.createWallet(body.name, body.groupId) });
    case '/api/multi/wallets/update': return reply({ wallet: multiStore.updateWallet(body.id, body) });
    case '/api/multi/wallets/check': return reply(await walletRuntime.inspect(body.id));
    case '/api/multi/wallets/signin':
      if (busyWallet(body.id)) throw new Error('请先停止使用此身份的跟单任务');
      return reply(await walletRuntime.signin(body.id));
    case '/api/multi/wallets/verify': return reply(await walletRuntime.verify(body.id));
    case '/api/multi/tasks/save':
      if (copyFeed.running.has(body.id)) throw new Error('请先停止任务再修改');
      return reply({ task: multiStore.saveTask(body) });
    case '/api/multi/tasks/start':
      if (!multiStore.data.tasks.find(t => t.id === body.id)?.walletIds.every(id => walletRuntime.statuses.get(id)?.status === 'CONNECTED')) throw new Error('请先检查所有执行钱包连接状态');
      copyFeed.start(body.id, body.clientId, body.liveAcknowledged === true); return reply({});
    case '/api/multi/tasks/stop': copyFeed.stop(body.id); return reply({});
    case '/api/multi/tasks/heartbeat': copyFeed.touch(body.clientId); return reply({});
    case '/api/multi/tasks/claim': return reply({ job: copyFeed.claim(body.clientId) });
    case '/api/multi/tasks/result': copyFeed.result(body); return reply({});
    default: return send(res, 404, { ok: false, error: 'not found' });
  }
}
export function requestWalletScope(req, fn) {
  const id = req.headers['x-baw-wallet'];
  if (Array.isArray(id)) throw new Error('钱包 ID 无效');
  const jobId = req.headers['x-baw-copy-job'];
  if (jobId && !id) throw new Error('跟单执行必须指定钱包身份');
  const permit = jobId ? { jobId, claim: req.headers['x-baw-copy-claim'] } : null;
  return walletRuntime.scope(id, fn, permit, req.headers['x-baw-preview-only'] === '1');
}
