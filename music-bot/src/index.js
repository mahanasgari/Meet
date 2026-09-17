/**
 * Meet Music Bot — isolated process.
 * Joins a LiveKit room and publishes decoded audio from media URLs.
 * YouTube / SoundCloud / etc. are resolved with yt-dlp; direct files use ffmpeg.
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
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz (per channel)
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
const MAX_QUEUE = 20;
const MAX_URL_LEN = 2048;
const BOT_NAME = "Music Bot";
/** Leave the LiveKit room shortly after the last human participant disconnects. */
const EMPTY_ROOM_GRACE_MS = Number(process.env.EMPTY_ROOM_GRACE_MS || 5_000);
/** Periodic sweep in case a disconnect event is missed. */
const EMPTY_ROOM_SWEEP_MS = Number(process.env.EMPTY_ROOM_SWEEP_MS || 15_000);
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";

/** Hosts that need yt-dlp (page URLs, not raw media files). */
const EXTRACTOR_HOST_RE =
  /(^|\.)((youtube|music\.youtube)\.com|youtu\.be|soundcloud\.com|bandcamp\.com|vimeo\.com)$/i;

/** @type {Map<string, RoomSession>} */
const sessions = new Map();

/**
 * @typedef {object} QueueItem
 * @property {string} url
 * @property {string | null} title
 */

/**
 * @typedef {object} RoomSession
 * @property {string} roomId
 * @property {QueueItem[]} queue
 * @property {QueueItem | null} current
 * @property {'idle'|'playing'|'paused'} status
 * @property {string | null} lastError
 * @property {import('@livekit/rtc-node').Room | null} room
 * @property {import('@livekit/rtc-node').AudioSource | null} source
 * @property {import('@livekit/rtc-node').LocalAudioTrack | null} track
 * @property {import('node:child_process').ChildProcess | null} ffmpeg
 * @property {import('node:child_process').ChildProcess | null} extractor
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

function needsExtractor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return EXTRACTOR_HOST_RE.test(host);
  } catch {
    return false;
  }
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
    current: session.current?.url ?? null,
    title: session.current?.title ?? null,
    queue: session.queue.map((item) => item.url),
    queueTitles: session.queue.map((item) => item.title),
    lastError: session.lastError,
  };
}

function idleStatus(roomId) {
  return {
    room: roomId,
    status: "idle",
    current: null,
    title: null,
    queue: [],
    queueTitles: [],
    lastError: null,
  };
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

  // Don't tear down mid-track (YouTube extract can take several seconds).
  // Leave only once the bot is idle with an empty queue.
  if (
    session.status === "playing" ||
    session.status === "paused" ||
    session.queue.length > 0 ||
    session.pump
  ) {
    return;
  }

  session.emptyTimer = setTimeout(() => {
    session.emptyTimer = null;
    if (!session.room?.isConnected) return;
    if (humanParticipantCount(session.room) > 0) return;
    if (
      session.status === "playing" ||
      session.status === "paused" ||
      session.queue.length > 0 ||
      session.pump
    ) {
      return;
    }
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
      lastError: null,
      room: null,
      source: null,
      track: null,
      ffmpeg: null,
      extractor: null,
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

  const source = new AudioSource(SAMPLE_RATE, CHANNELS, 4_000);
  const track = LocalAudioTrack.createAudioTrack("music", source);
  const options = new TrackPublishOptions();
  // Prefer ScreenShareAudio so clients that only wire mic/screenshare still
  // hear music; participants.ts also plays Unknown/any remote audio.
  options.source = TrackSource.SOURCE_SCREENSHARE_AUDIO;
  const local = room.localParticipant;
  if (!local) {
    await room.disconnect().catch(() => undefined);
    throw new Error("missing_local_participant");
  }
  await local.publishTrack(track, options);

  session.source = source;
  session.track = track;
}

function killChild(child) {
  if (!child) return;
  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    if (!child.killed) child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

function killPlayback(session) {
  const ffmpeg = session.ffmpeg;
  const extractor = session.extractor;
  session.ffmpeg = null;
  session.extractor = null;
  killChild(ffmpeg);
  killChild(extractor);
}

async function stopPlayback(session, { clearQueue = false } = {}) {
  session.playGeneration += 1;
  session.stopping = true;
  killPlayback(session);
  try {
    session.source?.clearQueue();
  } catch {
    // ignore
  }
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

/**
 * Resolve a page URL (YouTube etc.) to a direct media URL + headers via yt-dlp.
 * @param {string} pageUrl
 * @returns {Promise<{ title: string | null, streamUrl: string, headers: Record<string, string> }>}
 */
function resolveExtractorStream(pageUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP_BIN,
      [
        "-J",
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        pageUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killChild(child);
      reject(new Error("extractor_timeout"));
    }, 45_000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            (stderr.trim().split("\n").pop() || "extractor_failed").slice(0, 200),
          ),
        );
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const streamUrl = info.url || info.requested_formats?.[0]?.url;
        if (!streamUrl || typeof streamUrl !== "string") {
          reject(new Error("no_stream_url"));
          return;
        }
        resolve({
          title: typeof info.title === "string" ? info.title : null,
          streamUrl,
          headers: info.http_headers && typeof info.http_headers === "object"
            ? info.http_headers
            : {},
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad_extractor_json"));
      }
    });
  });
}

function headersToFfmpegArg(headers) {
  const lines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n");
  return lines ? `${lines}\r\n` : "";
}

/**
 * Start ffmpeg to produce s16le PCM on ffmpeg.stdout.
 * @param {string} inputUrl
 * @param {Record<string, string>} [headers]
 */
function spawnFfmpeg(inputUrl, headers = {}) {
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-thread_queue_size",
    "512",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
  ];

  const headerArg = headersToFfmpegArg(headers);
  if (headerArg) {
    ffmpegArgs.push("-headers", headerArg);
  } else {
    ffmpegArgs.push(
      "-user_agent",
      "Mozilla/5.0 (compatible; MeetMusicBot/1.0)",
    );
  }

  ffmpegArgs.push(
    "-i",
    inputUrl,
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
  );

  return spawn(FFMPEG_BIN, ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function pumpPcm(session) {
  const child = session.ffmpeg;
  const source = session.source;
  if (!child?.stdout || !source) return;

  /** @type {Buffer[]} */
  const chunks = [];
  let buffered = 0;
  let ended = false;
  let sawData = false;
  /** @type {((value?: unknown) => void) | null} */
  let wake = null;

  const notify = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };

  const waitForData = () =>
    new Promise((resolve) => {
      if (buffered >= FRAME_BYTES || ended) {
        resolve();
        return;
      }
      wake = resolve;
    });

  const MAX_BUFFER = SAMPLE_RATE * CHANNELS * 2 * 3; // ~3s of PCM
  const onData = (chunk) => {
    sawData = true;
    chunks.push(chunk);
    buffered += chunk.length;
    if (buffered >= MAX_BUFFER) {
      child.stdout.pause();
    }
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  const onError = (err) => {
    console.error(`[music-bot] ffmpeg stdout error (${session.roomId}):`, err);
    ended = true;
    notify();
  };

  child.stdout.on("data", onData);
  child.stdout.on("end", onEnd);
  child.stdout.on("error", onError);
  child.on("close", (code, signal) => {
    console.log(
      `[music-bot] ffmpeg closed (${session.roomId}) code=${code} signal=${signal}`,
    );
    ended = true;
    notify();
  });

  const takeFrame = () => {
    while (chunks.length && chunks[0].length === 0) chunks.shift();
    if (buffered < FRAME_BYTES) return null;

    const out = Buffer.allocUnsafe(FRAME_BYTES);
    let offset = 0;
    while (offset < FRAME_BYTES) {
      const head = chunks[0];
      const need = FRAME_BYTES - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        buffered -= head.length;
        chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        chunks[0] = head.subarray(need);
        offset += need;
        buffered -= need;
      }
    }
    return out;
  };

  try {
    while (!session.stopping && session.ffmpeg === child) {
      if (session.status === "paused") {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }

      let frameBuf = takeFrame();
      if (!frameBuf) {
        if (ended) break;
        await waitForData();
        continue;
      }

      const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
      samples.set(
        new Int16Array(frameBuf.buffer, frameBuf.byteOffset, FRAME_SAMPLES * CHANNELS),
      );

      await source.captureFrame(
        new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES),
      );
      if (buffered < MAX_BUFFER / 2 && child.stdout.isPaused()) {
        child.stdout.resume();
      }
    }

    if (!sawData && !session.stopping) {
      throw new Error("no_audio");
    }
  } catch (error) {
    if (!session.stopping) {
      console.error(`[music-bot] pump error (${session.roomId}):`, error);
      session.lastError =
        error instanceof Error ? error.message : "playback_error";
    }
  } finally {
    child.stdout.off("data", onData);
    child.stdout.off("end", onEnd);
    child.stdout.off("error", onError);
    killPlayback(session);
  }
}

async function playNext(session) {
  if (session.status === "playing" || session.status === "paused") return;
  if (session.queue.length === 0) {
    session.current = null;
    session.status = "idle";
    scheduleLeaveIfEmpty(session);
    return;
  }

  const item = session.queue.shift();
  session.current = item;
  session.status = "playing";
  session.stopping = false;
  session.lastError = null;
  const generation = ++session.playGeneration;

  try {
    await ensureConnected(session);
  } catch (error) {
    console.error(`[music-bot] connect failed (${session.roomId}):`, error);
    session.current = null;
    session.status = "idle";
    session.lastError = "connect_failed";
    scheduleLeaveIfEmpty(session);
    return;
  }

  /** @type {string} */
  let inputUrl = item.url;
  /** @type {Record<string, string>} */
  let headers = {};

  if (needsExtractor(item.url)) {
    try {
      const resolved = await resolveExtractorStream(item.url);
      inputUrl = resolved.streamUrl;
      headers = resolved.headers;
      if (resolved.title) {
        session.current = { ...item, title: resolved.title };
      }
    } catch (error) {
      console.error(`[music-bot] extract failed (${session.roomId}):`, error);
      session.lastError = "extract_failed";
      session.current = null;
      session.status = "idle";
      await playNext(session);
      return;
    }
  }

  if (generation !== session.playGeneration || session.stopping) return;

  const ffmpeg = spawnFfmpeg(inputUrl, headers);
  session.ffmpeg = ffmpeg;
  session.extractor = null;

  let ffmpegError = "";
  ffmpeg.stderr?.on("data", (buf) => {
    const text = buf.toString().trim();
    if (text) {
      ffmpegError = text;
      console.error(`[ffmpeg ${session.roomId}] ${text}`);
    }
  });
  ffmpeg.on("error", (err) => {
    console.error(`[ffmpeg ${session.roomId}] spawn error:`, err);
    session.lastError = "ffmpeg_missing";
  });

  session.pump = pumpPcm(session).finally(async () => {
    session.pump = null;
    if (generation !== session.playGeneration) return;

    if (session.lastError === "no_audio" || ffmpegError) {
      session.lastError = session.lastError || "playback_failed";
      console.error(
        `[music-bot] track failed (${session.roomId}): ${item.url} — ${session.lastError}`,
      );
    }

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
  session.queue.push({ url, title: null });
  session.lastError = null;
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
      sendJson(res, 200, { ok: true, extractor: "yt-dlp" });
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
