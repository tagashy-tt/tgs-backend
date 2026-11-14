// Anti-abuse helpers: in-memory sliding-window rate limits and small pure checks. No dependencies.
// The limits live in memory (one Railway instance); they slow down scripts, the database rules in trial.js are the real guard.

export function rateLimit({ windowMs, max, key = (req) => req.ip || 'unknown', name = 'rate' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, list] of hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, Math.max(1000, Math.min(windowMs, 60000)));
  timer.unref?.();

  return function limiter(req, res, next) {
    const k = String(key(req));
    const now = Date.now();
    const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      const retry = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'Too many requests', code: 'rate_limited', retryAfterSeconds: retry, limiter: name });
    }
    list.push(now);
    hits.set(k, list);
    next();
  };
}

/** A device id the app generated: 16-64 chars of [A-Za-z0-9_-]. Anything else is ignored (never trusted, never stored). */
export function cleanDeviceId(value) {
  const v = String(value || '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : '';
}

/** Flags the app may report about its own environment. Only known words are kept. */
export const KNOWN_FLAGS = ['emulator', 'rooted', 'hooked', 'tampered', 'debugger'];
export function cleanFlags(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x).toLowerCase()).filter((x) => KNOWN_FLAGS.includes(x)))].slice(0, KNOWN_FLAGS.length);
}
