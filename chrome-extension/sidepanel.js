'use strict';

const BASE = 'http://127.0.0.1:8787';
const frame = document.getElementById('dashboard');
const offline = document.getElementById('offline');
const status = document.getElementById('status');
const retryButton = document.getElementById('retry');
const gmgnStatus = document.getElementById('gmgn-status');
const currentCaBox = document.getElementById('current-ca');
const caValue = document.getElementById('ca-value');
let serviceOnline = false;
let activeTabId = null;
let pendingCa = null;
let lastParsedCa = null;
let scanRevision = 0;

function clearDetectedCa(message) {
  pendingCa = null;
  currentCaBox.hidden = true;
  caValue.textContent = '';
  gmgnStatus.textContent = message;
}

function goToBaw(ca) {
  const url = new URL(BASE);
  url.searchParams.set('ca', ca);
  url.searchParams.set('auto', '1');
  if (frame.src !== url.href) frame.src = url.href;
  frame.hidden = false;
  offline.hidden = true;
  pendingCa = null;
  gmgnStatus.textContent = `精准识别到 ${ca}，本机 BAW 正在自动只读解析。`;
}

function receiveCandidate(item) {
  const ca = String(item?.address || '').toLowerCase();
  if (!item?.precise || !/^0x[a-f0-9]{40}$/.test(ca) || /^0x0{40}$/.test(ca)) {
    clearDetectedCa('暂未精准定位到唯一 CA；打开 GMGN / Debot 的 BSC 代币详情后会继续自动识别。');
    return;
  }
  caValue.textContent = ca;
  currentCaBox.hidden = false;
  let frameCa = null;
  try { frameCa = new URL(frame.src).searchParams.get('ca')?.toLowerCase() || null; } catch { /* frame not initialized */ }
  if (ca === lastParsedCa && ca === frameCa && serviceOnline) {
    gmgnStatus.textContent = `已精准识别 ${ca}，已送本机 BAW 解析。`;
    return;
  }
  pendingCa = ca;
  lastParsedCa = ca;
  gmgnStatus.textContent = `精准识别到 ${ca}，正在准备自动解析…`;
  if (serviceOnline) goToBaw(ca);
  else connect();
}

let connecting = null;
async function probeService() {
  const response = await fetch(`${BASE}/api/launcher-status`, {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error('本机服务尚未就绪');
  const data = await response.json();
  if (data.app !== 'baw-original-multi' || data.launcherProtocol !== 1) throw new Error('本机服务版本不支持按需启动，请运行新版安装器');
}
function requestBackgroundStart() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('启动组件响应超时，请稍后重试')), 35000);
    chrome.runtime.sendNativeMessage('com.baw.original_multi', { action: 'ensureStarted' }, response => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error('未能连接本地启动组件，请先运行 1.4.1 配套安装器；升级 Node 后请重新安装组件。'));
      if (!response?.ok) return reject(new Error(response?.error || '后台启动失败'));
      resolve();
    });
  });
}
function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    status.textContent = '正在连接本机服务…';
    retryButton.disabled = true;
    try {
      try { await probeService(); }
      catch {
        status.textContent = '正在后台启动 BAW…';
        await requestBackgroundStart();
        await probeService();
      }
      serviceOnline = true;
      status.textContent = '本机服务已就绪';
      offline.hidden = true;
      frame.hidden = false;
      if (!frame.src || frame.src === 'about:blank') frame.src = `${BASE}/`;
      if (pendingCa) goToBaw(pendingCa);
    } catch (error) {
      serviceOnline = false;
      status.textContent = 'BAW 尚未就绪';
      frame.hidden = true;
      offline.hidden = false;
      document.getElementById('startup-error').textContent = error.message;
    } finally { retryButton.disabled = false; }
  })().finally(() => { connecting = null; });
  return connecting;
}

async function scanTokenPage() {
  const revision = ++scanRevision;
  // Do not let a pending connection send the previous tab's CA while this scan awaits.
  pendingCa = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (revision !== scanRevision) return;
    activeTabId = tab?.id ?? null;
    const page = bawTokenPage(tab?.url);
    if (!Number.isInteger(tab?.id) || !page || (!page.address && !page.allowDomScan)) {
      clearDetectedCa('切到 GMGN / Debot 的 BSC 代币详情页后会自动识别 CA。');
      return;
    }
    // The URL is authoritative: it works even if the page has not finished loading
    // or the content script was not injected into an already-open tab.
    if (page.address) {
      receiveCandidate({ address: page.address, precise: true });
      return;
    }
    gmgnStatus.textContent = '正在识别 GMGN 当前代币…';
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'BAW_GMGN_SCAN' });
    } catch {
      if (revision !== scanRevision) return;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['token-url.js', 'gmgn-content.js'] });
      if (revision !== scanRevision) return;
      response = await chrome.tabs.sendMessage(tab.id, { type: 'BAW_GMGN_SCAN' });
    }
    if (revision !== scanRevision) return;
    receiveCandidate(response?.candidate);
  } catch {
    if (revision === scanRevision) clearDetectedCa('无法读取当前页；请允许 GMGN / Debot 网站访问权限，刷新标签页后重试。');
  }
}

retryButton.addEventListener('click', connect);
document.getElementById('reload').addEventListener('click', () => {
  if (!frame.hidden) frame.src = frame.src;
  else connect();
});
document.getElementById('scan').addEventListener('click', () => scanTokenPage());
document.getElementById('copy-ca').addEventListener('click', async () => {
  if (!caValue.textContent) return;
  try {
    await navigator.clipboard.writeText(caValue.textContent);
    gmgnStatus.textContent = 'CA 已复制。';
  } catch {
    gmgnStatus.textContent = '复制失败，请手动选中 CA。';
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'BAW_GMGN_CA_UPDATE' || sender.tab?.id !== activeTabId) return;
  scanTokenPage();
});
chrome.tabs.onActivated.addListener(() => scanTokenPage());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.status === 'complete' || changeInfo.url)) scanTokenPage();
});

connect();
scanTokenPage();
