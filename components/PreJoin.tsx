"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from "./Icons";
import { sanitizeDisplayName, UserMessage, validateDisplayName } from "@/lib/errors";
import {
  cameraErrorMessage,
  isRealtimeSupported,
  microphoneErrorMessage,
} from "@/lib/media";
import type { PreparedTracks } from "@/lib/useLiveKitRoom";

type OnJoin = (
  displayName: string,
  tracks: PreparedTracks,
) => void | Promise<void>;

export function PreJoin({
  roomName,
  connecting,
  error,
  onJoin,
}: {
  roomName: string;
  connecting: boolean;
  error: string | null;
  onJoin: OnJoin;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrackRef = useRef<LocalVideoTrack | null>(null);
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const handedOffRef = useRef(false);

  const [supported] = useState(() => isRealtimeSupported());
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("meet.displayName");
    if (nameRef.current) {
      if (stored) nameRef.current.value = stored;
      nameRef.current.focus();
    }
  }, []);

  const listAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "audioinput",
      );
      setAudioDevices(devices);
    } catch {
      setAudioDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    const timeout = window.setTimeout(() => {
      void listAudioDevices();
    }, 0);
    navigator.mediaDevices?.addEventListener("devicechange", listAudioDevices);
    return () => {
      window.clearTimeout(timeout);
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        listAudioDevices,
      );
    };
  }, [listAudioDevices, supported]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;

    const acquire = async () => {
      try {
        const track = await createLocalVideoTrack({
          resolution: { width: 1280, height: 720 },
          facingMode: "user",
        });
        if (cancelled) {
          track.stop();
          return;
        }
        videoTrackRef.current = track;
        setHasVideo(true);
        setCameraEnabled(true);
        setCameraNotice(null);
      } catch (cause) {
        if (!cancelled) {
          setHasVideo(false);
          setCameraEnabled(false);
          setCameraNotice(cameraErrorMessage(cause));
        }
      }

      try {
        const track = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        if (cancelled) {
          track.stop();
          return;
        }
        audioTrackRef.current = track;
        setHasAudio(true);
        setMicrophoneEnabled(true);
        setMicNotice(null);
        void listAudioDevices();
      } catch (cause) {
        if (!cancelled) {
          setHasAudio(false);
          setMicrophoneEnabled(false);
          setMicNotice(microphoneErrorMessage(cause));
        }
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      if (!handedOffRef.current) {
        videoTrackRef.current?.stop();
        audioTrackRef.current?.stop();
      }
    };
  }, [listAudioDevices, supported]);

  useEffect(() => {
    if (!error) return;
    // Failed join returns ownership of media tracks to PreJoin.
    handedOffRef.current = false;

    const video = videoTrackRef.current;
    if (video && video.mediaStreamTrack.readyState === "ended") {
      videoTrackRef.current = null;
      setHasVideo(false);
    }
    const audio = audioTrackRef.current;
    if (audio && audio.mediaStreamTrack.readyState === "ended") {
      audioTrackRef.current = null;
      setHasAudio(false);
    }
  }, [error]);

  // Re-acquire preview media after a failed join that ended handed-off tracks.
  useEffect(() => {
    if (!error || !supported) return;

    let cancelled = false;

    const recover = async () => {
      if (!videoTrackRef.current) {
        try {
          const track = await createLocalVideoTrack({
            resolution: { width: 1280, height: 720 },
            facingMode: "user",
          });
          if (cancelled) {
            track.stop();
            return;
          }
          videoTrackRef.current = track;
          setHasVideo(true);
          setCameraEnabled(true);
          setCameraNotice(null);
        } catch (cause) {
          if (!cancelled) {
            setHasVideo(false);
            setCameraEnabled(false);
            setCameraNotice(cameraErrorMessage(cause));
          }
        }
      }

      if (!audioTrackRef.current) {
        try {
          const track = await createLocalAudioTrack({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          });
          if (cancelled) {
            track.stop();
            return;
          }
          audioTrackRef.current = track;
          setHasAudio(true);
          setMicrophoneEnabled(true);
          setMicNotice(null);
        } catch (cause) {
          if (!cancelled) {
            setHasAudio(false);
            setMicrophoneEnabled(false);
            setMicNotice(microphoneErrorMessage(cause));
          }
        }
      }
    };

    void recover();
    return () => {
      cancelled = true;
    };
  }, [error, supported]);

  useEffect(() => {
    const element = videoRef.current;
    const track = videoTrackRef.current;
    if (!element || !track || !hasVideo) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [hasVideo]);

  const toggleCamera = () => {
    if (!hasVideo) return;
    setCameraEnabled((enabled) => {
      const next = !enabled;
      if (videoTrackRef.current) {
        if (next) videoTrackRef.current.unmute();
        else videoTrackRef.current.mute();
      }
      return next;
    });
  };

  const toggleMicrophone = () => {
    if (!hasAudio) return;
    setMicrophoneEnabled((enabled) => {
      const next = !enabled;
      if (audioTrackRef.current) {
        if (next) audioTrackRef.current.unmute();
        else audioTrackRef.current.mute();
      }
      return next;
    });
  };

  const changeAudioDevice = async (deviceId: string) => {
    setAudioDeviceId(deviceId);
    const previous = audioTrackRef.current;
    try {
      const track = await createLocalAudioTrack({
        deviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (handedOffRef.current) {
        track.stop();
        return;
      }
      setMicrophoneEnabled((enabled) => {
        if (!enabled) track.mute();
        return enabled;
      });
      audioTrackRef.current = track;
      previous?.stop();
      setMicNotice(null);
      setHasAudio(true);
    } catch (cause) {
      if (!handedOffRef.current) {
        setMicNotice(microphoneErrorMessage(cause));
      }
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (connecting || !supported) return;

    const displayName = nameRef.current?.value ?? "";
    const nameProblem = validateDisplayName(displayName);
    if (nameProblem) {
      setNameError(nameProblem);
      nameRef.current?.focus();
      return;
    }

    setNameError(null);
    const trimmed = sanitizeDisplayName(displayName);
    localStorage.setItem("meet.displayName", trimmed);
    handedOffRef.current = true;
    void onJoin(trimmed, {
      audioTrack: audioTrackRef.current ?? undefined,
      videoTrack: videoTrackRef.current ?? undefined,
      microphoneEnabled: microphoneEnabled && hasAudio,
      cameraEnabled: cameraEnabled && hasVideo,
    });
  };

  const previewHidden = !cameraEnabled || !hasVideo;

  return (
    <div className="surface-ambient safe-page flex min-h-dvh items-center justify-center overflow-y-auto overscroll-y-contain">
      <form
        onSubmit={handleSubmit}
        data-testid="prejoin"
        className={`my-auto w-full max-w-[26rem] space-y-5 transition-opacity duration-150 ${
          connecting ? "opacity-70" : "opacity-100"
        }`}
      >
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1 text-left">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-[var(--text-faint)]">
              Meet
            </p>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Ready to join?
            </h1>
          </div>
          <span className="rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[0.6875rem] text-[var(--text-muted)]">
            {roomName}
          </span>
        </div>

        {!supported ? (
          <p className="rounded-[var(--radius)] bg-[var(--warn-soft)] px-3.5 py-3 text-sm leading-relaxed text-[var(--warn)]">
            {UserMessage.unsupportedBrowser}
          </p>
        ) : (
          <>
            <div className="relative aspect-video max-h-[min(40dvh,16rem)] overflow-hidden rounded-[var(--radius)] bg-[var(--bg-soft)] shadow-[0_0_0_1px_var(--border)] landscape:max-h-[min(48dvh,14rem)] sm:max-h-none">
              <video
                ref={videoRef}
                data-testid="preview"
                autoPlay
                playsInline
                muted
                className={`h-full w-full object-cover -scale-x-100 transition-opacity duration-200 ${
                  previewHidden ? "opacity-0" : "opacity-100"
                }`}
              />
              {previewHidden && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.05] text-[var(--text-faint)]">
                    <CameraOffIcon className="h-5 w-5" />
                  </span>
                  <span className="text-xs text-[var(--text-faint)]">
                    {hasVideo
                      ? "Camera off"
                      : cameraNotice
                        ? "Camera unavailable"
                        : "Starting camera\u2026"}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={toggleCamera}
                disabled={!hasVideo}
                aria-pressed={cameraEnabled && hasVideo}
                className={`inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius)] text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  cameraEnabled && hasVideo
                    ? "bg-white/[0.1] text-white active:bg-white/[0.16]"
                    : "bg-white/[0.04] text-[var(--text-muted)] active:bg-white/[0.1]"
                }`}
              >
                {cameraEnabled && hasVideo ? (
                  <CameraIcon className="h-4 w-4" />
                ) : (
                  <CameraOffIcon className="h-4 w-4" />
                )}
                Camera
              </button>

              <button
                type="button"
                onClick={toggleMicrophone}
                disabled={!hasAudio}
                aria-pressed={microphoneEnabled && hasAudio}
                className={`inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius)] text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  microphoneEnabled && hasAudio
                    ? "bg-white/[0.1] text-white active:bg-white/[0.16]"
                    : "bg-white/[0.04] text-[var(--text-muted)] active:bg-white/[0.1]"
                }`}
              >
                {microphoneEnabled && hasAudio ? (
                  <MicIcon className="h-4 w-4" />
                ) : (
                  <MicOffIcon className="h-4 w-4" />
                )}
                Mic
              </button>
            </div>

            {audioDevices.length > 1 && hasAudio && (
              <label className="block space-y-1.5 text-left">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Microphone
                </span>
                <select
                  value={audioDeviceId}
                  onChange={(event) =>
                    void changeAudioDevice(event.target.value)
                  }
                  className="h-12 w-full rounded-[var(--radius)] border border-[var(--border)] bg-white/[0.03] px-3 text-base text-white outline-none transition-colors duration-150 [&>option]:bg-[var(--bg-elevated)] focus:border-[var(--border-strong)]"
                >
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Microphone"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        <label className="block space-y-1.5 text-left">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Your name
          </span>
          <input
            ref={nameRef}
            data-testid="join-name"
            type="text"
            maxLength={40}
            placeholder="e.g. Alex"
            autoComplete="name"
            onChange={() => setNameError(null)}
            className="h-12 w-full rounded-[var(--radius)] border border-[var(--border)] bg-white/[0.03] px-3 text-base text-white placeholder:text-[var(--text-faint)] outline-none transition-colors duration-150 focus:border-[var(--border-strong)] focus:bg-white/[0.05]"
          />
          {nameError && (
            <p className="text-sm text-rose-400" role="alert">
              {nameError}
            </p>
          )}
        </label>

        {(cameraNotice || micNotice) && (
          <div className="space-y-1 rounded-[var(--radius)] bg-[var(--warn-soft)] px-3.5 py-3 text-left text-sm leading-relaxed text-[var(--warn)]">
            {cameraNotice && <p>{cameraNotice}</p>}
            {micNotice && <p>{micNotice}</p>}
          </div>
        )}

        {error && (
          <p
            className="rounded-[var(--radius)] bg-rose-950/45 px-3.5 py-3 text-left text-sm leading-relaxed text-rose-300"
            role="alert"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          data-testid="join"
          disabled={connecting || !supported}
          className="inline-flex h-12 w-full items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] text-[0.9375rem] font-semibold text-white transition-colors duration-150 hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connecting ? "Joining\u2026" : "Join room"}
        </button>
      </form>
    </div>
  );
}
