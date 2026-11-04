import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecEvents, createSse, keepConnected } from '../src/live.js';
import { makeLog } from './helpers/logs.js';

const EXCHANGE = '0x34b6552d57a35a1d042ccae1951bd1c370112a6f';

test('execution events: logs are grouped per proposed block, re-ordered, and finalization is reported', () => {
  const proposed = [], finalized = [];
  const feed = createExecEvents({ url: 'ws://unused', exchange: EXCHANGE, onProposed: p => proposed.push(p), onFinalized: n => finalized.push(n), WebSocketImpl: null });
  const a = makeLog('CollateralDeposit', { accountId: 5n, amountCNS: 10n, balanceCNS: 10n }, { block: 7, tx: 1, logIndex: 0 });
  const b = makeLog('CollateralWithdrawal', { accountId: 5n, amountCNS: 3n, balanceCNS: 7n }, { block: 7, tx: 2, logIndex: 1 });
  const txLog = (log, txIndex) => ({ event_name: 'TxnLog', block_number: 7, txn_idx: txIndex, txn_hash: log.transactionHash, payload: { type: 'TxnLog', txn_index: txIndex, log_index: 0, address: EXCHANGE, topics: '0x' + log.topics.map(t => t.slice(2)).join(''), data: log.data } });
  feed.handleEvent({ event_name: 'BlockStart', block_number: 7, payload: { type: 'BlockStart', block_number: 7, block_id: '0x01', timestamp: 1790000007 } });
  feed.handleEvent(txLog(b, 2)); // arrives first: transactions interleave
  feed.handleEvent(txLog(a, 1));
  feed.handleEvent({ event_name: 'TxnLog', block_number: 7, txn_idx: 3, payload: { type: 'TxnLog', txn_index: 3, log_index: 0, address: '0x0000000000000000000000000000000000000001', topics: '0x', data: '0x' } });
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 7, payload: { type: 'BlockEnd' } });
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].logs.map(l => l.transactionIndex), [1, 2], 'restored to chain order, other contracts ignored');
  assert.equal(proposed[0].logs[0].topics[0], a.topics[0]);
  feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0x01', block_number: 7 } });
  assert.deepEqual(finalized, [7]);
});

test('execution events: blocks that carried exchange logs report voted and finalized, timed from their start', () => {
  const stages = [];
  let t = 1000;
  const feed = createExecEvents({ url: 'ws://unused', exchange: EXCHANGE, onStage: s => stages.push(s), WebSocketImpl: null, now: () => t });
  const log = makeLog('CollateralDeposit', { accountId: 5n, amountCNS: 10n, balanceCNS: 10n }, { block: 8, tx: 1, logIndex: 0 });
  const start = (n, id) => feed.handleEvent({ event_name: 'BlockStart', block_number: n, payload: { type: 'BlockStart', block_number: n, block_id: id, timestamp: 1790000008 } });
  start(8, '0xAA');
  feed.handleEvent({ event_name: 'TxnLog', block_number: 8, txn_idx: 1, payload: { type: 'TxnLog', txn_index: 1, log_index: 0, address: EXCHANGE, topics: '0x' + log.topics.map(x => x.slice(2)).join(''), data: log.data } });
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 8, payload: { type: 'BlockEnd' } });
  start(9, '0xbb'); // no exchange logs: no stages reported
  feed.handleEvent({ event_name: 'BlockEnd', block_number: 9, payload: { type: 'BlockEnd' } });
  t = 1420; feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xaa', block_number: 8, round: 1 } });
  feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xaa', block_number: 8, round: 1 } }); // repeated: once
  feed.handleEvent({ event_name: 'BlockQC', payload: { type: 'BlockQC', block_id: '0xbb', block_number: 9, round: 2 } });
  t = 1810; feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0xaa', block_number: 8 } });
  feed.handleEvent({ event_name: 'BlockFinalized', payload: { type: 'BlockFinalized', block_id: '0xbb', block_number: 9 } });
  assert.deepEqual(stages.map(s => [s.block, s.stage, s.ms]), [[8, 'voted', 420], [8, 'finalized', 810]]);
});

test('server-sent events reach every open client in order', () => {
  const sse = createSse({ heartbeatMs: 60000 });
  const writes = [];
  const res = { writeHead() {}, write: text => writes.push(text), end() {} };
  const req = { on() {} };
  sse.open(req, res);
  sse.send('block', { block: 10n });
  sse.send('trades', [{ price: '1.0' }]);
  assert.equal(sse.clients, 1);
  assert.match(writes.at(-2), /^id: 1\nevent: block\ndata: \{"block":"10"\}\n\n$/);
  assert.match(writes.at(-1), /event: trades/);
  sse.close();
});

// A stream end point that records its status and lets the test close it.
function stream(peer, { buffered = 0 } = {}) {
  const closers = [];
  const req = { socket: { remoteAddress: peer }, on: (event, fn) => { if (event === 'close') closers.push(fn); } };
  const res = { status: null, ended: false, destroyed: false, writableLength: buffered, writeHead(code) { this.status = code; }, write() {}, end() { this.ended = true; }, destroy() { this.destroyed = true; } };
  return { req, res, close: () => closers.forEach(fn => fn()) };
}

test('server-sent events: each client gets a few streams, and a closed stream frees its slot', () => {
  const sse = createSse({ heartbeatMs: 60000, maxPerClient: 8 });
  const mine = Array.from({ length: 8 }, () => stream('203.0.113.7'));
  for (const s of mine) sse.open(s.req, s.res);
  assert.ok(mine.every(s => s.res.status === 200));
  const ninth = stream('203.0.113.7');
  sse.open(ninth.req, ninth.res);
  assert.equal(ninth.res.status, 429, 'the ninth stream from one client is refused');
  assert.ok(ninth.res.ended);
  const other = stream('198.51.100.2');
  sse.open(other.req, other.res);
  assert.equal(other.res.status, 200, 'other clients are not affected');
  assert.equal(sse.clients, 9);
  mine[0].close();
  mine[0].close(); // a second close event changes nothing
  const again = stream('203.0.113.7');
  sse.open(again.req, again.res);
  assert.equal(again.res.status, 200, 'a closed stream frees its slot');
  assert.equal(sse.clients, 9);
  sse.close();
});

test('server-sent events: the total cap still applies, and the per-client key comes from clientOf', () => {
  const sse = createSse({ heartbeatMs: 60000, maxClients: 3, maxPerClient: 2, clientOf: req => req.headers.who });
  const open = who => { const s = stream('127.0.0.1'); s.req.headers = { who }; sse.open(s.req, s.res); return s.res.status; };
  assert.deepEqual([open('a'), open('a'), open('a'), open('b'), open('c')], [200, 200, 429, 200, 503]);
  sse.close();
});

test('server-sent events: a client that stops reading is dropped once its backlog passes the limit', () => {
  const sse = createSse({ heartbeatMs: 60000, maxBufferedBytes: 1000 });
  const slow = stream('203.0.113.7', { buffered: 0 }), fast = stream('198.51.100.2');
  sse.open(slow.req, slow.res);
  sse.open(fast.req, fast.res);
  sse.send('block', { block: 1 });
  assert.equal(sse.clients, 2);
  slow.res.writableLength = 300 * 1024;
  sse.send('block', { block: 2 });
  assert.ok(slow.res.destroyed, 'the stalled stream is closed');
  assert.ok(!fast.res.destroyed);
  assert.equal(sse.clients, 1);
  slow.close(); // its close event after the drop is harmless
  assert.equal(sse.clients, 1);
  sse.close();
});

// A fake WebSocket and clock for the reconnect layer.
function fakeSockets() {
  const made = [];
  class FakeSocket { constructor(url) { this.url = url; this.closed = false; made.push(this); } close() { if (this.closed) return; this.closed = true; setImmediate(() => this.onclose?.()); } send() {} }
  return { made, FakeSocket };
}
function fakeTimers() {
  let t = 0; const due = [];
  const timers = {
    setTimeout: (fn, ms) => { const x = { at: t + ms, fn }; due.push(x); return x; },
    clearTimeout: x => { const i = due.indexOf(x); if (i >= 0) due.splice(i, 1); },
    setInterval: (fn, ms) => { const x = { every: ms, at: t + ms, fn }; due.push(x); return x; },
    clearInterval: x => { const i = due.indexOf(x); if (i >= 0) due.splice(i, 1); }
  };
  const advance = async ms => {
    const end = t + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next || next.at > end) break;
      t = next.at;
      if (next.every) next.at += next.every; else due.shift();
      next.fn();
      await new Promise(r => setImmediate(r));
    }
    t = end;
  };
  return { timers, advance, now: () => t };
}

test('reconnect layer: a stalled handshake and a silent socket are both retried, once each', async () => {
  const { made, FakeSocket } = fakeSockets();
  const clock = fakeTimers();
  const downs = [];
  const conn = keepConnected({ url: 'ws://x', WebSocketImpl: FakeSocket, openTimeoutMs: 15000, idleMs: 60000, now: clock.now, timers: clock.timers, onDown: d => downs.push(d.reason) });
  conn.start();
  assert.equal(made.length, 1);
  await clock.advance(20000);                  // never opens: closed and retried
  assert.equal(downs[0], 'connect timeout');
  await clock.advance(1000);
  assert.equal(made.length, 2, 'one new attempt, not two');
  made[1].onopen(); made[1].onmessage({ data: '{}' });
  await clock.advance(30000);
  assert.equal(made.length, 2, 'an open socket with traffic stays');
  await clock.advance(40000);                  // a minute of silence
  assert.equal(downs[1], 'no messages');
  made[0].onclose?.();                         // a late close from the first socket changes nothing
  await clock.advance(2000);
  assert.equal(made.length, 3);
  assert.equal(downs.length, 2);
  conn.stop();
});
