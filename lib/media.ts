import { MediaDeviceFailure } from "livekit-client";

export type MediaKind = "camera" | "microphone" | "screen";

/** True when the browser can capture media and run WebRTC. */
export function isRealtimeSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return (
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof WebSocket !== "undefined"
  );
}

function failureOf(error: unknown): MediaDeviceFailure | undefined {
  return MediaDeviceFailure.getFailure(error);
}

function isUserCancel(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  // Browser picker dismissed / permission prompt closed without granting.
  return name === "NotAllowedError" || name === "AbortError";
}

export function cameraErrorMessage(error: unknown): string {
  switch (failureOf(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return "Camera access was blocked. You can continue without video.";
    case MediaDeviceFailure.NotFound:
      return "No camera was found. You can continue without video.";
    case MediaDeviceFailure.DeviceInUse:
      return "Your camera is in use by another app. You can continue without video.";
    default:
      return "Your camera is unavailable. You can continue without video.";
  }
}

export function microphoneErrorMessage(error: unknown): string {
  switch (failureOf(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return "Microphone access was blocked. You can continue without audio.";
    case MediaDeviceFailure.NotFound:
      return "Your microphone is unavailable.";
    case MediaDeviceFailure.DeviceInUse:
      return "Your microphone is in use by another app.";
    default:
      return "Your microphone is unavailable.";
  }
}

/**
 * Returns a friendly screen-share message, or null when the user simply
 * cancelled the share picker (no toast needed).
 */
export function screenShareErrorMessage(error: unknown): string | null {
  if (isUserCancel(error)) {
    return null;
  }
  switch (failureOf(error)) {
    case MediaDeviceFailure.PermissionDenied:
      return "Screen sharing was blocked by the browser.";
    case MediaDeviceFailure.NotFound:
      return "Nothing was available to share.";
    default:
      return "Unable to share your screen. Please try again.";
  }
}

/** @deprecated Prefer cameraErrorMessage / microphoneErrorMessage. */
export function mediaDeviceErrorMessage(error: unknown): string {
  return microphoneErrorMessage(error);
}
