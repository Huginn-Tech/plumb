// Risk: what live positions would do under a price move. Liquidation ladder,
// shortfall against insurance, order-book cover and an interactive stress
// test, all from contract state at the collector's latest finalized block.
import { get } from '../api.js';
import { usd, usdShort, usdFull, int, price, dpOf, pct, share, num, esc, multiple } from '../format.js';
import { kpi, table, mktLink, sideTag, addr, pnlShort, skRows, skBox, skKpis, skChart, empty, logo, hold, morph, panelError, keepTrying, keepDots, toast, DASH } from '../ui.js';
import { mirrored, COLORS } from '../charts.js';

// Depth read up to the walk's level cap is a lower bound; a no-break space
// keeps the sign with its figure when a note wraps.
const atLeast = complete => (complete === false ? '≥ ' : '');
// Insurance against shortfall, and book depth against what a move would
// liquidate (book cover), read as multiples, rounded down so a cover short of
// what it faces never reads as 1×. The share actually absorbed (at most 100 %)
// stays a percentage.
const times = v => { const n = num(v); return n === null ? DASH : n >= 10000 ? `${int(Math.floor(n / 100))}×` : n >= 1000 ? `${(Math.floor(n / 10) / 10).toFixed(1)}×` : `${(Math.floor(n) / 100).toFixed(2)}×`; };
const cover = (v, complete) => (num(v) === null ? DASH : `<span title="Order-book depth is ${complete === false ? 'at least ' : ''}${times(v)} what this move would liquidate">${atLeast(complete) + times(v)}</span>`);
const signed = v => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v)}%`;
// A table or note amount, with the exact figure in its hover note.
const amount = v => (num(v) === null ? DASH : `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`);
// A move hits one side, and the two sides are equal, so the base is half of position
// notional (longs plus shorts): a share of the side the move would liquidate.
const sideOf = d => (d === 'rise' ? 'shorts' : 'longs');
const riskNote = (v, all, d) => (num(all) > 0 ? `${share(num(v) / (num(all) / 2) * 100)} of ${sideOf(d)} · if all markets ${esc(d)}` : 'no open positions');
const riskTip = n => `Notional a ${n}% move in every market would liquidate, in the worse direction. A static shock, not a forecast.`;
// The ladder's sides, named in the card head as on the market page.
const LADDER_KEY = [['Longs (price down)', COLORS.long], ['Shorts (price up)', COLORS.short]].map(([name, color]) => `<span><i style="background:${color}"></i>${name}</span>`).join('');
// Rows in the first paint: markets with open positions on a normal day, the hits shown.
const MARKET_ROWS = 11, HIT_ROWS = 8;

// The move in the address, 0 included (a plain || would turn 0 into the default).
const moveOf = (q, fallback) => { const v = q.get('move'); return v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.max(-50, Math.min(50, Math.round(Number(v)))) : fallback; };

export function mount(el, { query, setQuery, keepQuery }) {
  let alive = true, overview = null;
  const asked = Number(query.get('market')) || null;
  let marketId = asked, move = moveOf(query, -10);
  el.innerHTML = `
    <div class="page-head"><div><h1>Risk</h1><div class="sub">Liquidation exposure of every open position, from contract state read about every second and order books every 30 s.</div></div><span class="meta faint rk-block" id="block"></span></div>
    <div class="stack">
      <div class="kpis rk-kpis" id="kpis">${skKpis(6, { lines: 2 })}</div>
      <div class="grid g-main">
        <section class="panel rk-stress"><div class="panel-head"><h2>Stress test</h2><div id="mkt" class="mpick"></div></div>
          <div class="panel-body rk-controls"><div class="rk-range"><span class="faint num">-50%</span><input id="move" class="range" type="range" min="-50" max="50" step="1" value="${move}" aria-label="Price move"><span class="faint num">+50%</span></div>
          <div class="rk-move muted" id="move-line"></div></div>
          <div id="stress">${skBox(168, 336)}</div>
          <div class="panel-foot risk-foot"><span>A static price shock: positions whose liquidation price lies inside the move. Real liquidations depend on the path, the book and keepers.</span></div></section>
        <section class="panel rk-ladder"><div class="panel-head"><div><h2>Liquidation ladder</h2><div class="desc" id="ladder-meta"></div></div><div class="legend dots" id="ladder-lg"></div></div><div class="panel-body"><div class="chart" id="ladder">${skChart()}</div></div></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Largest positions exposed</h2><span class="meta" id="hit-meta"></span></div><div class="panel-body flush" id="hit">${skRows(HIT_ROWS, 38)}</div></section>
      <section class="panel"><div class="panel-head"><h2>By market</h2><span class="meta">Each market’s worse direction, longs in a fall or shorts in a rise, so rows can add to more than the cards above; shortfall is equity below zero at that price</span></div><div class="panel-body flush" id="table">${skRows(MARKET_ROWS, 52, 34, 44)}</div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);
  const retry = () => load({ fresh: true });

  // The line under the slider. Until the answer lands the target comes from the mark;
  // the price waits as a blank bar on first load, and is left out when nothing is known.
  let noMark = false;
  function drawMove(exact = null) {
    const mark = overview?.markets.find(m => m.id === marketId)?.prices?.mark ?? null, dp = dpOf(mark), to = exact ?? (mark === null ? null : num(mark) * (1 + move / 100));
    const figure = to === null ? (noMark ? '' : '<span class="skeleton sk-in rk-price"></span>') : `<b class="num">${price(to, dp)}</b>`;
    morph($('move-line'), move === 0 ? `Mark stays${figure ? ` at ${figure}` : ''}` : `Mark moves <b class="num">${signed(move)}</b>${figure ? ` to ${figure}` : ''}`);
  }

  let loadSeq = 0;
  async function load({ fresh = false } = {}) {
    const seq = ++loadSeq;
    const answer = await get('overview', { maxAge: fresh ? 0 : 3000 });
    if (!alive || seq !== loadSeq) return; // a newer read owns the page
    overview = answer;
    const t = overview.totals;
    // Every section below is drawn from this block and the same order-book read.
    const books = overview.markets.map(m => Number(m.liquidity?.book_block ?? 0)).filter(Boolean);
    morph($('block'), keepDots(`Contract state at block ${int(overview.snapshot.block)}${books.length ? ` · order books read at ${int(Math.max(...books))}` : ''}`));
    const dir5 = num(t.moves?.rise_5pct?.notional) > num(t.moves?.fall_5pct?.notional) ? 'rise' : 'fall';
    morph($('kpis'), [
      // Labels stay short enough for one line beside the tip on a phone.
      kpi({ label: 'Position notional', value: usd(t.total_notional), note: `${int(t.positions)} positions`, tip: 'All open positions valued at the mark price, longs plus shorts (open interest counts one side).' }),
      kpi({ label: 'At risk, 5% move', value: usd(t.notional_at_5pct), note: riskNote(t.notional_at_5pct, t.total_notional, dir5), tip: riskTip(5) }),
      kpi({ label: 'At risk, 10% move', value: usd(t.notional_at_10pct), note: riskNote(t.notional_at_10pct, t.total_notional, t.direction_at_10pct), tip: riskTip(10) }),
      kpi({ label: 'Shortfall, 10%', value: `<span class="${num(t.shortfall_at_10pct) > 0 ? 'neg' : ''}">${usd(t.shortfall_at_10pct)}</span>`, note: num(t.shortfall_at_10pct) > 0 && t.shortfall_direction_at_10pct ? `potential bad debt · if all markets ${esc(t.shortfall_direction_at_10pct)}` : 'potential bad debt · worse direction', tip: 'Equity below zero if all markets fell or rose 10%, whichever is worse, before any liquidation.' }),
      kpi({ label: 'Insurance funds', value: usd(t.insurance_total), note: t.insurance_coverage_at_10pct !== null && t.insurance_coverage_at_10pct !== undefined ? `${multiple(t.insurance_coverage_at_10pct)} of that shortfall covered` : 'no shortfall at 10%', tip: 'Sum of all market insurance funds. Each fund covers only its own market’s shortfall, so the share covered caps at 100%.' }),
      kpi({ label: 'Book absorbs, 10%', value: t.liquidity?.absorbed_at_10pct_pct !== null && t.liquidity?.absorbed_at_10pct_pct !== undefined ? atLeast(t.liquidity.complete) + multiple(t.liquidity.absorbed_at_10pct_pct) : DASH, note: t.liquidity?.weakest ? `weakest: ${esc(t.liquidity.weakest.symbol)} ${t.liquidity.weakest.side === 'long' ? 'longs' : 'shorts'} ${atLeast(t.liquidity.weakest.complete) + times(t.liquidity.weakest.cover_pct)} cover` : 'depth vs liquidation demand', tip: 'Share of the liquidations from a 10% move in all markets that each market’s own book could fill, worse direction, capped at 100%. A ≥ marks a floor: part of a book was not read.' })
    ].join(''));
    const markets = overview.markets.filter(m => m.positions.count > 0).sort((a, b) => num(b.open_interest.total_notional) - num(a.open_interest.total_notional));
    if (!marketId || !markets.some(m => m.id === marketId)) {
      if (marketId === asked && asked && markets.length) toast(`No open positions in market #${asked}, showing ${markets[0].symbol}`);
      marketId = markets[0]?.id ?? null;
    }
    pickMarkets = markets; if (!pickOpen) renderPick();
    morph($('table'), table({ id: 'risk', columns: [
      { key: 'm', label: 'Market', render: r => mktLink(r.id, r.symbol) },
      { key: 'oi', label: 'Position notional', n: true, tip: 'Longs plus shorts: twice open interest', render: r => amount(r.open_interest.total_notional) },
      { key: 'pos', label: 'Positions', phone: false, n: true, render: r => `${int(r.positions.count)}<div class="sub">${int(r.positions.long)} long · ${int(r.positions.short)} short</div>` },
      { key: 'a5', label: 'At risk 5%', phone: false, n: true, render: r => amount(r.risk.notional_at_5pct) },
      { key: 'a10', label: 'At risk 10%', n: true, render: r => amount(r.risk.notional_at_10pct) },
      { key: 'sf', label: 'Shortfall 10%', n: true, render: r => (num(r.risk.shortfall_at_10pct) > 0 ? `<span class="neg" title="${esc(usdFull(r.risk.shortfall_at_10pct))}">${usdShort(r.risk.shortfall_at_10pct)}</span>` : '<span class="faint">$0</span>') },
      { key: 'ins', label: 'Insurance', phone: false, n: true, render: r => amount(r.insurance.balance) },
      { key: 'cov', label: 'Insurance cover', phone: false, n: true, tip: 'The market’s insurance fund as a multiple of its shortfall after a 10% move', render: r => (r.risk.insurance_coverage_at_10pct === null ? '<span class="faint">no shortfall</span>' : times(r.risk.insurance_coverage_at_10pct)) },
      // The weaker side, named: the stress test above shows one side at a time.
      { key: 'book', label: 'Book cover 10%', phone: false, n: true, tip: 'Order-book depth against what a 10% move would liquidate, on the weaker side (2× = twice what it would liquidate)', render: r => { if (r.book_stale) return '<span class="faint" title="The last order-book read is too old to use">stale</span>'; if (!r.liquidity) return '<span class="faint" title="No order-book read for this market yet">not read</span>'; const c = r.liquidity.cover_at_10pct; if (c?.min_pct === null || c?.min_pct === undefined) return '<span class="faint" title="No position would reach liquidation in a 10% move">nothing to absorb</span>'; const weak = c.short_pct === c.min_pct ? 'shorts, +10%' : 'longs, -10%'; return `${cover(c.min_pct, c.complete)}<div class="sub" title="Longs in a fall or shorts in a rise, whichever the book covers less">${weak}</div>`; } },
      { key: 'top', label: 'Top 5 share', phone: false, n: true, tip: 'Share of open notional held by the five largest positions', render: r => share(r.concentration.top5_pct) },
      { key: 'mm', label: 'Maint. margin', phone: false, n: true, tip: 'Maintenance margin rate of this market', render: r => (r.margin.maintenance_margin_pct ? pct(r.margin.maintenance_margin_pct, { digits: 2 }) : DASH) }
    ], rows: markets, rowAttrs: r => `class="link${r.id === marketId ? ' sel' : ''}" data-action="pick" data-id="${r.id}"` }));
    await Promise.all([ladder({ fresh }), stress()]);
  }
  // Nothing could be read yet: each panel says so at its own height. A chart already
  // drawn, or a table, stays until a newer answer replaces it.
  function failed(error) {
    noMark = true; drawMove();
    for (const id of ['kpis', 'stress', 'ladder', 'hit', 'table']) panelError($(id), error.message, retry);
  }

  // The ladder is redrawn only when its figures change, and in place, so the
  // bars move to new values on the 5 s refresh instead of growing from zero.
  let drawn = null, drawnId = null, ladderHeld = null;
  const ladderDone = () => { ladderHeld?.(); ladderHeld = null; };
  async function ladder({ fresh = false } = {}) {
    if (!marketId) { $('ladder').innerHTML = empty('No open positions'); $('ladder-lg').innerHTML = ''; drawn = drawnId = null; ladderDone(); return; }
    const id = marketId;
    let r;
    try { r = await get(`markets/${id}/ladder`, { maxAge: fresh ? 0 : 5000 }); } catch (error) {
      if (!alive || id !== marketId) return;
      if (drawnId !== id) { drawn = drawnId = null; $('ladder-lg').innerHTML = ''; morph($('ladder-meta'), ''); panelError($('ladder'), error.message, () => ladder({ fresh: true })); }
      ladderDone();
      return;
    }
    if (!alive || id !== marketId) return; // another market was picked meanwhile
    morph($('ladder-meta'), keepDots(`${esc(r.symbol)} · notional exposed at each move`));
    const labels = r.ladder.map(x => `${x.shock_pct}%`), long = r.ladder.map(x => num(x.long.notional)), short = r.ladder.map(x => num(x.short.notional));
    const key = JSON.stringify([labels, long, short]);
    drawnId = id;
    if (key === drawn) { ladderDone(); return; }
    drawn = key;
    $('ladder-lg').innerHTML = labels.length ? LADDER_KEY : '';
    if (labels.length) mirrored($('ladder'), { labels, long, short, legend: false }); else $('ladder').innerHTML = empty('No positions');
    ladderDone();
  }

  // A press dims the stress figures and the hits at their height until the answer lands.
  let stressTimer = null, stressSeq = 0, resyncing = false, shown = null, stressHeld = null;
  const stressDone = () => { stressHeld?.(); stressHeld = null; };
  const holdStress = () => { const a = hold($('stress')), b = hold($('hit')); stressHeld = () => { a(); b(); }; };
  async function stress() {
    const seq = ++stressSeq, id = marketId, at = move, key = `${id}:${at}`;
    if (!id) { drawMove(); morph($('stress'), empty('No open positions')); morph($('hit'), empty('No open positions')); morph($('hit-meta'), ''); shown = key; stressDone(); return; }
    if (at === 0) { drawMove(); morph($('stress'), empty('Move the slider to simulate a price change')); morph($('hit'), empty('No move selected')); morph($('hit-meta'), ''); shown = key; stressDone(); return; } // no move: the mark as it is
    let r;
    try { r = await get(`markets/${id}/stress?move_pct=${at}`, { maxAge: 0 }); } catch (error) {
      if (!alive || seq !== stressSeq) return;
      drawMove();
      // A refresh that fails leaves the figures; a pick that fails must not leave another market's.
      if (shown !== key) { panelError($('stress'), error.message, stress); panelError($('hit'), error.message, stress); morph($('hit-meta'), ''); }
      stressDone();
      return;
    }
    if (!alive || seq !== stressSeq) return; // superseded by a newer slider position
    // The order book is re-read about every 30 s. If the table above was drawn
    // from the previous read, redraw it once so both show the same book.
    const row = overview?.markets.find(m => m.id === id);
    const tableBook = row?.liquidity?.book_block ?? null, stressBook = r.liquidity?.book_block ?? null;
    if (tableBook && stressBook && tableBook !== stressBook && !resyncing) {
      resyncing = true;
      try { await load({ fresh: true }); return; } catch { /* the answer in hand still stands */ } finally { resyncing = false; }
      if (!alive || seq !== stressSeq) return;
    }
    drawMove(r.price);
    const absorbed = r.liquidity?.absorption_pct, range = row?.liquidity ? row.liquidity.range_pct ?? null : null, dp = dpOf(r.mark);
    // Past the band the book walk covers, depth is unknown rather than zero:
    // one row says so instead of two dashes.
    const book = r.liquidity
      ? `<div class="stat"><span>Book depth to absorb</span><span>${atLeast(r.liquidity.complete)}${amount(r.liquidity.depth)}</span></div><div class="stat"><span>Book cover</span><span>${absorbed === null || absorbed === undefined ? '<span class="faint">nothing to absorb</span>' : cover(absorbed, r.liquidity.complete)}</span></div>`
      : `<div class="stat rk-wide"><span>Book depth to absorb</span>${range === null ? '<span class="faint">no order book read</span>' : `<span class="faint" title="The order book is read to ${esc(range)}% either side of the mark; depth past that is unknown, not zero.">not read past ±${esc(range)}%</span>`}</div>`;
    morph($('stress'), `<div class="stat-grid">
        <div class="stat"><span>Positions exposed</span><span>${int(r.liquidated.count)}</span></div><div class="stat"><span>Notional exposed</span><span>${amount(r.liquidated.notional)}</span></div>
        <div class="stat"><span>Share of ${r.side === 'short' ? 'short' : 'long'} open interest</span><span>${share(r.liquidated.share_of_oi_pct)}</span></div><div class="stat"><span>Side exposed</span><span>${sideTag(r.side)}</span></div>
        <div class="stat"><span>Shortfall (bad debt)</span><span class="${num(r.shortfall) > 0 ? 'neg' : ''}">${amount(r.shortfall)}</span></div><div class="stat"><span>Insurance cover</span><span>${r.insurance_coverage_pct === null ? '<span class="faint">no shortfall</span>' : `<span title="The market’s insurance fund as a multiple of this shortfall">${times(r.insurance_coverage_pct)}</span>`}</span></div>
        ${book}
      </div>`);
    const hits = r.positions_hit.slice(0, HIT_ROWS);
    morph($('hit-meta'), keepDots(`${esc(r.symbol)} ${signed(at)}${hits.length ? ` · ${hits.length < r.liquidated.count ? `${int(hits.length)} largest of ${int(r.liquidated.count)}` : `${int(hits.length)} position${hits.length === 1 ? '' : 's'}`}` : ''}`));
    morph($('hit'), hits.length ? table({ id: 'hit', compact: true, columns: [
      { key: 'a', label: 'Trader', render: p => addr(p.address, p.account_id) },
      { key: 's', label: 'Side', render: p => sideTag(p.side) },
      { key: 'n', label: 'Notional', n: true, render: p => amount(p.notional) },
      { key: 'l', label: 'Leverage', phone: false, n: true, render: p => (p.leverage ? `${p.leverage.toFixed(1)}x` : DASH) },
      { key: 'lp', label: 'Liq. price', phone: false, n: true, render: p => (num(p.liquidation_price) > 0 ? price(p.liquidation_price, dp) : '<span class="faint" title="No liquidation price: the margin covers any price move">none</span>') },
      { key: 'd', label: 'Liq. distance', n: true, tip: 'Mark price move that reaches the liquidation price', render: p => pct(p.liquidation_distance_pct, { digits: 1 }) },
      { key: 'u', label: 'Unrealized PnL', phone: false, n: true, render: p => pnlShort(p.pnl) }
    ], rows: hits }) : empty('No position reaches its liquidation price at this move'));
    shown = key;
    stressDone();
  }
  // The market picker lists each market with its logo (a native select cannot
  // show images); Escape or a click elsewhere closes it, arrow keys move through it.
  let pickMarkets = [], pickOpen = false;
  const caret = '<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function renderPick() {
    const cur = pickMarkets.find(m => m.id === marketId);
    morph($('mkt'), `<button class="btn ghost mpick-btn" data-action="mpick-open" aria-haspopup="listbox" aria-expanded="${pickOpen}" aria-label="Market">${cur ? `${logo(cur.id, cur.symbol, 16)}${esc(cur.symbol)}` : 'Market'}${caret}</button>`
      + `<div class="mpick-list" role="listbox" aria-label="Market"${pickOpen ? '' : ' hidden'}>${pickMarkets.map(m => `<button role="option" aria-selected="${m.id === marketId}" data-action="mpick" data-id="${m.id}">${logo(m.id, m.symbol, 16)}${esc(m.symbol)}</button>`).join('')}</div>`);
  }
  // The pick shows on its row at once; the table's next draw keeps it. The panels that
  // follow the market stay at their height, dimmed, until its answers land.
  const choose = id => {
    pickOpen = false;
    if (id === marketId) { renderPick(); return; }
    marketId = id; renderPick();
    for (const tr of $('table').querySelectorAll('tr[data-id]')) tr.classList.toggle('sel', Number(tr.dataset.id) === id);
    drawMove(); holdStress(); ladderHeld = hold($('ladder'));
    setQuery({ market: marketId });
  };
  const closePick = e => {
    if (!pickOpen || (e.type === 'click' && e.composedPath().some(n => n.id === 'mkt')) || (e.type === 'keydown' && e.key !== 'Escape')) return;
    pickOpen = false; renderPick(); if (e.type === 'keydown') el.querySelector('.mpick-btn')?.focus();
  };
  document.addEventListener('click', closePick); document.addEventListener('keydown', closePick);
  $('mkt').addEventListener('keydown', e => {
    if (!pickOpen || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const opts = [...el.querySelectorAll('.mpick-list button')], i = opts.indexOf(document.activeElement);
    opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
  });
  $('move').addEventListener('input', e => { move = Number(e.target.value); e.target.setAttribute('aria-valuetext', signed(move)); drawMove(); holdStress(); clearTimeout(stressTimer); stressTimer = setTimeout(stress, 120); });
  $('move').addEventListener('change', () => keepQuery({ move })); // already drawn: the address only records it
  renderPick(); drawMove();
  const stopTrying = keepTrying(load, { alive: () => alive, fail: failed });
  const timer = setInterval(() => { if (overview) load().catch(() => {}); }, 5000); // contract state, cached per block on the server
  return {
    onAction(a, t, event) {
      if (a === 'mpick-open') { if (!pickMarkets.length) return; pickOpen = !pickOpen; renderPick(); if (pickOpen) el.querySelector('.mpick-list [aria-selected="true"]')?.focus(); return; }
      if (a === 'mpick') { choose(Number(t.dataset.id)); el.querySelector('.mpick-btn')?.focus(); return; }
      if (a === 'pick') {
        if (event?.target.closest('a,button')) return; // the market's name goes to its own page
        choose(Number(t.dataset.id));
        // The pick fills the stress test above, so the reader is taken there, once nothing else will move.
        el.querySelector('.rk-stress').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    },
    update(q) { marketId = Number(q.get('market')) || marketId; move = moveOf(q, move); renderPick(); $('move').value = String(move); ladder(); stress(); },
    refresh() { load({ fresh: true }).catch(() => {}); },
    destroy() { alive = false; stopTrying(); clearInterval(timer); clearTimeout(stressTimer); document.removeEventListener('click', closePick); document.removeEventListener('keydown', closePick); }
  };
}
