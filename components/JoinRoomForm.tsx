"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeRoomInput } from "@/lib/join";

export function JoinRoomForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const roomId = normalizeRoomInput(value);
    if (!roomId) {
      setError("Enter a room code or a share link.");
      return;
    }
    router.push(`/room/${roomId}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          data-testid="join-input"
          placeholder="Room code or link"
          aria-label="Room code or link"
          className="h-12 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-white/[0.03] px-4 text-base text-white placeholder:text-[var(--text-faint)] outline-none transition-[border-color,background-color] duration-150 focus:border-[var(--border-strong)] focus:bg-white/[0.05]"
        />
        <button
          type="submit"
          data-testid="join-room"
          className="inline-flex h-12 shrink-0 items-center justify-center rounded-[var(--radius)] bg-white/[0.08] px-5 text-[0.9375rem] font-semibold text-white transition-colors duration-150 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 sm:min-w-[5.5rem]"
        >
          Join
        </button>
      </div>
      {error && (
        <p className="text-left text-sm text-rose-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
