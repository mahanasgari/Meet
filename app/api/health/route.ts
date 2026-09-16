import { NextResponse } from "next/server";

/** Liveness probe for Docker / reverse proxies. No dependency checks. */
export async function GET() {
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
