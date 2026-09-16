/** Simple in-memory sliding-window rate limit (single Node process). */

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec?: number;
}

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

/** Max entries before opportunistic cleanup. */
const MAX_KEYS = 5_000;

export function checkRateLimit(
  key: string,
  {
    windowMs = DEFAULT_WINDOW_MS,
    max = DEFAULT_MAX,
    now = Date.now(),
  }: { windowMs?: number; max?: number; now?: number } = {},
): RateLimitResult {
  if (buckets.size > MAX_KEYS) {
    pruneStale(now - windowMs);
  }

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }

  const cutoff = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= max) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  bucket.timestamps.push(now);
  return { ok: true };
}

/** Test helper — clears all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}

function pruneStale(cutoff: number): void {
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length === 0) {
      buckets.delete(key);
    }
  }
}
