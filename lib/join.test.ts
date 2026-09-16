import { describe, expect, it } from "vitest";
import { normalizeRoomInput } from "./join";

describe("normalizeRoomInput", () => {
  it("accepts a bare room id", () => {
    expect(normalizeRoomInput("abc123def4")).toBe("abc123def4");
  });

  it("accepts a leading/trailing whitespace", () => {
    expect(normalizeRoomInput("  abc123def4  ")).toBe("abc123def4");
  });

  it("accepts a room path", () => {
    expect(normalizeRoomInput("/room/abc123def4")).toBe("abc123def4");
  });

  it("accepts a room path with a trailing slash", () => {
    expect(normalizeRoomInput("/room/abc123def4/")).toBe("abc123def4");
  });

  it("accepts a full share link", () => {
    expect(
      normalizeRoomInput("https://meet.example.com/room/abc123def4"),
    ).toBe("abc123def4");
  });

  it("accepts a share link with a trailing slash or query", () => {
    expect(normalizeRoomInput("https://meet.example.com/room/abc123def4/")).toBe(
      "abc123def4",
    );
    expect(
      normalizeRoomInput("https://meet.example.com/room/abc123def4?ref=x"),
    ).toBe("abc123def4");
  });

  it("rejects an empty input", () => {
    expect(normalizeRoomInput("")).toBeNull();
    expect(normalizeRoomInput("   ")).toBeNull();
  });

  it.each(["ab", "UPPER", "not-a-room", "https://example.com/abc", "room code here"])(
    "rejects %s",
    (input) => {
      expect(normalizeRoomInput(input)).toBeNull();
    },
  );
});