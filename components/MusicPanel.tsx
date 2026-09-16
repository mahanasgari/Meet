"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CloseIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SkipIcon,
  StopIcon,
} from "./Icons";

export type MusicStatus = {
  room: string;
  status: "idle" | "playing" | "paused";
  current: string | null;
  queue: string[];
};

async function musicRequest(
  room: string,
  action: string,
  url?: string,
): Promise<MusicStatus> {
  const response = await fetch("/api/music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, action, url }),
  });
  const data = (await response.json().catch(() => ({}))) as MusicStatus & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(data.error || "music_error");
  }
  return data;
}

function shortUrl(value: string) {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.split("/").filter(Boolean).pop() || parsed.host;
    return decodeURIComponent(path).slice(0, 48);
  } catch {
    return value.slice(0, 48);
  }
}

export function MusicPanel({
  roomName,
  open,
  onClose,
}: {
  roomName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<MusicStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/music?room=${encodeURIComponent(roomName)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as MusicStatus;
      setStatus(data);
    } catch {
      // Bot may be offline — keep panel usable.
    }
  }, [roomName]);

  useEffect(() => {
    if (!open) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [open, refresh]);

  const run = async (action: string, mediaUrl?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await musicRequest(roomName, action, mediaUrl);
      setStatus(next);
      if (action === "enqueue") setUrl("");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "music_error";
      if (code === "music_unavailable") {
        setError("Music bot is offline.");
      } else if (code === "invalid_url") {
        setError("Enter an http(s) media URL.");
      } else if (code === "queue_full") {
        setError("Queue is full.");
      } else {
        setError("Couldn't update playback.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const playing = status?.status === "playing";
  const paused = status?.status === "paused";

  return (
    <div
      className="absolute bottom-3 left-1/2 z-30 w-[min(100%-1.5rem,22rem)] -translate-x-1/2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)]/95 p-3 shadow-lg backdrop-blur"
      data-testid="music-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-white">
          <MusicIcon className="h-4 w-4 text-[var(--text-muted)]" />
          Music
        </div>
        <button
          type="button"
          aria-label="Close music panel"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-faint)] active:bg-white/[0.06] active:text-white"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          if (!trimmed || busy) return;
          void run("enqueue", trimmed);
        }}
      >
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://… media URL"
          data-testid="music-url"
          className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-white/[0.03] px-3 text-sm text-white placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--border-strong)]"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          data-testid="music-add"
          className="h-10 shrink-0 rounded-lg bg-[var(--accent)] px-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Add
        </button>
      </form>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          title={paused ? "Resume" : "Pause"}
          disabled={busy || (!playing && !paused)}
          data-testid="music-pause"
          onClick={() => void run(paused ? "resume" : "pause")}
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.06] text-white disabled:opacity-30"
        >
          {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
        </button>
        <button
          type="button"
          title="Skip"
          disabled={busy || (!status?.current && !(status?.queue.length))}
          data-testid="music-skip"
          onClick={() => void run("skip")}
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.06] text-white disabled:opacity-30"
        >
          <SkipIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Stop"
          disabled={busy || (status?.status === "idle" && !status?.queue.length)}
          data-testid="music-stop"
          onClick={() => void run("stop")}
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.06] text-white disabled:opacity-30"
        >
          <StopIcon className="h-4 w-4" />
        </button>
        <span className="ml-1 truncate text-xs text-[var(--text-muted)]">
          {status?.status === "playing"
            ? "Playing"
            : status?.status === "paused"
              ? "Paused"
              : "Idle"}
        </span>
      </div>

      {status?.current && (
        <p className="mt-2 truncate text-xs text-[var(--text-muted)]">
          Now: {shortUrl(status.current)}
        </p>
      )}

      {status && status.queue.length > 0 && (
        <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs text-[var(--text-faint)]">
          {status.queue.map((item) => (
            <li key={item} className="truncate">
              Queued: {shortUrl(item)}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-2 text-xs text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function MusicToggleButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title="Music"
      aria-label="Toggle music panel"
      aria-pressed={active}
      data-testid="ctl-music"
      onClick={onClick}
      className={`inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium sm:h-8 sm:px-2.5 ${
        active
          ? "bg-white/[0.14] text-white"
          : "bg-white/[0.06] text-[var(--text-muted)] active:bg-white/[0.12] active:text-white"
      }`}
    >
      <MusicIcon className="h-3.5 w-3.5" />
      Music
    </button>
  );
}
