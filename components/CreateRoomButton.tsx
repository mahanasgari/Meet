"use client";

import { useRouter } from "next/navigation";
import { generateRoomId } from "@/lib/room";

export function CreateRoomButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      data-testid="create-room"
      onClick={() => router.push(`/room/${generateRoomId()}`)}
      className="inline-flex h-12 w-full items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] text-[0.9375rem] font-semibold text-white transition-colors duration-150 hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
    >
      Create a room
    </button>
  );
}
