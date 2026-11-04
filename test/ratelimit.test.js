import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, clientOf, costOf, rateLimitFromEnv, parseTrustedProxies, proxyTrustFromEnv, createSlot } from '../src/ratelimit.js';

const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('a burst is allowed, then requests wait for the refill', () => {
  let t = 0;
  const rl = createRateLimiter({ perMinute: 60, burst: 3, now: () => t });
  assert.ok(rl.take('a').ok); assert.ok(rl.take('a').ok); assert.ok(rl.take('a').ok);
  const denied = rl.take('a');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterS, 1);
  assert.ok(rl.take('b').ok, 'clients have separate buckets');
  t = 1000;
  assert.ok(rl.take('a').ok, 'one token back after a second at 60/min');
  assert.equal(rl.take('a').ok, false);
});

test('heavy requests cost more', () => {
  assert.equal(costOf('/api/v1/protocol', new URLSearchParams('window=7d')), 1);
  assert.equal(costOf('/api/v1/leaderboard', new URLSearchParams('format=csv')), 10);
  assert.equal(costOf('/api/v1/compare', new URLSearchParams('w=1,2')), 10);
  assert.equal(costOf('/api/v1/wallets/0xabc/analytics', new URLSearchParams()), 3);
  const rl = createRateLimiter({ perMinute: 60, burst: 12, now: () => 0 });
  assert.ok(rl.take('a', 10).ok);
  assert.equal(rl.take('a', 10).ok, false);
  assert.ok(rl.take('a', 1).ok);
});

test('the forwarded client is trusted only from a loopback proxy', () => {
  assert.equal(clientOf(req('127.0.0.1', '1.2.3.4, 5.6.7.8')), '5.6.7.8', 'last hop is the one nginx appended');
  assert.equal(clientOf(req('::ffff:127.0.0.1', '9.9.9.9')), '9.9.9.9');
  assert.equal(clientOf(req('203.0.113.7', '1.2.3.4')), '203.0.113.7', 'a direct client cannot pick its own key');
  assert.equal(clientOf(req('127.0.0.1', '1.2.3.4'), { trustProxy: false }), '127.0.0.1');
});

test('the client table stays bounded', () => {
  const rl = createRateLimiter({ perMinute: 60, burst: 5, maxClients: 100, now: () => 0 });
  for (let i = 0; i < 1000; i++) rl.take(`c${i}`);
  assert.ok(rl.clients <= 101);
});

test('configuration from the environment; zero disables', () => {
  assert.equal(rateLimitFromEnv({ RATE_LIMIT_PER_MIN: '0' }), null);
  assert.ok(rateLimitFromEnv({}));
});

test('TRUSTED_PROXIES names the proxies, such as the compose network gateway, that may name the client', () => {
  const trust = proxyTrustFromEnv({ TRUSTED_PROXIES: '172.18.0.1, 10.20.0.0/16, fd00::/8' });
  assert.equal(clientOf(req('172.18.0.1', '1.2.3.4, 5.6.7.8'), trust), '5.6.7.8', 'a named proxy');
  assert.equal(clientOf(req('::ffff:172.18.0.1', '5.6.7.8'), trust), '5.6.7.8', 'the same proxy on a dual-stack socket');
  assert.equal(clientOf(req('10.20.3.4', '5.6.7.8'), trust), '5.6.7.8', 'inside a named range');
  assert.equal(clientOf(req('fd00::17', '5.6.7.8'), trust), '5.6.7.8', 'an IPv6 range');
  assert.equal(clientOf(req('172.18.0.2', '5.6.7.8'), trust), '172.18.0.2', 'a neighbour of the proxy is not trusted');
  assert.equal(clientOf(req('10.21.0.1', '5.6.7.8'), trust), '10.21.0.1');
  assert.equal(clientOf(req('127.0.0.1', '5.6.7.8'), trust), '5.6.7.8', 'loopback stays trusted');
  assert.equal(clientOf(req('172.18.0.1'), trust), '172.18.0.1', 'without the header the peer is the client');
  assert.equal(clientOf(req('172.18.0.1', '5.6.7.8'), { ...trust, trustProxy: false }), '172.18.0.1', 'TRUST_PROXY=0 trusts nobody');
  assert.equal(clientOf(req('172.18.0.1', '5.6.7.8')), '172.18.0.1', 'without the list only loopback is trusted');
  const rl = rateLimitFromEnv({ RATE_LIMIT_PER_MIN: '60', RATE_LIMIT_BURST: '1', TRUSTED_PROXIES: '172.18.0.1' });
  assert.ok(rl.check(req('172.18.0.1', '5.6.7.8'), '/api/v1/overview', new URLSearchParams()).ok);
  assert.ok(rl.check(req('172.18.0.1', '9.9.9.9'), '/api/v1/overview', new URLSearchParams()).ok, 'clients behind the proxy have their own buckets');
  assert.equal(rl.check(req('172.18.0.1', '5.6.7.8'), '/api/v1/overview', new URLSearchParams()).ok, false);
});

test('TRUSTED_PROXIES: empty means none, and a malformed entry stops the start', () => {
  assert.equal(parseTrustedProxies(undefined), null);
  assert.equal(parseTrustedProxies(' , '), null);
  for (const bad of ['172.18.0.1/33', 'example.com', '172.18.0/24', '10.0.0.0/8/1', 'fd00::/129', '172.18.0.1/x']) {
    assert.throws(() => parseTrustedProxies(bad), /INVALID_TRUSTED_PROXIES/, bad);
  }
});

test('a slot lets one heavy job run at a time', () => {
  const slot = createSlot();
  const release = slot.enter();
  assert.ok(release);
  assert.equal(slot.busy, true);
  assert.equal(slot.enter(), null, 'a second job is refused while the first runs');
  release();
  release(); // releasing twice frees it once
  assert.equal(slot.busy, false);
  const next = slot.enter();
  assert.ok(next);
  assert.equal(slot.enter(), null);
  next();
});
