'use strict';

(() => {
  if (globalThis.__BAW_GMGN_CA_WATCHER__) return;

  const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;
  const TOKEN_ROUTE_RE = /\/bsc\/token\/(0x[a-fA-F0-9]{40})(?:[/?#]|$)/i;
  const SHORT_CA_RE = /0x[a-fA-F0-9]{4,12}(?:\.{3}|…|⋯)[a-fA-F0-9]{4,12}/;
  const TOKEN_LABEL_RE = /(?:\bCA\b|contract|token|合约|代币)/i;
  const WALLET_LABEL_RE = /(?:wallet|account|connect|portfolio|钱包|账户|余额|持仓)/i;
  const SELECTOR = 'button,[role="button"],[title],[aria-label],[data-address],[data-token-address],[data-ca],[data-clipboard-text],[class*="ca" i],[class*="address" i],[class*="contract" i],a[href]';
  let lastFingerprint = '';
  let lastHref = location.href;
  let lastScanAt = 0;
  let queuedTimer = 0;

  function scan() {
    const candidates = new Map();
    function add(rawAddress, score, source, context = '', detailEvidence = false) {
      const address = String(rawAddress || '').toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address) || /^0x0{40}$/.test(address)) return;
      const prior = candidates.get(address);
      if (!prior || score > prior.score) {
        candidates.set(address, {
          address,
          score,
          source,
          fromDetailRoute: source === 'GMGN BSC 代币详情链接' || Boolean(prior?.fromDetailRoute),
          detailEvidence: detailEvidence || Boolean(prior?.detailEvidence) || source === 'GMGN BSC 代币详情链接',
          context: String(context).replace(/\s+/g, ' ').trim().slice(0, 120),
        });
      }
    }

    const route = location.pathname.match(TOKEN_ROUTE_RE);
    if (route) add(route[1], 120, 'GMGN BSC 代币详情链接', location.pathname);

    const elements = [...document.querySelectorAll(SELECTOR)].slice(0, 1800);
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (!visible) continue;
      const topLeft = visible && rect.top < innerHeight * 0.48 && rect.left < innerWidth * 0.55;
      const text = (element.innerText || element.textContent || '').slice(0, 240);
      const parentText = (element.parentElement?.innerText || '').slice(0, 360);
      const context = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${text} ${parentText}`;
      const tokenLabelled = TOKEN_LABEL_RE.test(context);
      const walletLike = WALLET_LABEL_RE.test(context) && !tokenLabelled;
      const overlay = Boolean(element.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[data-state="open"],[class*="modal" i],[class*="drawer" i],[class*="detail" i]'));
      if (walletLike) continue;
      const isControl = element.matches('button,[role="button"]');
      const visibleShortCa = topLeft && isControl && SHORT_CA_RE.test(text);
      const visibleFullCa = topLeft && isControl && /0x[a-fA-F0-9]{40}/.test(text);
      const caControlBonus = visibleShortCa ? 38 : visibleFullCa ? 30 : 0;
      const attrs = [
        ['title', 8], ['aria-label', 8], ['data-address', 14],
        ['data-token-address', 40], ['data-ca', 40], ['data-clipboard-text', 14],
      ];
      for (const [name, base] of attrs) {
        const value = element.getAttribute(name);
        if (!value) continue;
        ADDRESS_RE.lastIndex = 0;
        let match;
        while ((match = ADDRESS_RE.exec(value))) {
          add(match[0], base + (topLeft ? 6 : 0) + (tokenLabelled ? 22 : 0) + (overlay ? 24 : 0) + caControlBonus, `GMGN ${name}`, context, overlay || caControlBonus > 0 || (topLeft && tokenLabelled));
        }
      }
      if (element.matches('a[href]')) {
        ADDRESS_RE.lastIndex = 0;
        let match;
        while ((match = ADDRESS_RE.exec(element.href))) {
          if (walletLike) continue;
          const routeScore = TOKEN_ROUTE_RE.test(new URL(element.href, location.href).pathname) ? 95 : 18;
          add(match[0], routeScore + (topLeft ? 6 : 0) + (tokenLabelled ? 22 : 0) + (overlay ? 24 : 0) + caControlBonus, 'GMGN 页面链接', text || element.href, overlay || caControlBonus > 0 || (topLeft && tokenLabelled));
        }
      }
      ADDRESS_RE.lastIndex = 0;
      let match;
      while ((match = ADDRESS_RE.exec(text))) {
        add(match[0], 8 + (topLeft ? 6 : 0) + (tokenLabelled ? 22 : 0) + (overlay ? 24 : 0) + caControlBonus, 'GMGN 页面文字', context, overlay || caControlBonus > 0 || (topLeft && tokenLabelled));
      }
    }

    const visibleText = (document.body?.innerText || '').slice(0, 160000);
    ADDRESS_RE.lastIndex = 0;
    let match;
    while ((match = ADDRESS_RE.exec(visibleText))) {
      const start = Math.max(0, match.index - 72);
      const end = Math.min(visibleText.length, match.index + match[0].length + 72);
      const context = visibleText.slice(start, end);
      const tokenLabelled = TOKEN_LABEL_RE.test(context);
      const walletLike = WALLET_LABEL_RE.test(context) && !tokenLabelled;
      if (!walletLike) add(match[0], 2 + (tokenLabelled ? 22 : 0), 'GMGN 可见页面文字', context);
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
    if (!ranked.length) return null;
    const routeCandidate = ranked.find(item => item.fromDetailRoute);
    if (routeCandidate) return { ...routeCandidate, precise: true };
    const best = ranked[0];
    const uniqueAndStrong = ranked.length === 1 && best.score >= 24 && best.detailEvidence;
    const clearlyDominant = best.score >= 45 && best.score - (ranked[1]?.score || 0) >= 20 && best.detailEvidence;
    if (!uniqueAndStrong && !clearlyDominant) return null;
    return { ...best, precise: true };
  }

  function publish(force = false) {
    lastScanAt = Date.now();
    const candidate = scan();
    const fingerprint = JSON.stringify(candidate && [candidate.address, candidate.score, candidate.source]);
    if (!force && fingerprint === lastFingerprint) return candidate;
    lastFingerprint = fingerprint;
    chrome.runtime.sendMessage({ type: 'BAW_GMGN_CA_UPDATE', candidate }, () => void chrome.runtime.lastError);
    return candidate;
  }

  function scheduleScan() {
    if (queuedTimer) return;
    const delay = Math.max(0, 1200 - (Date.now() - lastScanAt));
    queuedTimer = setTimeout(() => {
      queuedTimer = 0;
      publish();
    }, delay);
  }

  const observer = new MutationObserver(scheduleScan);
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'role', 'aria-modal', 'data-state', 'title', 'aria-label', 'data-address', 'data-token-address', 'data-ca', 'data-clipboard-text', 'href'] });

  const urlTimer = setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      publish(true);
    }
  }, 900);
  addEventListener('popstate', () => publish(true));
  addEventListener('hashchange', () => publish(true));
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'BAW_GMGN_SCAN') {
      sendResponse({ candidate: publish(true) });
    }
  });

  globalThis.__BAW_GMGN_CA_WATCHER__ = { observer, urlTimer };
  publish(true);
})();
