// Shell: router, header (search, live status), event delegation, the
// server-sent event stream and the indexing banner.
import { get, stream, openStale, closeStale } from './api.js';
import { esc, short, int, dateTime, price, dpOf, pct, signClass } from './format.js';
import { watch, toast, ICON, assignColors, download, logo, setAlertsBot, go, panelError, resolveWallet, morph } from './ui.js';
import { disposeAll, chartCsv, chartPng } from './charts.js';

// Path, view, and the page's name in the tab title (a function of the path's params).
const marketNames = new Map();
const routes = [
  [/^\/?$/, () => import('./views/overview.js'), null],
  [/^\/markets\/?$/, () => import('./views/markets.js'), 'Markets'],
  [/^\/markets\/(\d+)$/, () => import('./views/market.js'), ([id]) => marketNames.get(Number(id)) ?? 'Market'],
  [/^\/traders\/?$/, () => import('./views/traders.js'), 'Traders'],
  [/^\/liquidations\/?$/, () => import('./views/liquidations.js'), 'Liquidations'],
  [/^\/risk\/?$/, () => import('./views/risk.js'), 'Risk'],
  [/^\/wallet\/([0-9a-zA-Zx]{1,42})$/, () => import('./views/wallet.js'), ([key]) => `Wallet ${/^\d+$/.test(key) ? `#${key}` : short(key)}`],
  [/^\/compare\/?$/, () => import('./views/compare.js'), 'Compare wallets'],
  [/^\/(?:alerts|watchlist)\/?$/, () => import('./views/alerts.js'), 'Alerts'], // the watchlist lives on the alerts page
  [/^\/status\/?$/, () => import('./views/status.js'), 'Data & methodology']
];
const HOME_TITLE = document.title;
function setTitle(path) {
  const hit = routes.find(([re]) => re.test(path));
  const name = !hit ? 'Page not found' : typeof hit[2] === 'function' ? hit[2](path.match(hit[0]).slice(1)) : hit[2];
  const title = name ? `${name} · Plumb` : HOME_TITLE;
  if (document.title !== title) document.title = title;
}
// The header link a path belongs to; /status is the live pill.
const SECTIONS = { '': 'overview', markets: 'markets', traders: 'traders', wallet: 'traders', compare: 'traders', liquidations: 'liquidations', risk: 'risk', alerts: 'alerts', watchlist: 'alerts' };
function markSection(path) {
  const first = path.split('/')[1] ?? '';
  const mark = (a, on) => { a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', a.getAttribute('href') === path ? 'page' : 'true'); else a.removeAttribute('aria-current'); };
  document.querySelectorAll('.nav a').forEach(a => mark(a, a.dataset.nav === SECTIONS[first]));
  mark(document.getElementById('live'), first === 'status');
}

const view = document.getElementById('view');
let current = null; // { key, mod, instance }

// Links from before the dashboard used paths (#/wallet/…, as in older
// Telegram alerts) open the same page.
if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1));

function parseLocation() {
  return { path: location.pathname || '/', query: new URLSearchParams(location.search) };
}
export function navigate(path, query = null) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString() : '';
  go(`${path}${qs ? `?${qs}` : ''}`);
}
const withQuery = patch => {
  const { path, query } = parseLocation();
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') query.delete(k); else query.set(k, v); }
  const qs = query.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
};
// While the next page's module loads the old view is still on screen, and the
// URL is no longer its own: anything it writes there is dropped.
let leaving = false;
export function setQuery(patch) {
  if (leaving) return;
  history.replaceState(history.state, '', withQuery(patch));
  route(true);
}
// Writes a view's own state (pager, sort, open cohort) into the URL without routing,
// so Back and a shared link find it. The view has already drawn what it records.
export function keepQuery(patch) {
  if (leaving) return;
  history.replaceState(history.state, '', withQuery(patch));
  shown = location.pathname + location.search;
}

// Back returns the reader to where they were. A page still filling in is held at that
// place as it grows (scroll anchoring would carry the reader down with every section
// that lands above), until it has settled. Any move by the reader ends the hold.
const RESTORE_MS = 6000, SETTLED_MS = 500, MOVES = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
function restoreScroll(y, nav) {
  const from = performance.now();
  let moved = false, height = 0, steadyFrom = from;
  const stop = () => { moved = true; };
  const done = () => MOVES.forEach(type => removeEventListener(type, stop, true));
  MOVES.forEach(type => addEventListener(type, stop, { capture: true, passive: true }));
  const step = () => {
    if (moved || nav !== navigation) { done(); return; }
    const now = performance.now(), doc = document.documentElement.scrollHeight, tall = doc - innerHeight >= y;
    if (doc !== height || view.querySelector('.skeleton, .sk-rows')) { height = doc; steadyFrom = now; }
    if (tall) window.scrollTo({ top: y });
    if (now - from > RESTORE_MS || (tall && now - steadyFrom > SETTLED_MS)) { window.scrollTo({ top: y }); done(); return; }
    requestAnimationFrame(step);
  };
  step();
}

function leavePage() { current?.instance?.destroy?.(); current = null; disposeAll(); }
const pageFailed = error => { console.error(error); leavePage(); leaving = false; view.innerHTML = ''; panelError(view, 'Could not load this page.', () => location.reload()); };

// Each navigation takes a number; a view module that loads after a newer
// navigation started is not mounted. y: the scroll position to go back to.
let navigation = 0, shown = null;
// Views with a refresh() may open on cached answers: only they can bring them up to date.
const refreshable = new WeakSet();
async function route(queryOnly = false, y = 0) {
  const nav = ++navigation;
  const { path, query } = parseLocation();
  shown = location.pathname + location.search;
  const hit = routes.find(([re]) => re.test(path));
  markSection(path);
  setTitle(path);
  if (!hit) { leavePage(); leaving = false; view.innerHTML = '<div class="page-head"><div><h1>Page not found</h1></div></div><div class="empty-state"><a href="/">Back to overview</a></div>'; window.scrollTo({ top: 0 }); return; }
  const params = path.match(hit[0]).slice(1);
  const key = `${hit[0]}:${params.join('/')}`;
  if (queryOnly && current?.key === key && current.instance?.update) { current.instance.update(query); return; }
  leaving = true; // the old page stays whole, charts included, until the next one can take over
  try {
    const mod = await hit[1]();
    if (nav !== navigation) return;
    leavePage();
    leaving = false;
    view.innerHTML = '';
    window.scrollTo({ top: 0 });
    let instance = null;
    if (refreshable.has(mod)) openStale();
    // Cached answers render in microtasks, so the page is at full height by the next
    // task. Set before mount: a mount that throws must still close the window.
    setTimeout(() => { const used = closeStale(); if (nav !== navigation) return; if (y) restoreScroll(y, nav); if (used) instance?.refresh?.({ stale: true }); }, 0);
    instance = mod.mount(view, { params, query, navigate, setQuery, keepQuery });
    current = { key, mod, instance };
    if (instance?.refresh) refreshable.add(mod);
    // Keyboard readers go on from the new page, not from the link they left. Typing stays put.
    if (nav > 1 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) view.focus({ preventScroll: true });
  } catch (error) { if (nav === navigation) pageFailed(error); }
}
// Back and forward, and go(); a change of the #fragment alone is not a new page.
history.scrollRestoration = 'manual';
window.addEventListener('popstate', e => { if (location.pathname + location.search !== shown) route(false, e.state?.y ?? 0); });
// Each history entry keeps its own place, for Back, Forward, a reload and a return from another site.
let placeTimer = null;
const keepPlace = () => { try { history.replaceState({ ...history.state, y: Math.round(scrollY) }, ''); } catch { /* the browser's rate limit */ } };
window.addEventListener('scroll', () => { clearTimeout(placeTimer); placeTimer = setTimeout(keepPlace, 250); }, { passive: true });

// --- delegated interactions -------------------------------------------------------------
// What a row leaves to the thing under the pointer: links, buttons, tags and pills whose note a tap opens.
const ROW_KEEPS = 'a,button,.tag[title],.tag[data-tip],.rank-pill';
const openTab = url => window.open(url, '_blank', 'noopener');
document.addEventListener('click', async event => {
  const t = event.target.closest('[data-copy],[data-watch],[data-seg],[data-tab],[data-sort],tr[data-href],[data-action],[data-export]');
  if (!t) return;
  if (!getSelection().isCollapsed && t.matches('tr[data-href],tr[data-action]')) return; // a drag across a row selects its text
  if (t.dataset.export) {
    const w = parseLocation().query.get('window');
    const node = document.getElementById(t.dataset.chart), file = `plumb-${t.dataset.name || 'chart'}${w ? `-${w}` : ''}-${new Date().toISOString().slice(0, 10)}`;
    if (t.dataset.export === 'csv') { const csv = chartCsv(node); if (csv) download(`${file}.csv`, csv); else toast('Nothing to export yet'); }
    else { const url = chartPng(node); if (url) Object.assign(document.createElement('a'), { href: url, download: `${file}.png` }).click(); else toast('Nothing to export yet'); }
    return;
  }
  if (t.dataset.copy) { event.preventDefault(); try { await navigator.clipboard.writeText(t.dataset.copy); toast('Address copied'); } catch { toast('Copy failed'); } return; }
  if (t.dataset.watch) { event.preventDefault(); event.stopPropagation(); const on = watch.toggle(t.dataset.watch); t.classList.toggle('on', on); t.innerHTML = on ? ICON.star : ICON.starOff; toast(on ? 'Added to watchlist' : 'Removed from watchlist'); return; }
  if (t.dataset.seg) { current?.instance?.onSeg?.(t.dataset.seg, t.dataset.v); return; }
  if (t.dataset.tab) { current?.instance?.onTab?.(t.dataset.tab, t.dataset.v); return; }
  if (t.dataset.sort) { const [id, key] = t.dataset.sort.split(':'); current?.instance?.onSort?.(id, key); return; }
  if (t.dataset.action) { current?.instance?.onAction?.(t.dataset.action, t, event); return; }
  if (t.dataset.href && !event.target.closest(ROW_KEEPS)) { if (event.ctrlKey || event.metaKey) openTab(t.dataset.href); else go(t.dataset.href); }
});
// A row opens as a link does: a middle press or Ctrl/Cmd click takes a new tab. Without
// the mousedown a middle press starts the browser's autoscroll instead.
const middleRow = event => (event.button === 1 && !event.target.closest(ROW_KEEPS) ? event.target.closest('tr[data-href]') : null);
document.addEventListener('mousedown', event => { if (middleRow(event)) event.preventDefault(); });
document.addEventListener('auxclick', event => { const row = middleRow(event); if (row) openTab(row.dataset.href); });

document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const a = event.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !routes.some(([re]) => re.test(url.pathname))) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return; // a jump within the page
  event.preventDefault();
  go(url.pathname + url.search);
});

// --- search ------------------------------------------------------------------------------
const input = document.getElementById('search'), results = document.getElementById('search-results'), searchBox = input.closest('.search');
let searchTimer = null, selected = -1;
function openResult(key) { results.hidden = true; input.value = ''; input.blur(); navigate(`/wallet/${key}`); }
const showResults = html => { results.innerHTML = html; results.hidden = false; };
const searchNote = text => showResults(`<div class="empty">${esc(text)}</div>`);
// The answer to q, unless the box has moved on while it was on its way.
const resolved = async q => {
  try { const r = await resolveWallet(q); return input.value.trim() === q ? r : null; } catch { if (input.value.trim() === q) searchNote('Search unavailable'); return null; }
};
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (!q) { results.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const r = await resolved(q);
    if (!r) return;
    selected = -1;
    if (r.rows.length) showResults(r.rows.map(x => `<a href="/wallet/${esc(x.address)}" data-key="${esc(x.address)}"><span class="mono">${esc(short(x.address))}</span><span class="faint">#${esc(x.account)}</span></a>`).join(''));
    else searchNote(r.note || 'Search unavailable');
  }, 160);
});
input.addEventListener('keydown', async e => {
  const items = [...results.querySelectorAll('a')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, Math.min(items.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((a, i) => a.classList.toggle('sel', i === selected)); }
  else if (e.key === 'Enter') {
    const q = input.value.trim();
    if (items[selected]) { openResult(items[selected].dataset.key); return; }
    if (!q) return;
    clearTimeout(searchTimer);
    const r = await resolved(q);
    if (!r) return;
    const key = r.key ?? r.rows[0]?.address;
    if (key) openResult(key); else searchNote(r.note);
  }
});
searchBox.addEventListener('keydown', e => { if (e.key === 'Escape') { results.hidden = true; input.blur(); } });
// relatedTarget: a tap on a result may not take focus, and must still land on it.
searchBox.addEventListener('focusout', e => { if (e.relatedTarget && !searchBox.contains(e.relatedTarget)) results.hidden = true; });
results.addEventListener('click', e => { const a = e.target.closest('a[data-key]'); if (a) { e.preventDefault(); openResult(a.dataset.key); } });
document.addEventListener('click', e => { if (!e.target.closest('.search')) results.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); } });

// --- live status + banner -----------------------------------------------------------------
const live = document.getElementById('live'), liveText = document.getElementById('live-text'), banner = document.getElementById('banner');
let lastBlock = null, polledBlock = null, lastBlockAt = Date.now(), lostAt = Date.now(), streamOpen = false, apiDown = false;
live.querySelector('.dot').insertAdjacentHTML('afterend', `<span class="live-ico">${ICON.cube}</span>`);
function setLive(state, text, note) {
  live.classList.remove('ok', 'warn', 'bad'); live.classList.add(state);
  if (liveText.textContent !== text) liveText.textContent = text;
  // Once hovered, the note lives in data-tip (ui.js): update it there, so the
  // browser's own tooltip is not brought back every second.
  if (live.dataset.tip) live.dataset.tip = note; else live.title = note;
}
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
// The pill shows the latest finalized block. A stream that drops and reconnects
// within a few seconds (a deploy, a proxy hiccup), or that has not opened yet, keeps
// the pill steady. After that it says what is wrong; Offline outranks the rest, as
// nothing can be fetched then. The figures on the page are as old as the last block.
const RECONNECT_GRACE_MS = 4000, DELAYED_MS = 15000;
const streamLost = () => !streamOpen && Date.now() - lostAt > RECONNECT_GRACE_MS;
function renderLive() {
  const block = lastBlock?.block ?? polledBlock, since = Date.now() - lastBlockAt, minutes = Math.floor(since / 60000);
  if (apiDown) setLive('bad', 'Offline', 'The data service is not answering');
  else if (streamLost()) setLive('warn', 'Reconnecting…', lastBlock ? `Live connection lost. Last block at ${clock(lastBlockAt)}; figures are from then.` : 'No live connection; reconnecting');
  else if (!block) return;
  else if (since > DELAYED_MS) setLive('warn', `Delayed${minutes ? ` ${minutes}m` : ''}`, `No new block since ${clock(lastBlockAt)} (#${int(block)}). Figures are from then.`);
  else setLive('ok', `Live · #${int(block)}`, 'Latest finalized block indexed');
}
stream.on('block', b => { lastBlock = b; lastBlockAt = Date.now(); renderLive(); });
// A stream that has not opened or has dropped is checked once the grace time is over:
// Offline if the API has gone with it. The status event repeats on every browser
// retry; only the first starts the wait.
const checkLoss = () => setTimeout(poll, RECONNECT_GRACE_MS + 50);
let lossCheck = checkLoss();
stream.on('status', s => {
  const open = s === 'open';
  if (open) clearTimeout(lossCheck); else if (streamOpen) { lostAt = Date.now(); lossCheck = checkLoss(); }
  streamOpen = open;
  renderLive();
});
setInterval(renderLive, 1000);
// A view's refresh() brings its panels up to date when the stream or the API returns,
// and stands in for the pushes while the stream is out.
const refreshView = () => current?.instance?.refresh?.({ stale: false });
stream.on('resumed', refreshView);
function showBanner(p) {
  if (!p || (!p.running && !(p.pct < 100 && p.total_blocks !== '0'))) { banner.hidden = true; return; }
  const eta = p.eta_s ? (p.eta_s > 3600 ? `${Math.floor(p.eta_s / 3600)}h ${Math.round(p.eta_s % 3600 / 60)}m` : `${Math.max(1, Math.round(p.eta_s / 60))}m`) : '—';
  banner.hidden = false;
  banner.innerHTML = `<div class="banner-inner"><b>Indexing Perpl history</b><div class="bar"><i style="width:${Math.min(100, p.pct ?? 0)}%"></i></div><span class="num">${(p.pct ?? 0).toFixed(1)}% · ETA ${eta}</span><span class="faint">Recent windows are complete; longer windows fill in as blocks are indexed.</span></div>`;
}
stream.on('backfill', showBanner);

// MON price in the header: the mark of Perpl's MON market (chain state, not an
// external feed), refreshed by every protocol push.
const ticker = document.getElementById('ticker');
function renderTicker(markets) {
  if (markets?.length) { for (const m of markets) marketNames.set(Number(m.id), m.symbol); setTitle(location.pathname); }
  const m = markets?.find(x => String(x.symbol).toUpperCase() === 'MON');
  const p = m?.mark ?? m?.close;
  if (!m || p === null || p === undefined) return;
  const ch = Number(m.change_pct);
  ticker.hidden = false;
  ticker.href = `/markets/${m.id}`;
  morph(ticker, `${logo(m.id, 'MON', 16)}<span class="tp">$${esc(price(p, dpOf(p)))}</span>${Number.isFinite(ch) ? `<span class="${signClass(ch) || 'faint'}">${pct(ch, { sign: true })}</span>` : ''}`);
}
stream.on('protocol', p => renderTicker(p.markets));
get('protocol?window=24h', { maxAge: 5000 }).then(p => renderTicker(p.markets)).catch(() => {});
// Every 30 s; 15 s while the stream is out; 5 s while the API is not answering.
let pollTimer = null;
async function poll() {
  const wasDown = apiDown;
  try {
    const h = await get('health', { maxAge: 0 });
    apiDown = false;
    showBanner(h.index?.backfill);
    setAlertsBot(h.alerts?.bot);
    polledBlock = h.index?.live?.to ?? polledBlock;
  } catch (error) { if (error.status !== 429) apiDown = true; } // the rate limit is not an outage
  renderLive();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, apiDown ? 5000 : streamLost() ? 15000 : 30000);
  if (!apiDown && (wasDown || streamLost())) refreshView(); // last: a view's refresh cannot stop the polling
}
poll();
stream.connect();
// The first view renders at once (colours are seeded in ui.js); the market list
// then confirms each market's colour for the views that follow.
route(false, history.state?.y ?? 0);
get('protocol?window=all', { maxAge: 60000 }).then(p => assignColors([...p.markets].sort((a, b) => Number(b.volume) - Number(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })))).catch(() => {});
export { lastBlock, dateTime };
