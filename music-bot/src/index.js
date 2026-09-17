/**
 * Meet Music Bot — isolated process.
 * Joins a LiveKit room and publishes decoded audio from media URLs.
 * State is in-memory only. Failures here must not affect the Meet web app.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { AccessToken } from "livekit-server-sdk";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";

const PORT = Number(process.env.PORT || 4100);
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const MAX_QUEUE = 20;
const MAX_URL_LEN = 2048;
const BOT_NAME = "Music Bot";
/** Leave the LiveKit room shortly after the last human participant disconnects. */
const EMPTY_ROOM_GRACE_MS = Number(process.env.EMPTY_ROOM_GRACE_MS || 5_000);
/** Periodic sweep in case a disconnect event is missed. */
const EMPTY_ROOM_SWEEP_MS = Number(process.env.EMPTY_ROOM_SWEEP_MS || 15_000);

/** @type {Map<string, RoomSession>} */
const sessions = new Map();

/**
 * @typedef {object} RoomSession
 * @property {string} roomId
 * @property {string[]} queue
 * @property {string | null} current
 * @property {'idle'|'playing'|'paused'} status
 * @property {import('@livekit/rtc-node').Room | null} room
 * @property {import('@livekit/rtc-node').AudioSource | null} source
 * @property {import('@livekit/rtc-node').LocalAudioTrack | null} track
 * @property {import('node:child_process').ChildProcess | null} ffmpeg
 * @property {boolean} stopping
 * @property {number} playGeneration
 * @property {Promise<void> | null} pump
 * @property {ReturnType<typeof setTimeout> | null} emptyTimer
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function isValidRoomId(value) {
  return typeof value === "string" && /^[a-z0-9]{8,40}$/.test(value);
}

function isAllowedMediaUrl(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > MAX_URL_LEN) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function botIdentity(roomId) {
  return `music-bot-${roomId}`;
}

function isMusicBotIdentity(identity) {
  return typeof identity === "string" && identity.startsWith("music-bot-");
}

function publicStatus(session) {
  return {
    room: session.roomId,
    status: session.status,
    current: session.current,
    queue: [...session.queue],
  };
}

function idleStatus(roomId) {
  return { room: roomId, status: "idle", current: null, queue: [] };
}

/** Count remote humans (bots / self do not keep a room "occupied"). */
function humanParticipantCount(room) {
  if (!room) return 0;
  let count = 0;
  for (const participant of room.remoteParticipants.values()) {
    if (!isMusicBotIdentity(participant.identity)) count += 1;
  }
  return count;
}

function clearEmptyTimer(session) {
  if (session.emptyTimer) {
    clearTimeout(session.emptyTimer);
    session.emptyTimer = null;
  }
}

function scheduleLeaveIfEmpty(session) {
  clearEmptyTimer(session);
  if (!session.room?.isConnected) return;
  if (humanParticipantCount(session.room) > 0) return;

  session.emptyTimer = setTimeout(() => {
    session.emptyTimer = null;
    if (!session.room?.isConnected) return;
    if (humanParticipantCount(session.room) > 0) return;
    console.log(
      `[music-bot] leaving empty room ${session.roomId} (no human participants)`,
    );
    void disconnectSession(session);
  }, EMPTY_ROOM_GRACE_MS);
}

function bindRoomLifecycle(session, room) {
  const onPresenceChange = () => scheduleLeaveIfEmpty(session);
  room.on(RoomEvent.ParticipantConnected, onPresenceChange);
  room.on(RoomEvent.ParticipantDisconnected, onPresenceChange);
  room.on(RoomEvent.Disconnected, () => {
    clearEmptyTimer(session);
  });
  // Initial check in case we joined an already-empty room.
  scheduleLeaveIfEmpty(session);
}

async function createBotToken(roomId) {
  const apiKey = requireEnv("LIVEKIT_API_KEY");
  const apiSecret = requireEnv("LIVEKIT_API_SECRET");
  const token = new AccessToken(apiKey, apiSecret, {
    identity: botIdentity(roomId),
    name: BOT_NAME,
    ttl: "12h",
  });
  token.addGrant({
    room: roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
  });
  return token.toJwt();
}

function getOrCreateSession(roomId) {
  let session = sessions.get(roomId);
  if (!session) {
    session = {
      roomId,
      queue: [],
      current: null,
      status: "idle",
      room: null,
      source: null,
      track: null,
      ffmpeg: null,
      stopping: false,
      playGeneration: 0,
      pump: null,
      emptyTimer: null,
    };
    sessions.set(roomId, session);
  }
  return session;
}

async function ensureConnected(session) {
  if (session.room?.isConnected) return;

  const livekitUrl = requireEnv("LIVEKIT_URL");
  const jwt = await createBotToken(session.roomId);
  const room = new Room();
  await room.connect(livekitUrl, jwt);
  session.room = room;
  bindRoomLifecycle(session, room);

  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack("music", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  const local = room.localParticipant;
  if (!local) {
    await room.disconnect().catch(() => undefined);
    throw new Error("missing_local_participant");
  }
  await local.publishTrack(track, options);

  session.source = source;
  session.track = track;
}

function killFfmpeg(session) {
  if (!session.ffmpeg) return;
  const child = session.ffmpeg;
  session.ffmpeg = null;
  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

async function stopPlayback(session, { clearQueue = false } = {}) {
  session.playGeneration += 1;
  session.stopping = true;
  killFfmpeg(session);
  session.source?.clearQueue();
  const pendingPump = session.pump;
  session.current = null;
  session.status = "idle";
  if (clearQueue) session.queue = [];
  if (pendingPump) {
    await pendingPump.catch(() => undefined);
  }
  session.stopping = false;
}

async function disconnectSession(session) {
  clearEmptyTimer(session);
  await stopPlayback(session, { clearQueue: true });
  try {
    await session.track?.close();
  } catch {
    // ignore
  }
  try {
    await session.source?.close();
  } catch {
    // ignore
  }
  try {
    await session.room?.disconnect();
  } catch {
    // ignore
  }
  session.track = null;
  session.source = null;
  session.room = null;
  sessions.delete(session.roomId);
}

function spawnFfmpeg(url) {
  return spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      url,
      "-vn",
      "-ac",
      String(CHANNELS),
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function pumpPcm(session) {
  const child = session.ffmpeg;
  const source = session.source;
  if (!child?.stdout || !source) return;

  let pending = Buffer.alloc(0);

  const readChunk = () =>
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        cleanup();
        resolve(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        child.stdout.off("data", onData);
        child.stdout.off("end", onEnd);
        child.stdout.off("error", onError);
      };
      child.stdout.once("data", onData);
      child.stdout.once("end", onEnd);
      child.stdout.once("error", onError);
    });

  try {
    while (!session.stopping && session.ffmpeg === child) {
      if (session.status === "paused") {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const chunk = await readChunk();
      if (chunk == null) break;

      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_BYTES && !session.stopping) {
        if (session.status === "paused") break;
        const frameBuf = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        const samples = new Int16Array(
          frameBuf.buffer,
          frameBuf.byteOffset,
          FRAME_SAMPLES,
        );
        await source.captureFrame(
          new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES),
        );
      }
    }
  } catch (error) {
    if (!session.stopping) {
      console.error(`[music-bot] pump error (${session.roomId}):`, error);
    }
  } finally {
    killFfmpeg(session);
  }
}

async function playNext(session) {
  if (session.status === "playing" || session.status === "paused") return;
  if (session.queue.length === 0) {
    session.current = null;
    session.status = "idle";
    return;
  }

  const url = session.queue.shift();
  session.current = url;
  session.status = "playing";
  session.stopping = false;
  const generation = ++session.playGeneration;

  try {
    await ensureConnected(session);
  } catch (error) {
    console.error(`[music-bot] connect failed (${session.roomId}):`, error);
    session.current = null;
    session.status = "idle";
    return;
  }

  const child = spawnFfmpeg(url);
  session.ffmpeg = child;
  child.stderr?.on("data", (buf) => {
    const text = buf.toString().trim();
    if (text) console.error(`[ffmpeg ${session.roomId}] ${text}`);
  });

  session.pump = pumpPcm(session).finally(async () => {
    session.pump = null;
    if (generation !== session.playGeneration) return;
    session.current = null;
    session.status = "idle";
    await playNext(session);
  });
}

async function handleEnqueue(session, url) {
  if (session.queue.length >= MAX_QUEUE) {
    const err = new Error("queue_full");
    err.status = 400;
    throw err;
  }
  session.queue.push(url);
  if (session.status === "idle") {
    void playNext(session);
  }
  return publicStatus(session);
}

async function handlePause(session) {
  if (session.status !== "playing") return publicStatus(session);
  session.status = "paused";
  return publicStatus(session);
}

async function handleResume(session) {
  if (session.status !== "paused") return publicStatus(session);
  session.status = "playing";
  return publicStatus(session);
}

async function handleSkip(session) {
  await stopPlayback(session);
  await playNext(session);
  return publicStatus(session);
}

async function handleStop(session) {
  // Fully leave so LiveKit can idle-close the room; stop must not keep a
  // ghost bot participant around after everyone else left.
  await disconnectSession(session);
  return idleStatus(session.roomId);
}

function readBody(req, limit = 8_192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body_too_large"), { status: 400 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const roomMatch = url.pathname.match(
      /^\/rooms\/([a-z0-9]{8,40})(?:\/(enqueue|pause|resume|skip|stop|status))?$/,
    );
    if (!roomMatch) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const roomId = roomMatch[1];
    const action =
      roomMatch[2] ||
      (req.method === "GET" ? "status" : null);

    if (!isValidRoomId(roomId) || !action) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    // Status polls must not create lasting sessions (panel refreshes often).
    if (action === "status" && req.method === "GET") {
      const existing = sessions.get(roomId);
      sendJson(res, 200, existing ? publicStatus(existing) : idleStatus(roomId));
      return;
    }

    const session = getOrCreateSession(roomId);

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (action === "enqueue") {
      const body = await readBody(req);
      if (!isAllowedMediaUrl(body.url)) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      const status = await handleEnqueue(session, body.url);
      sendJson(res, 200, status);
      return;
    }

    if (action === "pause") {
      sendJson(res, 200, await handlePause(session));
      return;
    }
    if (action === "resume") {
      sendJson(res, 200, await handleResume(session));
      return;
    }
    if (action === "skip") {
      sendJson(res, 200, await handleSkip(session));
      return;
    }
    if (action === "stop") {
      sendJson(res, 200, await handleStop(session));
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error?.status || 500;
    console.error("[music-bot] request error:", error);
    sendJson(res, status, {
      error: status === 500 ? "server_error" : error.message || "error",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[music-bot] listening on :${PORT}`);
});

// Safety net if a ParticipantDisconnected event is missed.
setInterval(() => {
  for (const session of sessions.values()) {
    if (session.room?.isConnected) {
      scheduleLeaveIfEmpty(session);
    }
  }
}, EMPTY_ROOM_SWEEP_MS).unref();

async function shutdown() {
  console.log("[music-bot] shutting down");
  for (const session of [...sessions.values()]) {
    await disconnectSession(session);
  }
  await dispose().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
