import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('../chrome-extension/', import.meta.url);
const ca = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';
const other = '0x' + '7'.repeat(40);
const debot = 'https://debot.ai/token/bsc/312069_' + ca;
const gmgn = 'https://gmgn.ai/bsc/token/' + ca;
const tick = () => new Promise(resolve => setImmediate(resolve));

function panel(url) {
  const elements = new Map();
  const listeners = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { src: '', textContent: '', hidden: true, addEventListener(type, fn) { listeners[id + ':' + type] = fn; } });
    return elements.get(id);
  };
  let active = { id: 1, url };
  const events = {};
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, console,
    document: { getElementById: element }, navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, chain: 56, session: 'CONNECTED' }) }),
    chrome: {
      tabs: { query: async () => [active], get: async () => active, sendMessage: async () => { throw Error('No content script'); }, onActivated: event('activated'), onUpdated: event('updated') },
      scripting: { executeScript: async () => { throw Error('Cannot inject into fixture'); } },
      runtime: { onMessage: event('message') },
    },
  });
  const html = readFileSync(new URL('sidepanel.html', root), 'utf8');
  for (const [, file] of html.matchAll(/<script src="([^"]+)"/g)) vm.runInContext(readFileSync(new URL(file, root), 'utf8'), context);
  return { context, elements, events, setActive(tab) { active = tab; } };
}

for (const url of [debot, gmgn, gmgn.replace('/token/', '/token/MjhhuWaq_')]) {
  test('active token URL reaches BAW even without injected content script: ' + url, async () => {
    const p = panel(url); await tick();
    const target = new URL(p.elements.get('dashboard').src);
    assert.equal(target.searchParams.get('ca'), ca);
    assert.equal(target.searchParams.get('auto'), '1');
  });
}

test('active tab and SPA URL changes update the panel; non-BSC pages are rejected', async () => {
  const p = panel(debot); await tick();
  p.setActive({ id: 2, url: gmgn.replace(ca, other) });
  p.events.activated({ tabId: 2 }); await tick();
  assert.equal(new URL(p.elements.get('dashboard').src).searchParams.get('ca'), other);
  p.setActive({ id: 2, url: debot });
  p.events.updated(2, { url: debot }); await tick();
  assert.equal(new URL(p.elements.get('dashboard').src).searchParams.get('ca'), ca);
  p.setActive({ id: 3, url: gmgn.replace('/bsc/', '/eth/') });
  p.events.activated({ tabId: 3 }); await tick();
  assert.equal(p.elements.get('current-ca').hidden, true);
  assert.equal(p.elements.get('ca-value').textContent, '');
});

test('URL parser accepts supported BSC forms and rejects wrong chains, spoofed hosts and malformed addresses', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('token-url.js', root), 'utf8'), context);
  for (const url of [debot, debot + '/?share=1#chart', gmgn, gmgn.replace('/token/', '/token/MjhhuWaq_'), gmgn.replace('gmgn.ai', 'www.gmgn.ai')]) {
    assert.equal(context.bawTokenPage(url)?.address, ca, url);
  }
  assert.equal(context.bawTokenPage('https://gmgn.ai/?chain=bsc')?.allowDomScan, true);
  for (const url of ['https://gmgn.ai/?chain=eth', debot.replace('/bsc/', '/eth/'), gmgn.replace('/bsc/', '/sol/'), gmgn + '0', gmgn + '/extra', gmgn.replace('gmgn.ai', 'gmgn.ai.evil.test'), gmgn.replace('https://', 'https://user@'), gmgn.replace('https:', 'http:'), gmgn.replace(ca, '0x' + '0'.repeat(40))]) {
    assert.ok(!context.bawTokenPage(url)?.address, url);
    assert.ok(!context.bawTokenPage(url)?.allowDomScan, url);
  }
});

test('manifest grants both websites and loads the shared URL parser before the watcher', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root)));
  for (const host of ['gmgn.ai', 'debot.ai', 'www.gmgn.ai', 'www.debot.ai']) {
    assert.ok(manifest.host_permissions.includes('https://' + host + '/*'));
    assert.ok(manifest.content_scripts[0].matches.includes('https://' + host + '/*'));
  }
  assert.deepEqual(manifest.content_scripts[0].js, ['token-url.js', 'gmgn-content.js']);
});

test('slow response from the previous tab cannot replace the new active tab CA', async () => {
  const p = panel(debot); await tick();
  let resolveOld;
  p.context.chrome.tabs.sendMessage = () => new Promise(resolve => { resolveOld = resolve; });
  p.setActive({ id: 2, url: 'https://gmgn.ai/bsc' });
  p.events.activated({ tabId: 2 }); await tick();
  assert.ok(resolveOld);
  p.setActive({ id: 3, url: gmgn.replace(ca, other) });
  p.events.activated({ tabId: 3 }); await tick();
  resolveOld({ candidate: { address: ca, precise: true } }); await tick();
  assert.equal(p.elements.get('ca-value').textContent, other);
  assert.equal(new URL(p.elements.get('dashboard').src).searchParams.get('ca'), other);
});

test('content watcher follows Debot and GMGN history changes without reading page addresses', () => {
  const published = [], callbacks = {}, intervals = [];
  let onMessage;
  const location = new URL(debot);
  const context = vm.createContext({ URL, location, Date, console,
    document: { documentElement: {}, querySelectorAll() { throw Error('URL scan must not depend on DOM'); } },
    MutationObserver: class { observe() {} },
    setInterval(fn) { intervals.push(fn); return 1; }, setTimeout, clearTimeout,
    addEventListener(name, fn) { callbacks[name] = fn; },
    chrome: { runtime: { sendMessage(message, cb) { published.push(message); cb(); }, onMessage: { addListener(fn) { onMessage = fn; } } } },
  });
  for (const file of ['token-url.js', 'gmgn-content.js']) vm.runInContext(readFileSync(new URL(file, root), 'utf8'), context);
  assert.equal(published.at(-1).candidate.address, ca);
  location.href = debot.replace(ca, other);
  intervals[0]();
  assert.equal(published.at(-1).candidate.address, other);
  location.href = gmgn.replace('/token/', '/token/MjhhuWaq_');
  callbacks.popstate();
  assert.equal(published.at(-1).candidate.address, ca);
  const count = published.length;
  let result;
  onMessage({ type: 'BAW_GMGN_SCAN' }, {}, value => result = value);
  assert.equal(result.candidate.address, ca);
  assert.equal(published.length, count, 'scan replies must not start a message feedback loop');
  location.href = gmgn.replace('/bsc/', '/eth/');
  callbacks.popstate();
  assert.equal(published.at(-1).candidate, null);
});
