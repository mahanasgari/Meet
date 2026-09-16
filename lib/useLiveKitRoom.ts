"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import {
  connectErrorMessage,
  tokenErrorFromBody,
  UserMessage,
} from "./errors";
import {
  cameraErrorMessage,
  microphoneErrorMessage,
  screenShareErrorMessage,
} from "./media";
import { snapshotParticipants, type ParticipantInfo } from "./participants";

export type RoomStatus = "idle" | "connecting" | "connected" | "error";

export interface PreparedTracks {
  audioTrack?: LocalAudioTrack;
  videoTrack?: LocalVideoTrack;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
}

const CONNECT_TIMEOUT_MS = 20_000;

/** Expose LiveKit Room on window only for local e2e / debugging — never on a public host. */
function allowTestRoomHook(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const REFRESH_EVENTS: RoomEvent[] = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.AudioPlaybackStatusChanged,
];

interface TokenResponse {
  token?: string;
  url?: string;
  error?: string;
}

async function connectWithTimeout(
  room: Room,
  url: string,
  token: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      room.connect(url, token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("Connection timed out"));
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Abort an in-flight connect so it cannot complete after we've moved on.
    if (timedOut) {
      await room.disconnect().catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function teardownRoom(room: Room | null): Promise<void> {
  if (!room) return;
  room.removeAllListeners();
  await room.disconnect().catch(() => undefined);
}

export function useLiveKitRoom(roomName: string) {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [canPlayAudio, setCanPlayAudio] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const leavingRef = useRef(false);
  const connectGeneration = useRef(0);
  const deviceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectShownAt = useRef(0);

  const showDeviceError = useCallback((message: string) => {
    setDeviceError(message);
    if (deviceErrorTimer.current) {
      clearTimeout(deviceErrorTimer.current);
    }
    deviceErrorTimer.current = setTimeout(() => {
      setDeviceError(null);
      deviceErrorTimer.current = null;
    }, 4000);
  }, []);

  const markReconnecting = useCallback(() => {
    if (reconnectClearTimer.current) {
      clearTimeout(reconnectClearTimer.current);
      reconnectClearTimer.current = null;
    }
    reconnectShownAt.current = Date.now();
    setReconnecting(true);
  }, []);

  const clearReconnecting = useCallback(() => {
    if (reconnectClearTimer.current) {
      clearTimeout(reconnectClearTimer.current);
    }
    const remaining = Math.max(0, 1000 - (Date.now() - reconnectShownAt.current));
    reconnectClearTimer.current = setTimeout(() => {
      setReconnecting(false);
      reconnectClearTimer.current = null;
    }, remaining);
  }, []);

  useEffect(() => {
    return () => {
      if (deviceErrorTimer.current) {
        clearTimeout(deviceErrorTimer.current);
      }
      if (reconnectClearTimer.current) {
        clearTimeout(reconnectClearTimer.current);
      }
    };
  }, []);

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setParticipants(snapshotParticipants(room));
    setCanPlayAudio(room.canPlaybackAudio);
  }, []);

  const clearRoomHook = useCallback((room: Room | null) => {
    if (
      typeof window !== "undefined" &&
      allowTestRoomHook() &&
      room &&
      (window as Window & { __meetRoom?: Room }).__meetRoom === room
    ) {
      delete (window as Window & { __meetRoom?: Room }).__meetRoom;
    }
  }, []);

  const bindRoomEvents = useCallback(
    (room: Room) => {
      for (const event of REFRESH_EVENTS) {
        room.on(event, refresh);
      }
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        roomRef.current = null;
        clearRoomHook(room);
        room.removeAllListeners();
        setParticipants([]);
        setReconnecting(false);
        setStatus("idle");
        if (!leavingRef.current) {
          setError(UserMessage.disconnected);
        } else {
          setError(null);
        }
        leavingRef.current = false;
      });
      room.on(RoomEvent.Reconnecting, markReconnecting);
      room.on(RoomEvent.SignalReconnecting, markReconnecting);
      room.on(RoomEvent.Reconnected, clearReconnecting);
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (
          state === ConnectionState.Reconnecting ||
          state === ConnectionState.SignalReconnecting
        ) {
          markReconnecting();
        } else if (state === ConnectionState.Connected) {
          clearReconnecting();
          refresh();
        }
      });
    },
    [refresh, markReconnecting, clearReconnecting, clearRoomHook],
  );

  const connect = useCallback(
    async (displayName: string, prepared?: PreparedTracks) => {
      const generation = ++connectGeneration.current;
      leavingRef.current = false;
      setStatus("connecting");
      setError(null);
      setDeviceError(null);

      // Tear down any prior room before starting a new connection attempt.
      const prior = roomRef.current;
      roomRef.current = null;
      clearRoomHook(prior);
      await teardownRoom(prior);

      let room: Room | null = null;

      try {
        let response: Response;
        try {
          response = await fetch("/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ room: roomName, name: displayName }),
          });
        } catch (cause) {
          throw new Error(connectErrorMessage(cause));
        }

        if (generation !== connectGeneration.current) return;

        let data: TokenResponse = {};
        try {
          data = (await response.json()) as TokenResponse;
        } catch {
          data = {};
        }

        if (!response.ok || !data.token || !data.url) {
          throw new Error(tokenErrorFromBody(response.status, data));
        }

        room = new Room({
          adaptiveStream: true,
          dynacast: true,
          disconnectOnPageLeave: true,
        });
        bindRoomEvents(room);
        roomRef.current = room;

        try {
          await connectWithTimeout(room, data.url, data.token);
        } catch (cause) {
          throw new Error(connectErrorMessage(cause));
        }

        if (generation !== connectGeneration.current) {
          await teardownRoom(room);
          if (roomRef.current === room) roomRef.current = null;
          clearRoomHook(room);
          return;
        }

        await room.startAudio().catch(() => undefined);
        if (allowTestRoomHook()) {
          (window as Window & { __meetRoom?: Room }).__meetRoom = room;
        }

        const local = room.localParticipant;
        if (prepared?.audioTrack) {
          if (prepared.microphoneEnabled) {
            await local
              .publishTrack(prepared.audioTrack, {
                source: Track.Source.Microphone,
              })
              .catch(() => undefined);
          } else {
            prepared.audioTrack.stop();
          }
        } else if (prepared?.microphoneEnabled !== false) {
          await local.setMicrophoneEnabled(true).catch(() => undefined);
        }

        if (generation !== connectGeneration.current) {
          await teardownRoom(room);
          if (roomRef.current === room) roomRef.current = null;
          clearRoomHook(room);
          return;
        }

        if (prepared?.videoTrack) {
          if (prepared.cameraEnabled) {
            await local
              .publishTrack(prepared.videoTrack, {
                source: Track.Source.Camera,
              })
              .catch(() => undefined);
          } else {
            prepared.videoTrack.stop();
          }
        } else if (prepared?.cameraEnabled !== false) {
          await local.setCameraEnabled(true).catch(() => undefined);
        }

        if (generation !== connectGeneration.current) {
          await teardownRoom(room);
          if (roomRef.current === room) roomRef.current = null;
          clearRoomHook(room);
          return;
        }

        setStatus("connected");
        refresh();
      } catch (cause) {
        if (generation !== connectGeneration.current) return;

        const failed = room ?? roomRef.current;
        roomRef.current = null;
        clearRoomHook(failed);
        setParticipants([]);
        setReconnecting(false);
        setError(
          cause instanceof Error
            ? cause.message
            : UserMessage.unableToConnect,
        );
        setStatus("error");
        await teardownRoom(failed);
        // Leave prepared tracks alive — PreJoin reclaims them after a failed join.
      }
    },
    [roomName, refresh, bindRoomEvents, clearRoomHook],
  );

  const disconnect = useCallback(async () => {
    connectGeneration.current += 1;
    const room = roomRef.current;
    leavingRef.current = true;
    roomRef.current = null;
    clearRoomHook(room);
    setParticipants([]);
    setReconnecting(false);
    setStatus("idle");
    setError(null);
    setDeviceError(null);
    await teardownRoom(room);
    leavingRef.current = false;
  }, [clearRoomHook]);

  const toggleMicrophone = useCallback(() => {
    const local = roomRef.current?.localParticipant;
    if (!local) return;
    void local
      .setMicrophoneEnabled(!local.isMicrophoneEnabled)
      .then(() => {
        setDeviceError(null);
        refresh();
      })
      .catch((cause) => showDeviceError(microphoneErrorMessage(cause)));
  }, [showDeviceError, refresh]);

  const toggleCamera = useCallback(() => {
    const local = roomRef.current?.localParticipant;
    if (!local) return;
    void local
      .setCameraEnabled(!local.isCameraEnabled)
      .then(() => {
        setDeviceError(null);
        refresh();
      })
      .catch((cause) => showDeviceError(cameraErrorMessage(cause)));
  }, [showDeviceError, refresh]);

  const toggleScreenShare = useCallback(() => {
    const local = roomRef.current?.localParticipant;
    if (!local) return;
    const enabling = !local.isScreenShareEnabled;
    void local
      .setScreenShareEnabled(enabling)
      .then(() => {
        setDeviceError(null);
        refresh();
      })
      .catch((cause) => {
        const message = screenShareErrorMessage(cause);
        if (message) showDeviceError(message);
        // Browser "cancel" leaves state unchanged; refresh in case of partial publish.
        refresh();
      });
  }, [showDeviceError, refresh]);

  const resumeAudio = useCallback(async () => {
    await roomRef.current?.startAudio().catch(() => undefined);
    refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      connectGeneration.current += 1;
      leavingRef.current = true;
      const room = roomRef.current;
      roomRef.current = null;
      clearRoomHook(room);
      void teardownRoom(room);
    };
  }, [clearRoomHook]);

  return {
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
  };
}
