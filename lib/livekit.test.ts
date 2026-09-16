import { describe, expect, it, vi } from "vitest";
import { assertLiveKitCredentialsSafe, createJoinToken } from "./livekit";

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("createJoinToken", () => {
  it("signs a token with the identity, name and join grant", async () => {
    const token = await createJoinToken({
      apiKey: "test-key",
      apiSecret: "test-secret",
      room: "abcdef1234",
      identity: "user-1",
      name: "Alex",
    });

    expect(token.split(".")).toHaveLength(3);

    const payload = decodePayload(token);
    expect(payload.iss).toBe("test-key");
    expect(payload.sub).toBe("user-1");
    expect(payload.name).toBe("Alex");
    expect(payload.video).toMatchObject({
      room: "abcdef1234",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    expect(payload.exp).toBeGreaterThan(payload.nbf as number);
  });
});

describe("assertLiveKitCredentialsSafe", () => {
  it("allows strong credentials anywhere", () => {
    expect(() =>
      assertLiveKitCredentialsSafe(
        {
          url: "wss://livekit.example",
          apiKey: "prod-key",
          apiSecret: "prod-secret",
        },
        "production",
      ),
    ).not.toThrow();
  });

  it("allows default credentials only against local LiveKit in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() =>
      assertLiveKitCredentialsSafe(
        {
          url: "ws://localhost:7880",
          apiKey: "devkey",
          apiSecret: "local_dev_only_secret_do_not_use_in_prod",
        },
        "production",
      ),
    ).not.toThrow();
    warn.mockRestore();
  });

  it("refuses default credentials with a public LiveKit URL in production", () => {
    expect(() =>
      assertLiveKitCredentialsSafe(
        {
          url: "wss://livekit.example",
          apiKey: "devkey",
          apiSecret: "local_dev_only_secret_do_not_use_in_prod",
        },
        "production",
      ),
    ).toThrow(/default\/local LiveKit credentials/);
  });
});
