import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokenInput, extractClipboardCa } from '../baw-oneclick/ca-input.mjs';
const ca = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';
const link = 'https://debot.ai/token/bsc/312069_' + ca;

test('Debot BSC input accepts the supplied URL, query/fragment, trailing slash and ordinary CA', () => {
  for (const value of [link, link + '?source=share#chart', link + '/', link.replace('312069_', ''), '  ' + link + '  ', ca, '0x' + ca.slice(2).toUpperCase()]) {
    assert.equal(normalizeTokenInput(value), ca, value);
  }
});
test('Debot input rejects other chains, hosts and malformed or overlong addresses', () => {
  for (const value of [link.replace('/bsc/', '/eth/'), link.replace('/bsc/', '/solana/'), link.replace('debot.ai', 'debot.ai.evil.test'), link + '0', link.slice(0, -1), link + '/extra', link.replace('312069_', 'x_'), 'javascript:' + link, link.replace('https://', 'https://someone@'), '']) {
    assert.equal(normalizeTokenInput(value), null, value);
  }
});
test('clipboard keeps shared-text CA extraction and checks the chain in Debot links', () => {
  assert.equal(extractClipboardCa('看看这个 ' + link), ca);
  assert.equal(extractClipboardCa('(' + link + ')'), ca);
  assert.equal(extractClipboardCa('CA: ' + ca), ca);
  assert.equal(extractClipboardCa(link.replace('/bsc/', '/eth/')), null);
  assert.equal(extractClipboardCa('CA: ' + ca + '00'), null);
});
