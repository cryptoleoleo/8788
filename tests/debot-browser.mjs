import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { startFixture } from './server-fixture.mjs';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.BAW_TEST_PLAYWRIGHT || process.env.HOME + '/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const ca = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';
const link = 'https://debot.ai/token/bsc/312069_' + ca;
const fixture = await startFixture();
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage(), errors = [], blocked = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.url) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(({ link }) => {
    window.testClipboard = '';
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => window.testClipboard } });
  }, { link });
  await page.goto(fixture.url);
  await page.locator('#mw-wallet-select').waitFor();
  await page.locator('#ca').fill(link + '?source=share#chart');
  assert.equal(await page.locator('#ca').inputValue(), ca);
  await page.locator('#ca').blur();
  assert.equal(await page.evaluate(() => localStorage.getItem('baw.ca')), ca);
  // Exercise the native-paste listener without accessing the system clipboard.
  await page.evaluate(link => {
    const input = document.querySelector('#ca'); input.value = link;
    input.dispatchEvent(new Event('paste', { bubbles: true }));
  }, link);
  await page.waitForFunction(ca => document.querySelector('#ca').value === ca, ca);
  await page.evaluate(link => {
    const data = new DataTransfer(); data.setData('text/plain', link);
    document.querySelector('#ca').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, link);
  assert.equal(await page.locator('#ca').inputValue(), ca);
  await page.evaluate(link => window.testClipboard = link, link);
  await page.evaluate(() => document.querySelector('#ca').value = '');
  await page.locator('#btnPasteCa').click();
  assert.equal(await page.locator('#ca').inputValue(), ca);
  // Resolve-click validation also normalizes programmatically populated input.
  await page.evaluate(link => document.querySelector('#ca').value = link, link);
  await page.locator('#btnResolve').click();
  assert.equal(await page.locator('#ca').inputValue(), ca);
  await page.locator('#ca').fill(link.replace('/bsc/', '/eth/'));
  await page.locator('#btnResolve').click();
  assert.match(await page.locator('#log').innerText(), /Debot 的 \/token\/bsc\//);
  await page.goto(fixture.url + '/?ca=' + encodeURIComponent(link));
  await page.locator('#mw-wallet-select').waitFor();
  assert.equal(await page.locator('#ca').inputValue(), ca);
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  writeFileSync(new URL('../verification/debot-results.json', import.meta.url), JSON.stringify({ passed: true, checks: ['direct URL input', 'paste event', 'clipboard button with fake clipboard', 'resolve button', 'saved CA normalized', 'deep-link ca parameter', 'reject non-BSC Debot link'], network: 'Local fixture only; no real wallet or chain access' }, null, 2));
  console.log('PASS Debot compatibility in original BAW page; no real clipboard/wallet/chain access.');
} finally { await browser?.close(); await fixture.close(); }
