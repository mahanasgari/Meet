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
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const screen = participant.getTrackPublication(Track.Source.ScreenShare);
  const screenAudio = participant.getTrackPublication(
    Track.Source.ScreenShareAudio,
  );

  const audioTracks: Track[] = [];
  if (!isLocal) {
    if (microphone?.audioTrack && !microphone.isMuted) {
      audioTracks.push(microphone.audioTrack);
    }
    if (screenAudio?.audioTrack && !screenAudio.isMuted) {
      audioTracks.push(screenAudio.audioTrack);
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
