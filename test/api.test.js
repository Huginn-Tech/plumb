import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, collectorOptions } from '../src/collector.js';
import { createApi } from '../src/api.js';
import { createReference } from '../src/reference.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { ClickHouseError } from '../src/clickhouse.js';

const config = { url: 'https://example.invalid', chain: '143', exchange: EXCHANGE };

async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpl-api-'));
  const webDir = join(dir, 'web'); await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Plumb</title>');
  const fake = createFakeExchange();
  fake.open(1, 5n, 0, 100000n, 10000000000n); fake.open(1, 6n, 1, 100000n, 3000000000n); fake.open(20, 7n, 0, 5000n); fake.open(20, 8n, 1, 5000n);
  fake.emit('PositionLiquidated', { perpId: 1n, posAccountId: 99n, positionType: 0, markPricePNS: 990000n, liqPricePNS: 989900n, liqLotLNS: 1000n, posLotLNS: 0n, deltaPnlCNS: -5000000n, fundingCNS: 0n, posAmountCNS: 1000n, posDepositCNS: 0n, accAmountCNS: 800n, accBalanceCNS: 1800n, onOrderBook: true }, 990n);
  const collector = createCollector({ config, options: { ...collectorOptions({ BACKFILL_BLOCKS: 100, FUNDING_HISTORY_EVENTS: 1, HEAD_TAG: 'latest', MAX_BLOCK_AGE_MS: 0 }), checkpointPath: join(dir, 'cp.json') }, rpc: fake.rpc });
  const reference = createReference({ fetcher: async () => new Response(JSON.stringify({ chain: { chain_id: 143 }, markets: [{ perpetual_id: 1, name: 'BTC', config: { is_open: true, price_decimals: 1, size_decimals: 5, initial_margin: 1500, maintenance_margin: 2500 }, state: { mrk: 1000000, oi: 100000, at: { b: 1000 } }, funding: { rate: -40, sum: -35673, feb: 999 } }] })) });
  await reference.refresh();
  const api = createApi({ collector, reference, webDir, version: 'test', ...extra });
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  return { fake, collector, api, base, get: async path => { const r = await fetch(base + path); return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; } };
}

test('API reports syncing before bootstrap and serves snapshot-pinned data after', async t => {
  const { collector, get } = await setup(t);
  const early = await get('/api/v1/overview');
  assert.equal(early.status, 503);
  assert.equal(early.body.snapshot.status, 'syncing');
  // Market views that need contract state say so too, rather than "not found".
  for (const path of ['/api/v1/markets/1/liq-levels', '/api/v1/markets/1/entries']) assert.equal((await get(path)).body.error, 'SYNCING', path);
  assert.equal((await get('/api/v1/health')).status, 200);
  await collector.bootstrap('test');
  await collector.backfillHistory();
  const overview = await get('/api/v1/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('x-snapshot-block'), '1000');
  assert.equal(overview.body.snapshot.status, 'fresh');
  assert.equal(overview.body.totals.positions, 4);
  assert.equal(overview.body.totals.all_reconciled, true);
  assert.equal(overview.body.totals.total_notional, '210000.000000'); // 2 x 1 BTC at 100k + 2 x 0.05 ETH at 100k
  const btc = overview.body.markets.find(x => x.id === 1);
  assert.equal(btc.open_interest.reconciled, true);
  assert.equal(btc.margin.maintenance_margin_pct, 4);
  assert.equal(btc.funding.direction, 'shorts pay longs');
  assert.equal(btc.reference.found, true);
  assert.equal(btc.reference.marginFractionsMatch, true);
  assert.equal(btc.reference.fundingRateMatch, true);
});

test('market detail, positions, ladder, funding and liquidations endpoints', async t => {
  const { collector, get } = await setup(t);
  await collector.bootstrap('test');
  await collector.backfillHistory();
  const detail = await get('/api/v1/markets/1?limit=1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.market.top_positions.length, 1);
  assert.equal(detail.body.market.ladder.length, 11);
  assert.ok(detail.body.market.liquidation_map.bins.length >= 1);
  assert.equal(detail.body.market.recent_liquidations.length, 1);
  assert.equal(detail.body.market.recent_liquidations[0].account_id, '99');
  const short = detail.body.market.top_positions[0];
  assert.equal(short.side, 'long');
  assert.equal(short.liquidation_price, '94000.0000000');
  const positions = await get('/api/v1/markets/1/positions?sort=risk&limit=10');
  assert.equal(positions.body.positions[0].account_id, '6'); // 3k deposit on 100k => closest to liquidation
  assert.equal((await get('/api/v1/markets/1/positions?sort=bogus')).status, 400);
  assert.equal((await get('/api/v1/markets/77')).status, 404);
  const ladder = await get('/api/v1/markets/1/ladder');
  assert.equal(ladder.body.ladder[0].shock_pct, 0.5);
  const funding = await get('/api/v1/markets/1/funding');
  assert.equal(funding.body.current.interval_blocks, '8571');
  // Analytics endpoints need the ClickHouse index (covered by the integration test).
  assert.equal((await get('/api/v1/liquidations?market=1')).status, 503);
  const validation = await get('/api/v1/validation');
  assert.equal(validation.body.reconciliation.ok, true);
  assert.equal(validation.body.metrics.delta_pnl.status, 'validated');
  const reference = await get('/api/v1/reference');
  assert.equal(reference.body.enabled, true);
  const events = await get('/api/v1/events');
  assert.equal(events.status, 200);
});

test('static dashboard is served and traversal is rejected', async t => {
  const { get } = await setup(t);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Plumb/);
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal((await get('/api/v1/nothing')).status, 404);
  // The dashboard's pages are served the page; other paths are not.
  for (const path of ['/traders', '/markets/1', '/wallet/0x5d8f00000000000000000000000000000000765a', '/compare', '/status/']) { const r = await get(path); assert.equal(r.status, 200, path); assert.match(r.body, /Plumb/, path); }
  // Other paths are not found: a page-like one gets the page (its own "Page not found"), a file stays a JSON 404.
  for (const path of ['/traders/x', '/markets/btc', '/wallets']) { const r = await get(path); assert.equal(r.status, 404, path); assert.match(r.body, /Plumb/, path); }
  assert.deepEqual((await get('/missing.js')).body, { error: 'NOT_FOUND' });
});

test('stress, book, account state, series and CSV endpoints', async t => {
  const { fake, collector, api, get, base } = await setup(t);
  fake.setBook(1, [[990000n, 100000n], [960000n, 300000n]], [[1010000n, 100000n], [1040000n, 300000n]]);
  await collector.bootstrap('test');
  await collector.refreshBook(true);
  collector.sample();
  const stress = await get('/api/v1/markets/1/stress?move_pct=-10');
  assert.equal(stress.status, 200);
  assert.equal(stress.body.side, 'long');
  assert.equal(stress.body.liquidated.count, 1); // account 5: 10x long liquidates at 6 %
  assert.equal(stress.body.liquidity.levels, 2);
  assert.equal(stress.body.liquidity.book_block !== undefined, true);
  // Entry prices: every open position lands in one bin, on its side, and the averages are size-weighted.
  const entries = await get('/api/v1/markets/1/entries');
  assert.equal(entries.status, 200);
  const binned = entries.body.bins.reduce((a, b) => a + b.long_count + b.short_count, 0);
  assert.equal(binned, entries.body.positions);
  assert.equal(entries.body.long.count + entries.body.short.count, entries.body.positions);
  assert.ok(entries.body.bins.every((b, i, all) => b.hi > b.lo && (i === 0 || b.lo >= all[i - 1].lo)));
  assert.equal((await get('/api/v1/markets/999/entries')).status, 404);
  // Liquidation levels: every position with a liquidation price within 30 % of the mark is in one band.
  const levels = await get('/api/v1/markets/1/liq-levels');
  assert.equal(levels.status, 200);
  const positions = (await get('/api/v1/markets/1/positions?limit=500')).body.positions;
  const mark = Number(levels.body.mark);
  const inRange = positions.filter(p => Number(p.liquidation_price) > 0 && Math.abs(Number(p.liquidation_price) / mark - 1) <= 0.3);
  assert.equal(levels.body.levels.reduce((a, l) => a + l.count, 0), inRange.length);
  assert.ok(levels.body.levels.every(l => l.hi > l.lo && l.top && l.top.account_id));
  assert.equal((await get('/api/v1/markets/1/stress?move_pct=0')).status, 400);
  assert.equal((await get('/api/v1/markets/1/stress?move_pct=abc')).status, 400);
  const book = await get('/api/v1/markets/1/book');
  assert.equal(book.status, 200);
  assert.equal(book.body.bids.length, 2);
  assert.equal(book.body.liquidity.depth.bids['5'].levels, 2);
  const summary = (await get('/api/v1/markets/1')).body.market;
  assert.equal(summary.liquidity.cover_at_10pct.long_pct > 0, true);
  assert.equal(summary.adl_queue.short.length, 0); // account 6 short sits at its entry price: zero PnL, excluded
  const account = await api.accountState(5);
  assert.equal(account.positions.length, 1);
  assert.equal(account.portfolio.closest_liquidation.symbol, 'BTC');
  assert.equal((await get('/api/v1/wallets/zz')).status, 404, 'wallet keys are validated by the route');
  const series = await get('/api/v1/series?hours=24');
  assert.equal(series.body.points.length, 1);
  assert.equal(series.body.points[0].positions, 4);
  const marketSeries = await get('/api/v1/series?market=1');
  assert.equal(marketSeries.body.points[0].bid_depth_2pct, '99000.000000');
  const csv = await fetch(base + '/api/v1/markets/1/positions?format=csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.match(text.split('\r\n')[0], /^account_id,side,size/);
  assert.equal(text.trim().split('\r\n').length, 3);
});

test('audit fixes: cached account record, csv headers, sort validation, headers', async t => {
  const { fake, collector, api, get, base } = await setup(t);
  fake.setBook(1, [[990000n, 100000n]], [[1010000n, 100000n]]);
  await collector.bootstrap('test');
  await collector.refreshBook(true);
  // The on-chain account record is cached per block: a repeat read makes no RPC call.
  const first = await api.accountState(5);
  const before = fake.stats.requests;
  await api.accountState(5);
  assert.equal(fake.stats.requests, before);
  assert.equal(first.positions.length, 1);
  // Positions come from the current snapshot and the record is re-read at a new block.
  fake.advance(); fake.close(1, 5n);
  await collector.poll();
  const second = await api.accountState(5);
  assert.equal(second.positions.length, 0);
  assert.notEqual(second.block, first.block);
  // CSV keeps its header when there are no rows and escapes formula-leading cells.
  const empty = await fetch(base + '/api/v1/markets/20/positions?format=csv');
  assert.match((await empty.text()).split('\r\n')[0], /^account_id,side/);
  assert.equal((await fetch(base + '/api/v1/markets/1/positions?format=csv')).headers.get('x-content-type-options'), 'nosniff');
  const { toCsv } = await import('../src/api.js');
  assert.equal(toCsv([{ a: '=SUM(1)', b: '-5.25', c: 'x,y' }]), "a,b,c\r\n'=SUM(1),-5.25,\"x,y\"\r\n");
  // Sort and side are validated against an allowlist.
  assert.equal((await get('/api/v1/markets/1/positions?sort=__proto__')).status, 400);
  assert.equal((await get('/api/v1/markets/1/positions?side=up')).status, 400);
  // Stress responses carry the block and decimals the dashboard needs; moves beyond the walked range have no depth.
  const stress = await get('/api/v1/markets/1/stress?move_pct=-30');
  assert.equal(stress.body.price_decimals, 1);
  assert.equal(stress.body.liquidity, null);
  const book = await get('/api/v1/markets/1/book');
  assert.equal(book.body.liquidity.absorption.find(r => r.shock_pct === 30).beyond_range, true);
  assert.equal(book.body.liquidity.absorption.find(r => r.shock_pct === 10).beyond_range, false);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('health: a small public body without error text; the full status at /health/full', async t => {
  const statusOf = () => ({
    index: {
      live: { to: 10, toTs: 1790000000, finalized: 9, commits: 3, rows: 4, lastError: 'CLICKHOUSE_500: Code: 60. DB::Exception' },
      backfill: { running: false, complete: true, pct: 100, total_blocks: 5, eta_s: null, rate_blocks_per_s: 1, failed: [{ from: 1, to: 2, message: 'Code: 241. Memory limit exceeded' }], last_error: { message: 'boom', at: 1 } },
      topics: { running: false, complete: true, pct: 100, rate_blocks_per_s: 2 },
      coverage: [{ from: 1, to: 10, source: 'archive' }],
      rollups: { hours: 3, pending: 0, lastRunMs: 5, lastError: { message: 'Code: 60. Table missing', at: 7 } },
      decoder_checks: { checked: 4, note: 'free text' }
    },
    alerts: { bot: 'plumb_bot', chats: 12, sent: 40 },
    feeds: { exec_events: { connected: true, lastError: 'ECONNREFUSED 10.0.0.5' }, heads: null, sse_clients: 2 },
    clickhouse: { queries: 1, errors: 1 }
  });
  const { get } = await setup(t, { statusOf });
  const pub = await get('/api/v1/health');
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.body).sort(), ['alerts', 'collector', 'feeds', 'index', 'ok', 'snapshot', 'version']);
  assert.deepEqual(Object.keys(pub.body.collector).sort(), ['polls', 'rpc_requests', 'uptime_ms']);
  assert.equal(pub.body.index.live.to, 10);
  assert.equal(pub.body.index.backfill.complete, true);
  assert.deepEqual(pub.body.index.backfill.failed, [{ from: 1, to: 2 }]);
  assert.deepEqual(pub.body.index.coverage, [{ from: 1, to: 10 }]);
  assert.deepEqual(pub.body.index.rollups.lastError, { at: 7 }, 'the status page still sees that a rollup failed');
  assert.deepEqual(pub.body.index.decoder_checks, { checked: 4 });
  assert.deepEqual(pub.body.alerts, { bot: 'plumb_bot' });
  assert.deepEqual(pub.body.feeds, { exec_events: { connected: true }, heads: null, sse_clients: 2 });
  const text = JSON.stringify(pub.body);
  for (const leak of ['Code:', 'boom', 'ECONNREFUSED', 'Memory', 'free text', 'chats', 'memory', 'clickhouse']) assert.ok(!text.includes(leak), leak);
  const full = await get('/api/v1/health/full');
  assert.equal(full.status, 200);
  assert.ok(full.body.memory.rss_mb > 0);
  assert.equal(full.body.alerts.chats, 12);
  assert.equal(full.body.clickhouse.errors, 1);
  assert.ok('errors' in full.body.collector);
});

test('health is rate limited like any other read', async t => {
  const { get } = await setup(t, { rateLimit: createRateLimiter({ perMinute: 60, burst: 2, now: () => 0 }) });
  assert.equal((await get('/api/v1/health')).status, 200);
  assert.equal((await get('/api/v1/health')).status, 200);
  const third = await get('/api/v1/health');
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'RATE_LIMITED');
});

test('one CSV export at a time; a failed export frees the slot and its database error stays in the log', async t => {
  let entered, open;
  const called = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { open = resolve; });
  const logged = [];
  const analytics = {
    leaderboard: async () => { entered(); await gate; return { rows: [{ account_id: '1', markets: [1, 20] }], meta: { window: '7d', sort: 'pnl' } }; },
    liquidations: async () => ({ rows: [{ account_id: '2' }], meta: { block: 5 } }),
    walletTrades: async () => { throw new ClickHouseError('CLICKHOUSE_500: Code: 241. DB::Exception: Memory limit (for query) exceeded', { httpStatus: 500, code: 241 }); }
  };
  const { get, base } = await setup(t, { analytics, onError: (error, path) => logged.push(`${path}: ${error.message}`) });
  const first = fetch(base + '/api/v1/leaderboard?format=csv');
  await called;
  const second = await get('/api/v1/liquidations?format=csv');
  assert.equal(second.status, 503);
  assert.deepEqual(second.body, { error: 'BUSY', retry_after_s: 5 });
  assert.equal(second.headers.get('retry-after'), '5');
  assert.equal((await get('/api/v1/liquidations')).status, 200, 'JSON reads are not held up');
  open();
  const done = await first;
  assert.equal(done.status, 200);
  assert.match(await done.text(), /^account_id,markets\r\n1,1 20/);
  const failed = await get('/api/v1/wallets/7/trades?format=csv');
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'INTERNAL_ERROR' }, 'no database text reaches the client');
  assert.match(logged.join('\n'), /wallets\/7\/trades: CLICKHOUSE_500: Code: 241/);
  assert.equal((await get('/api/v1/liquidations?format=csv')).status, 200, 'the slot is free again');
});

test('a market that does not exist is refused', async t => {
  const { collector, get } = await setup(t);
  await collector.bootstrap('test');
  for (const market of ['99', 'abc', '1e3', '-1', '__proto__', '0001234567']) {
    const r = await get(`/api/v1/series?market=${market}`);
    assert.equal(r.status, 400, market);
    assert.equal(r.body.error, 'UNKNOWN_MARKET');
  }
  assert.equal((await get('/api/v1/series?market=1')).status, 200);
  assert.equal((await get('/api/v1/series?market=')).status, 200, 'empty means every market');
});
