import { describe, expect, it } from "vitest";
import type { Participant } from "livekit-client";
import { Track } from "livekit-client";
import { toParticipantInfo } from "./participants";

interface FakePublication {
  isMuted?: boolean;
  videoTrack?: unknown;
  audioTrack?: unknown;
  source?: Track.Source;
}

function fakeParticipant(
  publications: Partial<Record<Track.Source, FakePublication>>,
  overrides: Record<string, unknown> = {},
): Participant {
  const audioTrackPublications = new Map<string, FakePublication>();
  for (const [source, publication] of Object.entries(publications)) {
    const sourceNum = Number(source) as unknown as Track.Source;
    if (
      sourceNum === Track.Source.Microphone ||
      sourceNum === Track.Source.ScreenShareAudio ||
      sourceNum === Track.Source.Unknown
    ) {
      audioTrackPublications.set(String(source), {
        ...publication,
        source: sourceNum,
      });
    }
  }

  return {
    identity: "identity",
    name: "Alex",
    isSpeaking: false,
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    getTrackPublication: (source: Track.Source) => publications[source],
    audioTrackPublications,
    ...overrides,
  } as unknown as Participant;
}

describe("toParticipantInfo", () => {
  it("maps basic participant fields", () => {
    const info = toParticipantInfo(
      fakeParticipant({}, {
        identity: "abc",
        name: "Sam",
        isSpeaking: true,
        isMicrophoneEnabled: true,
      }),
      false,
    );

    expect(info).toMatchObject({
      identity: "abc",
      name: "Sam",
      isLocal: false,
      isSpeaking: true,
      microphoneEnabled: true,
    });
  });

  it("omits muted tracks", () => {
    const info = toParticipantInfo(
      fakeParticipant({
        [Track.Source.Camera]: { isMuted: true, videoTrack: { id: "cam" } },
        [Track.Source.Microphone]: { isMuted: true, audioTrack: { id: "mic" } },
      }),
      false,
    );

    expect(info.cameraTrack).toBeUndefined();
    expect(info.audioTracks).toHaveLength(0);
  });

  it("collects remote camera, microphone and screen tracks", () => {
    const cameraTrack = { id: "cam" };
    const microphoneTrack = { id: "mic" };
    const screenTrack = { id: "screen" };
    const info = toParticipantInfo(
      fakeParticipant({
        [Track.Source.Camera]: { videoTrack: cameraTrack },
        [Track.Source.Microphone]: { audioTrack: microphoneTrack },
        [Track.Source.ScreenShare]: { videoTrack: screenTrack },
      }, { isScreenShareEnabled: true }),
      false,
    );

    expect(info.cameraTrack).toBe(cameraTrack);
    expect(info.screenTrack).toBe(screenTrack);
    expect(info.screenSharing).toBe(true);
    expect(info.audioTracks).toEqual([microphoneTrack]);
  });

  it("plays music-bot Unknown audio tracks", () => {
    const musicTrack = { id: "music" };
    const info = toParticipantInfo(
      fakeParticipant({
        [Track.Source.Unknown]: { audioTrack: musicTrack },
      }),
      false,
    );

    expect(info.audioTracks).toEqual([musicTrack]);
  });

  it("never plays back local audio", () => {
    const info = toParticipantInfo(
      fakeParticipant({
        [Track.Source.Microphone]: { audioTrack: { id: "mic" } },
        [Track.Source.Unknown]: { audioTrack: { id: "music" } },
      }),
      true,
    );

    expect(info.audioTracks).toHaveLength(0);
  });

  it("falls back to the identity when the name is empty", () => {
    const info = toParticipantInfo(
      fakeParticipant({}, { identity: "xyz", name: "" }),
      false,
    );

    expect(info.name).toBe("xyz");
  });
});
