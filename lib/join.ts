import { isValidRoomId, ROOM_ID_MAX_LENGTH, ROOM_ID_MIN_LENGTH } from "./room";

const ROOM_PATH = new RegExp(
  `^\\/room\\/([a-z0-9]{${ROOM_ID_MIN_LENGTH},${ROOM_ID_MAX_LENGTH}})\\/?$`,
);

/**
 * Extracts a valid room id from user input. Accepts:
 *   - a bare room id ("abc123xyz")
 *   - a share link ("https://example.com/room/abc123xyz")
 *   - a path ("/room/abc123xyz")
 * Returns null when the input is not a valid room.
 */
export function normalizeRoomInput(value: string): string | null {
  const input = value.trim();
  if (!input) {
    return null;
  }

  if (isValidRoomId(input)) {
    return input;
  }

  const pathMatch = input.match(ROOM_PATH);
  if (pathMatch) {
    return pathMatch[1];
  }

  if (/^https?:\/\//i.test(input)) {
    try {
      const { pathname } = new URL(input);
      const match = pathname.match(ROOM_PATH);
      if (match) {
        return match[1];
      }
    } catch {
      return null;
    }
  }

  return null;
}
