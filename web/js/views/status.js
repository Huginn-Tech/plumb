// Data pipeline status, integrity checks and methodology: what every number
// is, where it comes from and how it is verified.
import { get } from '../api.js';
import { int, esc, ago, dateTime, pct, usdShort, usdFull, num } from '../format.js';
import { table, skBox, empty, mkt, morph, panelError, keepTrying, keepDots, DASH } from '../ui.js';

const dot = (s = '', tip = '') => `<span class="status-dot ${s}"${tip ? ` title="${esc(tip)}"` : ''}></span>`;
// Exact figures from the API (block numbers, lot counts) grouped by thousands
// like every other count on the page, their digits untouched.
const grouped = v => (v === null || v === undefined ? DASH : esc(v).replace(/^-?\d+/, d => d.replace(/\B(?=(\d{3})+$)/g, ',')));
const blockNo = v => (num(v) === null ? DASH : `#${int(v)}`);
const count = (n, word) => `${int(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
const clock = ms => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const line = html => `<div class="d">${keepDots(html)}</div>`;
// A figure in a note, with the exact amount as its hover note.
const amount = (v, opts) => `<span title="${esc(usdFull(v))}">${usdShort(v, opts)}</span>`;
// The header pill calls the feed delayed after this long without a block.
const DELAYED_S = 15;

// One result per row a check draws: true passed, false did not, null has nothing to say
// yet. Only a real answer counts: a check still waiting is left out of the total.
const row = (ok, label, value, state = ok === null ? '' : ok ? 'ok' : 'bad') => `<div class="stat"><span>${dot(state)} ${label}</span><span>${value}</span></div>`;

// The added topics (protocol balance transfers) scanned over the history.
const topicsLine = t => (!t || t.complete ? '' : line(`protocol transfers ${t.pct === null ? DASH : pct(t.pct, { digits: 1 })} scanned${t.running && t.rate_blocks_per_s ? ` · ${int(t.rate_blocks_per_s)} blocks/s` : ''}`));
// The protocol balance rebuilt from events against the contract.
function protocolLine(p) {
  if (!p) return '';
  if (p.status === 'pending') return `<div class="panel-foot st-tvl"><span>Protocol balance from events: waiting for the transfer scan (${p.scanned_pct === null ? DASH : pct(p.scanned_pct, { digits: 1 })})</span><span class="tag">pending</span></div>`;
  const why = p.status === 'match' ? '' : ` · difference ${amount(p.difference, { sign: true })}`;
  return `<div class="panel-foot st-tvl" title="Protocol fee and liquidation shares plus payouts, sweeps, deposits and withdrawals since launch"><span>${keepDots(`Protocol balance from events ${usdFull(p.events)} · contract ${usdFull(p.contract)}${why}`)}</span>${p.status === 'match' ? '<span class="tag good">match</span>' : '<span class="tag warn">differs</span>'}</div>`;
}

const DEFINITIONS = [
  ['Volume', 'Sum of maker-fill notional (price × size of every <code>MakerOrderFilled</code>), so each match counts once. Notional is computed with integer arithmetic from the market\'s price and lot decimals.'],
  ['Fees', 'Maker plus taker fees charged on fills. The exchange splits every fee into an insurance-fund part and a protocol part (<code>insFeeCNS + protFeeCNS</code> on the position event equals the fill fee, checked on every fill that opens, increases or flips a position; reducing fills carry no fee up to contract v1.1.7.4). A builder\'s share is part of the fill fee and of the protocol part. Fees are gross: rebates and referral shares are paid outside fills.'],
  ['Open interest', 'Live: long lots × mark price from <code>getPerpetualInfoV2</code> (long and short lots are equal by construction, so this counts each contract once). History: the running sum of lot changes from position events since the exchange was deployed, priced at the last trade; the running sum is compared with the contract\'s counters under Integrity checks.'],
  ['TVL and flows', 'Live TVL is the exchange\'s collateral balance read from the contract. History is deposits − withdrawals (plus protocol balance movements) since deployment; net flow is deposits − withdrawals in the period.'],
  ['Active traders', 'Distinct accounts with at least one trade (open, increase, decrease, close, flip, or a liquidation executed on the book) in the period.'],
  ['Realized and net PnL', 'Realized PnL is <code>deltaPnl + funding</code> reported by decrease, close, flip, liquidation and deleveraging events, plus the funding the contract settles when a position is increased. Net PnL subtracts the fees the account paid: fill fees, and on a liquidation the share of the remaining margin that goes to the insurance fund and protocol (the trader keeps 80 % by default).'],
  ['Round trips, win rate, profit factor, drawdown', 'Perpl holds one position per account and market. A round trip starts when that position leaves zero and ends when it returns to zero (a flip closes one side and opens the other). A win is a trip with positive net PnL; profit factor is gross wins ÷ gross losses; maximum drawdown is the largest peak-to-trough fall of cumulative net PnL over closed trips; hold time uses block timestamps.'],
  ['Liquidation risk', 'Liquidation and bankruptcy prices follow the Perpl documentation and perpl-sdk (<code>position.rs</code>), recomputed for every open position from contract state; a position\'s PnL is checked against <code>getPositionsV2</code>.'],
  ['Freshness', 'Only finalized blocks are indexed, so no stored number is ever rolled back (only the dimmed trades of proposed blocks are provisional). The ingest wakes on the execution-events sidecar, WebSocket heads or a 400 ms timer, reads new finalized blocks with <code>eth_getLogs</code>, commits to ClickHouse about once a second and pushes to this page over server-sent events. Contract state follows each commit; the order book is re-walked every 30 s.']
];

export function mount(el) {
  let alive = true, seq = 0, health = null, validation = null, shownInteg = null, waited = 0, again = null;
  const results = { snapshot: [], decoder: [], integrity: null }; // null: not counted yet
  // The two short check lists share a row; the per-market table gets the full width.
  el.innerHTML = `<div class="page-head"><div><h1>Data &amp; methodology</h1><div class="sub">How Plumb gets its numbers, and the live checks that compare them with the contract.</div></div></div>
    <div class="stack st-page">
      <section class="panel"><div class="panel-head"><h2>Pipeline</h2><span class="meta st-result" id="gen"></span></div><div class="pipeline" id="pipeline">${skBox(138, 330)}</div></section>
      <div class="grid g-2">
        <section class="panel st-checks"><div class="panel-head"><h2>Contract snapshot checks</h2><span class="meta">Every poll and periodic full rescan</span></div><div id="checks">${skBox(142, 250)}</div></section>
        <section class="panel st-checks"><div class="panel-head"><h2>Decoder checks</h2><span class="meta" id="decoder-meta">Since the last restart</span></div><div id="decoder">${skBox(142, 250)}</div></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Integrity checks</h2><span class="meta">Indexed events vs contract counters</span></div><div id="integrity">${skBox(770, 830)}</div></section>
      <section class="panel"><div class="panel-head"><h2>Definitions</h2></div><div class="doc">${DEFINITIONS.map(([title, text]) => `<div class="doc-item"><h3>${title}</h3><p>${text}</p></div>`).join('')}</div></section>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);

  function drawPipeline(h) {
    const live = h.index?.live, b = h.index?.backfill, r = h.index?.rollups, feed = h.feeds, coverage = h.index?.coverage;
    const lag = live?.finalized && live?.to ? Number(live.finalized) - Number(live.to) : null;
    const lastBlock = live?.toTs ? Date.now() / 1000 - live.toTs : null;
    const trigger = feed?.exec_events?.connected ? 'execution events' : feed?.heads?.connected ? 'WebSocket heads' : 'polling';
    morph($('pipeline'), [
      `<div class="stage"><h3>${dot(lag === null ? '' : lag < 10 && (lastBlock === null || lastBlock <= DELAYED_S) ? 'ok' : 'warn')}Live ingest</h3><div class="v">${blockNo(live?.to)}</div>${line(`${lag === null ? 'lag unknown' : `${count(lag, 'block')} behind finalized`}${live?.toTs ? ` · last block ${ago(live.toTs)}` : ''}`)}${line(`woken by ${trigger}`)}${line(`${int(live?.commits)} commits · ${int(live?.rows)} rows`)}</div>`,
      `<div class="stage"><h3>${dot(!b ? '' : b.running ? 'warn' : b.failed?.length ? 'bad' : 'ok')}History</h3><div class="v">${!b ? DASH : b.pct === null || b.pct === undefined ? '100%' : pct(b.pct, { digits: 1 })}</div>${line(`${b?.running ? `indexing · ${int(b.rate_blocks_per_s)} blocks/s` : 'complete'} · ${count(coverage?.length, 'coverage range')}`)}${line(`since block ${grouped(coverage?.[0]?.from)}`)}${topicsLine(h.index?.topics)}</div>`,
      `<div class="stage"><h3>${dot(!r ? '' : r.lastError ? 'bad' : 'ok')}Hourly rollups</h3><div class="v">${r ? `${int(r.hours)} h` : DASH}</div>${line(`${int(r?.pending)} pending${r?.lastRunMs === null || r?.lastRunMs === undefined ? '' : ` · last run ${r.lastRunMs} ms`}`)}</div>`,
      `<div class="stage"><h3>${dot(!h.snapshot ? '' : h.snapshot.status === 'fresh' ? 'ok' : 'warn')}Contract state</h3><div class="v">${blockNo(h.snapshot?.block)}</div>${line(`${esc(h.snapshot?.status ?? '')}${h.snapshot?.status_reason ? ` (${esc(h.snapshot.status_reason)})` : ''} · contract ${esc(h.snapshot?.contract_version ?? '—')}`)}${line(`${int(h.collector?.polls)} polls · ${int(h.collector?.rpc_requests)} RPC requests`)}${line(count(feed?.sse_clients, 'live viewer'))}</div>`
    ].join(''));
  }
  function drawDecoder(h) {
    const c = h.index?.decoder_checks;
    // The counts start with the process (the collector's uptime), not with the history.
    const since = h.collector?.uptime_ms ? `Since the last restart, ${dateTime(Date.now() / 1000 - h.collector.uptime_ms / 1000)} UTC` : 'Since the last restart';
    morph($('decoder-meta'), keepDots(c ? `${since} · ${int(c.logs)} logs` : since));
    if (!c) { results.decoder = []; morph($('decoder'), empty('Counted once the ingest has decoded new logs.')); return; }
    const forced = c.forcedLinked || c.takerFillsUnlinked;
    results.decoder = [!c.unlinked, !c.lotMismatch, !c.feeMismatch, forced ? !c.takerFillsUnlinked : null];
    morph($('decoder'), `<div class="stat-grid one">
      ${row(results.decoder[0], 'Position events linked to their fill', `${int(c.linked)} / ${int(c.userEvents)}`, c.unlinked ? 'warn' : 'ok')}
      ${row(results.decoder[1], 'Fill size equals the position change', count(c.lotMismatch, 'mismatch').replace(/mismatchs$/, 'mismatches'))}
      ${row(results.decoder[2], 'Fill fee equals insurance + protocol fee', `${int(c.feeChecked - c.feeMismatch)} / ${int(c.feeChecked)}`)}
      ${row(results.decoder[3], 'Liquidations linked to their book fill', forced ? `${int(c.forcedLinked)} linked · ${int(c.takerFillsUnlinked)} unlinked fills` : '<span class="faint">none since the restart</span>', forced ? (c.takerFillsUnlinked ? 'warn' : 'ok') : '')}
    </div>`);
  }
  function drawChecks(v) {
    const rec = v.reconciliation, ver = v.verification, pnl = v.pnl_agreement ?? [];
    const agree = pnl.reduce((a, x) => a + (x.agree ?? 0), 0), checked = pnl.reduce((a, x) => a + (x.checked ?? 0), 0);
    results.snapshot = [rec ? rec.ok : null, ver ? ver.ok : null, checked ? agree === checked : null];
    const rescan = ver?.ok === null ? 'could not finish' : ver ? `${ver.ok ? 'OK' : 'mismatch'} · ${int(ver.accounts)} accounts${ver.at ? ` · ${ago(ver.at / 1000)}` : ''}` : '<span class="faint">not run yet</span>';
    morph($('checks'), `<div class="stat-grid one">
      ${row(results.snapshot[0], 'Stored positions sum to the contract\'s open-interest counters', rec ? `${rec.ok ? 'OK' : 'mismatch'} · block ${grouped(rec.block)}` : '<span class="faint">not run yet</span>')}
      ${row(results.snapshot[1], 'Independent rescan of every account\'s position bitmap', rescan, ver?.ok === null ? 'warn' : undefined)}
      ${row(results.snapshot[2], 'Position PnL recomputed and compared with getPositionsV2', checked ? `${int(agree)} / ${int(checked)} agree` : '<span class="faint">no positions checked yet</span>')}
    </div>`);
  }
  function drawIntegrity(v) {
    const integ = v.integrity, ready = integ?.complete && !integ.pending && integ.block;
    // The server has nothing to compare for a moment now and then. The last table stays;
    // on a first read the skeleton holds for a few quick reads, and a note only after that.
    if (ready) { shownInteg = integ; waited = 0; }
    if (!shownInteg) {
      if (integ?.complete && ++waited < 4) { clearTimeout(again); again = setTimeout(() => load().catch(() => {}), 1500); return; }
      results.integrity = [];
      morph($('integrity'), empty(integ?.complete ? 'Waiting for the index and the contract snapshot to reach the same block.' : 'Available once the full history is indexed (the running sums need every event since deployment).'));
      return;
    }
    const shown = shownInteg, p = shown.protocol_balance;
    results.integrity = [...shown.open_interest.map(x => Boolean(x.ok)), ...(shown.tvl ? [Boolean(shown.tvl.ok)] : []), ...(p && p.status !== 'pending' ? [p.status === 'match'] : [])];
    // A relisted market shares its symbol with the old one; the id tells them apart.
    const seen = shown.open_interest.map(x => x.symbol), twin = x => seen.filter(y => y === x.symbol).length > 1;
    // The verdict sits beside the market, so a phone sees it before the table scrolls.
    morph($('integrity'), `<div class="panel-body faint st-method">${esc(shown.method)} Block ${grouped(shown.block)}.</div>` + table({ id: 'int', compact: true, columns: [
      { key: 'm', label: 'Market', render: x => `${mkt(x.market, x.symbol)}${twin(x) ? ` <span class="faint">#${esc(x.market)}</span>` : ''}` },
      { key: 'ok', label: 'Result', render: x => (x.ok ? '<span class="tag good">match</span>' : '<span class="tag bad">mismatch</span>') },
      { key: 'l', label: 'Long size (events / contract)', phone: false, n: true, tip: 'In units of the asset', render: x => `${grouped(x.events_long)} / ${grouped(x.contract_long)}` },
      { key: 's', label: 'Short size (events / contract)', phone: false, n: true, tip: 'In units of the asset', render: x => `${grouped(x.events_short)} / ${grouped(x.contract_short)}` }
    ], rows: shown.open_interest }) + (shown.tvl ? `<div class="panel-foot st-tvl"><span>${keepDots(`TVL from events ${usdFull(shown.tvl.events)} · contract ${usdFull(shown.tvl.contract)}`)}</span>${shown.tvl.ok ? '<span class="tag good">match</span>' : '<span class="tag warn">differs</span>'}</div>` : '') + protocolLine(p));
  }
  // The result of every row drawn, and how old it is. A read that failed is not a result:
  // what is on the page stays, and this line says it is the last reading.
  function drawResult(lost) {
    const at = [health?.snapshot?.generated_at, validation?.snapshot?.generated_at].filter(Boolean), when = at.length ? clock(Math.max(...at)) : null;
    if (lost) { morph($('gen'), `${dot('warn', 'A check did not answer. The page keeps asking.')}<span>Checks could not be read${when ? ` · last read ${when}` : ''}</span>`); return; }
    if (!results.integrity) return; // a total with a list missing would climb in front of the reader
    const all = [...results.snapshot, ...results.decoder, ...results.integrity].filter(x => x !== null), good = all.filter(Boolean).length;
    morph($('gen'), `${dot(good === all.length ? 'ok' : 'bad')}<span><b>Checks: ${int(good)} of ${int(all.length)} OK</b>${when ? ` · updated ${when}` : ''}</span>`);
  }

  async function load() {
    const asked = ++seq;
    const [h, v] = await Promise.allSettled([get('health', { maxAge: 0 }), get('validation', { maxAge: 0 })]);
    if (!alive || asked !== seq) return;
    // With no new answer the last one is redrawn, so the age of the last block keeps climbing.
    if (h.status === 'fulfilled') { health = h.value; drawPipeline(health); drawDecoder(health); } else if (health) drawPipeline(health); else for (const id of ['pipeline', 'decoder']) panelError($(id), h.reason.message, load);
    if (v.status === 'fulfilled') { validation = v.value; drawChecks(validation); drawIntegrity(validation); } else if (!validation) for (const id of ['checks', 'integrity']) panelError($(id), v.reason.message, load);
    drawResult(h.status === 'rejected' || v.status === 'rejected');
    if (!health && !validation) throw h.reason; // nothing on the page yet: keepTrying asks again
  }
  const stopTrying = keepTrying(load, { alive: () => alive });
  const timer = setInterval(() => { if (health || validation) load().catch(() => {}); }, 5000);
  return {
    refresh() { load().catch(() => {}); },
    destroy() { alive = false; stopTrying(); clearInterval(timer); clearTimeout(again); }
  };
}
