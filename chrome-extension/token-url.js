'use strict';

// Shared by the side panel and content watcher; never infer a chain from an address.
globalThis.bawTokenPage = function (value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/^www\./, '');
  let match;
  if (host === 'debot.ai') {
    match = url.pathname.match(/^\/token\/bsc\/(?:\d+_)?(0x[0-9a-f]{40})\/?$/i);
  } else if (host === 'gmgn.ai') {
    match = url.pathname.match(/^\/bsc\/token\/(?:[a-z0-9-]+_)?(0x[0-9a-f]{40})\/?$/i);
  } else return null;
  const address = match?.[1].toLowerCase();
  return {
    site: host === 'gmgn.ai' ? 'GMGN' : 'Debot',
    // DOM fallback is allowed only for GMGN's BSC overview/detail overlays.
    allowDomScan: host === 'gmgn.ai' && (/^\/bsc\/?$/i.test(url.pathname) || (url.pathname === '/' && url.searchParams.get('chain') === 'bsc')),
    address: address && !/^0x0{40}$/.test(address) ? address : null,
  };
};
