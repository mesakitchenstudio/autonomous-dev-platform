const buckets = new Map();

export function rateLimit({ key, windowMs = 60_000, max = 20 } = {}) {
  const now = Date.now();
  const current = buckets.get(key) || [];
  const fresh = current.filter(at => now - at < windowMs);
  if (fresh.length >= max) {
    buckets.set(key, fresh);
    return { ok: false, remaining: 0, retryAfterMs: windowMs - (now - fresh[0]) };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return { ok: true, remaining: max - fresh.length };
}

export function clientKey(req, action) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const ip = String(forwarded || req?.socket?.remoteAddress || 'local').split(',')[0].trim();
  return `${action}:${ip}`;
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
