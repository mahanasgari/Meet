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
  title?: string | null;
  queue: string[];
  queueTitles?: (string | null)[];
  lastError?: string | null;
};

export type MusicSearchResult = {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  channel: string | null;
};

async function musicRequest(
  room: string,
  action: string,
  payload?: { url?: string; query?: string },
): Promise<MusicStatus & { results?: MusicSearchResult[] }> {
  const response = await fetch("/api/music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, action, ...payload }),
  });
  const data = (await response.json().catch(() => ({}))) as MusicStatus & {
    error?: string;
    results?: MusicSearchResult[];
  };
  if (!response.ok) {
    throw new Error(data.error || "music_error");
  }
  return data;
}

function looksLikeMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatDuration(seconds: number | null) {
  if (seconds == null || seconds < 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function shortUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (/youtu\.be|youtube\.com/i.test(parsed.hostname)) {
      return "YouTube";
    }
    const path = parsed.pathname.split("/").filter(Boolean).pop() || parsed.host;
    return decodeURIComponent(path).slice(0, 48);
  } catch {
    return value.slice(0, 48);
  }
}

function displayTrack(url: string | null | undefined, title?: string | null) {
  if (title?.trim()) return title.trim().slice(0, 64);
  if (!url) return "";
  return shortUrl(url);
}

function errorMessage(code: string) {
  switch (code) {
    case "music_unavailable":
      return "Music bot is offline.";
    case "invalid_url":
      return "Enter a YouTube or direct media URL (https://…).";
    case "invalid_query":
      return "Enter a search term or paste a URL.";
    case "queue_full":
      return "Queue is full.";
    case "rate_limited":
      return "Too many searches — wait a moment.";
    case "search_timeout":
    case "search_failed":
      return "Search failed. Try again.";
    case "no_audio":
    case "playback_failed":
    case "extract_failed":
      return "Couldn't play that link. Try another YouTube URL or a direct mp3.";
    default:
      return "Couldn't update playback.";
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
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<MusicStatus | null>(null);
  const [results, setResults] = useState<MusicSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
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
      const next = await musicRequest(
        roomName,
        action,
        mediaUrl ? { url: mediaUrl } : undefined,
      );
      setStatus(next);
      if (action === "enqueue") {
        setQuery("");
        setResults([]);
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "music_error";
      setError(errorMessage(code));
    } finally {
      setBusy(false);
    }
  };

  const submitInput = async () => {
    const trimmed = query.trim();
    if (!trimmed || busy || searching) return;

    if (looksLikeMediaUrl(trimmed)) {
      await run("enqueue", trimmed);
      return;
    }

    setSearching(true);
    setError(null);
    setResults([]);
    try {
      const data = await musicRequest(roomName, "search", { query: trimmed });
      setResults(data.results ?? []);
      if (!(data.results?.length)) {
        setError("No YouTube results. Try another search.");
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "music_error";
      setError(errorMessage(code));
    } finally {
      setSearching(false);
    }
  };

  if (!open) return null;

  const playing = status?.status === "playing";
  const paused = status?.status === "paused";
  const inputBusy = busy || searching;

  return (
    <div
      className="absolute bottom-3 left-1/2 z-30 w-[min(100%-1.5rem,24rem)] -translate-x-1/2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)]/95 p-3 shadow-lg backdrop-blur"
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
          void submitInput();
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search YouTube or paste URL"
          data-testid="music-url"
          enterKeyHint="search"
          className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-white/[0.03] px-3 text-sm text-white placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--border-strong)]"
        />
        <button
          type="submit"
          disabled={inputBusy || !query.trim()}
          data-testid="music-add"
          className="h-10 shrink-0 rounded-lg bg-[var(--accent)] px-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {searching
            ? "…"
            : looksLikeMediaUrl(query.trim())
              ? "Add"
              : "Search"}
        </button>
      </form>

      {results.length > 0 && (
        <ul
          className="mt-2 max-h-44 space-y-1 overflow-y-auto"
          data-testid="music-search-results"
        >
          {results.map((item) => {
            const duration = formatDuration(item.duration);
            return (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">
                    {item.title}
                  </p>
                  <p className="truncate text-[11px] text-[var(--text-faint)]">
                    {[item.channel, duration].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="music-search-add"
                  onClick={() => void run("enqueue", item.url)}
                  className="h-8 shrink-0 rounded-md bg-white/[0.08] px-2.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  Add
                </button>
              </li>
            );
          })}
        </ul>
      )}

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
          Now: {displayTrack(status.current, status.title)}
        </p>
      )}

      {status && status.queue.length > 0 && (
        <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs text-[var(--text-faint)]">
          {status.queue.map((item, index) => (
            <li key={`${item}-${index}`} className="truncate">
              Queued: {displayTrack(item, status.queueTitles?.[index])}
            </li>
          ))}
        </ul>
      )}

      {(error || status?.lastError) && (
        <p className="mt-2 text-xs text-rose-300" role="alert">
          {error || errorMessage(status?.lastError || "playback_failed")}
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
