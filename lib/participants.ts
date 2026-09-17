import { Track, type Participant, type Room } from "livekit-client";

export interface ParticipantInfo {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenSharing: boolean;
  cameraTrack?: Track;
  screenTrack?: Track;
  audioTracks: Track[];
}

export function toParticipantInfo(
  participant: Participant,
  isLocal: boolean,
): ParticipantInfo {
  const camera = participant.getTrackPublication(Track.Source.Camera);
  const screen = participant.getTrackPublication(Track.Source.ScreenShare);

  // Collect every remote audio publication — mic, screenshare audio, and
  // Unknown (used by the music bot). Limiting to Microphone muted the bot.
  const audioTracks: Track[] = [];
  if (!isLocal) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.audioTrack && !publication.isMuted) {
        audioTracks.push(publication.audioTrack);
      }
    }
  }

  return {
    identity: participant.identity,
    name: participant.name || participant.identity,
    isLocal,
    isSpeaking: participant.isSpeaking,
    microphoneEnabled: participant.isMicrophoneEnabled,
    cameraEnabled: participant.isCameraEnabled,
    screenSharing: participant.isScreenShareEnabled,
    cameraTrack:
      camera && !camera.isMuted ? camera.videoTrack : undefined,
    screenTrack:
      screen && !screen.isMuted ? screen.videoTrack : undefined,
    audioTracks,
  };
}

export function snapshotParticipants(room: Room): ParticipantInfo[] {
  const remote = Array.from(room.remoteParticipants.values()).map(
    (participant) => toParticipantInfo(participant, false),
  );

  return [toParticipantInfo(room.localParticipant, true), ...remote];
}
