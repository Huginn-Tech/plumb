// API client: JSON GETs with a short in-memory cache and request coalescing,
// plus the server-sent event stream shared by all views.
const cache = new Map(); // url -> { at, data, pending }

// Display names: a relisted market ('SOL_v2') is shown as its asset ('SOL');
// the delisted original is tagged inactive where markets are listed. The API
// itself keeps the contract's symbols.
const RELISTED = /\b([A-Z][A-Z0-9]{1,9})[_-]v\d+\b/g;
export function displayNames(value) {
  if (typeof value === 'string') return value.includes('_v') || value.includes('-v') ? value.replace(RELISTED, '$1') : value;
  if (Array.isArray(value)) return value.map(displayNames);
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = displayNames(value[k]); return value; }
  return value;
}

// A failure in words: no code or browser message reaches the screen. The API's
// code stays on the error as .code, its HTTP status as .status.
const WORDS = { RATE_LIMITED: 'Too many requests', SYNCING: 'The index is catching up', INVALID_ACCOUNT: 'Not a full address or account ID', NOT_FOUND: 'Not found' };
const failure = (status, code) => Object.assign(new Error(WORDS[code] ?? (status >= 400 && status < 500 ? 'This request was not accepted' : 'Data service unavailable')), { status, code });

// A page opening takes the last answer there is, up to 10 minutes old, in place of a
// skeleton. The router opens this window around the mount of a view that has a
// refresh(), and calls that refresh when the window was used.
const STALE_CAP_MS = 600000;
let staleOpen = false, staleUsed = false;
export const openStale = () => { staleOpen = true; staleUsed = false; };
export const closeStale = () => { staleOpen = false; return staleUsed; };

export async function get(path, { maxAge = 1500, signal } = {}) {
  const hit = cache.get(path);
  if (hit?.data && Date.now() - hit.at < maxAge) return hit.data;
  if (staleOpen && hit?.data && Date.now() - hit.at < STALE_CAP_MS) { staleUsed = true; return hit.data; }
  if (hit?.pending) return hit.pending;
  const pending = fetch(`/api/v1/${path}`, { signal, headers: { accept: 'application/json' } }).catch(error => { throw error.name === 'AbortError' ? error : failure(undefined, 'NETWORK'); }).then(async res => {
    const body = displayNames(await res.json().catch(() => ({})));
    if (!res.ok) throw failure(res.status, body.error);
    cache.set(path, { at: Date.now(), data: body });
    return body;
  }).finally(() => { const cur = cache.get(path); if (cur) cur.pending = null; });
  cache.set(path, { ...(hit ?? {}), pending });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return pending;
}
export const invalidate = prefix => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

// One EventSource for the page; views subscribe to named events.
const handlers = new Map();
let source = null, lost = false;
export const stream = {
  status: 'connecting',
  on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event)?.delete(fn); },
  emit(event, data) { for (const fn of handlers.get(event) ?? []) { try { fn(data); } catch (error) { console.error(error); } } },
  connect() {
    if (source) return;
    const es = source = new EventSource('/api/v1/stream');
    source.onopen = () => { const back = lost; lost = false; this.status = 'open'; this.emit('status', 'open'); if (back) this.emit('resumed'); };
    source.onerror = () => {
      lost = true; this.status = 'reconnecting'; this.emit('status', 'reconnecting');
      // The browser retries a dropped connection by itself, but a non-200 answer (a
      // deploy, a full server) ends the stream for good: reopen it, each tab at its own time.
      if (es.readyState === EventSource.CLOSED) { source = null; setTimeout(() => this.connect(), 5000 + Math.random() * 5000); }
    };
    for (const name of ['block', 'trades', 'liquidations', 'protocol', 'backfill', 'proposed', 'stage']) source.addEventListener(name, e => { let data; try { data = displayNames(JSON.parse(e.data)); } catch { return; } this.emit(name, data); });
  }
};
