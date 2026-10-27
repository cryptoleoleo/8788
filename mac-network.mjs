import { execFileSync } from 'node:child_process';

export function parseSystemProxy(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  const url = (prefix) => {
    const host = values[`${prefix}Proxy`];
    const port = Number(values[`${prefix}Port`]);
    if (values[`${prefix}Enable`] !== '1' || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    // scutil supplies a hostname/IP, never credentials or a full URL.
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return null;
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${authority}:${port}`;
  };
  return { http: url('HTTP'), https: url('HTTPS') };
}

export function proxyEnvironment(env, systemProxy = '', nodeVersion = process.versions.node) {
  const result = { ...env };
  if (env.BAW_SYSTEM_PROXY === '0') return result;
  const system = parseSystemProxy(systemProxy);
  const http = env.http_proxy || env.HTTP_PROXY || system.http;
  const https = env.https_proxy || env.HTTPS_PROXY || system.https;
  if (!http && !https) return result;
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 21))) {
    throw new Error('使用系统代理需要 Node.js 24+ 或 22.21+。请升级 Node.js LTS 后重新启动。');
  }
  if (http) result.HTTP_PROXY = result.http_proxy = http;
  if (https) result.HTTPS_PROXY = result.https_proxy = https;
  const bypass = [env.no_proxy || env.NO_PROXY || '', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  result.NO_PROXY = result.no_proxy = bypass;
  result.NODE_USE_ENV_PROXY = '1';
  return result;
}

export function macNetworkEnvironment(env = process.env) {
  let settings = '';
  if (process.platform === 'darwin' && env.BAW_SYSTEM_PROXY !== '0') {
    try { settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }); }
    catch { /* Explicit proxy environment still works if scutil is unavailable. */ }
  }
  return proxyEnvironment(env, settings);
}
