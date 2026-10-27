// Local string parsing only: never navigate to a token page or infer its chain.
const address = /^0x[0-9a-fA-F]{40}$/;
const debotHost = /^(?:www\.)?debot\.ai$/i;

export function normalizeTokenInput(value) {
  const text = String(value ?? '').trim();
  if (address.test(text)) return text.toLowerCase();
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !debotHost.test(url.hostname) || url.username || url.password || url.port) return null;
  const match = url.pathname.match(/^\/token\/bsc\/(?:\d+_)?(0x[0-9a-fA-F]{40})\/?$/);
  return match ? match[1].toLowerCase() : null;
}

export function extractClipboardCa(value) {
  const text = String(value ?? '').trim();
  // A Debot URL must pass its chain/path checks, even when surrounded by share text.
  const links = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const debot = links.find(link => /^https?:\/\/(?:www\.)?debot\.ai(?:[/:?#]|$)/i.test(link));
  if (debot) return normalizeTokenInput(debot.replace(/[)\]，。；;]+$/, ''));
  // Preserve the original clipboard convenience for ordinary copied address text.
  const match = text.match(/(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/);
  return match ? match[1].toLowerCase() : null;
}
