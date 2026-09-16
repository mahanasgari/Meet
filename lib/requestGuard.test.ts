import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { clientRateLimitKey, isSameOriginRequest } from "./requestGuard";

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/token", {
    method: "POST",
    headers,
  });
}

describe("isSameOriginRequest", () => {
  it("allows missing Origin", () => {
    expect(isSameOriginRequest(req({ host: "meet.example" }))).toBe(true);
  });

  it("allows matching Origin and Host", () => {
    expect(
      isSameOriginRequest(
        req({ host: "meet.example", origin: "https://meet.example" }),
      ),
    ).toBe(true);
  });

  it("rejects cross-origin Origin", () => {
    expect(
      isSameOriginRequest(
        req({ host: "meet.example", origin: "https://evil.example" }),
      ),
    ).toBe(false);
  });
});

describe("clientRateLimitKey", () => {
  it("prefers the first X-Forwarded-For hop", () => {
    expect(
      clientRateLimitKey(
        req({
          host: "meet.example",
          "x-forwarded-for": "1.2.3.4, 10.0.0.1",
        }),
      ),
    ).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP then Host", () => {
    expect(clientRateLimitKey(req({ host: "meet.example", "x-real-ip": "9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
    expect(clientRateLimitKey(req({ host: "meet.example" }))).toBe("meet.example");
  });
});
