// One market: price candles and volume, positioning, funding history,
// liquidation ladder from live positions, top traders and recent trades.
import { get, stream } from '../api.js';
import { usd, usdShort, usdFull, int, price, dpOf, pct, num, esc, size, share, signClass, timeOnly, dateTime, duration } from '../format.js';
import { kpi, seg, table, sideTag, addr, ratio, pnl, pnlShort, pctCell, fundingCell, fundingTip, tradeAction, skRows, skBox, skKpis, skChart, empty, colorOf, chartTools, logo, go, hold, morph, panelError, keepTrying, keepDots, fitRows, infoTip, DASH } from '../ui.js';
import { candles, signedBars, mirrored, flowBars, entryProfile, dropZoom, cutsFirst, COLORS } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const windowOf = q => (WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h');
const segSm = (name, options, active) => seg(name, options, active).replace('class="seg"', 'class="seg sm"');
// Every empty panel of a market that is not open for trading says so in these words.
const CLOSED = 'This market is not open for trading';
// A table or note amount with its exact figure as the note.
const amount = v => (num(v) === null ? DASH : `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`);
// A table in place is patched. A skeleton or a failed panel is written over whole:
// morph would leave its inline height on the table that takes its place.
const paint = (node, html) => { if (node.querySelector(':scope > .table-wrap')) morph(node, html); else node.innerHTML = html; };
const stat = (label, value, { cls = '', tip = '' } = {}) => `<div class="stat"><span>${label}${infoTip(tip, label)}</span><span class="${cls}">${value}</span></div>`;

export function mount(el, { params, query, setQuery }) {
  const id = Number(params[0]);
  let w = windowOf(query);
  let alive = true, row = null, risk = null, showLevels = true;
  const LEVEL_TOGGLE = [['on', 'Liq. levels'], ['off', 'Off']];
  const wl = () => (w === 'all' ? 'All-time' : w);
  // Chart panels take the overview's trend-card head: a muted title with its
  // description in the (i), the figure and a note under it; tools, controls
  // and a dot legend on the right.
  // Skeleton heights, measured on the real panels: Positioning and the calculator stack
  // their stats under 640; Recent trades drops to eleven rows once it stands alone under 1000.
  const narrow = matchMedia('(max-width: 640px)').matches, stacked = matchMedia('(max-width: 999px)').matches;
  const panel = (key, title, desc, { csv = true, ctl = '', cls = '' } = {}) => `<section class="panel trend ${cls}"><div class="panel-head"><div class="trend-id"><h2>${title}${infoTip(desc, title)}</h2><div class="head-value" id="${key}-v"></div></div><div class="trend-side"><div class="trend-ctl">${chartTools(key, `market-${id}-${key}`, { csv })}${ctl}</div><div class="legend dots" id="${key}-lg"></div></div></div><div class="panel-body"><div class="chart sm" id="${key}">${skChart()}</div></div></section>`;
  el.innerHTML = `
    <div class="page-head">
      <div><div class="sub"><a href="/markets">Markets</a> /</div><h1 id="title">Market #${id}</h1><div class="sub" id="subtitle"></div></div>
      <div id="win">${seg('window', WINDOWS, w)}</div>
    </div>
    <div class="stack">
      <div class="kpis m-kpis" id="kpis">${skKpis(6)}</div>
      <div class="grid g-main">
        ${panel('candles', 'Price and volume', 'Trade price candles and volume, UTC. Bands show where open positions would be liquidated; click one for its largest wallet.', { ctl: `<span id="lvl-toggle" hidden>${segSm('lvl', LEVEL_TOGGLE, 'on')}</span>`, cls: 'm-price' })}
        <section class="panel"><div class="panel-head"><h2>Positioning</h2><span class="meta">Live positions</span></div><div id="positioning">${skBox(narrow ? 638.7 : 515.1)}</div></section>
      </div>
      <div class="grid g-2">
        ${panel('flow', 'Position flow', 'Longs and shorts opened (up) and closed (down) per period; the line is the change in open interest (one side only)')}
        ${panel('entries', 'Entry prices', 'Where open positions were entered: longs right, shorts left; the dashed line is the mark price', { csv: false })}
      </div>
      <div class="grid g-2">
        ${panel('funding', 'Funding rate · last 7 days', 'Rate paid each funding interval, last 7 days: green when longs pay, red when shorts pay. The figure is the current rate per 8 hours.')}
        ${panel('ladder', 'Liquidation ladder', 'Value of positions a price move of each size would liquidate: longs on a fall, shorts on a rise', { csv: false })}
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Largest positions</h2><div class="desc">Open now, from contract state</div></div><span class="meta" id="pos-meta">Top 15 by notional</span></div><div class="panel-body flush" id="positions">${skRows(15, 38)}</div></section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Order book</h2><div class="desc">${keepDots('Resting orders read from the contract · bars: cumulative depth')}</div></div><span class="meta" id="book-meta"></span></div><div class="panel-body flush" id="book">${skBox(665.4)}</div></section>
        <section class="panel fill"><div class="panel-head"><h2>Recent trades</h2><span class="meta" id="trades-meta">Taker side</span></div><div class="panel-body flush scroll" id="trades">${skRows(stacked ? 11 : 17, 38)}</div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Top traders</h2><span class="meta" id="lb-meta">By net PnL · ${wl()}</span></div><div class="panel-body flush" id="lb">${skRows(10, 38)}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Position calculator</h2><div class="desc">Liquidation price and PnL under this market's margin rules</div></div></div><div class="panel-body" id="calc">${skBox(narrow ? 429 : 346.5)}</div></section>
      </div>
    </div>`;
  const BOOK_LEVELS = 12;
  let calc = { side: 'long', usd: 1000, lev: 5, entry: null, exit: null };
  const $ = s => el.querySelector(`#${s}`);
  const text = (key, value) => { const n = $(key); if (n && n.textContent !== value) n.textContent = value; };
  const closed = () => row?.active === false;
  let everTraded = null; // whether this market has a trade in all of history (a listing may never have opened)
  // The market's price decimals, read off a chain price; a computed price (an entry, a
  // liquidation price, an average) carries more than the market trades in.
  let decimals = null;
  const dpFrom = v => { decimals = dpOf(v) ?? decimals; return decimals; };
  const none = value => empty(closed() ? CLOSED : value);
  // Open on the contract, but nothing traded in the window and nothing open: tagged like the list does.
  const idle = () => Boolean(row) && !closed() && !num(row.volume) && !num(row.open_interest);
  function headValue(key, value, note = '') { morph($(`${key}-v`), `<div class="hv">${value}</div>${note ? `<div class="hn">${keepDots(note)}</div>` : ''}`); }
  // A dot and a name per series; an entry without a colour is a plain note.
  const legendOf = (key, list) => morph($(`${key}-lg`), list.map(s => `<span${s.color ? '' : ' class="faint"'}>${s.color ? `<i style="background:${s.color}"></i>` : ''}${esc(s.name)}</span>`).join(''));
  const unit = value => `<span class="m-unit">${esc(value)}</span>`;
  function renderSubtitle() {
    if (!row) return;
    const lev = row.max_leverage ?? risk?.margin?.max_leverage;
    const tag = closed() ? (everTraded === false ? ' · <span class="tag" title="Listed on the exchange, not open for trading yet">upcoming</span>' : ' · <span class="tag warn" title="Not open for trading; the mark is the last one the contract holds">closed · last mark</span>')
      : idle() ? ` · <span class="tag" title="Open for trading, but no trades ${w === 'all' ? 'yet' : `in ${w}`} and no open positions">inactive</span>` : '';
    const mark = row.mark ?? row.close;
    morph($('subtitle'), keepDots(`Mark <b class="num" style="color:var(--text)">${price(mark, dpOf(mark))}</b> · ${num(row.change_pct) === null ? '' : `${pctCell(row.change_pct)} ${wl()} · `}max leverage ${lev ? `${lev}x` : DASH}${tag}`));
  }

  let levels = null; // liquidation bands from contract state, drawn on the candles
  // The sides of the bands candles() draws, by its filter: within the span of the mark,
  // at least 5% of the largest band, each coloured by the side with more notional.
  const LEVEL_SPAN = 0.04;
  const levelSides = lv => {
    const mark = num(lv?.mark), near = mark ? (lv.levels ?? []).filter(l => Math.abs((l.lo + l.hi) / 2 / mark - 1) <= LEVEL_SPAN).map(l => [num(l.long) ?? 0, num(l.short) ?? 0]) : [];
    const peak = Math.max(1, ...near.map(([a, b]) => a + b));
    return new Set(near.filter(([a, b]) => a + b >= peak * 0.05).map(([a, b]) => (a >= b ? 'long' : 'short')));
  };
  async function load({ fresh = false }, mine) {
    const at = w, age = ms => ({ maxAge: fresh ? 0 : ms });
    const [p, s, lv, all] = await Promise.all([get(`protocol?window=${at}`, age(1500)), get(`protocol/series?window=${at}&market=${id}`, age(1500)), get(`markets/${id}/liq-levels`, age(10000)).catch(() => null), get('protocol?window=all', { maxAge: 60000 }).catch(() => null)]);
    if (!mine()) return;
    const ever = all?.markets.find(m => m.id === id);
    everTraded = ever ? num(ever.fills) > 0 : null;
    levels = lv;
    row = p.markets.find(m => m.id === id) ?? null;
    if (!row) { el.querySelector('.stack').innerHTML = empty('Market not found'); return; }
    morph($('title'), `<span class="mkt" style="gap:10px">${logo(id, row.symbol, 24)}${esc(row.symbol)}<span class="muted" style="font-size:14px;font-weight:400;margin-left:2px">${esc(row.name && row.name !== row.symbol ? row.name : 'Perpetual')}</span></span>`);
    renderSubtitle();
    // A market with nothing in the window has no stats row: no liquidations and no taker trades, not unknowns.
    const liqs = row.liquidations ?? 0;
    morph($('kpis'), [
      kpi({ label: `Volume · ${wl()}`, value: usd(row.volume), note: num(row.volume) ? `${share(row.share_pct)} of exchange` : 'no trades' }),
      kpi({ label: 'Open interest', value: usd(row.open_interest), note: row.oi_cap_pct !== undefined && row.oi_cap_pct !== null ? `${share(row.oi_cap_pct)} of cap` : '' }),
      kpi({ label: 'Funding 8h', tip: `${fundingTip(row.funding?.interval_seconds)} Positive means longs pay shorts.`, value: row.funding ? fundingCell(row.funding, { apr: false }) : DASH, note: closed() ? 'not open for trading' : !row.funding ? '' : num(row.funding.rate_8h_pct) === 0 ? 'no payments this interval' : `${pct(row.funding.apr_pct, { digits: 1, sign: true })} APR · ${row.funding.rate_8h_pct > 0 ? 'longs pay' : 'shorts pay'}` }),
      kpi({ label: 'Traders', value: int(row.traders), note: `${int(row.fills)} trades` }),
      kpi({ label: 'Taker buy share', value: share(row.taker_buy_share_pct), note: num(row.taker_buy_share_pct) === null ? 'no trades' : `${amount(row.taker_buy)} bought · ${amount(row.taker_sell)} sold` }),
      kpi({ label: 'Liquidated', value: usd(row.liquidated ?? 0), note: `${int(liqs)} ${liqs === 1 ? 'liquidation' : 'liquidations'}` })
    ].join(''));
    const pts = s.points.filter(x => x.close !== null);
    // No volume in the window (an inactive market carries its last close): say so instead of a flat line.
    const traded = pts.length > 0 && s.points.some(x => num(x.volume) > 0);
    const mark = row.mark ?? row.close, dp = dpFrom(mark);
    headValue('candles', price(mark, dp), closed() ? 'last mark · not open for trading' : [num(row.change_pct) === null ? '' : `${pctCell(row.change_pct)} ${wl()}`, row.low ? `range ${price(row.low, dp)} – ${price(row.high, dp)}` : '', traded ? `${esc(s.meta.bucket)} candles, UTC` : ''].filter(Boolean).join(' · '));
    // Liquidation levels need candles to sit on and open positions to come from;
    // the switch stays hidden until then, so a closed market never shows it.
    const withLevels = traded && !closed();
    // The legend names only the sides drawn.
    const sides = withLevels && showLevels && levels ? levelSides(levels) : null;
    legendOf('candles', !sides ? [] : sides.size ? [sides.has('long') && { name: 'Long liq. levels', color: COLORS.long }, sides.has('short') && { name: 'Short liq. levels', color: COLORS.short }].filter(Boolean) : [{ name: `No liquidation levels within ${LEVEL_SPAN * 100}%` }]);
    $('lvl-toggle').hidden = !withLevels;
    // Redrawn in place on a refresh, so a zoom holds; a new window drops it (update).
    const node = $('candles');
    if (!traded) node.innerHTML = none('No trades in this window');
    else {
      // The chart spans the trading: buckets before the first trade have no price, and
      // a closed market's after its last trade would draw its last close as flat candles.
      const first = s.points.findIndex(x => x.close !== null), last = closed() ? s.points.findLastIndex(x => num(x.volume) > 0) : s.points.length - 1;
      const span = s.points.slice(first, last + 1);
      let prev = null;
      const ohlc = span.map(x => { const c = num(x.close), o = num(x.open) ?? prev ?? c, h = num(x.high) ?? Math.max(o, c), l = num(x.low) ?? Math.min(o, c); prev = c; return c === null ? '-' : [o, c, l, h]; });
      candles(node, { times: s.times.slice(first, last + 1), ohlc, volume: span.map(x => num(x.volume)), bucketSeconds: s.meta.bucket_seconds, priceFmt: v => price(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), volColor: colorOf(id) + '99', zoom: true,
        levels: showLevels ? levels?.levels ?? null : null, mark: num(levels?.mark), levelSpan: LEVEL_SPAN, onLevel: l => { const t = l.top; if (t) go(`/wallet/${t.address || t.account_id}`); } });
    }
  }
  // Exact flows from position events: what other dashboards infer from price and open interest.
  async function loadFlow({ fresh = false }, mine) {
    const f = await get(`markets/${id}/flow?window=${w}`, { maxAge: fresh ? 0 : 5000 });
    if (!mine()) return;
    const t = f.totals, node = $('flow'); // redrawn in place, like the candles
    const longOpen = num(t.long_open), longClose = num(t.long_close);
    // The head is the long side's change, which equals the short side's, so the note
    // sets out the long side it comes from; the short side is in the notes and the chart.
    // Written out in whole dollars (cents for a small change), or $3.1M and $3.2M would not add up to it.
    const net = longOpen - longClose, full = v => usdFull(v, Math.abs(net) < 100 ? 2 : 0);
    headValue('flow', usd(net, { sign: true }), `<span title="${esc(`Shorts opened ${usdFull(t.short_open)}`)}">Longs: ${full(longOpen)} opened</span> · <span title="${esc(`Shorts closed ${usdFull(t.short_close)}`)}">${full(longClose)} closed</span> · ${wl()}`);
    const moved = f.times.length && longOpen + num(t.short_open) + longClose + num(t.short_close);
    legendOf('flow', moved ? [{ name: 'Longs opened', color: COLORS.long }, { name: 'Longs closed', color: `${COLORS.long}80` }, { name: 'Shorts opened', color: COLORS.short }, { name: 'Shorts closed', color: `${COLORS.short}80` }, { name: 'Open interest change', color: '#ffffff' }] : []);
    if (!moved) { node.innerHTML = none('No position changes in this window'); return; }
    flowBars(node, { times: f.times, firstPartial: cutsFirst(f), longOpen: f.long_open, longClose: f.long_close, shortOpen: f.short_open, shortClose: f.short_close, bucketSeconds: f.meta.bucket_seconds });
  }
  // Where the open positions were entered, from contract state.
  async function loadEntries({ fresh = false }, mine) {
    const e = await get(`markets/${id}/entries`, { maxAge: fresh ? 0 : 10000 });
    if (!mine()) return;
    const node = $('entries'); // redrawn in place on each refresh, like the ladder
    const L = e.long, S = e.short, dp = dpFrom(e.mark);
    if (!e.positions) { headValue('entries', ''); legendOf('entries', []); node.innerHTML = none('No open positions'); return; }
    headValue('entries', `${pct((L.in_profit + S.in_profit) / e.positions * 100, { digits: 0 })}${unit('in profit')}`, `${int(L.in_profit + S.in_profit)} of ${int(e.positions)} positions · longs ${pct(L.in_profit_pct, { digits: 0 })}, shorts ${pct(S.in_profit_pct, { digits: 0 })}`);
    legendOf('entries', [{ name: `Longs · avg ${price(L.average_entry, dp)}`, color: COLORS.long }, { name: `Shorts · avg ${price(S.average_entry, dp)}`, color: COLORS.short }]);
    entryProfile(node, { bins: e.bins, mark: num(e.mark), priceFmt: v => price(v, dp) });
  }
  async function loadRisk({ fresh = false }, mine) {
    const r = await get(`markets/${id}`, { maxAge: fresh ? 0 : 3000 });
    if (!mine()) return;
    risk = r.market;
    const L = risk.long, S = risk.short;
    dpFrom(risk.prices?.mark);
    // With no positions there is no split to draw, and a zero count stays neutral.
    morph($('positioning'), `
      ${L.count + S.count ? `<div class="panel-body m-split"><div class="m-split-label">Positions by count</div>${ratio(L.count, S.count)}</div>` : ''}
      <div class="stat-grid">
        ${stat('Long positions', int(L.count), { cls: L.count ? 'pos' : '' })}${stat('Short positions', int(S.count), { cls: S.count ? 'neg' : '' })}
        ${stat('Long notional', amount(L.notional))}${stat('Short notional', amount(S.notional))}
        ${stat('Long avg leverage', L.average_leverage ? `${L.average_leverage.toFixed(1)}x` : DASH)}${stat('Short avg leverage', S.average_leverage ? `${S.average_leverage.toFixed(1)}x` : DASH)}
        ${stat('Long unrealized', pnlShort(num(L.delta_pnl) + num(L.premium_pnl)))}${stat('Short unrealized', pnlShort(num(S.delta_pnl) + num(S.premium_pnl)))}
        ${stat('Liquidatable now', int(risk.positions.liquidatable), { tip: 'Positions at or under maintenance margin with equity left, at this block' })}${stat('Insurance fund', amount(risk.insurance.balance))}
        ${stat('Largest position', amount(risk.concentration?.largest?.notional))}${stat('Top 5 share', share(risk.concentration?.top5_pct), { tip: 'Share of open notional held by the five largest positions' })}
      </div>${costTable(risk.liquidity)}`);
    renderSubtitle(); // the max leverage, for a market the window's row does not carry it for
    renderPositions(risk.top_positions ?? []);
    renderCalc();
    const ladder = risk.ladder ?? [];
    const lnode = $('ladder'); // redrawn in place on each refresh: the bars move rather than regrow
    const r10 = risk.risk ?? {}, open = ladder.length && (L.count + S.count) > 0;
    headValue('ladder', open ? `${usd(r10.notional_at_10pct)}${unit('on a 10% move')}` : '', open ? `longs ${amount(r10.long_notional_at_10pct)} if the price falls · shorts ${amount(r10.short_notional_at_10pct)} if it rises` : '');
    legendOf('ladder', open ? [{ name: 'Longs (price down)', color: COLORS.long }, { name: 'Shorts (price up)', color: COLORS.short }] : []);
    if (!open) { lnode.innerHTML = none('No open positions'); return; }
    mirrored(lnode, { labels: ladder.map(x => `${x.shock_pct}%`), long: ladder.map(x => num(x.long.notional)), short: ladder.map(x => num(x.short.notional)), legend: false }); // the dot legend in the head names the sides
  }
  // The largest open positions by notional; each row opens the wallet.
  function renderPositions(rows) {
    const shown = rows.slice(0, 15);
    text('pos-meta', rows.length ? `Top ${shown.length} by notional` : '');
    paint($('positions'), table({ id: 'pos', compact: true, emptyText: closed() ? CLOSED : 'No open positions', columns: [
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account_id) },
      { key: 's', label: 'Side', render: r => sideTag(r.side) },
      { key: 'n', label: 'Notional', n: true, render: r => amount(r.notional) },
      { key: 'e', label: 'Entry', phone: false, n: true, render: r => price(r.entry_price, decimals) },
      { key: 'l', label: 'Leverage', phone: false, n: true, render: r => (r.leverage ? `${Number(r.leverage).toFixed(1)}x` : DASH) },
      { key: 'u', label: 'Unrealized', phone: false, n: true, render: r => pnlShort(r.pnl) },
      { key: 'q', label: 'Liq. price', phone: false, n: true, render: r => (num(r.liquidation_price) > 0 ? price(r.liquidation_price, decimals) : '<span class="faint" title="No liquidation price: the margin covers any price move">none</span>') },
      { key: 'd', label: 'Liq. distance', tip: 'Mark price move that reaches the liquidation price. Amber under 15%, red under 5%.', n: true, render: r => (r.liquidation_distance_pct === null || !(num(r.liquidation_price) > 0) ? DASH : `<span class="${r.liquidation_distance_pct < 5 ? 'neg' : r.liquidation_distance_pct < 15 ? 'warn-text' : 'muted'}">${pct(r.liquidation_distance_pct, { digits: 1 })}</span>`) }
    ], rows: shown, rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account_id)}"` }));
  }
  // Order book: asks above, bids below, each level with its cumulative depth
  // from the touch; the bar width is that depth against the deeper side. Each side
  // keeps room for every level, so the mid line stays put as levels come and go.
  async function loadBook({ fresh = false }, mine) {
    const node = $('book');
    // A delisted market has no book to read.
    if (closed()) { node.innerHTML = empty(CLOSED); text('book-meta', ''); return; }
    const b = await get(`markets/${id}/book`, { maxAge: fresh ? 0 : 10000 }).catch(error => { if (error.status === 404) return { missing: true }; throw error; });
    if (!mine()) return;
    if (b.missing || (!b.bids?.length && !b.asks?.length)) { node.innerHTML = empty(b.missing ? 'No order book for this market' : 'No resting orders'); text('book-meta', ''); return; }
    // A level whose orders have all expired has no live size left: it is not shown.
    const cum = side => { let run = 0; return side.filter(l => num(l.size) > 0).slice(0, BOOK_LEVELS).map(l => ({ ...l, cum: (run += num(l.notional) || 0) })); };
    const asks = cum(b.asks), bids = cum(b.bids);
    if (!asks.length && !bids.length) { node.innerHTML = empty('No resting orders'); text('book-meta', ''); return; }
    const max = Math.max(asks.at(-1)?.cum ?? 0, bids.at(-1)?.cum ?? 0) || 1;
    const dp = dpFrom(asks[0]?.price ?? bids[0]?.price);
    const line = (l, side) => `<div class="book-row ${side}"><i style="width:${(l.cum / max * 100).toFixed(1)}%"></i><span class="num">${price(l.price, dp)}</span><span class="num">${size(l.size)}</span><span class="num muted">${amount(l.cum)}</span></div>`;
    const L = b.liquidity ?? {};
    const spread = L.spread_bps === null || L.spread_bps === undefined ? '—' : `${L.spread_bps.toFixed(L.spread_bps < 1 ? 2 : 1)} bps`;
    // The book's own midpoint; the mark follows the oracle and can sit outside the touch.
    const bestBid = num(bids[0]?.price ?? L.best_bid), bestAsk = num(asks[0]?.price ?? L.best_ask);
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
    // A one-tick spread puts the mid between two ticks: one more decimal, so it never prints as the ask or the bid.
    const places = dp ?? (price(bestAsk).split('.')[1] ?? '').length;
    const midText = mid && [bestBid, bestAsk].map(v => price(v, dp)).includes(price(mid, dp)) ? mid.toLocaleString('en-US', { minimumFractionDigits: places + 1, maximumFractionDigits: places + 1 }) : price(mid, dp);
    morph(node, `<div class="book"><div class="book-row head"><span>Price</span><span>Size (${esc(b.symbol)})</span><span>Total ($)</span></div>
      <div class="book-side ask">${asks.slice().reverse().map(l => line(l, 'ask')).join('')}</div>
      <div class="book-mid"><span class="num">${mid ? midText : price(b.mark, dp)}</span><span class="faint">${mid ? 'mid' : 'mark'} · spread ${spread}${mid ? ` · mark ${price(b.mark, dp)}` : ''}</span></div>
      <div class="book-side bid">${bids.map(l => line(l, 'bid')).join('')}</div></div>`);
    text('book-meta', b.stale ? 'stale read' : L.age_blocks !== null && L.age_blocks !== undefined ? `read ${int(L.age_blocks)} blocks ago` : '');
  }

  // Position calculator. Perpl liquidates a position when its equity falls to
  // the maintenance margin of its notional at the mark; with the deposit at
  // entry notional / leverage and no fees or funding, that price is
  //   long:  E·(1 − 1/L) / (1 − m)      short: E·(1 + 1/L) / (1 + m)
  // The inputs are written once and when the figures behind them change, so a
  // refresh never takes a field from someone typing in it.
  function renderCalc({ inputs = false } = {}) {
    const node = $('calc'); if (!node || !risk) return;
    if (closed()) { node.innerHTML = empty(CLOSED); return; }
    const m = (risk.margin?.maintenance_margin_pct ?? 0) / 100, maxLev = risk.margin?.max_leverage ?? 1;
    const markText = risk.prices?.mark ?? row?.mark ?? row?.close, mark = num(markText);
    if (!mark) { node.innerHTML = empty('No price for this market'); return; }
    const dp = dpFrom(markText);
    if (calc.entry === null) calc.entry = mark;
    // The default exit, 5% from the mark, keeps the mark's own decimals.
    const places = dp ?? (String(+mark.toPrecision(8)).split('.')[1] ?? '').length;
    if (calc.exit === null) calc.exit = +(mark * (calc.side === 'long' ? 1.05 : 0.95)).toFixed(places);
    calc.lev = Math.min(Math.max(1, calc.lev), maxLev);
    const E = calc.entry, L = calc.lev, qty = calc.usd / E, margin = calc.usd / L, long = calc.side === 'long';
    const liq = long ? E * (1 - 1 / L) / (1 - m) : E * (1 + 1 / L) / (1 + m);
    const dist = (long ? (mark - liq) / mark : (liq - mark) / mark) * 100;
    const pnlAtExit = (long ? calc.exit - E : E - calc.exit) * qty;
    const field = (k, label) => `<label class="calc-f"><span>${label}</span><input class="calc-in num" data-k="${k}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"></label>`;
    if (!node.querySelector('.calc')) {
      inputs = true;
      node.innerHTML = `<div class="calc">
        <div class="calc-top"></div>
        <div class="calc-grid">
          ${field('usd', 'Notional (USD)')}
          ${field('lev', `Leverage (1–${maxLev}x)`)}
          ${field('entry', 'Entry price')}
          ${field('exit', 'Exit price')}
        </div>
        <div class="stat-grid calc-out"></div>
        <div class="faint calc-note">An estimate before fees and funding. Live positions carry their own deposit, so their liquidation prices (above) differ slightly.</div></div>`;
    }
    if (inputs) for (const [k, v] of Object.entries({ usd: calc.usd, lev: calc.lev, entry: +E.toPrecision(8), exit: +calc.exit.toPrecision(8) })) node.querySelector(`[data-k="${k}"]`).value = inputNum(v);
    morph(node.querySelector('.calc-top'), `<div class="seg sm" role="group"><button data-action="calc-side" data-v="long" class="${long ? 'on' : ''}" aria-pressed="${long}">Long</button><button data-action="calc-side" data-v="short" class="${long ? '' : 'on'}" aria-pressed="${!long}">Short</button></div>
      <span class="faint">Max ${maxLev}x · maintenance margin ${pct(m * 100, { digits: 2 })}</span>`);
    morph(node.querySelector('.calc-out'), `
      ${stat('Margin', usd(margin))}
      ${stat('Quantity', size(qty))}
      ${stat('Liquidation price', liq > 0 ? price(liq, dp) : DASH, { cls: dist < 5 ? 'neg' : dist < 15 ? 'warn-text' : '' })}
      ${stat('From mark', liq > 0 ? `${pct(dist, { digits: 1 })} ${long ? 'down' : 'up'}` : DASH)}
      ${stat('PnL at exit', pnl(pnlAtExit))}
      ${stat('Return on margin', pct(pnlAtExit / margin * 100, { digits: 1, sign: true }), { cls: signClass(pnlAtExit / margin * 100, 1) })}`);
  }
  // Text inputs, not type="number": a number input writes the browser's locale
  // (83154,6 under tr-TR) where the page writes 83,154.6.
  const inputNum = v => v.toLocaleString('en-US', { maximumFractionDigits: 8 });
  // "83,154.6" and "1,000" read as en-US; a lone decimal comma ("75,28") as a decimal point.
  const parseNum = s => { const t = String(s).replace(/\s/g, ''); return t ? Number(/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.')) : NaN; };
  // The view container outlives this page: the listener is removed in destroy().
  const onCalcChange = e => {
    const k = e.target.closest?.('.calc-in')?.dataset.k; if (!k) return;
    const v = parseNum(e.target.value);
    if (Number.isFinite(v) && v > 0) calc[k] = v;
    renderCalc({ inputs: true }); // an unreadable entry falls back to the last value
  };
  el.addEventListener('change', onCalcChange);

  // What a market order costs against the on-chain book, from the mid.
  function costTable(L) {
    const rows = L?.cost_to_trade ?? [];
    if (!rows.length || !(L.best_bid || L.best_ask)) return ''; // an empty book has no cost to show
    const fmt = v => `${v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) < 1 ? 2 : 1)} bps`;
    const bps = (v, filled) => (v === null ? `<span class="faint" title="More than the order book shows: ${usdShort(filled)} on this side">&gt; book</span>` : fmt(v));
    return `<div class="panel-head m-subhead"><h2>Cost of a market order</h2><span class="meta">vs mid · spread ${L.spread_bps === null || L.spread_bps === undefined ? '—' : fmt(L.spread_bps)}</span></div>
      ${table({ id: 'cost', compact: true, columns: [
        { key: 's', label: 'Notional', render: r => `$${r.usd >= 1000 ? `${r.usd / 1000}K` : r.usd}` },
        { key: 'b', label: 'Buy', n: true, render: r => bps(r.buy_bps, r.buy_filled_usd) },
        { key: 'x', label: 'Sell', n: true, render: r => bps(r.sell_bps, r.sell_filled_usd) }
      ], rows })}`;
  }
  async function loadFunding({ fresh = false }, mine) {
    const f = await get(`markets/${id}/funding?limit=500`, { maxAge: fresh ? 0 : 30000 });
    if (!mine()) return;
    // Last seven days of funding events (one per interval), signed.
    const cutoff = Date.now() / 1000 - 7 * 86400;
    const rows = (f.history ?? []).filter(r => r.ts >= cutoff).slice().reverse();
    const node = $('funding');
    // The figure reads like the Funding 8h figure (scaled to 8 hours); the bars and the note
    // keep the rate the contract applies per interval, and the tooltip gives both (8h at today's interval).
    const c = f.current, per8h = c?.interval_seconds ? 28800 / c.interval_seconds : null;
    const rate = v => pct(v, { digits: 4, sign: true });
    const every = `${c?.interval_blocks ? `${int(c.interval_blocks)}-block ` : ''}interval${c?.interval_seconds ? ` (${duration(c.interval_seconds)})` : ''}`;
    if (!c) headValue('funding', '');
    else headValue('funding', `${fundingCell({ rate_8h_pct: c.rate_8h_pct }, { apr: false })}${num(c.rate_8h_pct) ? unit('per 8h') : ''}`, closed() ? 'not open for trading' : `${num(c.rate_per_interval_pct) === 0 ? '0%' : rate(c.rate_per_interval_pct)} per ${every} · next in ${duration(c.seconds_to_next)}`);
    const paid = rows.some(r => num(r.rate_pct));
    legendOf('funding', paid ? [{ name: 'Longs pay', color: COLORS.long }, { name: 'Shorts pay', color: COLORS.short }] : []);
    if (rows.length && !paid) node.innerHTML = none('Funding stayed at 0% over the last 7 days');
    else if (rows.length) signedBars(node, { times: rows.map(r => r.ts), values: rows.map(r => r.rate_pct), bucketSeconds: 3600, dayTicks: true, name: 'Per interval', fmt: v => (per8h ? `${rate(v)} · ${rate(v * per8h)} per 8h` : rate(v)), yFmt: v => `${Number(v).toFixed(3)}%` });
    else node.innerHTML = none('No funding events in the last 7 days');
  }
  async function loadTrades({ fresh = false }, mine) {
    const t = await get(`trades?market=${id}&limit=60`, { maxAge: fresh ? 0 : 1000 });
    if (!mine()) return;
    renderTrades(t.rows);
  }
  async function loadLeaders({ fresh = false }, mine) {
    const lb = await get(`leaderboard?window=${w}&market=${id}&limit=10`, fresh ? { maxAge: 0 } : undefined);
    if (!mine()) return;
    text('lb-meta', `By net PnL · ${wl()}`);
    paint($('lb'), table({ id: 'lb', compact: true, emptyText: closed() ? CLOSED : `No trades ${w === 'all' ? 'yet' : `in ${w}`}`, columns: [
      { key: 'r', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account) },
      { key: 'p', label: 'Net PnL', n: true, render: r => pnlShort(r.pnl) },
      { key: 'v', label: 'Volume', n: true, render: r => amount(r.volume) }
    ], rows: lb.rows, rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"` }));
  }
  let tape = null; // null until the first load: a push alone must not replace the skeleton with one row
  function renderTrades(rows) {
    tape = rows;
    text('trades-meta', rows.length ? `Taker side · ${int(Math.min(rows.length, 60))} shown` : 'Taker side');
    paint($('trades'), table({ id: 't', compact: true, emptyText: closed() ? CLOSED : 'No recent trades', columns: [
      { key: 't', label: 'Time (UTC)', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 's', label: 'Action', render: tradeAction },
      { key: 'p', label: 'Price', phone: false, n: true, render: r => price(r.price, dpOf(r.price)) },
      { key: 'v', label: 'Notional', n: true, render: r => amount(r.notional) },
      { key: 'a', label: 'Trader', phone: false, render: r => addr(r.address, r.account, { star: false }) }
    ], rows: tape.slice(0, 60), rowAttrs: r => `class="${r.fresh ? 'flash' : ''}"` }));
  }
  const off = stream.on('trades', rows => { const mine = rows.filter(r => r.market === id); if (!mine.length || !tape) return; tape = [...mine.reverse().map(r => ({ ...r, fresh: true })), ...tape].slice(0, 60); renderTrades(tape); tape.forEach(r => { r.fresh = false; }); });

  // Each panel loads until it works. A press holds its regions; the newest load owns the
  // panel, so a slow answer never lands over a newer one. A failed refresh leaves what is
  // still right on screen; a panel with nothing, or with another window's figures, says so
  // with a Retry. tied: its figures follow the window.
  const failed = (message, ...keys) => retry => keys.forEach(key => panelError($(key), message, retry));
  const panels = {
    main: { load, tied: true, regions: ['kpis', 'candles', 'candles-v'], fail: retry => { morph($('candles-v'), ''); legendOf('candles', []); failed('Market data unavailable', 'kpis')(retry); failed('Price history unavailable', 'candles')(retry); } },
    flow: { load: loadFlow, tied: true, regions: ['flow', 'flow-v'], fail: retry => { morph($('flow-v'), ''); legendOf('flow', []); failed('Position flow unavailable', 'flow')(retry); } },
    entries: { load: loadEntries, fail: failed('Entry prices unavailable', 'entries') },
    risk: { load: loadRisk, fail: retry => { failed('Live positions unavailable', 'positioning', 'positions')(retry); failed('Liquidation ladder unavailable', 'ladder')(retry); failed('Calculator unavailable', 'calc')(retry); } },
    book: { load: loadBook, fail: failed('Order book unavailable', 'book') },
    funding: { load: loadFunding, fail: failed('Funding history unavailable', 'funding') },
    trades: { load: loadTrades, fail: failed('Recent trades unavailable', 'trades') },
    lb: { load: loadLeaders, tied: true, regions: ['lb'], fail: failed('Top traders unavailable', 'lb') }
  };
  const release = p => { p.held?.forEach(done => done()); p.held = null; };
  function start(key, opts = {}) {
    const p = panels[key];
    if (opts.poll && p.busy) return;
    const run = p.run = (p.run ?? 0) + 1, at = p.tied ? w : 'live', mine = () => alive && run === p.run;
    p.busy = true;
    keepTrying(async () => { await p.load(opts, mine); if (!mine()) return; p.busy = false; p.shown = at; release(p); }, { alive: mine, fail: () => { release(p); if (p.shown !== at) p.fail(() => start(key)); } });
  }
  const press = key => { const p = panels[key]; p.held ??= p.regions.map(id => hold($(id))); start(key); };
  const stopFit = fitRows($('trades'), { headH: 34, rowH: 38 });
  let timer = null;
  start('main');
  // The panels and the refresh wait for the market row (the same request as load's,
  // shared), so an inactive market says so in each of them; an unknown market loads none.
  const known = get(`protocol?window=${w}`).then(p => { row = p.markets.find(m => m.id === id) ?? null; dpFrom(row?.mark ?? row?.close); return Boolean(row); }, () => true);
  known.then(found => {
    if (!found || !alive) return;
    ['flow', 'entries', 'risk', 'book', 'funding', 'trades', 'lb'].forEach(key => start(key));
    timer = setInterval(() => { ['risk', 'book', 'entries'].forEach(key => start(key, { poll: true })); if (w === '24h') { start('main', { poll: true }); start('flow', { poll: true }); } }, 20000);
  });
  return {
    onSeg(name, v) {
      if (name === 'lvl') { showLevels = v === 'on'; morph($('lvl-toggle'), segSm('lvl', LEVEL_TOGGLE, v)); start('main'); return; }
      if (name === 'window' && v !== w) setQuery({ window: v === '24h' ? null : v });
    },
    onAction(a, t) { if (a === 'calc-side') { calc.side = t.dataset.v; calc.exit = null; renderCalc({ inputs: true }); } },
    update(q) {
      const next = windowOf(q);
      if (next === w) return;
      w = next;
      morph($('win'), seg('window', WINDOWS, w));
      dropZoom($('candles')); dropZoom($('flow'));
      press('main');
      known.then(found => { if (found && alive) { press('flow'); press('lb'); } });
    },
    refresh() { known.then(found => { if (found && alive) Object.keys(panels).forEach(key => start(key, { fresh: true })); }); },
    destroy() { alive = false; el.removeEventListener('change', onCalcChange); off(); clearInterval(timer); stopFit(); }
  };
}
export { dateTime, sideTag };
