import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { clientRateLimitKey, isSameOriginRequest } from "@/lib/requestGuard";
import { isValidRoomId } from "@/lib/room";

const MUSIC_BOT_URL = process.env.MUSIC_BOT_URL || "http://127.0.0.1:4100";
const ACTIONS = new Set([
  "status",
  "enqueue",
  "pause",
  "resume",
  "skip",
  "stop",
]);

function botUnavailable() {
  return NextResponse.json({ error: "music_unavailable" }, { status: 503 });
}

async function forward(
  room: string,
  action: string,
  body?: Record<string, unknown>,
) {
  const path =
    action === "status"
      ? `/rooms/${room}/status`
      : `/rooms/${room}/${action}`;
  const method = action === "status" ? "GET" : "POST";

  const response = await fetch(`${MUSIC_BOT_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return NextResponse.json(data, { status: response.status });
}

export async function GET(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const room = request.nextUrl.searchParams.get("room") ?? "";
  if (!isValidRoomId(room)) {
    return NextResponse.json({ error: "invalid_room" }, { status: 400 });
  }

  try {
    return await forward(room, "status");
  } catch {
    return botUnavailable();
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const limited = checkRateLimit(`music:${clientRateLimitKey(request)}`, {
    max: 60,
    windowMs: 60_000,
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { room?: unknown; action?: unknown; url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const room = typeof body.room === "string" ? body.room : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!isValidRoomId(room) || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    if (action === "enqueue") {
      if (typeof body.url !== "string") {
        return NextResponse.json({ error: "invalid_url" }, { status: 400 });
      }
      return await forward(room, "enqueue", { url: body.url });
    }
    if (action === "status") {
      return await forward(room, "status");
    }
    return await forward(room, action);
  } catch {
    return botUnavailable();
  }
}
