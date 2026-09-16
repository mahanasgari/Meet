import type { NextRequest } from "next/server";

/**
 * Reject cross-origin browser POSTs. Missing Origin is allowed (curl, same-origin
 * quirks, non-browser clients) — rate limiting covers abuse there.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  const host = request.headers.get("host");
  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Best-effort client key for rate limiting (first X-Forwarded-For hop or host). */
export function clientRateLimitKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return request.headers.get("host") ?? "unknown";
}
