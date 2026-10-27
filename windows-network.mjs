import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function parseWindowsProxy(enabled, server) {
  if (!/\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return {};
  const raw = server.match(/\bProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
  if (!raw) return {};
  const valid = value => {
    if (!/^(?:https?:\/\/)?(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):\d+$/.test(value)) return null;
    try { const url = new URL(value.includes('://') ? value : 'http://' + value); const port = Number(value.match(/:(\d+)$/)[1]); return port > 0 && port <= 65535 ? url.origin : null; } catch { return null; }
  };
  if (!raw.includes('=')) { const url = valid(raw); return url ? { http: url, https: url } : {}; }
  const fields = Object.fromEntries(raw.split(';').map(part => part.trim().split('=')));
  return { http: fields.http && valid(fields.http), https: fields.https && valid(fields.https) };
}
export function windowsProxyEnvironment(env, settings = {}) {
  const result = { ...env };
  if (env.BAW_SYSTEM_PROXY === '0') return result;
  const http = env.http_proxy || env.HTTP_PROXY || settings.http;
  const https = env.https_proxy || env.HTTPS_PROXY || settings.https;
  if (!http && !https) return result;
  if (http) result.HTTP_PROXY = result.http_proxy = http;
  if (https) result.HTTPS_PROXY = result.https_proxy = https;
  result.NO_PROXY = result.no_proxy = [env.no_proxy || env.NO_PROXY || '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  result.NODE_USE_ENV_PROXY = '1';
  return result;
}
export function windowsNetworkEnvironment(env = process.env) {
  if (process.platform !== 'win32' || env.BAW_SYSTEM_PROXY === '0') return windowsProxyEnvironment(env);
  let settings = {};
  try {
    const reg = join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const read = value => execFileSync(reg, ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    settings = parseWindowsProxy(read('ProxyEnable'), read('ProxyServer'));
  } catch { /* Explicit proxy environment still works without a manual system proxy. */ }
  return windowsProxyEnvironment(env, settings);
}
