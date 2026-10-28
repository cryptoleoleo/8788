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
    clearDetectedCa('暂未精准定位到唯一 CA；打开 GMGN 的 BSC 代币详情后会继续自动识别。');
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

async function connect() {
  status.textContent = '正在连接本机服务…';
  retryButton.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${BASE}/api/health`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (!health || health.ok !== true || String(health.chain) !== '56') throw new Error('Unexpected local service response');
    serviceOnline = true;
    status.textContent = health.session === 'CONNECTED' ? '钱包服务已连接' : '本机服务已启动';
    offline.hidden = true;
    frame.hidden = false;
    if (!frame.src || frame.src === 'about:blank') frame.src = `${BASE}/`;
    if (pendingCa) goToBaw(pendingCa);
  } catch {
    serviceOnline = false;
    status.textContent = '等待本机服务';
    frame.hidden = true;
    offline.hidden = false;
  } finally {
    clearTimeout(timeout);
    retryButton.disabled = false;
  }
}

async function getActiveTab(tabId) {
  if (Number.isInteger(tabId)) {
    try { return await chrome.tabs.get(tabId); } catch { /* tab closed */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function scanGmgn(tabId) {
  try {
    const tab = await getActiveTab(tabId);
    if (!Number.isInteger(tab?.id)) throw new Error('没有活动标签页');
    activeTabId = tab.id;
    if (!tab.url) {
      clearDetectedCa('切到 GMGN 的 BSC 代币详情页后会自动抓取 CA。');
      return;
    }
    const url = new URL(tab.url);
    if (url.hostname !== 'gmgn.ai' || url.protocol !== 'https:') {
      clearDetectedCa('切到 GMGN 的 BSC 代币详情页后会自动抓取 CA。');
      return;
    }
    gmgnStatus.textContent = '正在精准识别 GMGN 当前代币…';
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'BAW_GMGN_SCAN' });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['gmgn-content.js'] });
      response = await chrome.tabs.sendMessage(tab.id, { type: 'BAW_GMGN_SCAN' });
    }
    receiveCandidate(response?.candidate);
  } catch {
    clearDetectedCa('无法读取 GMGN 当前页；刷新该标签页后再打开侧栏。');
  }
}

retryButton.addEventListener('click', connect);
document.getElementById('reload').addEventListener('click', () => {
  if (!frame.hidden) frame.src = frame.src;
  else connect();
});
document.getElementById('scan').addEventListener('click', () => scanGmgn());
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
  receiveCandidate(message.candidate);
});
chrome.tabs.onActivated.addListener(({ tabId }) => scanGmgn(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.status === 'complete' || changeInfo.url)) scanGmgn(tabId);
});

connect();
scanGmgn();
