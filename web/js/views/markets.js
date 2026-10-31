// Markets list: price, change, volume, open interest, funding, skew and risk
// for every market over the chosen window.
import { get, stream } from '../api.js';
import { usdShort, usdFull, int, price, dpOf, pct, share, num, esc } from '../format.js';
import { seg, table, mkt, ratio, pctCell, fundingCell, fundingTip, skRows, skChart, empty, assignColors, chartTools, hold, morph, panelError, keepTrying, keepDots, DASH } from '../ui.js';
import { divergingHeatmap } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const windowOf = q => (WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h');
// A table amount with its exact figure as the note.
const amount = v => (num(v) === null ? DASH : `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`);
const bpsText = v => `${v.toFixed(v >= 100 ? 0 : v < 1 ? 2 : 1)} bps`;
const given = v => v !== null && v !== undefined;
// A table in place is patched. A skeleton or a failed panel is written over whole:
// morph would leave its inline height on the table that takes its place.
const paint = (node, html) => { if (node.querySelector(':scope > .table-wrap')) morph(node, html); else node.innerHTML = html; };
// The heatmap's height from its last draw, so a return visit opens at it; 400 is 11 rows.
let mapHeight = 400;

export function mount(el, { query, setQuery, keepQuery }) {
  let w = windowOf(query);
  let data = null, alive = true;
  const scope = () => keepDots(`Change, range, volume, trades and fees: ${w === 'all' ? 'all-time' : `last ${w}`} · the rest is live`);
  el.innerHTML = `
    <div class="page-head"><div><h1>Markets</h1><div class="sub">Every Perpl market with live prices, open interest and funding.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack">
    <section class="panel markets-list"><div class="panel-head"><h2>All markets</h2><span class="meta" id="scope">${scope()}</span></div><div class="panel-body flush" id="list">${skRows(17)}</div></section>
    <section class="panel"><div class="panel-head"><div><h2>Funding</h2><div class="desc" id="f-desc">Annualised funding rate per market</div></div><div class="head-right">${chartTools('funding-map', 'funding')}</div></div>
      <div class="panel-body"><div class="chart" id="funding-map" style="height:${mapHeight}px">${skChart()}</div></div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);
  // Not trading: closed on the contract after trading ("closed"), listed but
  // never opened ("upcoming", no trade in all of history), or open with no
  // trades in the window and no open positions ("inactive"). All are dimmed.
  let traded = null; // ids of the markets with a trade in all of history
  const idle = r => r.active === false || (!num(r.volume) && !num(r.open_interest));
  const neverOpened = r => r.active === false && traded !== null && !traded.has(r.id);
  const idleTag = r => (r.active !== false ? 'inactive' : neverOpened(r) ? 'upcoming' : 'closed');
  const idleTitle = r => (neverOpened(r) ? 'Listed on the exchange, not open for trading yet' : r.active === false ? 'Not open for trading' : `Open for trading, but no trades ${w === 'all' ? 'yet' : `in ${w}`} and no open positions`);
  const lev = v => (v ? `${v.toFixed(1)}x` : DASH);
  const COLS = [
    { key: 'symbol', label: 'Market', sort: r => r.symbol, render: r => `${mkt(r.id, r.symbol, r.name && r.name !== r.symbol && r.name !== `${r.symbol} Perp` ? r.name : null, { link: true })}${idle(r) ? ` <span class="tag" title="${idleTitle(r)}">${idleTag(r)}</span>` : ''}` },
    { key: 'mark', label: 'Mark', tip: 'Contract mark price, used for unrealized PnL and liquidation', n: true, sort: r => num(r.mark ?? r.close), render: r => `${price(r.mark ?? r.close, dpOf(r.mark ?? r.close))}<div class="sub-sm">${pctCell(r.change_pct)}</div>` },
    { key: 'change_pct', label: 'Change', tip: 'Change in price over the selected period', phone: false, n: true, sort: r => num(r.change_pct) ?? -1e9, render: r => pctCell(r.change_pct) },
    { key: 'range', label: 'Low – High', tip: 'Lowest and highest trade price in the selected period', phone: false, n: true, render: r => (r.low ? `<span class="muted"><span class="lh">${price(r.low, dpOf(r.low))}</span><span class="lh-sep"> – </span><span class="lh">${price(r.high, dpOf(r.high))}</span></span>` : DASH) },
    { key: 'volume', label: 'Volume', tip: 'Notional traded in the selected period, each trade counted once', phone: false, n: true, sort: r => num(r.volume), render: r => amount(r.volume) },
    { key: 'trades', label: 'Trades', phone: false, tip: 'Matches between a maker and a taker, each counted once', n: true, sort: r => r.fills ?? 0, render: r => int(r.fills) },
    { key: 'fees', label: 'Fees', tip: 'Trading fees in the selected period', phone: false, n: true, sort: r => num(r.fees) ?? 0, render: r => amount(r.fees) },
    { key: 'open_interest', label: 'Open interest', tip: 'Value of open positions, one side only. Below: share of the market\'s cap.', n: true, sort: r => num(r.open_interest) ?? 0, render: r => `${amount(r.open_interest)}${given(r.oi_cap_pct) ? `<div class="sub hide-sm">${share(r.oi_cap_pct)} of cap</div>` : ''}` },
    { key: 'funding', label: 'Funding 8h', phone: false, get tip() { return `${fundingTip(data?.markets?.find(m => m.funding?.interval_seconds)?.funding.interval_seconds)} Positive means longs pay shorts.`; }, n: true, sort: r => r.funding?.rate_8h_pct ?? 0, render: r => fundingCell(r.funding) },
    { key: 'cost', label: 'Cost of $10K', phone: false, n: true, tip: 'Average cost of a $10K market buy and sell on the onchain order book, versus the mid price. Includes half the spread.', sort: r => r.cost_10k_bps ?? -1, render: r => (given(r.cost_10k_bps) ? `${bpsText(r.cost_10k_bps)}${given(r.spread_bps) ? `<div class="sub">spread ${bpsText(r.spread_bps)}</div>` : ''}` : DASH) },
    { key: 'ls', label: 'Long / short positions', tip: 'Share of open positions by count, not by value', phone: false, sort: r => r.long_position_share_pct ?? 0, render: r => (num(r.long_positions) || num(r.short_positions) ? ratio(r.long_positions, r.short_positions) : `<span class="ls-none">${DASH}</span>`) },
    { key: 'lev', label: 'Avg lev. L / S', tip: 'Average leverage of open long and of open short positions', phone: false, n: true, render: r => (r.long_leverage || r.short_leverage ? `${lev(r.long_leverage)} / ${lev(r.short_leverage)}` : DASH) },
    { key: 'max_leverage', label: 'Max lev.', tip: 'Highest leverage this market allows', phone: false, n: true, sort: r => r.max_leverage ?? 0, render: r => (r.max_leverage ? `${r.max_leverage}x` : DASH) },
    { key: 'insurance', label: 'Insurance', tip: 'This market\'s insurance fund', phone: false, n: true, sort: r => num(r.insurance) ?? 0, render: r => amount(r.insurance) }
  ];
  const sortable = key => COLS.some(c => c.key === key && c.sort);
  let sort = { key: sortable(query.get('sort')) ? query.get('sort') : 'volume', dir: query.get('dir') === 'asc' ? 'asc' : 'desc' };
  function render() { if (data) paint($('list'), table({ id: 'm', columns: COLS, rows: data.markets, sortKey: sort.key, sortDir: sort.dir, rowAttrs: r => `class="link${idle(r) ? ' inactive' : ''}" data-href="/markets/${r.id}"` })); }
  async function loadList({ fresh = false }, mine) {
    const at = w;
    const [d, all] = await Promise.all([get(`protocol?window=${at}`, fresh ? { maxAge: 0 } : undefined), at === 'all' ? null : get('protocol?window=all', { maxAge: 60000 }).catch(() => null)]);
    if (!mine()) return;
    data = d;
    const history = at === 'all' ? d : all;
    traded = history ? new Set(history.markets.filter(m => num(m.fills) > 0).map(m => m.id)) : null;
    assignColors([...data.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
    render();
  }
  // Funding across markets and time: APR per bucket, green when longs pay.
  async function loadFunding({ fresh = false }, mine) {
    const at = w;
    const [f, p] = await Promise.all([get(`funding?window=${at}`, { maxAge: fresh ? 0 : 30000 }), get(`protocol?window=${at}`).catch(() => null)]);
    if (!mine()) return;
    // A relisted market and its delisted original share a name: the old one's row says so.
    const closed = new Set((p?.markets ?? []).filter(m => m.active === false).map(m => m.id));
    const twins = f.series.map(s => s.symbol).filter((x, i, all) => all.indexOf(x) !== i);
    const rowName = s => {
      if (!twins.includes(s.symbol)) return s.symbol;
      if (closed.has(s.id)) return `${s.symbol} (closed)`;
      return f.series.some(o => o.symbol === s.symbol && closed.has(o.id)) ? s.symbol : `${s.symbol} #${s.id}`; // no closed one known: the ids tell them apart
    };
    const node = $('funding-map');
    const b = f.meta.bucket_seconds;
    const all = f.series.flatMap(s => s.points.map(p => p.t));
    if (!all.length) { morph($('f-desc'), 'Annualised funding rate per market'); node.innerHTML = empty('No funding events in this window'); return; }
    const times = []; for (let t = Math.min(...all); t <= Math.max(...all); t += b) times.push(t);
    // Each bucket is annualised with the funding interval of its own time (the API's apr_pct).
    const oi = new Map(f.markets.map(m => [m.id, num(m.open_interest) ?? 0]));
    // A market not trading, with no funding paid in the window, gets no row of grey cells.
    const pm = new Map((p?.markets ?? []).map(m => [m.id, m]));
    const quiet = s => { const m = pm.get(s.id); return !!m && (m.active === false || (!num(m.volume) && !num(m.open_interest))) && s.points.every(pt => !num(pt.apr_pct)); };
    const shown = f.series.filter(s => !quiet(s)), left = f.series.length - shown.length;
    const rows = shown.filter(s => s.points.some(p => p.apr_pct !== null && p.apr_pct !== undefined)).sort((a, b2) => (oi.get(b2.id) ?? 0) - (oi.get(a.id) ?? 0)).map(s => {
      const byTime = new Map(s.points.filter(p => p.apr_pct !== null && p.apr_pct !== undefined).map(p => [p.t, p.apr_pct]));
      return { name: rowName(s), values: times.map(t => byTime.get(t) ?? null) };
    });
    mapHeight = Math.max(180, rows.length * 30 + 70);
    node.style.height = `${mapHeight}px`;
    // Scale to the data: the 95th percentile of |APR|, rounded up to a step.
    const mags = rows.flatMap(r => r.values).filter(v => v !== null).map(Math.abs).sort((a, b2) => a - b2);
    const p95 = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.95))] : 0;
    const clamp = [10, 20, 25, 50, 100, 200].find(x => x >= p95) ?? 200;
    const notes = [`Annualised rate per market, ${b >= 86400 ? 'daily' : b >= 14400 ? '4-hour' : 'hourly'} averages`, 'green: longs pay shorts, red: shorts pay longs', `scale ±${clamp}% APR`];
    if (left) notes.push(`${left} market${left === 1 ? '' : 's'} not trading left out`);
    morph($('f-desc'), keepDots(notes.join(' · ')));
    divergingHeatmap(node, { times, rows, bucketSeconds: b, clamp, labels: ['longs pay', 'shorts pay'], fmt: v => `${pct(v, { digits: 1, sign: true })} APR` });
  }
  // Each panel loads until it works. A press holds its regions; the newest load owns the
  // panel, so a slow answer never lands over a newer one. A failed refresh leaves this
  // window's figures on screen; figures of another window give way to Retry.
  const panels = {
    list: { load: loadList, regions: ['list'], fail: retry => panelError($('list'), 'Markets unavailable', retry) },
    funding: { load: loadFunding, regions: ['funding-map'], fail: retry => { morph($('f-desc'), 'Annualised funding rate per market'); panelError($('funding-map'), 'Funding history unavailable', retry); } }
  };
  const release = p => { p.held?.forEach(done => done()); p.held = null; };
  function start(key, opts = {}) {
    const p = panels[key];
    if (opts.poll && p.busy) return;
    const run = p.run = (p.run ?? 0) + 1, at = w, mine = () => alive && run === p.run;
    p.busy = true;
    keepTrying(async () => { await p.load(opts, mine); if (!mine()) return; p.busy = false; p.shown = at; release(p); }, { alive: mine, fail: () => { release(p); if (p.shown !== at) p.fail(() => start(key)); } });
  }
  const press = key => { const p = panels[key]; p.held ??= p.regions.map(id => hold($(id))); start(key); };
  // 24h follows every push; longer windows refetch at most every 15 s.
  let lastLongLoad = 0;
  const off = stream.on('protocol', () => {
    if (w === '24h') { start('list', { poll: true }); return; }
    if (Date.now() - lastLongLoad < 15000) return;
    lastLongLoad = Date.now();
    start('list', { poll: true, fresh: true });
  });
  start('list');
  start('funding');
  return {
    onSeg(name, v) { if (name === 'window' && v !== w) setQuery({ window: v === '24h' ? null : v }); },
    onSort(id, key) {
      sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' };
      keepQuery({ sort: key === 'volume' ? null : key, dir: sort.dir === 'asc' ? 'asc' : null });
      render();
    },
    update(q) {
      const next = windowOf(q);
      if (next === w) return;
      w = next;
      morph($('win'), seg('window', WINDOWS, w));
      morph($('scope'), scope());
      press('list'); press('funding');
    },
    refresh() { start('list', { fresh: true }); start('funding', { fresh: true }); },
    destroy() { alive = false; off(); }
  };
}
