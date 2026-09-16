import { ConnectionError, ConnectionErrorReason } from "livekit-client";

const UNABLE_TO_CONNECT = "Unable to connect to the room. Please try again.";
const INVALID_ROOM = "This room link isn't valid.";
const INVALID_NAME = "Enter a display name between 1 and 40 characters.";
const DISCONNECTED = "You were disconnected from the room.";
const TIMED_OUT = "Connection timed out. Please try again.";
const SERVER_UNAVAILABLE = "The meeting server is unavailable. Please try again later.";
const TOO_MANY_REQUESTS = "Too many join attempts. Please wait a moment and try again.";

export const UserMessage = {
  unableToConnect: UNABLE_TO_CONNECT,
  invalidRoom: INVALID_ROOM,
  invalidName: INVALID_NAME,
  disconnected: DISCONNECTED,
  timedOut: TIMED_OUT,
  serverUnavailable: SERVER_UNAVAILABLE,
  tooManyRequests: TOO_MANY_REQUESTS,
  unsupportedBrowser:
    "This browser doesn't support video calls. Try the latest Chrome, Firefox, or Safari.",
} as const;

const CONTROL_AND_BIDI =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Strip control/bidi characters and collapse whitespace for safe display names. */
export function sanitizeDisplayName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(CONTROL_AND_BIDI, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map /api/token failures to a user-facing message (never echo raw server text). */
export function tokenErrorMessage(status: number): string {
  if (status === 429) {
    return TOO_MANY_REQUESTS;
  }
  if (status === 400) {
    // Room vs name is distinguished by the client before calling, or we use a
    // generic 400. Prefer invalid name when status is 400 from name validation —
    // callers can pass a hint; default to unable-to-connect for safety.
    return UNABLE_TO_CONNECT;
  }
  if (status === 404 || status === 502 || status === 503) {
    return SERVER_UNAVAILABLE;
  }
  return UNABLE_TO_CONNECT;
}

export function tokenErrorFromBody(
  status: number,
  body: { error?: string } | null,
): string {
  const code = body?.error;
  if (status === 429 || code === "rate_limited") {
    return TOO_MANY_REQUESTS;
  }
  if (status === 403) {
    return UNABLE_TO_CONNECT;
  }
  if (status === 400) {
    if (code === "invalid_room") return INVALID_ROOM;
    if (code === "invalid_name") return INVALID_NAME;
    return UNABLE_TO_CONNECT;
  }
  if (status >= 500) return SERVER_UNAVAILABLE;
  return UNABLE_TO_CONNECT;
}

/** Map LiveKit / network failures to a user-facing message. */
export function connectErrorMessage(error: unknown): string {
  if (error instanceof ConnectionError) {
    switch (error.reason) {
      case ConnectionErrorReason.Timeout:
        return TIMED_OUT;
      case ConnectionErrorReason.ServerUnreachable:
      case ConnectionErrorReason.WebSocket:
      case ConnectionErrorReason.ServiceNotFound:
        return SERVER_UNAVAILABLE;
      case ConnectionErrorReason.NotAllowed:
        return "You aren't allowed to join this room.";
      case ConnectionErrorReason.Cancelled:
        return UNABLE_TO_CONNECT;
      default:
        return UNABLE_TO_CONNECT;
    }
  }

  if (error instanceof TypeError) {
    // fetch() network failure
    return SERVER_UNAVAILABLE;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("timed out")) {
      return TIMED_OUT;
    }
    if (
      message.includes("failed to fetch") ||
      message.includes("network") ||
      message.includes("websocket")
    ) {
      return SERVER_UNAVAILABLE;
    }
  }

  return UNABLE_TO_CONNECT;
}

export function validateDisplayName(value: string): string | null {
  const name = sanitizeDisplayName(value);
  if (name.length < 1) {
    return "Please enter a display name.";
  }
  if (name.length > 40) {
    return INVALID_NAME;
  }
  return null;
}
