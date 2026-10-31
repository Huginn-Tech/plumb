// Trader leaderboard over a period: net PnL, volume, losses, liquidations,
// with open positions from the live contract state.
import { get } from '../api.js';
import { usd, usdShort, usdFull, int, pct, share, num, esc, price, dpOf, ago, duration, epochSpan, epochLeft } from '../format.js';
import { seg, table, addr, pnl, pnlShort, bpsCell, kpi, skRows, skBox, skKpis, DASH, hold, morph, panelError, keepTrying, keepDots, mktLink, sideTag, logo, assetOf, ICON, go, ratioCell } from '../ui.js';
import { SEA_ICONS } from '../cohort-icons.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
// Card labels per window.
const WINDOW_LABEL = { all: 'All-time' };
// The page's window switch drives the four cards and, with no epoch picked, the
// board. Perpl's epochs (weekly, Wednesday 16:00 UTC) sit in the board's own
// Period group and set the board alone; one period is lit there. The board's
// period comes from ?window= (rolling) and ?epoch=; an older ?window=last_epoch
// link still opens the board on that epoch.
const windowCtl = w => seg('window', WINDOWS, w);
const EPOCHS = { this: 'this_epoch', last: 'last_epoch' };
const EPOCH_TIP = "Ranks the leaderboard over Perpl's weekly epoch: Wednesday 16:00 UTC to the next Wednesday 16:00 UTC";
const rollingOf = q => (WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h');
const epochOf = q => EPOCHS[q.get('epoch')] ?? (Object.values(EPOCHS).includes(q.get('window')) ? q.get('window') : null);
const SORTS = [['pnl', 'Top PnL'], ['loss', 'Top losses'], ['volume', 'Volume'], ['fees', 'Fees paid'], ['liquidated', 'Liquidated'], ['net_flow', 'Net inflow'], ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals']];
const FLOW_SORTS = new Set(['net_flow', 'deposits', 'withdrawals']);
const rankOf = q => (SORTS.some(([v]) => v === q.get('by')) ? q.get('by') : 'pnl');
const pageOf = q => Math.max(0, Math.floor(Number(q.get('page'))) - 1 || 0);
// What each ranking orders the board by, and the column that carries the band.
const RANKED = { pnl: 'net PnL', loss: 'largest net loss', volume: 'volume', fees: 'fees paid', liquidated: 'notional liquidated', net_flow: 'net inflow', deposits: 'deposits', withdrawals: 'withdrawals' };
const RANKED_COL = { pnl: 'pnl', loss: 'pnl', volume: 'volume', fees: 'fees', liquidated: 'liq', net_flow: 'net', deposits: 'dep', withdrawals: 'wd' };
// The switch group's name for a screen reader; seg() prints the group.
const named = (html, label) => html.replace('role="group"', `role="group" aria-label="${label}"`);
// The board's own row of switches: the period, the trading rankings, the flows.
const periodChips = (ep, w) => {
  const chip = (v, label, on, tip) => `<button class="ep-chip${on ? ' on' : ''}" data-seg="epoch" data-v="${v}" aria-pressed="${on}" title="${esc(tip)}">${label}</button>`;
  return `<span class="ep-chips" role="group" aria-label="Period">${chip('', WINDOWS.find(([v]) => v === w)[1], !ep, 'The period picked at the top of the page')}${chip('this', 'This epoch', ep === EPOCHS.this, EPOCH_TIP)}${chip('last', 'Last epoch', ep === EPOCHS.last, EPOCH_TIP)}</span>`;
};
const rankBy = (by, ep, w) => `<div class="lb-period"><span class="lb-label">Period</span>${periodChips(ep, w)}</div><div class="lb-sorts"><span class="lb-label group">Rank by</span>${named(seg('by', SORTS.filter(([v]) => !FLOW_SORTS.has(v)), by), 'Rank by')}<span class="lb-label group">Flows</span>${named(seg('by', SORTS.filter(([v]) => FLOW_SORTS.has(v)), by), 'Rank by flows')}</div>`;
const CO_TABS = [['size', 'By size'], ['pnl', 'By track record']];
const SM_WINDOWS = [['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const SM_SIZES = [['100', '≥$100'], ['1000', '≥$1K'], ['10000', '≥$10K']];
const known = (list, v, fallback) => (list.some(([k]) => k === v) ? v : fallback);
const LIMIT = 20, SM_ROWS = 12;
// Cohort rules, by the API's key: the API's own text is shorter and names no period.
const RULES = { whale: '≥ $100K notional', dolphin: '$10K–100K notional', fish: '$1K–10K notional', shrimp: '< $1K notional', top: '≥ +$10K all-time', winner: '$0 to +$10K all-time', loser: '-$10K to $0 all-time', rekt: '≤ -$10K all-time' };
const CO_SIZE_DESC = "Open positions now, grouped by each trader's total open notional · click a cohort for its traders";
// The cohorts panel's height with its strip: four cards to a row, two, or one.
const coHeight = () => (matchMedia('(max-width: 640px)').matches ? 1232 : matchMedia('(max-width: 1240px)').matches ? 629 : 351);
// A table amount: the short form, with the exact figure as its note.
const money = v => `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`;
// A skeleton or a failed panel gives way whole; anything else is patched in place.
const put = (node, html) => { if (node.querySelector('.sk-rows, .sk-box, .skeleton, .panel-error')) node.innerHTML = html; else morph(node, html); };
const dotted = text => keepDots(esc(text));

export function mount(el, { query, setQuery, keepQuery }) {
  let w = rollingOf(query), ep = epochOf(query), by = rankOf(query), page = pageOf(query);
  // The board's period: the epoch when one is picked, else the page's.
  const bw = () => ep ?? w;
  let alive = true, data = null, cohorts = null, filter = (query.get('q') ?? '').trim();
  let coTab = known(CO_TABS, query.get('co'), 'size'), coSel = query.get('cohort'), smWin = known(SM_WINDOWS, query.get('smw'), '30d'), smMin = known(SM_SIZES, query.get('smm'), '1000');
  el.innerHTML = `
    <div class="page-head"><div><h1>Traders</h1><div class="sub">Rankings of every trader, how traders are positioned now, and the latest moves of the most profitable ones.</div></div><div id="win">${windowCtl(w)}</div></div>
    <div class="stack traders-page">
    <div class="kpis k4" id="tkpis">${skKpis(4)}</div>
    <section class="panel" id="board"><div class="panel-head lb-head"><div><h2>Leaderboard</h2><div class="desc" id="meta"></div></div><div class="lb-tools"><input id="lb-search" class="calc-in lb-search" type="search" placeholder="Filter or paste a wallet" autocomplete="off" spellcheck="false" aria-label="Filter traders by address" value="${esc(filter)}"><a class="btn ghost" id="csv">${ICON.download} CSV</a></div><div class="lb-rank" id="by">${rankBy(by, ep, w)}</div></div>
      <div class="panel-body flush" id="list">${skRows(LIMIT, 44, 34, 52)}</div>
      <div class="panel-foot pager"><span id="count"></span><span class="pager-ctl" id="pager"></span></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Positioning by cohort</h2><div class="desc" id="co-desc">${dotted(coTab === 'size' ? CO_SIZE_DESC : 'Traders with open positions now, grouped by all-time net PnL')}</div></div><div id="co-tabs">${seg('co', CO_TABS, coTab)}</div></div>
      <div class="panel-body flush" id="cohorts">${skBox(coHeight())}</div><div id="co-detail"></div></section>
    <section class="panel sm-panel"><div class="panel-head"><div><h2>Smart money moves</h2><div class="desc" id="sm-desc">What the most profitable traders are doing now</div></div><div class="sm-ctl"><div class="sm-group"><span class="lb-label">Min size</span><div id="sm-min">${named(seg('smm', SM_SIZES, smMin), 'Minimum size of a move')}</div></div><div class="sm-group"><span class="lb-label">Rank leaders over</span><div id="sm-win">${named(seg('smw', SM_WINDOWS, smWin), 'Rank leaders over')}</div></div></div></div>
      <div class="panel-body flush scroll sm-list" id="moves">${skRows(SM_ROWS, 38, 34)}</div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);
  // At most two rule-based style tags per trader; each note gives the evidence.
  const DAYS = { '24h': 1, '7d': 7, '30d': 30, last_epoch: 7 };
  function styleTags(r) {
    const out = [], trades = r.trades ?? 0, vol = num(r.volume) ?? 0;
    if (trades && vol / trades >= 25000) out.push(['Large trades', `Average trade ${usdShort(vol / trades)}`]);
    if (trades >= 100 && (r.maker_share_pct ?? 0) >= 80) out.push(['Maker', `${Math.round(r.maker_share_pct)}% of volume as maker`]);
    const days = DAYS[bw()];
    if (days && trades / days >= 5000) out.push(['High frequency', `${int(trades / days)} trades a day, one every ${Math.round(86400 * days / trades)} s`]);
    const tags = out.slice(0, 2).map(([t, why]) => `<span class="tag" title="${esc(why)}">${t}</span>`).join('');
    return tags ? `<span class="sub tags inline">${tags}</span>` : '';
  }
  const SHARE_COL = { key: 'share', label: 'Share of volume', tip: 'Share of the exchange volume in the epoch (each trade has two sides, so shares add up to 200%)', phone: false, n: true, render: r => (num(r.volume_share_pct) === null ? DASH : share(r.volume_share_pct, { digits: r.volume_share_pct < 1 ? 2 : 1 })) };
  const COLS = [
    { key: 'rank', label: '#', render: r => `<span class="rank">${int(r.rank)}</span>` },
    { key: 'addr', label: 'Trader', render: r => addr(r.address, r.account, { after: styleTags(r) }) },
    { key: 'pnl', label: 'Net PnL', tip: 'Realized PnL with funding, minus fees, in the period', n: true, render: r => pnlShort(r.pnl) },
    { key: 'roi', label: 'PnL / volume', tip: 'Net PnL as a share of volume. 10 bps is $1 per $1,000 traded. Shown from $1K of volume.', phone: false, n: true, render: r => ratioCell(r.roi_on_volume_bps, r.volume) }, // in bps, as the card above and the wallet page
    { key: 'volume', label: 'Volume', tip: 'Notional this trader traded in the period, as maker and taker', n: true, render: r => money(r.volume) },
    { key: 'trades', label: 'Trades', tip: "This trader's opens, adds, reduces, closes, flips and liquidations in the period", phone: false, n: true, render: r => int(r.trades) },
    { key: 'maker', label: 'Maker share', tip: "Share of this trader's volume filled as maker", phone: false, n: true, render: r => (num(r.maker_share_pct) === null ? DASH : share(r.maker_share_pct)) },
    { key: 'fees', label: 'Fees paid', tip: 'Trading and liquidation fees paid in the period', phone: false, n: true, render: r => money(r.fees) },
    { key: 'liq', label: 'Liquidated', tip: "Notional of this trader's positions liquidated in the period", phone: false, n: true, render: r => (num(r.liquidated) > 0 ? `<span class="neg" title="${esc(usdFull(r.liquidated))}">${usdShort(r.liquidated)}</span>` : DASH) },
    { key: 'dep', flow: true, label: 'Deposits', n: true, render: r => (num(r.deposits) > 0 ? money(r.deposits) : DASH) },
    { key: 'wd', flow: true, label: 'Withdrawals', n: true, render: r => (num(r.withdrawals) > 0 ? money(r.withdrawals) : DASH) },
    { key: 'net', flow: true, label: 'Net flow', tip: 'Deposits minus withdrawals in the period', n: true, render: r => { const v = (num(r.deposits) ?? 0) - (num(r.withdrawals) ?? 0); return v ? `<span title="${esc(usdFull(v))}">${usdShort(v, { sign: true })}</span>` : DASH; } },
    { key: 'pos', label: 'Positions', tip: 'Open positions now, whatever the period', phone: false, n: true, render: r => (r.open_positions ? int(r.open_positions) : DASH) },
    { key: 'open', label: 'Open notional', tip: 'Open positions at the mark price, now, whatever the period', phone: false, n: true, render: r => (r.open_positions ? money(r.open_notional) : DASH) },
    { key: 'upnl', label: 'Unrealized', tip: 'Unrealized PnL of those positions now, whatever the period', phone: false, n: true, render: r => (r.open_positions ? pnlShort(r.unrealized_pnl) : DASH) },
    { key: 'markets', label: 'Markets', tip: 'Markets traded in the period', phone: false, render: r => marketsCell(r.markets) }
  ];
  function marketsCell(list) {
    if (!list.length) return DASH;
    const more = n => (list.length > n ? `+${list.length - n}` : '');
    return `<span class="mk muted" title="${esc(list.join(' · '))}"><span class="mk-names">${esc(list.slice(0, 3).join(' · '))}${list[3] ? `<span class="mk-name4"> · ${esc(list[3])}</span>` : ''}</span><span class="mk-more mk-more3">${more(3)}</span><span class="mk-more mk-more4">${more(4)}</span></span>`;
  }
  // Flow rankings swap the maker, fee and liquidation columns for the flows
  // themselves; an epoch shows each trader's share of the epoch's volume where the
  // open positions (now) would be.
  function columnsFor() {
    const flow = FLOW_SORTS.has(by), epoch = ep !== null;
    return COLS.filter(c => (flow ? !['fees', 'liq', 'maker'].includes(c.key) : !c.flow)).filter(c => !(epoch && ['pos', 'upnl'].includes(c.key))).map(c => (epoch && c.key === 'open' ? SHARE_COL : c));
  }
  const csvHref = () => `/api/v1/leaderboard?window=${bw()}&by=${by}&limit=200&format=csv`;
  $('csv').href = csvHref();

  // The board holds its old rows, dimmed, until the new ones land, whichever press
  // asked; only the latest answer is drawn. A failure takes the old rows away, so no
  // figure sits under a switch it does not belong to, and keepTrying brings it back.
  let lbColumns = null, seq = 0, unhold = null, stopBoard = () => {};
  const letBoardGo = () => { unhold?.(); unhold = null; };
  function boardFailed(error) {
    letBoardGo(); data = null;
    renderMeta(); $('count').textContent = ''; morph($('pager'), '');
    panelError($('list'), error.message, () => load());
  }
  async function load({ quiet = false, maxAge } = {}) {
    const asked = ++seq;
    if (!quiet && !$('list').querySelector('.sk-rows')) unhold ??= hold($('list'));
    const d = await get(`leaderboard?window=${bw()}&by=${by}&limit=${LIMIT}&offset=${page * LIMIT}`, maxAge === undefined ? {} : { maxAge }).catch(error => {
      if (alive && asked === seq && (!quiet || !data)) boardFailed(error); // a quiet refresh over good rows leaves them be
      throw error;
    });
    if (!alive || asked !== seq) return;
    // An old link to a page past the end opens the first one.
    if (!d.rows.length && page > 0) { page = 0; keepQuery({ page: null }); await load({ quiet, maxAge }); return; }
    data = d; letBoardGo();
    renderMeta();
    lbColumns = columnsFor();
    renderList();
    renderPager();
  }
  const board = () => { stopBoard(); let again = false; stopBoard = keepTrying(() => { const quiet = again; again = true; return load({ quiet }); }, { alive: () => alive }); };
  // The board's subtitle: what it ranks, over which period, and for an epoch its
  // span, the time to its end and its volume. Hovering it names the epoch's blocks.
  function renderMeta() {
    const head = `Ranked by ${RANKED[by]}`, period = ep === 'this_epoch' ? 'this epoch' : ep === 'last_epoch' ? 'last epoch' : w === 'all' ? 'all-time' : `last ${w}`;
    if (!data) { morph($('meta'), dotted(`${head} · ${period}`)); return; }
    const m = data.meta, who = FLOW_SORTS.has(by) ? 'accounts' : 'traders', partial = m.coverage && !m.coverage.complete ? ' · history still indexing' : '';
    const size = `${int(data.total)} ${who}${num(m.volume) ? ` · ${usd(m.volume)} volume` : ''}`;
    // An epoch's line keeps to two lines on narrow screens, so the board does not move under the chip just pressed.
    const span = ep && `<span class="m-wide">${period}, ${esc(epochSpan(m.from))}</span><span class="m-tight">${esc(epochSpan(m.from).replaceAll(' 16:00', '').replace(' UTC', ''))}</span>`;
    const text = ep === 'this_epoch' ? `${esc(head)} · ${span} · ends in ${esc(epochLeft(m.from))} · ${esc(size)}` : ep === 'last_epoch' ? `${esc(head)} · ${span} · final · ${esc(size)}` : esc(`${head} · ${period} · ${size}`);
    morph($('meta'), keepDots(text + partial));
    $('meta').title = m.blocks?.first ? `Perpl activity from block ${int(m.blocks.first)} to block ${int(m.blocks.last)}` : '';
  }
  renderMeta();
  // The countdown moves on; at the epoch's end the one under way turns into the
  // last one, within seconds (and again until the server has rolled over too).
  const epochTimer = setInterval(() => { if (!data || ep !== 'this_epoch' || unhold) return; if (Date.now() / 1000 >= data.meta.from + 7 * 86400) load({ quiet: true, maxAge: 0 }).catch(() => {}); else renderMeta(); }, 10000);
  // Prev is off on the first page and Next on the last; one page needs neither, nor
  // does a filter that found nothing here.
  const pages = () => Math.max(1, Math.ceil((data?.total ?? 0) / LIMIT));
  function renderPager(hidden = false) { const n = pages(); morph($('pager'), n > 1 && !hidden ? `<button class="btn ghost sm" data-action="prev" ${page === 0 ? 'disabled' : ''}>← Prev</button><span class="num">Page ${int(page + 1)} of ${int(n)}</span><button class="btn ghost sm" data-action="next" ${page + 1 >= n ? 'disabled' : ''}>Next →</button>` : ''); }
  // The press is kept in the address, so Back returns to this page of the board.
  function goTo(n) { page = n; keepQuery({ page: n ? n + 1 : null }); renderPager(); board(); }
  // The leaderboard page, filtered by the address typed in its search box.
  function renderList() {
    if (!data || !lbColumns) return;
    const f = filter.toLowerCase(), who = FLOW_SORTS.has(by) ? 'accounts' : 'traders';
    const rows = f ? data.rows.filter(r => String(r.address ?? '').toLowerCase().includes(f) || String(r.account) === f.replace(/^#/, '')) : data.rows;
    const widths = `<colgroup>${lbColumns.map(c => `<col class="c-${c.key}${c.phone === false ? ' hide-sm' : ''}">`).join('')}</colgroup>`; // set in styles.css, so a press moves no column
    put($('list'), table({ id: 'lb', columns: lbColumns, rows, focusKey: RANKED_COL[by], rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"`, emptyText: f ? 'Not on this page. Press Enter to open the wallet, if it is a full address or account ID.' : `No ${who} in this period` }).replace('<thead>', `${widths}<thead>`));
    // The count says what is on screen: a filter's matches on this page, or the page's place in the ranking.
    $('count').textContent = !data.total ? '' : f ? `${int(rows.length)} of ${int(data.rows.length)} on this page match` : `${int(data.total)} ${who} · showing ${int(page * LIMIT + 1)}–${int(page * LIMIT + data.rows.length)}`;
  }
  $('lb-search').addEventListener('input', e => { filter = e.target.value.trim(); keepQuery({ q: filter }); renderList(); renderPager(Boolean(filter) && !$('list').querySelector('tbody')); });
  $('lb-search').addEventListener('keydown', e => { const q = e.target.value.trim().replace(/^#/, ''); if (e.key === 'Enter' && (/^0x[0-9a-fA-F]{40}$/.test(q) || /^\d{1,9}$/.test(q))) go(`/wallet/${q}`); });

  // The latest position changes of the top directional traders (makers and
  // high-frequency accounts left out server-side), ranked by net PnL in smWin.
  // A trader splitting one decision into many fills ("reduce long" eight times
  // in five minutes) shows as one row: the same account, market, action and
  // side within 30 minutes of each other fold together.
  const MOVE_VERBS = { open: 'Open', increase: 'Add', decrease: 'Reduce', close: 'Close', invert: 'Flip to', liquidation: 'Liquidated', deleverage: 'ADL' };
  function foldMoves(rows) {
    const out = [], open = new Map();
    for (const r of rows) {
      const key = `${r.account}|${r.market}|${r.kind}|${r.side}`, g = open.get(key);
      if (g && g.oldest - r.ts <= 1800) { g.count++; g.notional += num(r.notional) || 0; g.size += num(r.size) || 0; g.pnl += num(r.pnl) || 0; g.oldest = r.ts; continue; }
      const next = { ...r, count: 1, notional: num(r.notional) || 0, size: num(r.size) || 0, pnl: num(r.pnl) || 0, oldest: r.ts };
      open.set(key, next); out.push(next);
    }
    return out;
  }
  // The verb in plain text and the side as a tag: a red "Close long" beside a green gain read as a loss.
  const moveAction = r => `<span class="mv-verb">${esc(MOVE_VERBS[r.kind] ?? r.kind)}</span>${sideTag(r.side)}${r.count > 1 ? ` <span class="tag hide-sm" title="${r.count} fills over ${Math.max(1, Math.round((r.ts - r.oldest) / 60))} min">×${r.count}</span>` : ''}`;
  // The API returns at most this many raw fills; a busy leader can fill them all.
  const MOVE_FILLS = 500;
  let mvSeq = 0, mvRelease = null, movesShown = false;
  const letMovesGo = () => { mvRelease?.(); mvRelease = null; };
  async function loadMoves({ press = false, maxAge = 8000 } = {}) {
    const asked = ++mvSeq;
    if (press && movesShown) mvRelease ??= hold($('moves'));
    const m = await get(`traders/moves?window=${smWin}&min=${smMin}&limit=${MOVE_FILLS}`, { maxAge }).catch(error => {
      // Only a press or a first load shows the failure; a timer's miss leaves the list be.
      if (alive && asked === mvSeq && (press || mvRelease || !movesShown)) { letMovesGo(); movesShown = false; panelError($('moves'), error.message, () => loadMoves({ press: true })); }
      throw error;
    });
    if (!alive || asked !== mvSeq) return;
    const fresh = Boolean(mvRelease);
    letMovesGo();
    const wl = smWin === 'all' ? 'all-time' : smWin;
    // Cut off by the fill limit, the list covers less than the 7 days asked for: it says how much.
    const oldest = m.rows.at(-1)?.ts, cut = m.rows.length >= MOVE_FILLS && oldest;
    const span = cut ? `the last ${duration(Date.now() / 1000 - oldest)} (the latest ${int(MOVE_FILLS)} fills)` : 'last 7 days';
    morph($('sm-desc'), dotted(`${int(m.leaders)} most profitable directional traders by net PnL (${wl}) · their moves, ${span}${m.excluded ? ` · ${int(m.excluded)} market-making and high-frequency accounts left out` : ''}`));
    put($('moves'), table({ id: 'moves', compact: true, emptyText: 'No moves by these traders in the last 7 days', columns: [
      { key: 't', label: 'Time', render: r => `<span class="muted num" title="${esc(new Date(r.ts * 1000).toISOString().replace('T', ' ').slice(0, 19))} UTC">${ago(r.ts).replace(' ago', '<span class="mv-ago"> ago</span>')}</span>` },
      { key: 'a', label: 'Trader', phone: false, render: r => `<span class="sm-trader"><span class="rank-pill" title="Rank by net PnL among all traders, ${esc(wl)}">#${int(r.leader.rank)}</span>${addr(r.address, r.account)}</span>` },
      { key: 'x', label: 'Action', render: moveAction },
      { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
      { key: 'n', label: 'Notional', n: true, render: r => money(r.notional) },
      { key: 'p', label: 'Price', phone: false, n: true, render: r => price(r.count > 1 && r.size ? r.notional / r.size : r.price, dpOf(r.price)) },
      { key: 'r', label: 'Realized PnL', tip: 'Profit or loss this move booked, before fees', phone: false, n: true, render: r => (['decrease', 'close', 'invert', 'liquidation', 'deleverage'].includes(r.kind) && num(r.pnl) ? pnlShort(r.pnl) : DASH) },
      { key: 'l', label: `Net PnL · ${wl}`, tip: "This trader's net PnL over the period that ranked them, not from this move", phone: false, n: true, render: r => pnlShort(r.leader.pnl) }
    ], rows: foldMoves(m.rows).slice(0, 30), rowAttrs: r => `class="link" data-href="/wallet/${esc(r.address || r.account)}"` }));
    movesShown = true;
    if (fresh) $('moves').scrollTop = 0; // a new list starts at its top
  }

  // Traders at a glance for the page's window.
  let sumSeq = 0, sumRelease = null, cardsShown = false, stopSummary = () => {};
  const letCardsGo = () => { sumRelease?.(); sumRelease = null; };
  async function loadSummary({ quiet = false, maxAge = 20000 } = {}) {
    const asked = ++sumSeq;
    if (!quiet && cardsShown) sumRelease ??= hold($('tkpis'));
    const t = await get(`traders/summary?window=${w}`, { maxAge }).catch(error => {
      if (alive && asked === sumSeq && (!quiet || !cardsShown)) { letCardsGo(); cardsShown = false; panelError($('tkpis'), error.message, () => loadSummary()); }
      throw error;
    });
    if (!alive || asked !== sumSeq) return;
    letCardsGo();
    const wl = WINDOW_LABEL[w] ?? w, partial = t.meta?.coverage && !t.meta.coverage.complete ? ' <span class="status-dot warn" title="History for this period is still being indexed"></span>' : '';
    put($('tkpis'), [
      kpi({ label: `Traders · ${wl}`, value: int(t.traders), note: `${usd(t.volume)} volume${partial}` }),
      kpi({ label: `Profitable · ${wl}`, value: int(t.profitable), note: `${pct(t.profitable_pct, { digits: 1 })} of traders, after fees`, tip: 'Traders with net PnL above zero in the period, after fees' }),
      kpi({ label: `Traders' net PnL · ${wl}`, value: pnl(t.net_pnl), note: 'all traders, after fees', tip: 'Realized PnL with funding, minus fees, summed over every trader in the period.' }),
      kpi({ label: `Median PnL / volume · ${wl}`, value: num(t.median_pnl_per_volume_bps) === null ? DASH : bpsCell(t.median_pnl_per_volume_bps), note: 'the middle trader · 10 bps is $1 per $1,000', tip: 'Half of traders did better than this, half worse. 10 bps is $1 per $1,000 traded.' })
    ].join(''));
    cardsShown = true;
  }
  const summary = () => { stopSummary(); let again = false; stopSummary = keepTrying(() => { const quiet = again; again = true; return loadSummary({ quiet }); }, { alive: () => alive }); };

  // Cohorts: who holds the open interest, by size or by track record. One unit per
  // cohort: its direction three ways (label, split bar, long/short $), its
  // share of all open notional, and where it is positioned. Purple marks
  // identity; green and red only ever mean long and short.
  const CO_SHADES = ['#6f5cff', '#8f82ff', '#b3aaff', '#d9d4ff'];
  const stroke = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const CO_ICON = {
    ...SEA_ICONS, // size tiers: whale, dolphin, fish, shrimp
    top: stroke('<path d="M3 17h18M4 8l4.5 4.5L12 6l3.5 6.5L20 8l-1.5 9h-13z"/>'),
    winner: stroke('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    loser: stroke('<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>'),
    rekt: stroke('<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><path d="M10.5 20v-2M13.5 20v-2"/>')
  };
  // Net exposure names its side ("$142K short"): a bare "-$142K" read like a loss.
  const netSide = v => { const n = num(v) ?? 0; return n ? `<span class="${n > 0 ? 'pos' : 'neg'}" title="${esc(usdFull(Math.abs(n)))}">${usdShort(Math.abs(n))} ${n > 0 ? 'long' : 'short'}</span>` : '<span class="faint">flat</span>'; };
  function biasOf(s) {
    if (s === null || s === undefined) return ['No positions', 'flat', '', ''];
    const of = 'of open notional is long';
    return s >= 65 ? ['Strong long', 'long', '▲', `Strong long: 65% or more ${of}`] : s >= 55 ? ['Long', 'long', '▲', `Long: 55–65% ${of}`] : s <= 35 ? ['Strong short', 'short', '▼', `Strong short: 35% or less ${of}`] : s <= 45 ? ['Short', 'short', '▼', `Short: 35–45% ${of}`] : ['Balanced', 'flat', '◆', `Balanced: 45–55% ${of}`];
  }
  function renderCohorts() {
    if (!cohorts) return;
    const groups = coTab === 'size' ? cohorts.by_size : cohorts.by_pnl;
    const held = g => g.long_notional + g.short_notional, all = groups.reduce((a, g) => a + held(g), 0) || 1;
    // Where the open notional sits, cohort by cohort.
    const strip = `<div class="co-strip"><div class="co-strip-head"><span>Open notional held</span><span class="faint" title="${esc(usdFull(all))}">${usdShort(all)} long + short</span></div><div class="co-strip-bar">${groups.map((g, i) => (held(g) > 0 ? `<i style="flex:${held(g)};background:${CO_SHADES[i % CO_SHADES.length]}" title="${esc(g.label)}: ${esc(usdShort(held(g)))} (${share(held(g) / all * 100)})"></i>` : '')).join('')}</div>
      <div class="co-strip-keys">${groups.map((g, i) => `<span><i style="background:${CO_SHADES[i % CO_SHADES.length]}"></i>${esc(g.label)} <b>${share(held(g) / all * 100, { digits: 0 })}</b></span>`).join('')}<span class="co-arrows">↑ net long · ↓ net short</span></div></div>`;
    const card = (g, i) => {
      const [label, cls, arrow, rule] = biasOf(g.accounts ? g.long_share_pct : null), l = g.long_share_pct ?? 50, lp = Math.round(l);
      const markets = g.markets.slice(0, 3).map(m => `<span class="co-mk ${m.long >= m.short ? 'long' : 'short'}" title="${esc(`${assetOf(m.symbol)}: ${usdShort(m.long)} long, ${usdShort(m.short)} short`)}">${logo(m.market, m.symbol, 14)}${esc(assetOf(m.symbol))}${m.long >= m.short ? '↑' : '↓'}</span>`).join('');
      const amount = v => `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`;
      return `<button type="button" class="co-card${coSel === g.key ? ' sel' : ''}" data-action="co-pick" data-key="${esc(g.key)}" aria-pressed="${coSel === g.key}">
        <div class="co-top"><span class="co-ic" style="--shade:${CO_SHADES[i % CO_SHADES.length]}">${CO_ICON[g.key] ?? ''}</span><span class="co-id"><b>${esc(g.label)}</b><span>${esc(RULES[g.key] ?? g.rule)}</span></span><span class="co-pill ${cls}"${rule ? ` title="${esc(rule)}"` : ''}>${arrow} ${label}</span></div>
        <div class="co-count"><span><b>${int(g.accounts)}</b> ${g.accounts === 1 ? 'trader' : 'traders'}</span><span class="co-ls"><span class="pos">${int(g.net_long_accounts)} net long</span> · <span class="neg">${int(g.net_short_accounts)} net short</span></span></div>
        <div class="co-bar" title="${pct(l, { digits: 1 })} of this cohort's open notional is long">${g.accounts ? `<i style="width:${l}%"></i><i></i>` : ''}</div>
        <div class="co-ends"><span class="pos">Long ${amount(g.long_notional)}${g.accounts ? ` · ${lp}%` : ''}</span><span class="neg">${g.accounts ? `${100 - lp}% · ` : ''}Short ${amount(g.short_notional)}</span></div>
        <div class="co-stats"><span title="Long minus short open notional">Net exposure<b>${netSide(g.net_notional)}</b></span><span title="Unrealized PnL of this cohort's open positions">Unrealized<b>${pnlShort(g.unrealized_pnl)}</b></span><span title="Traders whose open positions show a gain now">In profit<b>${int(g.in_profit)} of ${int(g.accounts)}</b></span></div>
        <div class="co-mks">${markets || '<span class="faint">No open positions</span>'}</div>
      </button>`;
    };
    put($('cohorts'), `<div class="panel-body">${strip}<div class="co-grid">${groups.map(card).join('')}</div></div>`);
    morph($('co-desc'), dotted(coTab === 'size' ? CO_SIZE_DESC : `Traders with open positions now, grouped by all-time net PnL${cohorts.meta?.coverage && !cohorts.meta.coverage.complete ? ' (history still indexing)' : ''}${cohorts.unranked ? ` · ${int(cohorts.unranked)} accounts without indexed trades left out` : ''}`));
    const g = groups.find(x => x.key === coSel);
    morph($('co-detail'), g ? `<div class="panel-head co-top-head"><h3>${esc(g.label)}: largest traders</h3><button class="btn ghost" data-action="co-close">Close</button></div>${table({ id: 'co-top', compact: true, emptyText: 'No traders', columns: [
      { key: 'a', label: 'Trader', render: a => addr(a.address, a.account) },
      { key: 'n', label: 'Open notional', n: true, render: a => money(a.notional) },
      { key: 'd', label: 'Net exposure', n: true, render: a => netSide(a.net) },
      { key: 'u', label: 'Unrealized', phone: false, n: true, render: a => pnlShort(a.upnl) },
      { key: 'p', label: 'Net PnL · all-time', phone: false, n: true, render: a => (a.pnl === null ? DASH : pnlShort(a.pnl)) }
    ], rows: g.top, rowAttrs: a => `class="link" data-href="/wallet/${esc(a.address || a.account)}"` })}` : '');
  }
  let coSeq = 0;
  const loadCohorts = ({ maxAge = 5000 } = {}) => { const asked = ++coSeq; return get('cohorts', { maxAge }).then(c => { if (!alive || asked !== coSeq) return; cohorts = c; renderCohorts(); }).catch(error => { if (alive && asked === coSeq && !cohorts) panelError($('cohorts'), error.message, () => loadCohorts()); }); };
  loadCohorts();
  const coTimer = setInterval(loadCohorts, 10000); // live positions; also what heals a failed panel
  loadMoves().catch(() => {});
  const smTimer = setInterval(() => loadMoves().catch(() => {}), 15000);

  board();
  summary();
  // Reaches the network and draws in place: run after a cached open and whenever the
  // stream or the API comes back. A panel in failure goes back to trying.
  function refresh() {
    if (data) load({ quiet: true, maxAge: 0 }).catch(() => {}); else board();
    if (cardsShown) loadSummary({ quiet: true, maxAge: 0 }).catch(() => {}); else summary();
    loadCohorts({ maxAge: 0 });
    loadMoves({ maxAge: 0 }).catch(() => {});
  }
  return {
    refresh,
    onSeg(name, v) {
      if (name === 'smm' && v !== smMin) { smMin = v; keepQuery({ smm: v === '1000' ? null : v }); morph($('sm-min'), named(seg('smm', SM_SIZES, smMin), 'Minimum size of a move')); loadMoves({ press: true }).catch(() => {}); }
      if (name === 'smw' && v !== smWin) { smWin = v; keepQuery({ smw: v === '30d' ? null : v }); morph($('sm-win'), named(seg('smw', SM_WINDOWS, smWin), 'Rank leaders over')); loadMoves({ press: true }).catch(() => {}); }
      if (name === 'co' && v !== coTab) { coTab = v; coSel = null; keepQuery({ co: v === 'size' ? null : v, cohort: null }); morph($('co-tabs'), seg('co', CO_TABS, coTab)); renderCohorts(); }
      if (name === 'window' && (v !== w || ep)) setQuery({ window: v === '24h' ? null : v, epoch: null, page: null });
      if (name === 'epoch' && (EPOCHS[v] ?? null) !== ep) setQuery({ epoch: v || null, window: w === '24h' ? null : w, page: null });
      if (name === 'by' && v !== by) setQuery({ by: v === 'pnl' ? null : v, page: null });
    },
    onAction(a, t) {
      if (a === 'co-pick') { coSel = coSel === t.dataset.key ? null : t.dataset.key; keepQuery({ cohort: coSel }); renderCohorts(); return; }
      if (a === 'co-close') { coSel = null; keepQuery({ cohort: null }); renderCohorts(); return; }
      if (a === 'next' && data && page + 1 < pages()) goTo(page + 1);
      if (a === 'prev' && page > 0) goTo(page - 1);
    },
    update(q) {
      const nw = rollingOf(q), cardsChanged = nw !== w;
      w = nw; ep = epochOf(q); by = rankOf(q); page = pageOf(q);
      morph($('win'), windowCtl(w));
      morph($('by'), rankBy(by, ep, w));
      $('csv').href = csvHref();
      board();
      if (cardsChanged) summary();
    },
    destroy() { alive = false; stopBoard(); stopSummary(); clearInterval(coTimer); clearInterval(smTimer); clearInterval(epochTimer); }
  };
}
