// Protocol overview: headline metrics for the chosen window, volume by market
// next to the live tape, a grid of trend charts, the latest liquidations and
// flows, and market share.
import { get, stream } from '../api.js';
import { usd, usdShort, usdFull, compact, int, price, dpOf, pct, num, esc, signClass, timeOnly, dateTime, ago, duration } from '../format.js';
import { kpi, keepDots, infoTip, seg, table, mktLink, sideTag, addr, pnl, tradeAction, DASH, chartTools, skRows, skKpis, skChart, empty, assignColors, colorOf, hasColor, logo, ICON, OTHER_HEX, SLOT_HEX, mergeByAsset, hold, morph, panelError, keepTrying, fitRows } from '../ui.js';
import { sparkline, stackedBars, lineChart, signedBars, twoSided, toggleSeries, dropZoom, COLORS, CUMULATIVE } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const MIN_SIZES = [['0', 'All'], ['100', '≥$100'], ['1000', '≥$1K'], ['10000', '≥$10K']];
const FEE_VIEWS = [['type', 'By recipient'], ['market', 'By market']];
const FLOW_VIEWS = [['recent', 'Latest'], ['in', 'Top in'], ['out', 'Top out']];
// Windows other than 24h and the flow lists have no push of their own: refetch at most this often while blocks arrive.
const QUIET_REFRESH_MS = 15000;
// The window the headline cards and the lists open on: the last day, updated live.
const DEFAULT_WINDOW = '24h';
const segSm = (name, options, active) => seg(name, options, active).replace('class="seg"', 'class="seg sm"');
// Rows in the two lists of the Activity row.
const LIST_ROWS = 8;
// Below these widths a row no longer shares its height with the panel beside it.
const stacked = width => matchMedia(`(max-width: ${width}px)`).matches;
const windowOf = q => (WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : DEFAULT_WINDOW);
const savedMinSize = () => { try { const v = localStorage.getItem('ps.minsize'); return MIN_SIZES.some(([x]) => x === v) ? v : '100'; } catch { return '100'; } };
// What the API says goes unprinted (panelError has its own words); a bug in this file does not.
// A table or note amount: the short form, with the exact figure as its note.
const amt = (v, opts) => (num(v) === null ? DASH : `<span class="amt" title="${esc(usdFull(v))}">${usdShort(v, opts)}</span>`);
// How long ago, with the exact time as its note.
const when = ts => `<span class="muted" title="${esc(dateTime(ts))} UTC">${ago(ts)}</span>`;
// Pages with a period of their own, opened on the one being read. Each has its own default.
const withWindow = (path, win, home = DEFAULT_WINDOW) => (win === home ? path : `${path}?window=${win}`);
const liqPage = win => withWindow('/liquidations', win, '30d');
// A whole card is the link: the anchor sits on the figure, and stretches over the card in CSS.
const newAccounts = n => `${int(n)} new ${num(n) === 1 ? 'account' : 'accounts'}`;
const cardLink = (name, value, href, page) => `<a class="kpi-link" href="${esc(href)}" aria-label="${esc(`${name} ${value}, open ${page}`)}">${value}</a>`;
// A skeleton or an error gives way to the table: patched over, its inline height would stay on the table's wrapper.
const fill = (node, html) => { node.querySelector(':scope > .sk-rows, :scope > .panel-error')?.remove(); morph(node, html); };
const logBug = e => { if (e?.status === undefined && e?.code === undefined) console.error(e); };

export function mount(el, { query, setQuery }) {
  let w = windowOf(query);
  let feeView = 'type';
  let minSize = savedMinSize();
  // dataWin and flowsWin: the window the cards and the flow lists show, which trails w while its answer is on the way.
  let data = null, series = null, dataWin = null, alive = true, flows = null, flowsWin = null, flowView = 'recent', lastQuiet = Date.now();
  let tapeLoaded = false, liqsLoaded = false, lsLoaded = false;
  const tape = [], off = [], hidden = new Set(), sparks = {}, trendAsk = {};
  // One hold per region, taken on a press and let go by the answer that lands.
  const held = {};
  const dim = id => { held[id] ??= hold($(id)); };
  const undim = id => { held[id]?.(); held[id] = null; };
  // One retry loop per region: a newer load replaces the one before it.
  const stops = {};
  const run = (key, load, fail) => { stops[key]?.(); stops[key] = keepTrying(load, { alive: () => alive, fail }); };
  // The volume chart and the trend charts each keep their own window, independent
  // of the one at the top (which drives the headline cards and the activity lists).
  const TRENDS = ['oi', 'tvl', 'flows', 'traders', 'fees', 'liq', 'tpnl', 'taker'];
  // The window each trend opens on.
  const pw = { oi: '30d', tvl: '30d', flows: 'all', traders: '30d', fees: 'all', liq: '30d', tpnl: 'all', taker: 'all' };
  const winCtl = id => segSm(`tw:${id}`, WINDOWS, pw[id]);
  // The volume chart opens on the last 24 hours, hour by hour.
  let vw = '24h';
  const panel = (id, title, desc, extra = '') => `<section class="panel trend"><div class="panel-head"><div class="trend-id"><h2>${title}${infoTip(desc, title)}</h2><div class="head-value" id="${id}-v"></div>${extra}</div><div class="trend-side"><div class="trend-ctl">${chartTools(id, id)}<span id="${id}-win" class="trend-win">${winCtl(id)}</span></div><div class="legend dots" id="${id}-lg"></div></div></div><div class="panel-body"><div class="chart sm" id="${id}">${skChart()}</div></div></section>`;

  el.innerHTML = `
    <div class="page-head hero">
      <div class="hero-id">
        <div><h1><img class="hero-logo" src="/img/venues/perpl.png" alt="" width="26" height="26">Perpl <span class="hero-muted">Analytics</span></h1>
          <div class="sub">Live analytics for Perpl on Monad: markets, traders, liquidation risk and alerts, from every onchain trade.</div></div>
      </div>
      <div class="hero-actions"><a class="btn primary" href="https://app.perpl.xyz" target="_blank" rel="noopener noreferrer">Trade on Perpl ${ICON.ext}</a><div class="ov-switch"><span id="win-for">Cards and Wallet flows</span><div id="win" role="group" aria-labelledby="win-for">${seg('window', WINDOWS, w)}</div></div></div>
    </div>
    <div class="stack">
      <div class="kpis keep-delta" id="kpis">${skKpis(6, { spark: true, lines: 2 })}</div>
      <div class="grid g-main ov-main">
        <section class="panel">
          <div class="panel-head"><div><h2>Trading volume</h2><div class="desc">${keepDots('Traded notional by market · line: running total')}</div></div><div class="head-right vol-head">${chartTools('main-chart', 'volume')}<a class="meta" id="vol-link" href="${withWindow('/markets', vw)}">Market details →</a><span id="vwin" class="trend-win">${segSm('vw', WINDOWS, vw)}</span></div></div>
          <div class="panel-head vol-keys"><div class="legend toggles" id="legend"></div><span class="head-right"><span id="bucket"></span><span class="meta" id="chart-meta"></span></span></div>
          <div class="panel-body"><div class="chart" id="main-chart">${skChart()}</div></div>
        </section>
        <section class="panel fill">
          <div class="panel-head"><h2>Live trades</h2><div id="minsize">${segSm('min', MIN_SIZES, minSize)}</div></div>
          <div class="panel-body flush scroll" id="tape">${skRows(11, 38, 34)}</div>
          <div class="panel-foot ov-tape-foot"><span id="tape-meta">${keepDots('Finalized blocks · taker side · UTC')}</span><span id="tape-count"></span></div>
        </section>
      </div>
      <div class="section-label">Trends <span class="section-note">Each chart has its own period</span></div>
      <div class="grid g-2">
        ${panel('oi', 'Open interest', 'Value of open positions, one side only (longs equal shorts); the chart uses last trade prices')}
        ${panel('tvl', 'TVL', 'Collateral in the exchange contract')}
        ${panel('flows', 'Deposits and withdrawals', 'Deposits (up) and withdrawals (down) per period; the line is the net flow')}
        ${panel('traders', 'Active traders', 'Accounts that traded in each period, split into returning and first-time (first trade ever)')}
        ${panel('fees', 'Fees', 'Trading fees before rebates, split between the protocol and the insurance fund', `<div id="fees-mode">${segSm('feesv', FEE_VIEWS, feeView)}</div>`)}
        ${panel('liq', 'Liquidated', 'Notional liquidated per period, by market; the line is the running total')}
        ${panel('tpnl', 'Trader PnL', 'Realized PnL of all traders per period, funding included, before fees. The after-fees figure subtracts trading and liquidation fees.')}
        ${panel('taker', 'Taker flow', 'Volume bought (up) and sold (down) by takers per period; the line is net buying')}
      </div>
      <div class="section-label">Activity</div>
      <div class="grid g-3 aligned ov-lists">
        <section class="panel"><div class="panel-head"><h2>Latest liquidations</h2><a class="meta" id="liq-link" href="${liqPage(w)}">View all →</a></div><div class="panel-body flush" id="liqs">${skRows(LIST_ROWS, 38, 34)}</div></section>
        <section class="panel"><div class="panel-head"><h2>Wallet flows</h2><div id="flowview">${segSm('flowv', FLOW_VIEWS, flowView)}</div></div><div class="panel-body flush" id="flowlist">${skRows(LIST_ROWS, 38, 34)}</div></section>
        <section class="panel fill"><div class="panel-head"><h2>By period</h2><span class="meta">Exchange totals</span></div><div class="panel-body flush fill-table" id="windows">${skRows(4, stacked(1100) ? 48 : 76, 34, 48)}</div></section>
      </div>
      <div class="section-label">Market share</div>
      <div class="grid g-2" id="landscape-grid">
        <section class="panel fill"><div class="panel-head"><div><h2>Perps on Monad</h2><div class="desc">Open interest by venue</div></div><span class="meta" id="ls-chain-meta"></span></div><div class="panel-body flush fill-table ls-table" id="ls-chain">${skRows(3, stacked(999) ? 38 : 76, 34)}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Among all perps</h2><div class="desc">Open interest by venue</div></div><span class="meta" id="ls-meta"></span></div><div class="panel-body flush ls-table" id="ls-all">${skRows(6, 38, 34)}</div></section>
      </div>
    </div>`;
  const $ = id => el.querySelector(`#${id}`);
  const winLabel = win => (win === 'all' ? 'All-time' : win);
  const BUCKET_NAMES = { 3600: 'hourly', 14400: '4-hour', 86400: 'daily', 604800: 'weekly' };
  // Period length: the API's default per window (all-time: weekly), or daily/weekly on request.
  const BUCKET_CHOICES = { '30d': [['1d', 'Daily'], ['1w', 'Weekly']], all: [['1d', 'Daily'], ['1w', 'Weekly']] };
  // The headline cards' series (sparklines) follow the top switch; the volume
  // chart's series follows its own window and period length.
  let bucket = null, vseries = null;
  const volPath = () => `protocol/series?window=${vw}${bucket ? `&bucket=${bucket}` : ''}`;
  function renderBucket() { const c = BUCKET_CHOICES[vw]; morph($('bucket'), c ? segSm('bucket', c, bucket ?? (vw === 'all' ? '1w' : '1d')) : ''); }
  // The answer that lands last is the newest press, whatever order they arrive in.
  let volAsk = 0, volShown = null;
  async function loadVolume(fresh = false) {
    const ask = ++volAsk, path = volPath();
    const v = await get(path, fresh ? { maxAge: 0 } : undefined);
    if (!alive || ask !== volAsk) return;
    vseries = v; volShown = path; undim('main-chart'); renderVolume();
  }
  const startVolume = (fresh = false) => run('volume', () => loadVolume(fresh), e => {
    logBug(e); undim('main-chart');
    if (volShown !== volPath()) { $('chart-meta').textContent = ''; panelError($('main-chart'), undefined, () => startVolume()); }
  });
  const pressVolume = () => { dropZoom($('main-chart')); dim('main-chart'); startVolume(); };

  // On all time the active traders card shows the last 30 days: not every
  // account that ever traded is an active one.
  let active30 = null;
  const active30Data = fresh => Promise.all([get('protocol?window=30d', { maxAge: fresh ? 0 : 15000 }), get('protocol/series?window=30d', { maxAge: fresh ? 0 : 15000 })]).then(([p, s]) => ({ p, s }));
  let mainAsk = 0;
  async function loadMain(fresh = false) {
    const ask = ++mainAsk, win = w, opt = fresh ? { maxAge: 0 } : undefined;
    const [p, s, a] = await Promise.all([get(`protocol?window=${win}`, opt), get(`protocol/series?window=${win}`, opt), win === 'all' ? active30Data(fresh).catch(() => null) : null]);
    if (!alive || ask !== mainAsk) return;
    data = p; series = s; active30 = a; dataWin = win;
    assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
    renderKpis(); renderWindows();
    undim('kpis'); undim('windows');
  }
  // A refresh that fails leaves the figures of this window where they are.
  const startMain = (fresh = false) => run('main', () => loadMain(fresh), e => {
    logBug(e); undim('kpis'); undim('windows');
    if (dataWin !== w) { panelError($('kpis'), undefined, () => startMain()); panelError($('windows'), undefined, () => startMain()); }
  });
  // Rows from the stream that are newer than the answer stay above it.
  let tapeAsk = 0;
  async function loadTape(fresh = false) {
    const ask = ++tapeAsk;
    const t = await get('trades?limit=200', { maxAge: fresh ? 0 : 800 });
    if (!alive || ask !== tapeAsk) return;
    const newest = t.rows.reduce((a, r) => Math.max(a, Number(r.block)), 0);
    const kept = tape.filter(r => (r.proposed ? !t.rows.some(x => x.tx === r.tx) : Number(r.block) > newest));
    tape.length = 0; tape.push(...kept, ...t.rows);
    tapeLoaded = true; renderTape();
  }
  const startTape = (fresh = false) => run('tape', () => loadTape(fresh), e => { logBug(e); if (!$('tape').querySelector('table')) panelError($('tape'), undefined, () => startTape()); });
  let liqAsk = 0;
  async function loadLiqs(fresh = false) {
    const ask = ++liqAsk;
    const l = await get(`liquidations?limit=${LIST_ROWS}`, fresh ? { maxAge: 0 } : undefined);
    if (!alive || ask !== liqAsk) return;
    liqsLoaded = true; renderLiqs(l);
  }
  const startLiqs = (fresh = false) => run('liqs', () => loadLiqs(fresh), e => { logBug(e); if (!liqsLoaded) panelError($('liqs'), undefined, () => startLiqs()); });
  let flowAsk = 0;
  async function loadFlows(fresh = false) {
    const ask = ++flowAsk, win = w;
    const f = await get(`flows?window=${win}`, fresh ? { maxAge: 0 } : undefined);
    if (!alive || ask !== flowAsk) return;
    flows = f; flowsWin = win; undim('flowlist'); renderFlows();
  }
  const startFlows = (fresh = false) => run('flows', () => loadFlows(fresh), e => { logBug(e); undim('flowlist'); if (flowsWin !== w) renderFlows(); });

  // Change over the window from the running-sum series (null until history is complete).
  function seriesChange(field, sr = series, win = dataWin) {
    if (win === 'all' || !sr?.meta?.cumulative_complete) return undefined; // from launch the change is meaningless
    const vals = sr.points.map(p => num(p[field])).filter(v => v !== null);
    if (vals.length < 2 || !vals[0]) return undefined;
    return Math.round((vals.at(-1) - vals[0]) / vals[0] * 10000) / 100;
  }
  // A card's line is drawn again only when its numbers moved.
  function spark(key, values, color = COLORS.accent) {
    const node = $(key), mark = values.join();
    if (!node || !values.some(v => v !== null && v !== undefined) || (node.__chart && sparks[key] === mark)) return;
    sparks[key] = mark; sparkline(node, values, { color });
  }
  function renderKpis() {
    const h = data.headline, c = data.current, pts = series.points, win = dataWin;
    const cov = data.meta.coverage, wl = winLabel(win), act = win === 'all' ? active30 : null;
    // A change against a previous window that is still being indexed would mislead: hide it.
    // All-time has no previous period, so no change is shown (not a "—").
    const ch = v => (win === 'all' || data.meta.previous_complete === false ? undefined : v);
    const partial = cov && !cov.complete ? ' <span class="tag warn" title="History for this window is still being indexed">partial</span>' : '';
    // Window totals compare with the window before; open interest and TVL show their change within the window.
    const vsPrev = { basis: `vs prev ${wl}`, basisTitle: `Compared with the previous ${wl}` }, within = { basis: `in ${wl}`, basisTitle: `Change over the last ${wl}` };
    morph($('kpis'), [
      kpi({ label: `Volume · ${wl}`, value: cardLink('Volume', usd(h.volume.value), withWindow('/markets', win), 'Markets'), delta: ch(h.volume.change_pct), ...vsPrev, note: `${int(data.markets.reduce((a, m) => a + (m.fills ?? 0), 0))} trades${partial}`, spark: 'sp-vol' }),
      kpi({ label: 'Open interest', value: cardLink('Open interest', usd(c?.open_interest), withWindow('/markets', win), 'Markets'), delta: seriesChange('open_interest'), ...within, note: c ? `${int(c.positions)} open positions` : '', spark: 'sp-oi' }),
      kpi({ label: 'TVL', value: cardLink('TVL', usd(c?.tvl), '/status', 'Status'), delta: seriesChange('tvl'), ...within, note: `${amt(h.net_flow.value, { sign: true })} net flow · ${wl}`, spark: 'sp-tvl' }),
      kpi({ label: `Fees · ${wl}`, value: cardLink('Fees', usd(h.fees.value), withWindow('/markets', win), 'Markets'), delta: ch(h.fees.change_pct), ...vsPrev, note: h.protocol_revenue ? `<span tabindex="0" data-tip="The protocol's share of fees (${usdFull(h.protocol_fees?.value)}) plus its share of liquidations (${usdFull(h.revenue?.protocol?.liquidations)})">${usdShort(h.protocol_revenue.value)} protocol revenue</span>` : '', spark: 'sp-fees' }),
      act ? kpi({ label: 'Active traders · 30d', value: cardLink('Active traders', int(act.p.headline.traders.value), withWindow('/traders', '30d'), 'Traders'), note: newAccounts(act.p.headline.new_accounts.value), spark: 'sp-tr' })
        : kpi({ label: `Active traders · ${wl}`, value: cardLink('Active traders', int(h.traders.value), withWindow('/traders', win), 'Traders'), delta: ch(h.traders.change_pct), ...vsPrev, note: newAccounts(h.new_accounts.value), spark: 'sp-tr' }),
      kpi({ label: `Liquidated · ${wl}`, value: cardLink('Liquidated', usd(h.liquidated.value), liqPage(win), 'Liquidations'), delta: ch(h.liquidated.change_pct), ...vsPrev, invert: true, note: `${int(h.liquidations.value)} ${num(h.liquidations.value) === 1 ? 'liquidation' : 'liquidations'}`, spark: 'sp-liq' })
    ].join(''));
    spark('sp-vol', pts.map(p => num(p.volume)));
    spark('sp-oi', pts.map(p => num(p.open_interest)));
    spark('sp-tvl', pts.map(p => num(p.tvl)));
    spark('sp-fees', pts.map(p => num(p.fees)));
    spark('sp-tr', (act ? act.s.points : pts).map(p => p.traders));
    spark('sp-liq', pts.map(p => num(p.liquidated)), COLORS.short);
  }

  // Stacked by market: the six largest markets keep their colour, the rest fold into Other.
  function byMarket(metric, sr = series) {
    const all = mergeByAsset(sr.by_market ?? [], ['volume', 'liquidated', 'fees']).filter(m => m[metric].some(v => num(v) > 0));
    const top = all.filter(m => hasColor(m.id)), rest = all.filter(m => !hasColor(m.id));
    const list = top.map(m => ({ id: m.id, name: m.symbol, color: colorOf(m.id), data: m[metric].map(num) }));
    if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: sr.times.map((_, i) => rest.reduce((a, m) => a + num(m[metric][i]), 0)) });
    return list;
  }
  // The swatch keeps the series colour; the logo (when the asset has one) names it.
  const legendLogo = s => { if (s.id === undefined) return ''; const html = logo(s.id, s.name, 14); return html.startsWith('<img') ? html : ''; };
  // Redrawn in place on the minute refresh, so a zoom holds and a market switched
  // off stays off; a new window or period length drops the zoom (pressVolume).
  function renderVolume() {
    if (!vseries) return;
    const node = $('main-chart'), b = vseries.meta.bucket_seconds;
    // With the daily/weekly switch shown, the meta says only UTC.
    $('chart-meta').textContent = BUCKET_CHOICES[vw] ? 'UTC' : `${BUCKET_NAMES[b] ?? `${vseries.meta.bucket}`} bars · UTC`;
    const list = byMarket('volume', vseries);
    stackedBars(node, { times: vseries.times, series: list, bucketSeconds: b, cumulative: true, zoom: true });
    for (const name of hidden) if (name === CUMULATIVE || list.some(s => s.name === name)) toggleSeries(node, name);
    const isOff = name => (hidden.has(name) ? ' off' : '');
    morph($('legend'), list.map(s => `<button class="lg${isOff(s.name)}" data-action="toggle" data-name="${esc(s.name)}"><i style="background:${s.color}"></i>${legendLogo(s)}${esc(s.name)}</button>`).join('')
      + `<button class="lg${isOff(CUMULATIVE)}" data-action="toggle" data-name="${CUMULATIVE}"><i style="background:#fff;height:2px;border-radius:1px"></i>Cumulative</button>`);
  }
  // Open interest and TVL are running sums from launch, so they wait for the backfill.
  let backfill = null;
  function historyNote() {
    const p = backfill && !backfill.complete && backfill.pct < 100 ? ` Indexing is ${Math.floor(backfill.pct)}% done${backfill.eta_s ? `, about ${duration(backfill.eta_s)} left` : ''}.` : '';
    return `A running sum over every event since launch, drawn once history indexing completes.${p}`;
  }
  // A dot and a name per series, above the chart on the right.
  const legendOf = (id, list) => morph($(`${id}-lg`), list.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join(''));
  const NET = { color: '#ffffff' };
  // A note wraps only between its parts ("$267.8K insurance" stays whole), each "·" with the part before it.
  const noteParts = note => keepDots(note.split(' · ').map(x => `<span class="nw">${x}</span>`).join(' · '));
  function headValue(id, value, note = '') { morph($(`${id}-v`), `<div class="hv">${value}</div>${note ? `<div class="hn">${noteParts(note)}</div>` : ''}`); }
  // Fees per period by recipient (the protocol's and the insurance fund's
  // shares, which add up to the fees) or by market.
  function renderFees() {
    const d = trendOf.fees, node = $('fees'); if (!node || !d) return;
    const sr = d.s, pts = sr.points, times = sr.times, b = sr.meta.bucket_seconds;
    const list = feeView === 'market' ? byMarket('fees', sr) : [{ name: 'Protocol', color: SLOT_HEX[0], data: pts.map(p => num(p.protocol_fees)) }, { name: 'Insurance fund', color: SLOT_HEX[2], data: pts.map(p => num(p.insurance_fees)) }].filter(x => x.data.some(v => v > 0));
    legendOf('fees', list);
    if (list.length) stackedBars(node, { times, series: list, bucketSeconds: b }); else node.innerHTML = empty('No fees in this period');
  }
  // Each trend panel: its window's totals (header) and series (chart).
  const trendOf = {};
  const trendData = (win, fresh) => Promise.all([get(`protocol?window=${win}`, { maxAge: fresh ? 0 : 15000 }), get(`protocol/series?window=${win}`, { maxAge: fresh ? 0 : 15000 })]).then(([p, s]) => ({ p, s }));
  async function loadTrend(id, fresh = false) {
    const win = pw[id], ask = trendAsk[id] = (trendAsk[id] ?? 0) + 1;
    const d = await trendData(win, fresh);
    if (!alive || ask !== trendAsk[id]) return; // switched again meanwhile
    trendOf[id] = { ...d, win }; undim(id); undim(`${id}-v`); renderTrend(id);
  }
  const startTrend = (id, fresh = false) => run(`trend:${id}`, () => loadTrend(id, fresh), e => {
    logBug(e); undim(id); undim(`${id}-v`);
    if (trendOf[id]?.win !== pw[id]) { morph($(`${id}-v`), ''); panelError($(id), undefined, () => startTrend(id)); }
  });
  const startTrends = (fresh = false) => TRENDS.forEach(id => startTrend(id, fresh));
  // The after-fees figure waits on its own call: the line keeps the last one meanwhile.
  let afterFees = null;
  function renderTrend(id) {
    const d = trendOf[id], node = $(id); if (!d || !node) return;
    const win = pw[id], sr = d.s, pts = sr.points, times = sr.times, b = sr.meta.bucket_seconds, h = d.p.headline, c = d.p.current;
    // Charts are redrawn in place, on the minute refresh and on a window switch (their marks move, not regrow).
    // Open interest and TVL: axes start at zero, so a 1% move looks like one; the change
    // over the window is in the header, at the KPI's precision (one decimal, none from 100%).
    const moved = field => { const x = seriesChange(field, sr, win); if (x === undefined) return win === 'all' ? 'now' : ''; return `<span class="${signClass(x, 1) || 'faint'}">${pct(x, { digits: 1, sign: true })}</span> over ${win}`; };
    const cumulative = sr.meta.cumulative_complete;
    switch (id) {
      case 'oi':
        headValue('oi', usd(c?.open_interest), moved('open_interest'));
        if (cumulative) lineChart(node, { times, series: [{ name: 'Open interest', color: COLORS.accent, data: pts.map(p => num(p.open_interest)) }], bucketSeconds: b }); else node.innerHTML = empty(historyNote());
        break;
      case 'tvl':
        headValue('tvl', usd(c?.tvl), moved('tvl'));
        if (cumulative) lineChart(node, { times, series: [{ name: 'TVL', color: SLOT_HEX[0], data: pts.map(p => num(p.tvl)) }], bucketSeconds: b }); else node.innerHTML = empty(historyNote());
        break;
      case 'flows':
        headValue('flows', usd(h.net_flow.value, { sign: true }), `${amt(h.deposits.value)} in · ${amt(h.withdrawals.value)} out · ${winLabel(win)}`);
        legendOf('flows', [{ name: 'Deposits', color: COLORS.long }, { name: 'Withdrawals', color: COLORS.short }, { name: 'Net flow', ...NET }]); // the chart's own names, as in its tooltip
        twoSided(node, { times, bucketSeconds: b, up: { name: 'Deposits', data: pts.map(p => p.deposits) }, down: { name: 'Withdrawals', data: pts.map(p => p.withdrawals) }, net: 'Net flow' });
        break;
      case 'traders':
        {
          // First-time: accounts trading for the first time ever; the rest came back.
          // "Ever" needs every event since launch, so the split waits for the backfill.
          const fresh = pts.reduce((a, p) => a + (p.new_traders ?? 0), 0);
          headValue('traders', int(h.traders.value), `${winLabel(win)} distinct${cumulative ? ` · ${int(fresh)} first-time` : ''}`);
          const split = cumulative ? [
            { name: 'Returning traders', color: COLORS.accent, data: pts.map(p => Math.max(0, (p.traders ?? 0) - (p.new_traders ?? 0))) },
            { name: 'First-time traders', color: SLOT_HEX[2], data: pts.map(p => p.new_traders ?? 0) }
          ] : [{ name: 'Active traders', color: COLORS.accent, data: pts.map(p => p.traders ?? 0) }];
          legendOf('traders', split.length > 1 ? split : []);
          stackedBars(node, { times, series: split, bucketSeconds: b, fmt: v => int(v), yFmt: v => (Math.abs(v) >= 1000 ? compact(v, { digits: 1 }) : int(v)) });
        }
        break;
      case 'fees':
        // Payouts from the protocol to trader accounts show on hover over its share.
        const paid = num(h.protocol_payouts?.value) > 0 ? `<span tabindex="0" data-tip="${usdFull(h.protocol_payouts.value)} paid from the protocol to trader accounts">${usdShort(h.protocol_fees.value)} protocol</span>` : `${amt(h.protocol_fees.value)} protocol`;
        headValue('fees', usd(h.fees.value), `${paid} · ${amt(h.insurance_fees.value)} insurance · ${winLabel(win)}`);
        renderFees();
        break;
      case 'liq': {
        headValue('liq', usd(h.liquidated.value), `${int(h.liquidations.value)} liquidations · ${winLabel(win)}`);
        const list = byMarket('liquidated', sr);
        legendOf('liq', list.length ? [...list, { name: 'Cumulative', ...NET }] : []);
        if (list.length) stackedBars(node, { times, series: list, bucketSeconds: b, cumulative: true }); else node.innerHTML = empty('No liquidations in this period');
        break;
      }
      case 'tpnl': {
        // Header figures come from the window's own totals, not from summing the
        // chart's buckets; 'after fees' is the Traders page's figure for the same window.
        const total = num(h.realized_pnl?.value ?? h.realized_pnl) ?? 0;
        const value = pnl(total), line = () => `${winLabel(win)}${afterFees?.win === win ? ` · after fees ${afterFees.text}` : ''}`;
        headValue('tpnl', value, line());
        get(`traders/summary?window=${win}`, { maxAge: 20000 }).then(t => { if (!alive || !t || trendOf.tpnl?.win !== win) return; afterFees = { win, text: amt(t.net_pnl, { sign: true }) }; headValue('tpnl', value, line()); }).catch(() => {});
        signedBars(node, { times, values: pts.map(p => num(p.realized_pnl)), bucketSeconds: b, name: 'Trader realized PnL' });
        break;
      }
      case 'taker': {
        const buys = d.p.markets.reduce((a, m) => a + (num(m.taker_buy) ?? 0), 0), sells = d.p.markets.reduce((a, m) => a + (num(m.taker_sell) ?? 0), 0);
        headValue('taker', buys + sells ? `${pct(buys / (buys + sells) * 100, { digits: 1 })} buys` : '—', `${amt(buys)} bought · ${amt(sells)} sold · ${winLabel(win)}`);
        legendOf('taker', [{ name: 'Taker buys', color: COLORS.long }, { name: 'Taker sells', color: COLORS.short }, { name: 'Net taker buying', ...NET }]);
        twoSided(node, { times, bucketSeconds: b, up: { name: 'Taker buys', data: pts.map(p => p.taker_buy) }, down: { name: 'Taker sells', data: pts.map(p => p.taker_sell) }, net: 'Net taker buying' });
        break;
      }
      default:
    }
  }

  // Consensus timing of the blocks behind proposed trades (from the node's
  // execution events): the tape footer shows the median time from a block
  // starting to its finalization; a dimmed row's tooltip gives its own stage.
  const finalMs = [];
  const secs = ms => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const stageTitle = r => (r.votedMs !== undefined ? `Proposed block, not final yet; validators voted for it ${secs(r.votedMs)} after it began executing` : 'Proposed block, not final yet');
  function renderSpeed() {
    if (!finalMs.length) return;
    const sorted = [...finalMs].sort((a, b) => a - b), mid = sorted[Math.floor(sorted.length / 2)];
    morph($('tape-meta'), `<span class="speed-pill">${ICON.cube} Proposed → final <b class="num" title="Median time for a block to go from proposed to final, over the last ${sorted.length} blocks with Perpl activity">${secs(mid)}</b></span><span>UTC</span>`);
  }
  function renderTape() {
    const min = Number(minSize);
    const rows = tape.filter(r => (num(r.notional) ?? 0) >= min);
    $('tape-count').textContent = rows.length ? `${int(Math.min(rows.length, 60))} shown` : '';
    // Until the first answer the skeleton or the error stays: no rows yet says nothing about the market.
    if (!rows.length) { if (tapeLoaded) fill($('tape'), empty(tape.length ? 'No trades of this size yet' : 'Waiting for trades')); return; }
    fill($('tape'), table({ id: 'tape', compact: true, columns: [
      { key: 't', label: 'Time (UTC)', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 'm', label: 'Market', cls: 'mkt-cell', render: r => mktLink(r.market, r.symbol) },
      { key: 's', label: 'Action', tip: 'What the taker did: green bought, red sold. Liq marks a liquidation.', render: tradeAction },
      { key: 'p', label: 'Price', phone: false, n: true, render: r => price(r.price, dpOf(r.price)) },
      { key: 'v', label: 'Notional', n: true, render: r => amt(r.notional) }
    ], rows: rows.slice(0, 60), rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''} ${r.proposed ? 'proposed' : ''}" data-href="/wallet/${esc(r.address || r.account)}" ${r.proposed ? `title="${stageTitle(r)}"` : ''}` }));
    for (const r of tape) r.fresh = false;
  }
  function renderLiqs(l) {
    fill($('liqs'), l.rows.length ? table({ id: 'liqs', compact: true, columns: [
      { key: 'm', label: 'Market', cls: 'mkt-cell', render: r => mktLink(r.market, r.symbol) },
      { key: 's', label: 'Side', render: r => sideTag(r.side) },
      { key: 'v', label: 'Notional', n: true, render: r => amt(r.notional) },
      { key: 't', label: 'Time', n: true, render: r => `<a href="/wallet/${esc(r.address || r.account)}" aria-label="${esc(`Wallet, ${ago(r.ts)}`)}">${when(r.ts)}</a>` }
    ], rows: l.rows.slice(0, LIST_ROWS), rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"` }) : empty('No liquidations yet'));
  }
  // Latest movements, or the window's largest depositors / withdrawers with their net.
  function renderFlows() {
    const f = flows, node = $('flowlist');
    // The top lists belong to one window: another window's are no answer. Latest is the same on all of them.
    if (flowsWin !== w && (!f || flowView !== 'recent')) { if (!held.flowlist) panelError(node, undefined, () => startFlows()); return; }
    const link = r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"`;
    if (flowView === 'recent') {
      const rows = (f.recent ?? []).slice(0, LIST_ROWS);
      fill(node, rows.length ? table({ id: 'flowlist', compact: true, columns: [
        { key: 'k', label: 'Type', render: r => `<span class="${r.kind === 'deposit' ? 'pos' : 'neg'}">${r.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</span>` },
        { key: 'a', label: 'Wallet', render: r => addr(r.address, r.account, { star: false }) },
        { key: 'v', label: 'Amount', n: true, render: r => amt(r.amount) },
        { key: 't', label: 'Time', phone: false, n: true, render: r => when(r.ts) }
      ], rows, rowAttrs: link }) : empty('No recent deposits or withdrawals'));
      return;
    }
    const inbound = flowView === 'in', rows = ((inbound ? f.top_depositors : f.top_withdrawers) ?? []).slice(0, LIST_ROWS);
    fill(node, rows.length ? table({ id: 'flowlist', compact: true, columns: [
      { key: 'a', label: 'Wallet', render: r => addr(r.address, r.account, { star: false }) },
      { key: 'v', label: inbound ? 'Deposited' : 'Withdrew', n: true, render: r => amt(inbound ? r.deposits : r.withdrawals) },
      { key: 'n', label: 'Net flow', n: true, render: r => amt(r.net, { sign: true }) }
    ], rows, rowAttrs: link }) : empty(`No ${inbound ? 'deposits' : 'withdrawals'} in this period`));
  }
  function renderWindows() {
    const ws = data.windows;
    const rows = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All-time']].map(([k, label]) => ({ k, label, ...(ws[k] ?? {}) }));
    fill($('windows'), table({ id: 'win', compact: true, columns: [
      { key: 'label', label: 'Period', render: r => `<a href="${withWindow('/', r.k)}">${r.label}</a>${r.k === 'all' && backfill && !backfill.complete ? ' <span class="tag warn" title="History is still being indexed">partial</span>' : ''}${r.k === dataWin ? ' <span class="tag accent">shown</span>' : ''}<div class="sub">${int(r.trades)} trades</div>` },
      { key: 'volume', label: 'Volume', n: true, render: r => amt(r.volume) },
      { key: 'fees', label: 'Fees', n: true, render: r => amt(r.fees) },
      { key: 'traders', label: 'Traders', n: true, render: r => int(r.traders) }
    ], rows, rowAttrs: r => `class="link" data-action="win" data-v="${r.k}"` }));
  }

  // Market-share context from DefiLlama's open-interest overview (external, labelled as such).
  let lsAsk = 0;
  async function loadLandscape(fresh = false) {
    const grid = $('landscape-grid'), ask = ++lsAsk;
    if (!grid) return;
    let l;
    try { l = await get('landscape', { maxAge: fresh ? 0 : 300000 }); } catch (e) {
      if (!alive || ask !== lsAsk) return;
      if (e.status !== 404) throw e;
      grid.previousElementSibling.remove(); grid.remove(); return; // turned off on this server
    }
    if (!alive || ask !== lsAsk) return;
    lsLoaded = true;
    const src = `<a href="${esc(l.source.url)}" target="_blank" rel="noopener noreferrer">${esc(l.source.name)}</a>, ${ago(Math.round(l.fetched_at / 1000))}`;
    const bar = (v, share) => `${amt(v)}<span class="track"><i style="width:${Math.max(2, Math.min(100, share ?? 0))}%"></i></span>`;
    const name = r => (r.self || r.name === 'Perpl' ? `<span class="mkt"><img class="tk" src="/img/venues/perpl.png" alt="" width="16" height="16"><b>${esc(r.name)}</b></span>` : esc(r.name));
    // The five largest venues give the scale; Perpl's own row follows them.
    const top = l.top.slice(0, 5);
    if (l.perpl && l.perpl.rank > top.length) top.push({ rank: l.perpl.rank, name: 'Perpl', oi: l.perpl.oi, share_pct: l.perpl.share_pct });
    morph($('ls-meta'), keepDots(l.perpl ? `Perpl #${int(l.perpl.rank)} of ${int(l.venues)} · ${pct(l.perpl.share_pct, { digits: 2 })} · ${src}` : src));
    fill($('ls-all'), table({ id: 'ls-all', compact: true, columns: [
      { key: 'r', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
      { key: 'n', label: 'Venue', render: name },
      { key: 'o', label: 'Open interest', n: true, center: true, cls: 'cell-bar', render: r => bar(r.oi, r.share_pct / (l.top[0]?.share_pct || 1) * 100) },
      { key: 's', label: 'Share', n: true, render: r => `<span class="muted">${pct(r.share_pct, { digits: 2 })}</span>` }
    ], rows: top, rowAttrs: r => (r.name === 'Perpl' ? 'class="hl"' : '') }));
    morph($('ls-chain-meta'), keepDots(l.perpl?.share_of_chain_pct !== null && l.perpl ? `Perpl ${pct(l.perpl.share_of_chain_pct, { digits: 1 })} of ${esc(l.chain.name)} · ${src}` : src));
    fill($('ls-chain'), table({ id: 'ls-chain', compact: true, emptyText: 'No venues listed', columns: [
      { key: 'n', label: 'Venue', render: name },
      { key: 'o', label: 'Open interest', n: true, center: true, cls: 'cell-bar', render: r => bar(r.oi, r.share_pct) },
      { key: 's', label: 'Share', n: true, render: r => `<span class="muted">${pct(r.share_pct, { digits: 1 })}</span>` }
    ], rows: l.chain.venues, rowAttrs: r => (r.self ? 'class="hl"' : '') }));
  }
  const startLandscape = (fresh = false) => run('landscape', () => loadLandscape(fresh), e => {
    logBug(e);
    if (!lsLoaded) for (const id of ['ls-chain', 'ls-all']) panelError($(id), undefined, () => startLandscape());
  });

  // Live: finalized trades stream in; proposed ones appear first, dimmed. A batch
  // arrives in block order (oldest first), so each row goes on top in turn.
  off.push(stream.on('trades', rows => {
    for (const r of rows) { const i = tape.findIndex(x => x.proposed && x.tx === r.tx); if (i >= 0) tape.splice(i, 1); tape.unshift({ ...r, fresh: true }); }
    tape.length = Math.min(tape.length, 400); renderTape();
  }));
  // A proposed trade still unmatched 10 finalized blocks later never finalized.
  off.push(stream.on('block', b => { let dropped = false; for (let i = tape.length - 1; i >= 0; i--) if (tape[i].proposed && Number(tape[i].block) <= Number(b.block) - 10) { tape.splice(i, 1); dropped = true; } if (dropped) renderTape(); }));
  off.push(stream.on('stage', s => {
    if (s.stage === 'voted') { for (const r of tape) if (r.proposed && Number(r.block) === s.block) r.votedMs = s.ms; return; }
    if (s.stage === 'finalized') { finalMs.push(s.ms); if (finalMs.length > 50) finalMs.shift(); renderSpeed(); }
  }));
  off.push(stream.on('proposed', p => { for (const r of p.trades) if (!tape.some(x => x.tx === r.tx)) tape.unshift({ ...r, proposed: true, fresh: true }); tape.length = Math.min(tape.length, 400); if (!finalMs.length) morph($('tape-meta'), keepDots('Proposed + finalized blocks · taker side · UTC')); renderTape(); }));
  off.push(stream.on('backfill', p => {
    const finished = backfill && !backfill.complete && p.complete;
    backfill = p;
    if (!alive) return;
    if (finished) startTrends(true);
    else for (const id of ['oi', 'tvl']) { const n = $(id)?.querySelector('.empty-state'); if (n) n.textContent = historyNote(); }
  }));
  get('health', { maxAge: 30000 }).then(h => { backfill = h.index?.backfill ?? null; if (alive && data && backfill && !backfill.complete) renderWindows(); }).catch(() => {});
  off.push(stream.on('liquidations', () => startLiqs(true)));
  off.push(stream.on('protocol', p => {
    // The push carries 24h figures only.
    if (w === '24h' && dataWin === '24h') { data = { ...data, headline: p.headline, current: p.current, markets: data.markets.map(m => { const u = p.markets.find(x => x.id === m.id); return u ? { ...m, mark: u.mark ?? m.mark, volume: u.volume, change_pct: u.change_pct, open_interest: u.open_interest ?? m.open_interest, funding: u.funding ?? m.funding } : m; }) }; renderKpis(); }
    if (Date.now() - lastQuiet < QUIET_REFRESH_MS) return;
    lastQuiet = Date.now();
    startFlows(true);
    if (w === '24h' || dataWin !== w) return;
    // Longer windows: refetch their totals. A press since then owns the cards, so this answer is dropped.
    const ask = mainAsk, win = w;
    get(`protocol?window=${win}`, { maxAge: 0 }).then(d => { if (!alive || ask !== mainAsk || win !== w) return; data = d; renderKpis(); renderWindows(); }).catch(() => {});
  }));
  const timer = setInterval(() => { startVolume(true); startMain(true); startTrends(true); }, 60000);

  renderBucket();
  startMain(); startVolume(); startTrends();
  startTape(); startLiqs(); startFlows(); startLandscape();
  const stopFit = fitRows($('tape'));

  return {
    onSeg(name, v) {
      if (name.startsWith('tw:')) { const id = name.slice(3); pw[id] = v; morph($(`${id}-win`), winCtl(id)); dim(id); dim(`${id}-v`); startTrend(id); return; }
      if (name === 'window') setQuery({ window: v === DEFAULT_WINDOW ? null : v });
      if (name === 'min') { minSize = v; try { localStorage.setItem('ps.minsize', v); } catch { /* storage unavailable */ } morph($('minsize'), segSm('min', MIN_SIZES, minSize)); renderTape(); }
      if (name === 'flowv') { flowView = v; morph($('flowview'), segSm('flowv', FLOW_VIEWS, flowView)); renderFlows(); }
      if (name === 'bucket') { bucket = v; renderBucket(); pressVolume(); return; }
      if (name === 'vw') { vw = v; bucket = null; morph($('vwin'), segSm('vw', WINDOWS, vw)); $('vol-link').setAttribute('href', withWindow('/markets', vw)); renderBucket(); pressVolume(); return; }
      if (name === 'feesv') { feeView = v; morph($('fees-mode'), segSm('feesv', FEE_VIEWS, feeView)); renderFees(); }
    },
    onAction(a, t, event) {
      if (a === 'toggle') { const name = t.dataset.name, hide = !hidden.has(name); if (hide) hidden.add(name); else hidden.delete(name); t.classList.toggle('off', hide); toggleSeries($('main-chart'), name); }
      if (a === 'win') {
        // A plain press changes the period where the reader is; a new tab stays a link's job.
        if (event.ctrlKey || event.metaKey || event.shiftKey) { if (!event.target.closest('a')) window.open(withWindow('/', t.dataset.v), '_blank', 'noopener'); return; }
        event.preventDefault();
        setQuery({ window: t.dataset.v === DEFAULT_WINDOW ? null : t.dataset.v });
      }
    },
    update(q) {
      const nw = windowOf(q); if (nw === w) return;
      w = nw; morph($('win'), seg('window', WINDOWS, w));
      $('liq-link').setAttribute('href', liqPage(w));
      for (const id of ['kpis', 'windows', 'flowlist']) dim(id);
      startMain(); startFlows();
    },
    // Back on the stream or the API, and after a cached open: every region asks again, quietly.
    refresh() { startMain(true); startVolume(true); startTrends(true); startTape(true); startLiqs(true); startFlows(true); startLandscape(true); },
    destroy() { alive = false; clearInterval(timer); off.forEach(f => f()); Object.values(stops).forEach(stop => stop()); stopFit(); }
  };
}
