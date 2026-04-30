/**
 * CRUDE INTENTIONS — Simple KV-backed rate limiter
 *
 * Sliding-window-bucket counter. For each (key, windowSeconds) pair we
 * maintain a counter at `ratelimit:{key}:{bucket}` where bucket is
 * Math.floor(epoch_seconds / windowSeconds). The key auto-expires
 * after windowSeconds * 2 so old buckets don't bloat Redis.
 *
 * Race condition note: get-then-set is non-atomic, so under heavy
 * concurrent load the effective max can briefly overshoot the
 * configured limit by a small amount. Acceptable for our scale —
 * trade a hard atomic guarantee for the ability to use the existing
 * kv abstraction.
 *
 * Fails OPEN: if KV throws, the request is allowed through with
 * remaining=maxRequests so downstream availability isn't gated on
 * the rate-limit infrastructure.
 */

import { kv } from '@/lib/kv';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current bucket rolls over. */
  resetIn: number;
}

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / windowSeconds);
  const fullKey = `ratelimit:${key}:${bucket}`;
  const resetIn = Math.max(1, (bucket + 1) * windowSeconds - nowSec);

  try {
    const current = (await kv.get<number>(fullKey)) ?? 0;
    const next = (typeof current === 'number' ? current : 0) + 1;
    await kv.set(fullKey, next, windowSeconds * 2);

    if (next > maxRequests) {
      return { allowed: false, remaining: 0, resetIn };
    }
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - next),
      resetIn,
    };
  } catch (err) {
    // Fail open — never let the rate limiter take down a route.
    console.error('[RATE-LIMIT] kv error, failing open:', err);
    return { allowed: true, remaining: maxRequests, resetIn };
  }
}

/**
 * Helper for routes that need to attach the standard X-RateLimit headers
 * to every response (200, 4xx, 5xx).
 */
export function rateLimitHeaders(rl: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset': String(rl.resetIn),
  };
}
