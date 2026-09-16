import Link from "next/link";

export default function NotFound() {
  return (
    <main className="surface-ambient safe-page flex min-h-dvh flex-col items-center justify-center gap-5 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Room not found
        </h1>
        <p className="max-w-sm text-sm leading-relaxed text-[var(--text-muted)]">
          This room link isn&apos;t valid. Check the link, or create a new room.
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex h-12 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-5 text-sm font-semibold text-white transition-colors duration-150 active:bg-[var(--accent-hover)]"
      >
        Back to Meet
      </Link>
    </main>
  );
}
