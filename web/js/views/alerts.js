// Alerts: the Telegram bot (what it sends, one tap to open it) above the
// watchlist of wallets starred in this browser, each with a link that starts
// watching it in Telegram. The watchlist itself stays in this browser only.
import { get } from '../api.js';
import { usdShort, usdFull, int, esc, short, ago, dateTime, num, pct } from '../format.js';
import { table, pnlShort, empty, skRows, watch, ICON, alertsLink, alertsBotReady, alertsBotName, setAlertsBot, morph, panelError, keepTrying, DASH } from '../ui.js';

const FEATURES = [
  ['👛', 'Your wallets', 'Every position change: open, add, reduce, close, liquidation.'],
  ['🚨', 'Before liquidation', 'A warning as a position nears its liquidation price, at the levels you pick.'],
  ['📍', 'Positions on demand', 'Each watched wallet\'s positions now, closest to liquidation first.'],
  ['💥', 'Market moves', 'Large liquidations, large trades and funding flips, above sizes you pick.']
];
const NO_WALLETS = 'No wallets yet. Star a wallet from the leaderboard, a feed or a wallet page.';
// A table amount, with the exact figure in its hover note.
const amount = v => (num(v) === null ? DASH : `<span title="${esc(usdFull(v))}">${usdShort(v)}</span>`);
// A 4xx names the wallet itself: it stays as it is. Anything else can pass.
const lasting = e => e.status >= 400 && e.status < 500 && e.status !== 429;

export function mount(el, { navigate }) {
  // The bot's name comes with /health. Until that answers, nothing is known about it:
  // no bot and no answer are different things, and each says so in the same slot.
  let alive = true, bot = alertsBotName(), known = Boolean(bot), noAnswer = false, seq = 0;
  const first = watch.list();
  el.innerHTML = `<div class="page-head"><div><h1>Alerts</h1><div class="sub">Watch wallets here, and get their moves in Telegram as they land onchain.</div></div></div>
    <section class="panel alerts-hero" id="bot"></section>
    <section class="panel al-watch"><div class="panel-head"><div><h2>Watchlist</h2><div class="desc">Wallets you star are kept in this browser only; the bell starts watching one in Telegram</div></div><button class="btn ghost" data-action="compare"${first.length ? '' : ' disabled'}>${ICON.plus} Compare all</button></div>
      <div class="panel-body flush" id="list">${first.length ? skRows(first.length) : empty(NO_WALLETS)}</div></section>`;
  const $ = s => el.querySelector(`#${s}`);

  // A sample of what the bot sends, drawn as a chat bubble.
  const sample = `<div class="tg-bubble" aria-hidden="true">
      <div class="tg-line">🚨 <b>BTC long near liquidation</b>  <span class="tg-link">#BTC</span></div>
      <div class="tg-line"><b>Distance:</b> 2.6%</div>
      <div class="tg-line"><b>Mark → liq:</b> 84,419.3 → 82,252.5</div>
      <div class="tg-line"><b>Position:</b> $478</div>
      <div class="tg-line"><b>Wallet:</b> <span class="tg-link">0xcfe9…b477</span></div>
      <div class="tg-time">15:55</div>
    </div>`;
  const cta = () => {
    if (bot) return `<a class="btn primary" href="${esc(`https://t.me/${bot}`)}" target="_blank" rel="noopener noreferrer">Open @${esc(bot)} ${ICON.ext}</a><span class="faint">Free · send it a wallet address to start</span>`;
    return known ? '<span class="faint">Telegram alerts are not enabled on this server.</span>' : '<span class="skeleton sk-in al-wait"></span>';
  };
  function renderBot() {
    morph($('bot'), `<div class="alerts-grid">
      <div class="alerts-copy">
        <div class="alerts-kicker">${ICON.bell} Telegram bot${bot ? ` · @${esc(bot)}` : ''}</div>
        <h2>Alerts for the wallets you watch</h2>
        <div class="alerts-features">${FEATURES.map(([i, t, d]) => `<div class="alerts-f"><span class="alerts-fi">${i}</span><div><b>${t}</b><span>${d}</span></div></div>`).join('')}</div>
        <div class="alerts-cta" id="bot-cta">${cta()}</div>
      </div>
      <div class="alerts-demo">${sample}</div>
    </div>`);
    if (!known && noAnswer) panelError($('bot-cta'), 'Could not check the Telegram bot', askBot);
  }
  const askBot = () => get('health', { maxAge: 5000 }).then(h => { setAlertsBot(h.alerts?.bot); });

  // The last answer per wallet: a refresh that fails keeps it, and only a wallet never
  // read shows its gap, with an amber dot.
  const last = new Map();
  async function load({ fresh = false } = {}) {
    const asked = ++seq, list = watch.list();
    el.querySelector('[data-action="compare"]').disabled = !list.length;
    if (!list.length) { morph($('list'), empty(NO_WALLETS)); return; }
    const reads = await Promise.all(list.map(w => get(`wallets/${encodeURIComponent(w.key)}`, { maxAge: fresh ? 0 : 10000 }).then(d => { last.set(w.key, d); return { key: w.key, d }; }).catch(e => ({ key: w.key, d: last.get(w.key) ?? null, error: e }))));
    if (!alive || asked !== seq) return;
    const down = reads.find(r => r.error && !lasting(r.error))?.error;
    if (down && reads.every(r => !r.d)) throw down; // nothing to show: the list says so, once
    morph($('list'), table({ id: 'watch', columns: [
      { key: 'a', label: 'Wallet', render: r => `<span class="addr"><a class="mono" href="/wallet/${esc(r.d?.account?.address ?? r.key)}">${esc(short(r.d?.account?.address ?? r.key))}</a><button class="icon-btn on" data-watch="${esc(r.key)}" title="Remove from watchlist">${ICON.star}</button>${r.d ? '' : `<span class="status-dot warn" title="${esc(lasting(r.error) ? r.error.message : 'Could not read this wallet')}"></span>`}</span>` },
      { key: 'v', label: 'Account value', n: true, render: r => amount(r.d?.portfolio?.account_value) },
      { key: 'o', label: 'Open positions', phone: false, n: true, render: r => (r.d ? int(r.d.positions?.length ?? 0) : DASH) }, // a wallet that failed to load: unknown, not none
      { key: 'c', label: 'Liq. distance', n: true, tip: 'Mark price move that reaches the closest liquidation price among this wallet’s positions', render: r => { const d = r.d?.portfolio?.closest_liquidation?.distance_pct ?? null; return d === null ? DASH : `<span class="${d < 5 ? 'neg' : d < 15 ? 'warn-text' : 'muted'}">${pct(d, { digits: 1 })}</span>`; } },
      { key: 'u', label: 'Unrealized PnL', phone: false, n: true, render: r => pnlShort(r.d?.portfolio?.unrealized_pnl) },
      { key: 'p', label: 'Net PnL', phone: false, n: true, render: r => pnlShort(r.d?.summary?.net_pnl) },
      { key: 'l', label: 'Last trade', phone: false, n: true, render: r => (r.d?.summary?.last_trade ? `<span class="muted" title="${esc(dateTime(r.d.summary.last_trade))} UTC">${ago(r.d.summary.last_trade)}</span>` : DASH) },
      { key: 't', label: '', n: true, render: r => { const link = alertsLink(r.d?.account?.address ?? r.key); return link ? `<a class="btn ghost sm al-bell" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Watch this wallet in Telegram" aria-label="Alert me">${ICON.bell} <span>Alert me</span></a>` : ''; } }
    ], rows: reads, rowAttrs: r => `class="link" data-href="/wallet/${esc(r.d?.account?.address ?? r.key)}"` }));
    if (down) throw down; // drawn with what there is; the rest is asked for again
  }
  let stopList = () => {};
  const showList = (opts = {}) => {
    stopList();
    stopList = keepTrying(() => load(opts), { alive: () => alive, fail: e => { if (!$('list').querySelector('table')) panelError($('list'), e.message, () => load({ fresh: true })); } });
  };
  const onChange = () => showList();
  window.addEventListener('watchlist', onChange);
  renderBot();
  // The first answer that names the bot, or says there is none, redraws the card and the links.
  alertsBotReady.then(() => { if (!alive) return; known = true; noAnswer = false; bot = alertsBotName(); renderBot(); showList(); });
  const stopBot = known ? () => {} : keepTrying(askBot, { alive: () => alive, fail: () => { if (!known && !noAnswer) { noAnswer = true; renderBot(); } } });
  showList();
  return {
    onAction(a) { if (a === 'compare') navigate('/compare', { w: watch.list().slice(0, 5).map(w => w.key).join(',') }); },
    refresh() { showList({ fresh: true }); },
    destroy() { alive = false; stopBot(); stopList(); window.removeEventListener('watchlist', onChange); }
  };
}
