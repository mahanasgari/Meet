import { describe, expect, it } from "vitest";
import {
  cameraErrorMessage,
  microphoneErrorMessage,
  screenShareErrorMessage,
} from "./media";

describe("cameraErrorMessage", () => {
  it("explains permission denial without blocking join", () => {
    expect(
      cameraErrorMessage(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    ).toMatch(/blocked/i);
    expect(
      cameraErrorMessage(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    ).toMatch(/continue without video/i);
  });

  it("explains a missing camera", () => {
    expect(
      cameraErrorMessage(Object.assign(new Error("gone"), { name: "NotFoundError" })),
    ).toMatch(/no camera/i);
  });
});

describe("microphoneErrorMessage", () => {
  it("uses a short unavailable message", () => {
    expect(
      microphoneErrorMessage(
        Object.assign(new Error("gone"), { name: "NotFoundError" }),
      ),
    ).toBe("Your microphone is unavailable.");
  });
});

describe("screenShareErrorMessage", () => {
  it("stays quiet when the user cancels the picker", () => {
    expect(
      screenShareErrorMessage(
        Object.assign(new Error("cancel"), { name: "NotAllowedError" }),
      ),
    ).toBeNull();
    expect(
      screenShareErrorMessage(
        Object.assign(new Error("abort"), { name: "AbortError" }),
      ),
    ).toBeNull();
  });

  it("explains other failures", () => {
    expect(
      screenShareErrorMessage(Object.assign(new Error("x"), { name: "Other" })),
    ).toMatch(/unable to share/i);
  });
});
