import { describe, expect, it } from "vitest";
import { generateRoomId, isValidRoomId, ROOM_ID_LENGTH } from "./room";

describe("generateRoomId", () => {
  it("returns an id of the requested length", () => {
    expect(generateRoomId()).toHaveLength(ROOM_ID_LENGTH);
    expect(generateRoomId(8)).toHaveLength(8);
  });

  it("uses only lowercase alphanumeric characters", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRoomId()).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRoomId()));
    expect(ids.size).toBe(1000);
  });
});

describe("isValidRoomId", () => {
  it.each(["abcdefgh", "room1234", "a1b2c3d4e5"])("accepts %s", (id) => {
    expect(isValidRoomId(id)).toBe(true);
  });

  it.each([
    "",
    "ab",
    "abcdef",
    "UPPERCAS",
    "has space",
    "with/slash",
    "x".repeat(41),
  ])("rejects %s", (id) => {
    expect(isValidRoomId(id)).toBe(false);
  });
});
