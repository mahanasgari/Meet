const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const ROOM_ID_LENGTH = 10;
export const ROOM_ID_MIN_LENGTH = 8;
export const ROOM_ID_MAX_LENGTH = 40;

export function generateRoomId(length: number = ROOM_ID_LENGTH): string {
  let id = "";
  // Rejection sampling avoids modulo bias from `byte % alphabet.length`.
  while (id.length < length) {
    const bytes = new Uint8Array(length - id.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === length) break;
    }
  }
  return id;
}

export function isValidRoomId(value: string): boolean {
  return new RegExp(
    `^[a-z0-9]{${ROOM_ID_MIN_LENGTH},${ROOM_ID_MAX_LENGTH}}$`,
  ).test(value);
}
