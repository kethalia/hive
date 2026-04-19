const store = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  const timestamps = (store.get(key) ?? []).filter((t) => t > cutoff);

  if (timestamps.length === 0) {
    store.delete(key);
  }

  if (timestamps.length >= limit) {
    const oldestInWindow = timestamps[0]!;
    store.set(key, timestamps);
    return {
      allowed: false,
      remaining: 0,
      resetMs: oldestInWindow + windowMs - now,
    };
  }

  timestamps.push(now);
  store.set(key, timestamps);

  return {
    allowed: true,
    remaining: limit - timestamps.length,
    resetMs: windowMs,
  };
}

export const loginRateLimiter = {
  check(ip: string): RateLimitResult {
    return checkRateLimit(ip, 5, 60_000);
  },
};
