// Liquidations: window totals, liquidated notional over time by side, and the
// full feed (on-book liquidations and auto-deleveraging), live.
import { get, stream } from '../api.js';
import { usd, usdShort, usdFull, int, price, dpOf, esc, dateTime, ago, num, size } from '../format.js';
import { kpi, keepDots, infoTip, seg, table, mktLink, sideTag, addr, pnlShort, DASH, skKpis, skRows, skChart, empty, ICON, colorOf, hasColor, OTHER_HEX, assignColors, chartTools, mergeByAsset, hold, morph, panelError, keepTrying, toast } from '../ui.js';
import { stackedBars, dropZoom } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const BUCKETS = { 3600: 'Per hour', 14400: 'Per 4 hours', 86400: 'Per day', 604800: 'Per week' };
const DEFAULT_WINDOW = '30d';
// The feed pages through every event of the window, newest first, fifty at a time.
const PAGE = 50;
const windowOf = q => (WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : DEFAULT_WINDOW);
const pageOf = q => Math.max(0, (parseInt(q.get('page'), 10) || 1) - 1);
// What the API says goes unprinted (panelError has its own words); a bug in this file does not.
// A table or note amount: the short form, with the exact figure as its note.
const amt = v => (num(v) === null ? DASH : `<span class="amt" title="${esc(usdFull(v))}">${usdShort(v)}</span>`);
const exactPrice = v => (num(v) === null ? DASH : price(v, dpOf(v)));
// A skeleton or an error gives way to the table: patched over, its inline height would stay on the table's wrapper.
const fill = (node, html) => { node.querySelector(':scope > .sk-rows, :scope > .panel-error')?.remove(); morph(node, html); };
const logBug = e => { if (e?.status === undefined && e?.code === undefined) console.error(e); };

export function mount(el, { query, setQuery, keepQuery }) {
  let w = windowOf(query);
  let market = query.get('market') ?? '';
  let page = pageOf(query);
  let alive = true, markets = [], adl = null; // { key: filters counted under, n }
  const mq = () => (market ? `&market=${encodeURIComponent(market)}` : '');
  el.innerHTML = `
    <div class="page-head"><div><h1>Liquidations</h1><div class="sub">Forced closes from exchange events: liquidations on the order book and auto-deleveraging.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack"><div class="kpis k4 keep-delta" id="kpis">${skKpis(4, { lines: 2 })}</div>
      <section class="panel lq-chart"><div class="panel-head"><div><h2>Liquidated notional${infoTip('Notional liquidated per period, by market, with the running total as a line. Excludes ADL and force closes.', 'Liquidated notional')}</h2><div class="desc" id="chart-desc"></div></div><div class="head-right"><div class="legend dots" id="legend"></div>${chartTools('chart', 'liquidations')}</div></div><div class="panel-body"><div class="chart" id="chart">${skChart()}</div></div></section>
      <section class="panel lq-feed"><div class="panel-head"><h2>Feed</h2><div class="lq-feed-ctl"><span class="meta" id="feed-meta" title="Includes ADL and force closes, so it can exceed the liquidation count above."></span><select id="mf" class="btn ghost" aria-label="Market filter"><option value="">All markets</option></select><a class="btn ghost" id="csv">${ICON.download} CSV</a></div></div><div class="panel-body flush" id="feed">${w === '24h' ? skRows(8, 44, 34) : `${skRows(PAGE, 44, 34)}<div class="panel-foot pager"></div>`}</div></section></div>`;
  const $ = s => el.querySelector(`#${s}`);
  // One hold per region, taken on a press and let go by the answer that lands.
  const held = {};
  const dim = id => { held[id] ??= hold($(id)); };
  const undim = id => { held[id]?.(); held[id] = null; };
  const feedPath = (n = page) => `liquidations?limit=${PAGE}&offset=${n * PAGE}&window=${w}${mq()}`;
  // The filters each region shows, which trail the page's while an answer is on the way.
  const filters = () => `${w}|${market}`;
  const shown = {};
  const syncCsv = () => { $('csv').href = `/api/v1/liquidations?limit=10000&window=${w}&format=csv${mq()}`; };
  syncCsv();
  // The select stays as it is unless its list changed: a refresh leaves an open list alone.
  let filterList = '';
  function renderFilter() {
    // The delisted original and its relisting share a name: the old one says so.
    const html = `<option value="">All markets</option>${markets.filter(m => m.liquidations || m.id === Number(market)).map(m => `<option value="${m.id}" ${String(m.id) === market ? 'selected' : ''}>${esc(m.symbol)}${m.active === false ? ' (inactive)' : ''}</option>`).join('')}`;
    if (html !== filterList) { filterList = html; $('mf').innerHTML = html; }
    $('mf').value = market;
  }
  // The biggest close opens its wallet, and its row is marked when it is on the page.
  let largestOne = null;
  const largestLink = r => { const who = r.address || r.account; return `${who ? `<a class="lq-largest" href="/wallet/${esc(who)}">` : '<span>'}${esc(r.symbol)} ${esc(r.side ?? '')}${who ? '</a>' : '</span>'}`; };
  function renderKpis(p, l, row) {
    const h = p.headline, wl = w === 'all' ? 'All-time' : w, asked = filters();
    // A market filter narrows the KPIs and the chart too, not only the feed. A
    // market with nothing in the window had no liquidations and no volume, not unknowns.
    const liquidated = row ? row.liquidated ?? 0 : h.liquidated.value, count = row ? row.liquidations ?? 0 : h.liquidations.value, volume = row ? row.volume ?? 0 : h.volume.value;
    const largest = l.largest ?? null; // the largest inside the window, from the server
    largestOne = largest;
    // ADL and force closes: the headline counts them for all markets only, so
    // one market's are its feed events less its liquidations.
    adl = { key: asked, n: row ? Math.max(0, num(l.total) - (num(count) ?? 0)) : num(h.deleverages) };
    morph($('kpis'), [
      kpi({ label: `Liquidated · ${wl}${row ? ` · ${row.symbol}` : ''}`, value: usd(liquidated), delta: row || w === 'all' || p.meta.previous_complete === false ? undefined : h.liquidated.change_pct, basis: `vs prev ${wl}`, basisTitle: `Compared with the previous ${wl}`, invert: true, note: `${int(count)} ${num(count) === 1 ? 'liquidation' : 'liquidations'}` }),
      // With no volume there is no share to take: the note says why.
      kpi({ label: 'Liquidated / volume', value: num(volume) ? `${(num(liquidated) / num(volume) * 100).toFixed(2)}%` : '—', note: num(volume) ? `of ${amt(volume)} traded` : `no trades in ${wl}`, tip: 'Liquidated notional over volume traded in the period' }),
      kpi({ label: 'ADL, force closes', value: int(adl.n), note: 'closed by the protocol', tip: 'Closes forced by the protocol, full or partial: auto-deleveraging against a bankrupt position, or a force close at the mark price.' }),
      kpi({ label: `Largest · ${wl}`, value: largest ? usd(largest.notional) : '—', note: largest ? `${largestLink(largest)} · ${ago(largest.ts)}` : 'none in this period' })
    ].join(''));
    shown.kpis = asked; undim('kpis');
  }
  function renderChart(s, row) {
    const node = $('chart');
    let list;
    if (row) list = [{ name: row.symbol, color: colorOf(row.id), data: s.points.map(x => num(x.liquidated)) }].filter(x => x.data.some(v => v > 0));
    else {
      const withLiq = mergeByAsset(s.by_market ?? [], ['liquidated']).filter(m => m.liquidated.some(v => num(v) > 0));
      const top = withLiq.filter(m => hasColor(m.id)), rest = withLiq.filter(m => !hasColor(m.id));
      list = top.map(m => ({ name: m.symbol, color: colorOf(m.id), data: m.liquidated.map(num) }));
      if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: s.times.map((_, i) => rest.reduce((a, m) => a + num(m.liquidated[i]), 0)) });
    }
    morph($('legend'), list.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('') + (list.length ? '<span><i style="background:#fff"></i>Cumulative</span>' : ''));
    morph($('chart-desc'), list.length ? keepDots(`${BUCKETS[s.meta.bucket_seconds] ?? 'Per period'}${row ? '' : ' by market'} · line: running total`) : '');
    if (list.length) stackedBars(node, { times: s.times, series: list, bucketSeconds: s.meta.bucket_seconds, cumulative: true, zoom: true }); else node.innerHTML = empty('No liquidations in this period');
    shown.chart = filters(); undim('chart');
  }
  function renderFeed(l) {
    const rows = l.rows, total = l.total ?? rows.length, pages = Math.max(1, Math.ceil(total / PAGE));
    // The feed has ADL and force closes too, so it runs longer than the liquidation
    // count above. A redraw under filters not yet loaded leaves the count out.
    const n = adl?.key === filters() ? adl.n : null;
    morph($('feed-meta'), keepDots(`${int(total)} events${n ? ` · incl. ${int(n)} ADL and force close${n === 1 ? '' : 's'}` : ''} · ${w === 'all' ? 'All-time' : w}`));
    const biggest = r => largestOne && r.tx === largestOne.tx && r.log_index === largestOne.log_index;
    const first = total ? page * PAGE + 1 : 0, last = page * PAGE + rows.length;
    const pager = pages > 1 ? `<div class="panel-foot pager"><span>${int(first)}–${int(last)} of ${int(total)}</span><span class="pager-ctl"><button class="btn ghost sm" data-action="prev" ${page === 0 ? 'disabled' : ''}>← Prev</button><span class="num">Page ${int(page + 1)} of ${int(pages)}</span><button class="btn ghost sm" data-action="next" ${page + 1 >= pages ? 'disabled' : ''}>Next →</button></span></div>` : '';
    fill($('feed'), table({ id: 'liq', columns: [
      { key: 't', label: 'Time (UTC)', render: r => { const d = dateTime(r.ts); return `<span class="muted num"><span class="yr">${d.slice(0, 5)}</span>${d.slice(5)}</span>`; } },
      { key: 'm', label: 'Market', cls: 'mkt-cell', render: r => mktLink(r.market, r.symbol) },
      { key: 'k', label: 'Type', phone: false, tip: 'Order book: filled on the book. ADL and Force close: closed by the protocol.', render: r => (r.kind === 'deleverage' ? (r.force_close ? '<span class="tag warn">Force close</span>' : '<span class="tag warn">ADL</span>') : `<span class="tag">${r.on_book ? 'Order book' : 'Liquidation'}</span>`) },
      { key: 's', label: 'Side', render: r => sideTag(r.side) },
      { key: 'a', label: 'Trader', phone: false, render: r => addr(r.address, r.account) },
      { key: 'sz', label: 'Size', phone: false, n: true, tip: 'Size liquidated, in units of the asset', render: r => size(r.size) },
      { key: 'p', label: 'Fill price', phone: false, n: true, tip: 'Price the liquidation filled at', render: r => exactPrice(r.price) },
      { key: 'mk', label: 'Mark price', phone: false, n: true, tip: 'Mark price at that moment', render: r => exactPrice(r.mark) },
      { key: 'n', label: 'Notional', n: true, render: r => amt(r.notional) },
      { key: 'pnl', label: 'Realized PnL', phone: false, n: true, tip: 'Loss or gain booked by the liquidation, before fees', render: r => pnlShort(r.pnl) },
      { key: 'rem', label: 'Remaining', phone: false, n: true, tip: 'Size left open after a partial liquidation, in units of the asset', render: r => (num(r.remaining) ? size(r.remaining) : '<span class="faint">closed</span>') }
    ], rows, rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''} ${biggest(r) ? 'hl' : ''}" data-href="/wallet/${esc(r.address || r.account)}"`, emptyText: 'No liquidations in this period' }) + pager);
    shown.feed = filters(); undim('feed');
  }
  // The last answer asked for is the one drawn: seq for a load, feedSeq for all the feed's readers.
  let seq = 0, feedSeq = 0;
  async function load(fresh = false) {
    const ask = ++seq, askFeed = ++feedSeq, opt = fresh ? { maxAge: 0 } : undefined, q = mq();
    const [pr, sr, lr] = await Promise.allSettled([get(`protocol?window=${w}`, opt), get(`protocol/series?window=${w}${q}`, opt), get(feedPath(), opt)]);
    if (!alive || ask !== seq) return;
    const p = pr.status === 'fulfilled' ? pr.value : null, s = sr.status === 'fulfilled' ? sr.value : null;
    let l = lr.status === 'fulfilled' ? lr.value : null;
    if (p) {
      // An id no market has is a link gone wrong, not a market with nothing to show.
      if (market && !p.markets.some(m => String(m.id) === market)) { toast('No such market'); setQuery({ market: null, page: null }); return; }
      markets = p.markets;
      assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
      renderFilter();
    }
    // A page past the end, from an old link or a window that shrank, opens on the last page.
    if (l && page && !l.rows.length && l.total) {
      page = Math.ceil(l.total / PAGE) - 1;
      keepQuery({ page: page ? page + 1 : null });
      l = await get(feedPath(), opt);
      if (!alive || ask !== seq) return;
    }
    const row = p && market ? p.markets.find(m => String(m.id) === market) ?? null : null;
    if (p && l) renderKpis(p, l, row);
    if (p && s) renderChart(s, row);
    if (l && askFeed === feedSeq) renderFeed(l);
    const failed = [pr, sr, lr].find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  // Only a region that does not show the current filters says so; the rest keep what they have.
  function failed(e) {
    logBug(e);
    const now = filters(), retry = () => start();
    for (const id of ['kpis', 'chart', 'feed']) {
      if (shown[id] === now) continue;
      panelError($(id), undefined, retry);
      undim(id);
    }
  }
  let stop = null;
  function start(fresh = false) { stop?.(); stop = keepTrying(() => load(fresh), { alive: () => alive, fail: failed }); }
  async function goTo(n) {
    const ask = ++feedSeq;
    dim('feed');
    try {
      const l = await get(feedPath(n), { maxAge: 3000 });
      if (!alive || ask !== feedSeq) return;
      page = n; keepQuery({ page: n ? n + 1 : null }); renderFeed(l);
      const top = $('feed').closest('section');
      if (top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
    } catch (e) {
      if (!alive || ask !== feedSeq) return;
      logBug(e); panelError($('feed'), undefined, () => goTo(n)); undim('feed');
    }
  }
  $('mf').addEventListener('change', e => setQuery({ market: e.target.value || null, page: null }));
  const off = stream.on('liquidations', () => {
    if (page !== 0) return;
    const ask = ++feedSeq;
    get(feedPath(0), { maxAge: 0 }).then(l => { if (alive && ask === feedSeq && page === 0) renderFeed({ ...l, rows: l.rows.map((r, i) => ({ ...r, fresh: i === 0 })) }); }).catch(() => {});
  });
  start();
  return {
    onAction(a) { if (a === 'prev' && page > 0) goTo(page - 1); if (a === 'next') goTo(page + 1); },
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === DEFAULT_WINDOW ? null : v, page: null }); },
    update(q) {
      const nw = windowOf(q), nm = q.get('market') ?? '', np = pageOf(q);
      if (nw === w && nm === market && np === page) return;
      const narrowed = nw !== w || nm !== market;
      w = nw; market = nm; page = narrowed ? 0 : np;
      morph($('win'), seg('window', WINDOWS, w)); syncCsv();
      dropZoom($('chart'));
      for (const id of ['kpis', 'chart', 'feed']) dim(id);
      start();
    },
    // Back on the stream or the API, and after a cached open: the page asks again, quietly.
    refresh() { start(true); },
    destroy() { alive = false; off(); stop?.(); }
  };
}
