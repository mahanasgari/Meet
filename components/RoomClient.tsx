"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon, LinkIcon, UsersIcon } from "./Icons";
import { AudioRenderer } from "./AudioRenderer";
import { ControlBar } from "./ControlBar";
import { MusicPanel, MusicToggleButton } from "./MusicPanel";
import { ParticipantList } from "./ParticipantList";
import { PreJoin } from "./PreJoin";
import { VideoTile } from "./VideoTile";
import { useLiveKitRoom } from "@/lib/useLiveKitRoom";

function isMusicBot(identity: string) {
  return identity.startsWith("music-bot-");
}

type FocusedTile = {
  identity: string;
  source: "camera" | "screen";
};

export function RoomClient({ roomName }: { roomName: string }) {
  const {
    status,
    error,
    participants,
    canPlayAudio,
    reconnecting,
    deviceError,
    connect,
    disconnect,
    toggleMicrophone,
    toggleCamera,
    toggleScreenShare,
    resumeAudio,
  } = useLiveKitRoom(roomName);

  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [focused, setFocused] = useState<FocusedTile | null>(null);

  useEffect(() => {
    if (!focused) return;
    const person = participants.find(
      (participant) => participant.identity === focused.identity,
    );
    if (!person || isMusicBot(person.identity)) {
      setFocused(null);
      return;
    }
    if (
      focused.source === "screen" &&
      !(person.screenSharing && person.screenTrack)
    ) {
      setFocused(null);
    }
  }, [focused, participants]);

  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocused(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused]);

  const toggleMaximize = useCallback((tile: FocusedTile) => {
    setFocused((current) =>
      current?.identity === tile.identity && current.source === tile.source
        ? null
        : tile,
    );
  }, []);

  if (status !== "connected") {
    return (
      <PreJoin
        roomName={roomName}
        connecting={status === "connecting"}
        error={error}
        onJoin={(name, tracks) => connect(name, tracks)}
      />
    );
  }

  const local = participants.find((person) => person.isLocal);
  const screenShares = participants.filter(
    (person) => person.screenSharing && person.screenTrack,
  );
  const audioTracks = participants.flatMap((person) => person.audioTracks);
  const videoParticipants = participants.filter(
    (person) => !isMusicBot(person.identity),
  );
  const sharing = screenShares.length > 0;

  const focusedPerson = focused
    ? videoParticipants.find((person) => person.identity === focused.identity)
    : undefined;
  const focusActive = Boolean(focused && focusedPerson);
  const primaryStage = focusActive || sharing;

  const stripParticipants = focusActive
    ? videoParticipants.filter((person) => {
        if (focused!.source === "camera") {
          return person.identity !== focused!.identity;
        }
        return true;
      })
    : videoParticipants;

  return (
    <div className="room-shell">
      <header className="room-header">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[0.9375rem] font-semibold tracking-tight">
            Meet
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-[var(--text-faint)]">
            {roomName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <MusicToggleButton
            active={musicOpen}
            onClick={() => setMusicOpen((open) => !open)}
          />
          <CopyLinkButton />
        </div>
      </header>

      {!canPlayAudio && (
        <button
          type="button"
          onClick={() => void resumeAudio()}
          className="shrink-0 bg-[var(--warn-soft)] px-4 py-3 text-center text-sm text-[var(--warn)] active:bg-amber-500/20"
        >
          Tap to enable audio
        </button>
      )}

      {reconnecting && (
        <div
          data-testid="reconnecting"
          className="flex shrink-0 items-center justify-center gap-2 bg-[var(--warn-soft)] px-4 py-2 text-sm text-[var(--warn)]"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--warn)]" />
          Reconnecting&hellip;
        </div>
      )}

      {deviceError && (
        <div className="shrink-0 bg-rose-950/50 px-4 py-2.5 text-center text-sm text-rose-300">
          {deviceError}
        </div>
      )}

      <div className="room-body">
        <main className="room-main">
          <div
            className="video-stage"
            data-sharing={!focusActive && sharing ? "true" : "false"}
            data-focused={focusActive ? "true" : "false"}
          >
            {focusActive && focusedPerson && focused && (
              <div className="focus-stage">
                <VideoTile
                  key={`focus-${focused.source}-${focusedPerson.identity}`}
                  info={focusedPerson}
                  source={focused.source}
                  maximized
                  onToggleMaximize={() => toggleMaximize(focused)}
                />
              </div>
            )}

            {!focusActive && sharing && (
              <div className="screen-stage">
                {screenShares.map((person) => (
                  <VideoTile
                    key={`screen-${person.identity}`}
                    info={person}
                    source="screen"
                    onToggleMaximize={() =>
                      toggleMaximize({
                        identity: person.identity,
                        source: "screen",
                      })
                    }
                  />
                ))}
              </div>
            )}

            {stripParticipants.length === 0 && !primaryStage ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-faint)]">
                Connecting&hellip;
              </div>
            ) : stripParticipants.length > 0 ? (
              <div className="video-grid" data-count={stripParticipants.length}>
                {stripParticipants.map((person) => (
                  <VideoTile
                    key={person.identity}
                    info={person}
                    source="camera"
                    maximized={
                      focused?.identity === person.identity &&
                      focused.source === "camera"
                    }
                    onToggleMaximize={() =>
                      toggleMaximize({
                        identity: person.identity,
                        source: "camera",
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>

          <MusicPanel
            roomName={roomName}
            open={musicOpen}
            onClose={() => setMusicOpen(false)}
          />
        </main>

        <button
          type="button"
          onClick={() => setParticipantsOpen(true)}
          className="absolute right-[max(0.75rem,var(--safe-right))] top-3 z-[5] flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full bg-[var(--bg-elevated)]/95 px-3 text-xs font-medium text-[var(--text-muted)] shadow-[0_0_0_1px_var(--border)] backdrop-blur active:text-white lg:hidden"
        >
          <UsersIcon className="h-4 w-4" />
          <span className="tabular-nums">{participants.length}</span>
        </button>

        {participantsOpen && (
          <button
            type="button"
            aria-label="Close participant list"
            onClick={() => setParticipantsOpen(false)}
            className="absolute inset-0 z-10 bg-black/55 lg:hidden"
          />
        )}

        <aside
          className={`absolute inset-y-0 right-0 z-20 flex w-[min(100%,20rem)] flex-col border-l border-[var(--border)] bg-[var(--bg-elevated)] transition-transform duration-200 ease-out ${
            participantsOpen
              ? "translate-x-0"
              : "translate-x-full lg:translate-x-0"
          } lg:static lg:w-64 xl:w-72`}
          style={{
            paddingBottom: "var(--safe-bottom)",
          }}
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-2 lg:hidden">
            <span className="pl-2 text-sm font-medium text-[var(--text-muted)]">
              People
            </span>
            <button
              type="button"
              aria-label="Close participant list"
              onClick={() => setParticipantsOpen(false)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-faint)] active:bg-white/[0.06] active:text-white"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ParticipantList participants={participants} />
          </div>
        </aside>
      </div>

      <ControlBar
        microphoneEnabled={local?.microphoneEnabled ?? false}
        cameraEnabled={local?.cameraEnabled ?? false}
        screenSharing={local?.screenSharing ?? false}
        participantsOpen={participantsOpen}
        onToggleMicrophone={toggleMicrophone}
        onToggleCamera={toggleCamera}
        onToggleScreenShare={toggleScreenShare}
        onToggleParticipants={() => setParticipantsOpen((open) => !open)}
        onLeave={() => void disconnect()}
      />

      <AudioRenderer tracks={audioTracks} />
    </div>
  );
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  }, []);

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs font-medium text-[var(--text-muted)] active:bg-white/[0.12] active:text-white sm:h-8 sm:px-2.5"
    >
      <LinkIcon className="h-3.5 w-3.5" />
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
