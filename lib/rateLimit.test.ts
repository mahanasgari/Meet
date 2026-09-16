import { afterEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rateLimit";

describe("checkRateLimit", () => {
  afterEach(() => {
    resetRateLimits();
  });

  it("allows requests under the limit", () => {
    expect(checkRateLimit("a", { max: 3, windowMs: 1000 }).ok).toBe(true);
    expect(checkRateLimit("a", { max: 3, windowMs: 1000 }).ok).toBe(true);
    expect(checkRateLimit("a", { max: 3, windowMs: 1000 }).ok).toBe(true);
  });

  it("blocks when the limit is exceeded", () => {
    const opts = { max: 2, windowMs: 60_000, now: 1_000 };
    expect(checkRateLimit("ip", opts).ok).toBe(true);
    expect(checkRateLimit("ip", { ...opts, now: 1_001 }).ok).toBe(true);
    const blocked = checkRateLimit("ip", { ...opts, now: 1_002 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("isolates keys", () => {
    const opts = { max: 1, windowMs: 60_000 };
    expect(checkRateLimit("one", opts).ok).toBe(true);
    expect(checkRateLimit("two", opts).ok).toBe(true);
    expect(checkRateLimit("one", opts).ok).toBe(false);
  });

  it("resets after the window", () => {
    expect(checkRateLimit("z", { max: 1, windowMs: 100, now: 0 }).ok).toBe(true);
    expect(checkRateLimit("z", { max: 1, windowMs: 100, now: 50 }).ok).toBe(false);
    expect(checkRateLimit("z", { max: 1, windowMs: 100, now: 101 }).ok).toBe(true);
  });
});
