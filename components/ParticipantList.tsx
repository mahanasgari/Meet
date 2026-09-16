"use client";

import { CameraOffIcon, MicOffIcon, ScreenShareIcon } from "./Icons";
import type { ParticipantInfo } from "@/lib/participants";

export function ParticipantList({
  participants,
}: {
  participants: ParticipantInfo[];
}) {
  return (
    <div className="flex h-full flex-col">
      <h2
        data-testid="participant-count"
        className="px-4 py-3.5 text-[0.8125rem] font-semibold tracking-wide text-[var(--text-muted)]"
      >
        In this room
        <span className="ml-1.5 tabular-nums text-[var(--text-faint)]">
          {participants.length}
        </span>
      </h2>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {participants.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-[var(--text-faint)]">
            Waiting for others&hellip;
          </li>
        ) : (
          participants.map((person) => (
            <li
              key={person.identity}
              data-testid="participant"
              data-name={person.name}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 ${
                person.isSpeaking ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
              }`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  person.isSpeaking
                    ? "bg-[var(--accent-soft)] text-[var(--accent-hover)]"
                    : "bg-white/[0.06] text-[var(--text-muted)]"
                }`}
              >
                {person.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.875rem] text-zinc-200">
                {person.name}
                {person.isLocal && (
                  <span className="text-[var(--text-faint)]"> (you)</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {person.screenSharing && (
                  <span
                    title="Sharing screen"
                    className="flex items-center gap-1 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[0.625rem] font-medium text-[var(--accent-hover)]"
                  >
                    <ScreenShareIcon className="h-3 w-3" />
                    Sharing
                  </span>
                )}
                {!person.cameraEnabled && (
                  <CameraOffIcon className="h-3.5 w-3.5 text-[var(--text-faint)]" />
                )}
                {!person.microphoneEnabled && (
                  <MicOffIcon className="h-3.5 w-3.5 text-rose-400" />
                )}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
