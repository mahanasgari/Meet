"use client";

import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  UsersIcon,
} from "./Icons";

export function ControlBar({
  microphoneEnabled,
  cameraEnabled,
  screenSharing,
  participantsOpen,
  onToggleMicrophone,
  onToggleCamera,
  onToggleScreenShare,
  onToggleParticipants,
  onLeave,
}: {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  participantsOpen: boolean;
  onToggleMicrophone: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleParticipants: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="control-bar">
      <div className="control-bar__cluster">
        <ControlButton
          label={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
          active={microphoneEnabled}
          muted={!microphoneEnabled}
          testId="ctl-mic"
          onClick={onToggleMicrophone}
        >
          {microphoneEnabled ? <MicIcon /> : <MicOffIcon />}
        </ControlButton>

        <ControlButton
          label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
          active={cameraEnabled}
          muted={!cameraEnabled}
          testId="ctl-cam"
          onClick={onToggleCamera}
        >
          {cameraEnabled ? <CameraIcon /> : <CameraOffIcon />}
        </ControlButton>

        <ControlButton
          label={screenSharing ? "Stop sharing screen" : "Share screen"}
          active={screenSharing}
          testId="ctl-screen"
          onClick={onToggleScreenShare}
        >
          <ScreenShareIcon />
        </ControlButton>

        <ControlButton
          label="Toggle participant list"
          active={participantsOpen}
          testId="ctl-participants"
          onClick={onToggleParticipants}
          className="lg:hidden"
        >
          <UsersIcon />
        </ControlButton>

        <span
          className="mx-0.5 hidden h-7 w-px bg-[var(--border)] sm:mx-1 sm:block"
          aria-hidden="true"
        />

        <ControlButton
          label="Leave room"
          danger
          testId="ctl-leave"
          onClick={onLeave}
        >
          <LeaveIcon />
        </ControlButton>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  active,
  muted,
  danger,
  testId,
  onClick,
  children,
  className = "",
}: {
  label: string;
  active?: boolean;
  muted?: boolean;
  danger?: boolean;
  testId?: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  let tone: string;
  if (danger) {
    tone = "bg-[var(--danger)] text-white active:bg-[var(--danger-hover)]";
  } else if (muted) {
    tone =
      "bg-rose-500/15 text-rose-300 active:bg-rose-500/30 focus-visible:ring-rose-400/30";
  } else if (active) {
    tone = "bg-white/[0.14] text-white active:bg-white/[0.2]";
  } else {
    tone =
      "bg-white/[0.06] text-[var(--text-muted)] active:bg-white/[0.12] active:text-white";
  }

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className={`control-btn ${tone} ${className}`}
    >
      {children}
    </button>
  );
}
