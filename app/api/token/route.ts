import { NextRequest, NextResponse } from "next/server";
import { sanitizeDisplayName } from "@/lib/errors";
import { createJoinToken, readLiveKitConfig } from "@/lib/livekit";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientRateLimitKey, isSameOriginRequest } from "@/lib/requestGuard";
import { isValidRoomId } from "@/lib/room";

const MAX_BODY_BYTES = 4_096;

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const limited = checkRateLimit(clientRateLimitKey(request));
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(limited.retryAfterSec ?? 60),
        },
      },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { room, name } = (body ?? {}) as { room?: unknown; name?: unknown };

  if (typeof room !== "string" || !isValidRoomId(room)) {
    return NextResponse.json({ error: "invalid_room" }, { status: 400 });
  }

  if (typeof name !== "string") {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  const displayName = sanitizeDisplayName(name);
  if (displayName.length < 1 || displayName.length > 40) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  try {
    const { url, apiKey, apiSecret } = readLiveKitConfig();
    const token = await createJoinToken({
      apiKey,
      apiSecret,
      room,
      identity: crypto.randomUUID(),
      name: displayName,
    });

    return NextResponse.json({ token, url });
  } catch (error) {
    console.error("Failed to create LiveKit token:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
