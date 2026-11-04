// Per-client token buckets for the public API. Heavy requests (CSV exports,
// wallet comparisons, first-load wallet analytics) cost more than a plain read.
// Behind a reverse proxy the client is the last X-Forwarded-For entry, the one
// the proxy itself appended; it is trusted only from loopback peers and from
// the proxies named in TRUSTED_PROXIES (a proxy on the host reaches a container
// from the compose network's gateway, not from loopback).
import { BlockList, isIP } from 'node:net';

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export function costOf(pathname, query) {
  if (query.get('format') === 'csv') return 10;
  if (pathname === '/api/v1/compare') return 10;
  if (/^\/api\/v1\/wallets\/[^/]+\/analytics$/.test(pathname)) return 3;
  return 1;
}

// "172.18.0.1, 10.0.0.0/8, ::1": IPv4 or IPv6 addresses and CIDR ranges.
// Anything else is a configuration error, refused at start.
export function parseTrustedProxies(text) {
  const entries = String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)))) throw new Error(`INVALID_TRUSTED_PROXIES: ${entry}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(address, type); else list.addSubnet(address, Number(bits), type);
  }
  return list;
}

function trusted(peer, trustedProxies) {
  if (LOOPBACK.test(peer)) return true;
  if (!trustedProxies) return false;
  const plain = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(peer)?.[1] ?? peer; // an IPv4 peer on a dual-stack socket
  const family = isIP(plain);
  return family !== 0 && trustedProxies.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

export function clientOf(req, { trustProxy = true, trustedProxies = null } = {}) {
  const peer = req.socket?.remoteAddress ?? '';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (trustProxy && forwarded && trusted(peer, trustedProxies)) {
    const last = String(forwarded).split(',').map(s => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return peer || 'unknown';
}

// Which peers may name the client (TRUST_PROXY=0 trusts none, not even loopback).
export function proxyTrustFromEnv(env) {
  return { trustProxy: env.TRUST_PROXY !== '0', trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES) };
}

export function createRateLimiter({ perMinute = 600, burst = 120, trustProxy = true, trustedProxies = null, maxClients = 20000, now = () => Date.now() } = {}) {
  const rate = perMinute / 60000; // tokens per ms
  const buckets = new Map(); // client -> { tokens, at }
  function refill(b, t) { b.tokens = Math.min(burst, b.tokens + (t - b.at) * rate); b.at = t; }
  function prune(t) {
    for (const [k, b] of buckets) { refill(b, t); if (b.tokens >= burst) buckets.delete(k); }
    // Still over the cap (a flood of distinct clients): drop the oldest entries.
    for (const k of buckets.keys()) { if (buckets.size <= maxClients) break; buckets.delete(k); }
  }
  return {
    get clients() { return buckets.size; },
    // { ok, remaining, retryAfterS }
    take(client, cost = 1) {
      const t = now();
      let b = buckets.get(client);
      if (!b) { if (buckets.size >= maxClients) prune(t); b = { tokens: burst, at: t }; buckets.set(client, b); } else refill(b, t);
      if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens), retryAfterS: 0 }; }
      return { ok: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil((cost - b.tokens) / rate / 1000)) };
    },
    check(req, pathname, query) { return this.take(clientOf(req, { trustProxy, trustedProxies }), costOf(pathname, query)); }
  };
}

export function rateLimitFromEnv(env, trust = proxyTrustFromEnv(env)) {
  const perMinute = Number(env.RATE_LIMIT_PER_MIN ?? 600);
  if (!(perMinute > 0)) return null;
  return createRateLimiter({ perMinute, burst: Number(env.RATE_LIMIT_BURST ?? 120) || 120, ...trust });
}

// One heavy job at a time app-wide (CSV exports, a protocol balance at a past
// block): enter() hands back the release, or null while another job holds it.
export function createSlot() {
  let held = false;
  return {
    get busy() { return held; },
    enter() {
      if (held) return null;
      held = true;
      let released = false;
      return () => { if (!released) { released = true; held = false; } };
    }
  };
}
