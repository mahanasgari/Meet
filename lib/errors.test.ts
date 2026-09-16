import { describe, expect, it } from "vitest";
import { ConnectionError, ConnectionErrorReason } from "livekit-client";
import {
  connectErrorMessage,
  sanitizeDisplayName,
  tokenErrorFromBody,
  UserMessage,
  validateDisplayName,
} from "./errors";

describe("sanitizeDisplayName", () => {
  it("strips control and bidi characters", () => {
    expect(sanitizeDisplayName("Al\u0000ex\u202E")).toBe("Alex");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeDisplayName("  Ann   Marie  ")).toBe("Ann Marie");
  });
});

describe("validateDisplayName", () => {
  it("rejects empty names", () => {
    expect(validateDisplayName("")).toBe("Please enter a display name.");
    expect(validateDisplayName("   ")).toBe("Please enter a display name.");
    expect(validateDisplayName("\u200B\u200B")).toBe(
      "Please enter a display name.",
    );
  });

  it("rejects names over 40 characters", () => {
    expect(validateDisplayName("x".repeat(41))).toBe(UserMessage.invalidName);
  });

  it("accepts normal names", () => {
    expect(validateDisplayName(" Alex ")).toBeNull();
  });
});

describe("tokenErrorFromBody", () => {
  it("maps known codes without exposing internals", () => {
    expect(tokenErrorFromBody(400, { error: "invalid_room" })).toBe(
      UserMessage.invalidRoom,
    );
    expect(tokenErrorFromBody(400, { error: "invalid_name" })).toBe(
      UserMessage.invalidName,
    );
    expect(tokenErrorFromBody(429, { error: "rate_limited" })).toBe(
      UserMessage.tooManyRequests,
    );
    expect(tokenErrorFromBody(500, { error: "server_error" })).toBe(
      UserMessage.serverUnavailable,
    );
  });

  it("never returns raw server text", () => {
    const message = tokenErrorFromBody(500, {
      error: "ECONNREFUSED 127.0.0.1:7880",
    });
    expect(message).toBe(UserMessage.serverUnavailable);
    expect(message).not.toMatch(/ECONNREFUSED|7880/);
  });
});

describe("connectErrorMessage", () => {
  it("maps LiveKit connection failures", () => {
    expect(
      connectErrorMessage(ConnectionError.timeout("room connection timed out")),
    ).toBe(UserMessage.timedOut);
    expect(
      connectErrorMessage(ConnectionError.serverUnreachable("offline")),
    ).toBe(UserMessage.serverUnavailable);
  });

  it("maps network TypeErrors", () => {
    expect(connectErrorMessage(new TypeError("Failed to fetch"))).toBe(
      UserMessage.serverUnavailable,
    );
  });

  it("falls back to a generic join message", () => {
    expect(connectErrorMessage(new Error("weird stack trace xyz"))).toBe(
      UserMessage.unableToConnect,
    );
  });

  it("recognizes NotAllowed", () => {
    const error = ConnectionError.notAllowed("nope", 401);
    expect(error.reason).toBe(ConnectionErrorReason.NotAllowed);
    expect(connectErrorMessage(error)).toBe(
      "You aren't allowed to join this room.",
    );
  });
});
