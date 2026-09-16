import { CreateRoomButton } from "@/components/CreateRoomButton";
import { JoinRoomForm } from "@/components/JoinRoomForm";

export default function Home() {
  return (
    <main className="surface-ambient safe-page flex min-h-dvh flex-col items-center justify-center overflow-y-auto overscroll-y-contain text-center">
      <div className="flex w-full max-w-md flex-col items-center gap-10 py-2">
        <div className="space-y-3">
          <h1 className="text-[2.5rem] font-semibold leading-none tracking-tight text-white sm:text-5xl">
            Meet
          </h1>
          <p className="mx-auto max-w-[22rem] text-[0.9375rem] leading-relaxed text-[var(--text-muted)]">
            Tiny video rooms for hanging out with friends. No accounts, no
            setup&nbsp;&mdash; just share the link.
          </p>
        </div>

        <div className="flex w-full flex-col items-stretch gap-5">
          <CreateRoomButton />

          <div
            className="flex items-center gap-3 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-[var(--text-faint)]"
            aria-hidden="true"
          >
            <span className="h-px flex-1 bg-[var(--border)]" />
            or
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>

          <JoinRoomForm />
        </div>

        <p className="max-w-xs text-xs leading-relaxed text-[var(--text-faint)]">
          Rooms are temporary and disappear once everyone leaves.
        </p>
      </div>
    </main>
  );
}
