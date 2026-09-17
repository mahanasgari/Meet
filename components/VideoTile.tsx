"use client";

import { useEffect, useRef } from "react";
import {
  CameraOffIcon,
  CompressIcon,
  ExpandIcon,
  MicOffIcon,
} from "./Icons";
import type { ParticipantInfo } from "@/lib/participants";

export function VideoTile({
  info,
  source,
  maximized = false,
  onToggleMaximize,
}: {
  info: ParticipantInfo;
  source: "camera" | "screen";
  maximized?: boolean;
  onToggleMaximize?: () => void;
}) {
  const track = source === "screen" ? info.screenTrack : info.cameraTrack;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  const isLocalCamera = source === "camera" && info.isLocal;
  const showMicOff = source === "camera" && !info.microphoneEnabled;
  const showCameraOff = source === "camera" && !info.cameraEnabled;
  const speaking = info.isSpeaking && source === "camera";

  return (
    <div
      data-testid={source === "screen" ? "screen-share-tile" : "tile"}
      data-name={info.name}
      data-sharing={info.screenSharing}
      data-maximized={maximized ? "true" : "false"}
      className={`relative min-h-0 overflow-hidden rounded-[var(--radius)] bg-[var(--bg-soft)] transition-[box-shadow] duration-150 ${
        speaking
          ? "shadow-[0_0_0_2px_var(--accent)]"
          : "shadow-[0_0_0_1px_var(--border)]"
      }`}
    >
      <video
        ref={videoRef}
        data-testid="tile-video"
        autoPlay
        playsInline
        muted
        // iOS Safari needs playsInline + muted for local preview reliability
        className={`h-full w-full ${
          source === "screen" ? "object-contain bg-black" : "object-cover"
        } ${isLocalCamera ? "-scale-x-100" : ""}`}
      />

      {!track && source === "camera" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-soft)]">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06] text-lg font-semibold tracking-tight text-[var(--text-muted)] sm:h-14 sm:w-14 sm:text-xl">
            {info.name.charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      {!track && source === "screen" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-faint)]">
          No screen shared
        </div>
      )}

      {onToggleMaximize && (
        <button
          type="button"
          data-testid="tile-maximize"
          aria-label={maximized ? "Restore tile size" : "Maximize tile"}
          onClick={onToggleMaximize}
          className="absolute right-2 top-2 z-[1] flex h-8 w-8 items-center justify-center rounded-lg bg-black/55 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/75 hover:text-white"
        >
          {maximized ? (
            <CompressIcon className="h-3.5 w-3.5" />
          ) : (
            <ExpandIcon className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2.5 pb-2 pt-8 sm:px-3 sm:pb-2.5 sm:pt-10">
        <span className="min-w-0 truncate text-[0.75rem] font-medium text-white sm:text-[0.8125rem]">
          {info.name}
          {info.isLocal && (
            <span className="font-normal text-white/55"> (you)</span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {source === "screen" && (
            <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-white">
              Screen
            </span>
          )}
          {showMicOff && (
            <span
              title="Microphone off"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-rose-300"
            >
              <MicOffIcon className="h-3 w-3" />
              <span className="sr-only">Mic off</span>
            </span>
          )}
          {showCameraOff && (
            <span
              title="Camera off"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white/70"
            >
              <CameraOffIcon className="h-3 w-3" />
              <span className="sr-only">Camera off</span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
