/**
 * Meet Music Bot — isolated process.
 * Joins a LiveKit room and publishes decoded audio from media URLs.
 * YouTube / SoundCloud / etc. are resolved with yt-dlp; direct files use ffmpeg.
 * State is in-memory only. Failures here must not affect the Meet web app.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  createReadStream,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { AccessToken } from "livekit-server-sdk";
import { buildWeeklyChart } from "./charts.js";
import { audioFormat } from "./quality.js";
import { clipParams, makeClip } from "./clip.js";
import { renderDownloadPage } from "./download_page.js";
import {
  InviteStore,
  RateLimiter,
  Usage,
  makeUserToken,
  verifyUserToken,
} from "./invites.js";
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
/** Netscape cookies.txt — needed when YouTube bot-checks the server IP. */
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || "";
/** Optional: chrome / firefox / chromium (alternative to YTDLP_COOKIES). */
const YTDLP_BROWSER = process.env.YTDLP_BROWSER || "";
/**
 * Shared secret for MiniPlayer / external clients hitting /search and /audio.
 * Room control endpoints stay on the Docker network and do not need this.
 */
const MUSIC_API_TOKEN = process.env.MUSIC_API_TOKEN || "";

/** Optional outbound proxy for yt-dlp (e.g. Cloudflare WARP on a worker
 * whose own IP YouTube asks to sign in). */
const YTDLP_PROXY = process.env.YTDLP_PROXY || "";
function ytdlpNetArgs() {
  // Node (already in the image) as yt-dlp's JavaScript runtime: without one
  // YouTube serves fewer formats and flags the server as a bot more often.
  return [
    "--js-runtimes",
    "node",
    ...(YTDLP_PROXY ? ["--proxy", YTDLP_PROXY] : []),
  ];
}

function ytdlpCookieArgs() {
  if (YTDLP_COOKIES) return ["--cookies", YTDLP_COOKIES];
  if (YTDLP_BROWSER) return ["--cookies-from-browser", YTDLP_BROWSER];
  return [];
}

/**
 * A MiniPlayer user's YouTube session, sent per request as `X-YT-Cookie`
 * (never stored or logged here), written to a private Netscape cookie file
 * for yt-dlp. The caller must run the returned cleanup when done.
 * @param {string | undefined} header
 * @returns {{ args: string[], cleanup: () => void } | null}
 */
function userCookieArgs(header) {
  if (typeof header !== "string" || !header.includes("=") || header.length > 16_384) {
    return null;
  }
  const lines = ["# Netscape HTTP Cookie File"];
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!/^[\w.-]+$/.test(name) || /[\t\r\n]/.test(value)) continue;
    lines.push([".youtube.com", "TRUE", "/", "TRUE", expiry, name, value].join("\t"));
  }
  if (lines.length < 2) return null;
  const dir = mkdtempSync(joinPath(tmpdir(), "mp-ck-"));
  const file = joinPath(dir, "cookies.txt");
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return {
    args: ["--cookies", file],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function extractBearerOrHeader(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const header = req.headers["x-music-token"];
  return typeof header === "string" ? header.trim() : "";
}

// --- MiniPlayer invites: personal tokens signed with MUSIC_API_TOKEN.
// The home server keeps invites.json; workers (HOME_URL set) fetch the list
// of blocked users from it every few minutes.
const HOME_URL = (process.env.HOME_URL || "").replace(/\/+$/, "");
const invites = new InviteStore(process.env.SHARES_DIR || "/shares");
const usage = new Usage(process.env.SHARES_DIR || "/shares");
const userLimiter = new RateLimiter(
  Number(process.env.USER_REQUESTS_PER_10MIN) || 3000,
  10 * 60_000,
);
const redeemLimiter = new RateLimiter(10, 10 * 60_000);
let remoteBlocked = new Set();
setInterval(() => usage.save(), 60_000).unref();
async function refreshBlocked() {
  if (!HOME_URL) return;
  try {
    const r = await fetch(`${HOME_URL}/app/revoked.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) remoteBlocked = new Set((await r.json()).uids || []);
  } catch {
    // keep the last list
  }
}
refreshBlocked();
setInterval(refreshBlocked, 5 * 60_000).unref();
const isBlocked = (uid) =>
  remoteBlocked.has(uid) || invites.disabledUids().includes(uid);

/** True for the server's own secret (admin / owner). */
function isMasterToken(req) {
  return Boolean(MUSIC_API_TOKEN) && extractBearerOrHeader(req) === MUSIC_API_TOKEN;
}

/**
 * Check MUSIC_API_TOKEN or a MiniPlayer user token (from an invite). When
 * [optional], missing token is allowed (in-compose Meet app).
 */
function requireApiToken(req, res, { optional = false } = {}) {
  if (!MUSIC_API_TOKEN) return true;
  const got = extractBearerOrHeader(req);
  if (got === MUSIC_API_TOKEN) return true;
  if (optional && !got) return true;
  const uid = verifyUserToken(MUSIC_API_TOKEN, got);
  if (uid) {
    if (isBlocked(uid)) {
      sendJson(res, 403, { error: "blocked" });
      return false;
    }
    if (!userLimiter.hit(uid)) {
      sendJson(res, 429, { error: "slow_down" });
      return false;
    }
    usage.touch(uid);
    req.mpUser = uid;
    return true;
  }
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

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
        ...ytdlpNetArgs(),
        ...ytdlpCookieArgs(),
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
 * Stream extracted audio to an HTTP client (yt-dlp stdout).
 * Used by MiniPlayer so playback is not tied to the server's googlevideo IP.
 */
function pipeExtractorAudio(pageUrl, req, res, userCookies = null, quality = "") {
  const child = spawn(
    YTDLP_BIN,
    [
      "-f",
      audioFormat(quality),
      "--no-playlist",
      "--no-warnings",
      // The listener's own account when they sent one, else the server's.
      ...ytdlpNetArgs(),
      ...(userCookies ? userCookies.args : ytdlpCookieArgs()),
      "-o",
      "-",
      pageUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  let headersSent = false;
  const timer = setTimeout(() => {
    killChild(child);
    if (!headersSent && !res.headersSent) {
      sendJson(res, 504, { error: "extractor_timeout" });
    } else {
      res.destroy();
    }
  }, 10 * 60_000);

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8_000) stderr = stderr.slice(-4_000);
  });

  child.stdout?.once("data", (chunk) => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "Accept-Ranges": "none",
    });
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    console.error("[music-bot] audio spawn error:", err);
    if (!headersSent && !res.headersSent) {
      sendJson(res, 502, { error: "extractor_failed" });
    } else {
      res.destroy();
    }
  });

  child.on("close", () => userCookies?.cleanup());
  child.on("close", (code) => {
    clearTimeout(timer);
    if (!headersSent && !res.headersSent) {
      sendJson(res, 502, {
        error: (stderr.trim().split("\n").pop() || "extractor_failed").slice(
          0,
          200,
        ),
      });
      return;
    }
    if (code !== 0 && !res.writableEnded) {
      res.destroy();
    }
  });

  req.on("close", () => {
    clearTimeout(timer);
    killChild(child);
  });
}

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 40;
const MAX_SEARCH_QUERY_LEN = 100;

function isValidSearchQuery(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= MAX_SEARCH_QUERY_LEN
  );
}

const YTM_SONGS_PARAMS = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

function ytmText(column) {
  const runs =
    column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  return runs.map((r) => r.text || "");
}

function parseDurationText(text) {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text || "")) return null;
  return text.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Official audio tracks only, via YouTube Music's "Songs" search filter.
 * Music videos carry intros/skits/edits that break synced lyrics; these are
 * the studio recordings with real artist/album/duration metadata.
 * @param {string} query
 * @param {{ limit?: number, offset?: number }} [opts]
 */
async function searchYouTubeMusicSongs(query, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const r = await fetch(
    "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://music.youtube.com",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en" },
        },
        query: query.trim(),
        params: decodeURIComponent(YTM_SONGS_PARAMS),
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!r.ok) {
    throw Object.assign(new Error(`ytmusic_search_${r.status}`), { status: 502 });
  }
  const data = await r.json();
  const rows = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.musicResponsiveListItemRenderer) {
      rows.push(node.musicResponsiveListItemRenderer);
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(data);
  const results = [];
  for (const row of rows) {
    const id = row.playlistItemData?.videoId;
    if (!id || !/^[\w-]{11}$/.test(id)) continue;
    const title = ytmText(row.flexColumns?.[0]).join("").trim();
    // "Artist • Album • 3:38" (artist may be "A & B", album may be absent)
    const parts = ytmText(row.flexColumns?.[1])
      .join("")
      .split(" • ")
      .map((x) => x.trim())
      .filter(Boolean);
    const durationPart = parts.length ? parts[parts.length - 1] : "";
    const duration = parseDurationText(durationPart);
    const meta = duration != null ? parts.slice(0, -1) : parts;
    // YT Music prefixes the type on some layouts ("Song • Artist • …").
    if (meta[0] === "Song") meta.shift();
    results.push({
      id,
      title: title || "Unknown title",
      url: `https://www.youtube.com/watch?v=${id}`,
      duration,
      channel: meta[0] || null,
      album: meta[1] || null,
      kind: "video",
      audio: true,
      count: null,
    });
  }
  return results.slice(offset, offset + limit);
}

/**
 * YouTube search via yt-dlp (metadata only — no media download).
 * @param {string} query
 * @param {{ limit?: number, offset?: number, type?: 'video'|'playlist'|'mix' }} [opts]
 * @returns {Promise<Array<{ id: string, title: string, url: string, duration: number | null, channel: string | null, kind: string, count: number | null }>>}
 */
function searchYouTube(query, opts = {}) {
  const trimmed = query.trim();
  const type = opts.type === "playlist" || opts.type === "mix" ? opts.type : "video";
  const limit = Math.min(
    Math.max(Number(opts.limit) || SEARCH_LIMIT_DEFAULT, 1),
    SEARCH_LIMIT_MAX,
  );
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const fetchCount = Math.min(offset + limit, SEARCH_LIMIT_MAX);

  /** @type {string[]} */
  let ytdlpArgs;
  if (type === "playlist" || type === "mix") {
    // YouTube web results filtered to Playlists (sp=EgIQAw%3D%3D).
    const resultsUrl =
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(trimmed) +
      "&sp=EgIQAw%3D%3D";
    ytdlpArgs = [
      resultsUrl,
      "--flat-playlist",
      "-J",
      "--no-warnings",
      "--no-download",
      `--playlist-end=${fetchCount}`,
      ...ytdlpNetArgs(),
        ...ytdlpCookieArgs(),
    ];
  } else {
    ytdlpArgs = [
      `ytsearch${fetchCount}:${trimmed}`,
      "--flat-playlist",
      "-J",
      "--no-warnings",
      "--no-download",
      ...ytdlpNetArgs(),
        ...ytdlpCookieArgs(),
    ];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killChild(child);
      reject(Object.assign(new Error("search_timeout"), { status: 504 }));
    }, 35_000);

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
          Object.assign(
            new Error(
              (stderr.trim().split("\n").pop() || "search_failed").slice(0, 200),
            ),
            { status: 502 },
          ),
        );
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const entries = Array.isArray(info.entries) ? info.entries : [];
        const results = [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const id =
            typeof entry.id === "string" && entry.id
              ? entry.id
              : typeof entry.url === "string" && /^[\w-]{6,}$/.test(entry.url)
                ? entry.url
                : null;
          if (!id) continue;

          const isPlaylistEntry =
            entry._type === "playlist" ||
            entry.ie_key === "YoutubeTab" ||
            /^PL|^RD|^OL|^UU|^LL|^WL/i.test(id) ||
            (typeof entry.url === "string" && entry.url.includes("list="));

          if (type === "video" && isPlaylistEntry) continue;

          let kind = "video";
          if (isPlaylistEntry || type === "playlist" || type === "mix") {
            kind = /^RD/i.test(id) || /\bmix\b/i.test(String(entry.title || ""))
              ? "mix"
              : "playlist";
          }

          if (type === "mix" && kind !== "mix") continue;
          if (type === "playlist" && kind === "mix") {
            // Still allow mixes in playlist search — user asked for both.
          }

          const title =
            typeof entry.title === "string" && entry.title.trim()
              ? entry.title.trim()
              : id;
          const channel =
            (typeof entry.channel === "string" && entry.channel) ||
            (typeof entry.uploader === "string" && entry.uploader) ||
            null;
          const duration =
            typeof entry.duration === "number" && Number.isFinite(entry.duration)
              ? Math.round(entry.duration)
              : null;
          const count =
            typeof entry.playlist_count === "number"
              ? entry.playlist_count
              : typeof entry.n_entries === "number"
                ? entry.n_entries
                : null;

          let pageUrl;
          if (kind === "video") {
            pageUrl = `https://www.youtube.com/watch?v=${id}`;
          } else if (/^RD/i.test(id)) {
            pageUrl = `https://www.youtube.com/watch?v=${id.slice(2)}&list=${id}`;
            // RD mixes need a seed video; if id is only RD..., use playlist URL.
            if (id.length <= 4) {
              pageUrl = `https://www.youtube.com/playlist?list=${id}`;
            } else if (!/^RD[A-Za-z0-9_-]{11}/.test(id) && id.startsWith("RD")) {
              pageUrl = `https://www.youtube.com/playlist?list=${id}`;
            } else if (/^RD[A-Za-z0-9_-]{11}/.test(id)) {
              const seed = id.slice(2, 13);
              pageUrl = `https://www.youtube.com/watch?v=${seed}&list=${id}`;
            } else {
              pageUrl = `https://www.youtube.com/playlist?list=${id}`;
            }
          } else {
            pageUrl =
              typeof entry.url === "string" && entry.url.startsWith("http")
                ? entry.url
                : `https://www.youtube.com/playlist?list=${id}`;
          }

          results.push({
            id,
            title: title.slice(0, 120),
            url: pageUrl,
            duration,
            channel: channel ? channel.slice(0, 64) : null,
            kind,
            count,
          });
        }
        resolve(results.slice(offset, offset + limit));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad_search_json"));
      }
    });
  });
}

/** In-memory metadata cache (url → { at, data }). Avoids re-running yt-dlp on song click. */
const META_CACHE_TTL_MS = 30 * 60 * 1000;
const META_CACHE_MAX = 200;
/** @type {Map<string, { at: number, data: object }>} */
const metaCache = new Map();

/**
 * Full metadata for one watch/playlist URL (lazy — called when user opens a song).
 * @param {string} pageUrl
 */
function fetchVideoMeta(pageUrl) {
  const key = pageUrl.trim();
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_CACHE_TTL_MS) {
    return Promise.resolve(hit.data);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP_BIN,
      [
        key,
        "-J",
        "--no-warnings",
        "--no-download",
        "--no-playlist",
        "--skip-download",
        ...ytdlpNetArgs(),
        ...ytdlpCookieArgs(),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killChild(child);
      reject(Object.assign(new Error("meta_timeout"), { status: 504 }));
    }, 25_000);

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
          Object.assign(
            new Error(
              (stderr.trim().split("\n").pop() || "meta_failed").slice(0, 200),
            ),
            { status: 502 },
          ),
        );
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const id =
          typeof info.id === "string" && info.id
            ? info.id
            : null;
        let thumb = null;
        if (typeof info.thumbnail === "string" && info.thumbnail) {
          thumb = info.thumbnail;
        } else if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
          const last = info.thumbnails[info.thumbnails.length - 1];
          if (last && typeof last.url === "string") thumb = last.url;
        }
        if (!thumb && id && id.length >= 11) {
          thumb = `https://i.ytimg.com/vi/${id.slice(0, 11)}/hqdefault.jpg`;
        }
        const data = {
          id,
          title:
            typeof info.title === "string" && info.title.trim()
              ? info.title.trim().slice(0, 200)
              : null,
          channel:
            (typeof info.channel === "string" && info.channel) ||
            (typeof info.uploader === "string" && info.uploader) ||
            null,
          duration:
            typeof info.duration === "number" && Number.isFinite(info.duration)
              ? Math.round(info.duration)
              : null,
          thumbnail: thumb,
          description:
            typeof info.description === "string" && info.description.trim()
              ? info.description.trim().slice(0, 500)
              : null,
          url:
            typeof info.webpage_url === "string"
              ? info.webpage_url
              : key,
        };
        if (metaCache.size >= META_CACHE_MAX) {
          const oldest = metaCache.keys().next().value;
          if (oldest) metaCache.delete(oldest);
        }
        metaCache.set(key, { at: Date.now(), data });
        resolve(data);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad_meta_json"));
      }
    });
  });
}

/**
 * Expand a playlist / mix URL to track entries.
 * @param {string} pageUrl
 * @param {{ limit?: number }} [opts]
 */
function listPlaylistEntries(pageUrl, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 80);
  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP_BIN,
      [
        pageUrl,
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--no-download",
        "--yes-playlist",
        `--playlist-end=${limit}`,
        ...ytdlpNetArgs(),
        ...ytdlpCookieArgs(),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killChild(child);
      reject(Object.assign(new Error("playlist_timeout"), { status: 504 }));
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
          Object.assign(
            new Error(
              (stderr.trim().split("\n").pop() || "playlist_failed").slice(
                0,
                200,
              ),
            ),
            { status: 502 },
          ),
        );
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const entries = Array.isArray(info.entries) ? info.entries : [];
        const results = [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const id =
            typeof entry.id === "string" && entry.id
              ? entry.id
              : typeof entry.url === "string" && /^[\w-]{11}$/.test(entry.url)
                ? entry.url
                : null;
          if (!id || id.length < 10) continue;
          const title =
            typeof entry.title === "string" && entry.title.trim()
              ? entry.title.trim()
              : id;
          const channel =
            (typeof entry.channel === "string" && entry.channel) ||
            (typeof entry.uploader === "string" && entry.uploader) ||
            null;
          const duration =
            typeof entry.duration === "number" && Number.isFinite(entry.duration)
              ? Math.round(entry.duration)
              : null;
          results.push({
            id,
            title: title.slice(0, 120),
            url: `https://www.youtube.com/watch?v=${id}`,
            duration,
            channel: channel ? channel.slice(0, 64) : null,
            kind: "video",
            count: null,
          });
          if (results.length >= limit) break;
        }
        resolve({
          title: typeof info.title === "string" ? info.title : null,
          results,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad_playlist_json"));
      }
    });
  });
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

// --- Shared playlists (MiniPlayer): code → {name, tracks} --------------
const SHARES_DIR = process.env.SHARES_DIR || "/shares";
const SHARES_FILE = joinPath(SHARES_DIR, "shares.json");
const SHARES_MAX = 5000;
/** @type {Map<string, {name: string, tracks: object[], at: number}>} */
const shares = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(SHARES_FILE, "utf8")))) {
    shares.set(k, v);
  }
} catch {
  // first run / no volume
}
let sharesSaveTimer = null;
function saveSharesSoon() {
  clearTimeout(sharesSaveTimer);
  sharesSaveTimer = setTimeout(() => {
    try {
      mkdirSync(SHARES_DIR, { recursive: true });
      writeFileSync(SHARES_FILE, JSON.stringify(Object.fromEntries(shares)));
    } catch (e) {
      console.error("[shares] save failed", e?.message);
    }
  }, 1000);
}
function shareCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (shares.has(code));
  return code;
}
function cleanShareTrack(t) {
  if (!t || typeof t !== "object") return null;
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const id = str(t.id, 80);
  const u = str(t.u, 300);
  if (!id || !u || !isAllowedMediaUrl(u)) return null;
  return {
    id,
    t: str(t.t, 200) || "Unknown title",
    a: str(t.a, 120),
    u,
    art: str(t.art, 500).startsWith("http") ? str(t.art, 500) : undefined,
    d: Number.isFinite(t.d) ? Math.max(0, Math.round(t.d)) : undefined,
  };
}

/** Body as JSON; accepts `Content-Encoding: gzip` (small over lossy links). */
function readJsonMaybeGzip(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body_too_large"), { status: 400 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        let buf = Buffer.concat(chunks);
        if ((req.headers["content-encoding"] || "").includes("gzip")) {
          buf = gunzipSync(buf, { maxOutputLength: 1_000_000 });
        }
        resolve(buf.length ? JSON.parse(buf.toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
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

/** In-memory Listen Together (jam) rooms — synced queue, clients play locally. */
const JAM_MAX_QUEUE = 80;
const JAM_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
/** @type {Map<string, JamSession>} */
const jamSessions = new Map();

/**
 * @typedef {object} JamTrack
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string} artist
 * @property {string | null} artworkUrl
 */

/**
 * @typedef {object} JamSession
 * @property {string} roomId
 * @property {JamTrack[]} queue
 * @property {number} index
 * @property {'idle'|'playing'|'paused'} status
 * @property {number} basePositionMs
 * @property {number | null} startedAtMs
 * @property {number} updatedAt
 */

function randomRoomId(len = 8) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function jamPositionMs(session) {
  if (session.status === "playing" && session.startedAtMs != null) {
    return Math.max(
      0,
      session.basePositionMs + (Date.now() - session.startedAtMs),
    );
  }
  return Math.max(0, session.basePositionMs);
}

function publicJamStatus(session) {
  const current =
    session.index >= 0 && session.index < session.queue.length
      ? session.queue[session.index]
      : null;
  return {
    roomId: session.roomId,
    status: session.status,
    index: session.index,
    current,
    queue: session.queue,
    positionMs: jamPositionMs(session),
    serverTime: Date.now(),
    messages: (session.messages || []).slice(-JAM_MAX_MESSAGES),
    // Recent reactions only; clients float each one once.
    reactions: (session.reactions || []).filter((r) => Date.now() - r.ts < 15_000),
    listeners: [...(session.seen || new Map()).entries()]
      .filter(([, at]) => Date.now() - at < 12_000)
      .map(([n]) => n),
  };
}

const JAM_MAX_MESSAGES = 40;
const JAM_REACTIONS = new Set(["❤️", "🔥", "😂", "👏", "🎉", "😮"]);

function jamName(name) {
  const n = typeof name === "string" ? name.trim().slice(0, 24) : "";
  return n || "Guest";
}

/** Presence: who polled this room recently. */
function jamSeen(session, name) {
  if (typeof name !== "string" || !name.trim()) return;
  (session.seen ||= new Map()).set(jamName(name), Date.now());
}

function getJam(roomId) {
  return jamSessions.get(roomId) || null;
}

function touchJam(session) {
  session.updatedAt = Date.now();
}

function createJamSession() {
  let roomId = randomRoomId(8);
  while (jamSessions.has(roomId)) roomId = randomRoomId(8);
  /** @type {JamSession} */
  const session = {
    roomId,
    queue: [],
    index: -1,
    status: "idle",
    basePositionMs: 0,
    startedAtMs: null,
    updatedAt: Date.now(),
  };
  jamSessions.set(roomId, session);
  return session;
}

function jamEnqueue(session, track) {
  if (session.queue.length >= JAM_MAX_QUEUE) {
    const err = new Error("queue_full");
    err.status = 400;
    throw err;
  }
  session.queue.push(track);
  touchJam(session);
  if (session.status === "idle" || session.index < 0) {
    session.index = session.queue.length - 1;
    session.status = "playing";
    session.basePositionMs = 0;
    session.startedAtMs = Date.now();
  }
  return publicJamStatus(session);
}

function jamPause(session) {
  if (session.status !== "playing") return publicJamStatus(session);
  session.basePositionMs = jamPositionMs(session);
  session.startedAtMs = null;
  session.status = "paused";
  touchJam(session);
  return publicJamStatus(session);
}

function jamResume(session) {
  if (session.status !== "paused") return publicJamStatus(session);
  if (session.index < 0 || session.index >= session.queue.length) {
    return publicJamStatus(session);
  }
  session.status = "playing";
  session.startedAtMs = Date.now();
  touchJam(session);
  return publicJamStatus(session);
}

function jamSkip(session) {
  if (session.queue.length === 0) {
    session.index = -1;
    session.status = "idle";
    session.basePositionMs = 0;
    session.startedAtMs = null;
    touchJam(session);
    return publicJamStatus(session);
  }
  if (session.index < session.queue.length - 1) {
    session.index += 1;
  } else {
    session.index = -1;
    session.status = "idle";
    session.basePositionMs = 0;
    session.startedAtMs = null;
    touchJam(session);
    return publicJamStatus(session);
  }
  session.status = "playing";
  session.basePositionMs = 0;
  session.startedAtMs = Date.now();
  touchJam(session);
  return publicJamStatus(session);
}

function jamPlayAt(session, index) {
  if (index < 0 || index >= session.queue.length) {
    const err = new Error("invalid_index");
    err.status = 400;
    throw err;
  }
  session.index = index;
  session.status = "playing";
  session.basePositionMs = 0;
  session.startedAtMs = Date.now();
  touchJam(session);
  return publicJamStatus(session);
}

function jamRemove(session, index) {
  if (index < 0 || index >= session.queue.length) {
    const err = new Error("invalid_index");
    err.status = 400;
    throw err;
  }
  session.queue.splice(index, 1);
  if (session.queue.length === 0) {
    session.index = -1;
    session.status = "idle";
    session.basePositionMs = 0;
    session.startedAtMs = null;
  } else if (index < session.index) {
    session.index -= 1;
  } else if (index === session.index) {
    if (session.index >= session.queue.length) {
      session.index = session.queue.length - 1;
    }
    session.basePositionMs = 0;
    session.startedAtMs =
      session.status === "playing" ? Date.now() : null;
  }
  touchJam(session);
  return publicJamStatus(session);
}

function jamStop(session) {
  session.status = "idle";
  session.index = -1;
  session.basePositionMs = 0;
  session.startedAtMs = null;
  session.queue = [];
  touchJam(session);
  return publicJamStatus(session);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of jamSessions) {
    if (now - session.updatedAt > JAM_IDLE_TTL_MS) {
      jamSessions.delete(id);
    }
  }
}, 60_000);

function parseJamTrack(body) {
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isAllowedMediaUrl(url)) return null;
  const id =
    (typeof body.id === "string" && body.id.trim()) ||
    `jam_${Buffer.from(url).toString("base64url").slice(0, 24)}`;
  return {
    id,
    url,
    title:
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : "Unknown title",
    artist:
      typeof body.artist === "string" && body.artist.trim()
        ? body.artist.trim().slice(0, 120)
        : "Unknown",
    artworkUrl:
      typeof body.artworkUrl === "string" && body.artworkUrl.startsWith("http")
        ? body.artworkUrl.slice(0, 500)
        : null,
  };
}

/** First continuation token in an innertube response, if any. */
function findContinuation(node) {
  if (!node || typeof node !== "object") return null;
  if (node.nextContinuationData?.continuation) {
    return node.nextContinuationData.continuation;
  }
  if (node.continuationCommand?.token) return node.continuationCommand.token;
  for (const v of Object.values(node)) {
    const t = findContinuation(v);
    if (t) return t;
  }
  return null;
}

/** JSON reply, gzip-compressed when the client accepts it (≈10× smaller). */
function sendMaybeGzip(req, res, status, text) {
  const headers = { "Content-Type": "application/json" };
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    const body = gzipSync(text);
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(status, headers);
  res.end(text);
}

/** Innertube calls MiniPlayer may relay with the listener's own session. */
const YTM_ENDPOINTS = new Set([
  "browse",
  "next",
  "player",
  "search",
  "account/account_menu",
  "like/like",
  "like/removelike",
]);

/**
 * The listener's YouTube session headers. `-B64` variants are preferred:
 * some mobile networks drop requests whose headers contain Google auth
 * keywords (e.g. "SAPISIDHASH"), so MiniPlayer base64-encodes them.
 * @param {"cookie" | "auth"} which
 */
function ytSessionHeader(req, which) {
  const b64 = req.headers[`x-yt-${which}-b64`];
  if (typeof b64 === "string" && b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  const plain = req.headers[`x-yt-${which}`];
  return typeof plain === "string" ? plain : undefined;
}

/** Headers for a relayed signed-in call; the session never touches logs. */
function ytmForwardHeaders(req, extra) {
  const h = {
    ...extra,
    Origin: "https://music.youtube.com",
    "X-Origin": "https://music.youtube.com",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
  const cookie = ytSessionHeader(req, "cookie");
  const auth = ytSessionHeader(req, "auth");
  const user = req.headers["x-goog-authuser"];
  const visitor = req.headers["x-goog-visitor-id"];
  if (typeof visitor === "string") h["X-Goog-Visitor-Id"] = visitor;
  h.Referer = "https://music.youtube.com/";
  const ver = req.headers["x-youtube-client-version"];
  if (typeof cookie === "string") h.Cookie = cookie;
  if (typeof auth === "string") h.Authorization = auth;
  if (typeof user === "string") h["X-Goog-AuthUser"] = user;
  if (typeof ver === "string") {
    h["X-YouTube-Client-Name"] = "67";
    h["X-YouTube-Client-Version"] = ver;
  }
  return h;
}

/** MiniPlayer lyrics proxy: path → fixed upstream + allowed query params. */
const LYRICS_ROUTES = {
  "/lyrics/lrclib/get": {
    url: "https://lrclib.net/api/get",
    params: ["track_name", "artist_name", "album_name", "duration"],
  },
  "/lyrics/lrclib/search": {
    url: "https://lrclib.net/api/search",
    params: ["q", "track_name", "artist_name"],
  },
  "/lyrics/better": {
    url: "https://lyrics-api.boidu.dev/getLyrics",
    params: ["s", "a", "d", "al"],
  },
  "/lyrics/lyricsplus": {
    url: "https://lyricsplus.binimum.org/v2/lyrics/get",
    params: ["title", "artist", "duration", "album"],
  },
  "/lyrics/bini": {
    url: "https://lyrics-api.binimum.org/",
    params: ["track", "artist", "album", "duration"],
  },
  // Bini search results point at a TTML file named by ISRC.
  "/lyrics/bini/ttml": {
    url: (q) => {
      const id = q.get("id") || "";
      return /^[A-Za-z0-9]{8,16}$/.test(id)
        ? `https://lrc.red/s/${id}.ttml`
        : null;
    },
    params: [],
  },
  "/lyrics/unison": {
    url: "https://unison.boidu.dev/lyrics",
    params: ["song", "artist", "album", "duration"],
  },
  "/lyrics/kugou/search": {
    url: "https://lyrics.kugou.com/search?ver=1&man=yes&client=pc",
    params: ["keyword", "duration", "hash"],
  },
  // Lyrics translation (Google's public endpoint), a few lines per call.
  "/lyrics/translate": {
    url: "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t",
    params: ["sl", "tl", "q"],
    max: 1500,
  },
  "/lyrics/kugou/download": {
    url: "https://lyrics.kugou.com/download?ver=1&client=pc&fmt=lrc&charset=utf8",
    params: ["id", "accesskey"],
  },
};
const LYRICS_CACHE_MS = 6 * 60 * 60 * 1000;
const LYRICS_CACHE_MAX = 500;
/** @type {Map<string, {at: number, status: number, type: string, body: string}>} */
const lyricsCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        extractor: "yt-dlp",
        publicApi: Boolean(MUSIC_API_TOKEN),
        jamRooms: jamSessions.size,
      });
      return;
    }

    // --- Listen Together (jam) API ---
    if (req.method === "POST" && url.pathname === "/jam") {
      if (!requireApiToken(req, res)) return;
      const session = createJamSession();
      sendJson(res, 200, publicJamStatus(session));
      return;
    }

    const jamMatch = url.pathname.match(
      /^\/jam\/([a-z0-9]{8,40})(?:\/(enqueue|pause|resume|skip|stop|playAt|remove|chat|react))?$/,
    );
    if (jamMatch) {
      if (!requireApiToken(req, res)) return;
      const roomId = jamMatch[1];
      const action = jamMatch[2] || (req.method === "GET" ? "status" : null);
      if (!isValidRoomId(roomId) || !action) {
        sendJson(res, 400, { error: "invalid_request" });
        return;
      }

      if (action === "status" && req.method === "GET") {
        const existing = getJam(roomId);
        if (!existing) {
          sendJson(res, 404, { error: "room_not_found" });
          return;
        }
        touchJam(existing);
        jamSeen(existing, url.searchParams.get("name"));
        sendJson(res, 200, publicJamStatus(existing));
        return;
      }

      const session = getJam(roomId);
      if (!session) {
        sendJson(res, 404, { error: "room_not_found" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (action === "enqueue") {
        const body = await readBody(req);
        const track = parseJamTrack(body);
        if (!track) {
          sendJson(res, 400, { error: "invalid_track" });
          return;
        }
        sendJson(res, 200, jamEnqueue(session, track));
        return;
      }
      if (action === "pause") {
        sendJson(res, 200, jamPause(session));
        return;
      }
      if (action === "resume") {
        sendJson(res, 200, jamResume(session));
        return;
      }
      if (action === "skip") {
        sendJson(res, 200, jamSkip(session));
        return;
      }
      if (action === "stop") {
        sendJson(res, 200, jamStop(session));
        return;
      }
      if (action === "playAt") {
        const body = await readBody(req);
        const index = Number(body.index);
        sendJson(res, 200, jamPlayAt(session, index));
        return;
      }
      if (action === "chat") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          sendJson(res, 400, { error: "empty_message" });
          return;
        }
        const msgs = (session.messages ||= []);
        msgs.push({
          id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          name: jamName(body.name),
          text: text.slice(0, 300),
          ts: Date.now(),
        });
        if (msgs.length > JAM_MAX_MESSAGES) msgs.splice(0, msgs.length - JAM_MAX_MESSAGES);
        jamSeen(session, body.name);
        touchJam(session);
        sendJson(res, 200, publicJamStatus(session));
        return;
      }
      if (action === "react") {
        const body = await readBody(req);
        if (!JAM_REACTIONS.has(body.emoji)) {
          sendJson(res, 400, { error: "invalid_reaction" });
          return;
        }
        const list = (session.reactions ||= []);
        list.push({
          id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          name: jamName(body.name),
          emoji: body.emoji,
          ts: Date.now(),
        });
        if (list.length > 30) list.splice(0, list.length - 30);
        jamSeen(session, body.name);
        touchJam(session);
        sendJson(res, 200, publicJamStatus(session));
        return;
      }
      if (action === "remove") {
        const body = await readBody(req);
        const index = Number(body.index);
        sendJson(res, 200, jamRemove(session, index));
        return;
      }

      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/share") {
      if (!requireApiToken(req, res)) return;
      const body = await readJsonMaybeGzip(req, 200_000);
      const tracks = (Array.isArray(body.tracks) ? body.tracks : [])
        .slice(0, 300)
        .map(cleanShareTrack)
        .filter(Boolean);
      if (!tracks.length) {
        sendJson(res, 400, { error: "no_tracks" });
        return;
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 80)
          : "Shared playlist";
      if (shares.size >= SHARES_MAX) shares.delete(shares.keys().next().value);
      const code = shareCode();
      shares.set(code, { name, tracks, at: Date.now() });
      saveSharesSoon();
      sendJson(res, 200, { code });
      return;
    }
    // --- MiniPlayer app updates: latest.json + release files (public, no
    // token, so any old app can always update). Files live in SHARES_DIR/app.
    // --- Download page for friends (public).
    if (req.method === "GET" && (url.pathname === "/app/" || url.pathname === "/app")) {
      if (url.pathname === "/app") {
        res.writeHead(301, { Location: "app/" });
        res.end();
        return;
      }
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(joinPath(SHARES_DIR, "app", "latest.json"), "utf8"));
      } catch {
        // nothing published yet
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(renderDownloadPage(manifest));
      return;
    }

    // --- Invites: redeem a code (public, rate-limited per address).
    if (req.method === "POST" && url.pathname === "/invite/redeem") {
      const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
      if (!redeemLimiter.hit(ip)) {
        sendJson(res, 429, { error: "too_many_attempts" });
        return;
      }
      const body = await readBody(req, 2_000).catch(() => ({}));
      const entry = invites.redeem(body.code);
      if (!entry) {
        sendJson(res, 404, { error: "invalid_code" });
        return;
      }
      if (entry.disabled) {
        sendJson(res, 403, { error: "blocked" });
        return;
      }
      sendJson(res, 200, {
        token: makeUserToken(MUSIC_API_TOKEN, entry.uid),
        name: entry.name,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/app/revoked.json") {
      sendJson(res, 200, { uids: invites.disabledUids() });
      return;
    }
    // --- Feedback from the app (signed-in users; stored on this server).
    if (req.method === "POST" && url.pathname === "/feedback") {
      if (!requireApiToken(req, res)) return;
      const body = await readJsonMaybeGzip(req, 400_000).catch(() => null);
      const text = typeof body?.text === "string" ? body.text.trim().slice(0, 5000) : "";
      if (!text) {
        sendJson(res, 400, { error: "empty" });
        return;
      }
      const who = req.mpUser
        ? invites.list().find((e) => e.uid === req.mpUser)?.name || req.mpUser
        : "owner";
      const entry = {
        at: new Date().toISOString(),
        from: who,
        uid: req.mpUser || null,
        text,
        version: String(body.version || "").slice(0, 40),
        platform: String(body.platform || "").slice(0, 40),
        log: typeof body.log === "string" ? body.log.slice(0, 200_000) : null,
      };
      const dir = joinPath(SHARES_DIR, "feedback");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        joinPath(dir, `${entry.at.replace(/[:.]/g, "-")}-${req.mpUser || "owner"}.json`),
        JSON.stringify(entry, null, 1),
      );
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/feedback") {
      if (!isMasterToken(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const dir = joinPath(SHARES_DIR, "feedback");
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
      } catch {
        // none yet
      }
      const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 200);
      sendJson(res, 200, {
        feedback: files.slice(0, limit).map((f) => {
          try {
            return { file: f, ...JSON.parse(readFileSync(joinPath(dir, f), "utf8")) };
          } catch {
            return { file: f, error: "unreadable" };
          }
        }),
      });
      return;
    }

    // --- Invite admin (the server secret only).
    if (url.pathname.startsWith("/admin/invites")) {
      if (!isMasterToken(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/admin/invites") {
        usage.save();
        sendJson(res, 200, {
          invites: invites.list().map((e) => ({ ...e, usage: usage.summary(e.uid) })),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/invites") {
        const body = await readBody(req, 2_000).catch(() => ({}));
        sendJson(res, 200, invites.create(body.name));
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/invites/delete") {
        const body = await readBody(req, 2_000).catch(() => ({}));
        const e = invites.remove(body.id);
        sendJson(res, e ? 200 : 404, e || { error: "not_found" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/invites/block") {
        const body = await readBody(req, 2_000).catch(() => ({}));
        const e = invites.setDisabled(body.id, body.blocked !== false);
        sendJson(res, e ? 200 : 404, e || { error: "not_found" });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    // servers.json: the list of music servers apps may use (edited by the
    // operator, so adding a server needs no app update).
    const appJson = url.pathname.match(/^\/app\/(latest|servers)\.json$/);
    if (req.method === "GET" && appJson) {
      try {
        const body = readFileSync(joinPath(SHARES_DIR, "app", `${appJson[1]}.json`));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(body);
      } catch {
        sendJson(res, 404, { error: appJson[1] === "latest" ? "no_release" : "not_found" });
      }
      return;
    }
    const appFile = url.pathname.match(/^\/app\/files\/([A-Za-z0-9._-]{1,120})$/);
    if ((req.method === "GET" || req.method === "HEAD") && appFile) {
      const p = joinPath(SHARES_DIR, "app", "files", appFile[1]);
      let size;
      try {
        size = statSync(p).size;
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      // Range support so interrupted downloads can resume.
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(p, { start, end }).pipe(res);
      return;
    }

    // --- "Popular on MiniPlayer": weekly chart from the opt-in sync. Only
    // songs played by >= CHARTS_MIN_LISTENERS different people appear.
    if (req.method === "GET" && url.pathname === "/charts/weekly") {
      if (!requireApiToken(req, res)) return;
      if (!globalThis.__chart || Date.now() - globalThis.__chart.at > 10 * 60_000) {
        globalThis.__chart = {
          at: Date.now(),
          items: buildWeeklyChart(joinPath(SHARES_DIR, "users"), {
            minListeners: Number(process.env.CHARTS_MIN_LISTENERS) || 2,
          }),
        };
      }
      sendJson(res, 200, { items: globalThis.__chart.items, week: true });
      return;
    }

    // --- Opt-in listening sync (MiniPlayer): one JSONL file per anonymous id.
    if (url.pathname === "/sync/events" || url.pathname === "/sync/user") {
      if (!requireApiToken(req, res)) return;
      const uid = (url.searchParams.get("uid") || "").toLowerCase();
      if (req.method === "POST" && url.pathname === "/sync/events") {
        const body = await readJsonMaybeGzip(req, 300_000);
        const id = String(body.uid || "").toLowerCase();
        if (!/^[a-f0-9]{16,40}$/.test(id)) {
          sendJson(res, 400, { error: "invalid_uid" });
          return;
        }
        const kinds = new Set(["play", "skip", "like", "dislike", "fav", "unfav", "follow"]);
        const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
        const lines = (Array.isArray(body.events) ? body.events : [])
          .slice(0, 500)
          .filter((e) => e && kinds.has(e.t))
          .map((e) =>
            JSON.stringify({
              t: e.t,
              id: str(e.id, 80),
              ti: str(e.ti, 200),
              a: str(e.a, 120),
              s: Number.isFinite(e.s) ? Math.max(0, Math.min(36000, Math.round(e.s))) : undefined,
              ts: Number.isFinite(e.ts) ? Math.round(e.ts) : Date.now(),
            }),
          );
        if (lines.length) {
          mkdirSync(joinPath(SHARES_DIR, "users"), { recursive: true });
          appendFileSync(joinPath(SHARES_DIR, "users", `${id}.jsonl`), lines.join("\n") + "\n");
        }
        sendJson(res, 200, { ok: true, stored: lines.length });
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/sync/user") {
        if (!/^[a-f0-9]{16,40}$/.test(uid)) {
          sendJson(res, 400, { error: "invalid_uid" });
          return;
        }
        rmSync(joinPath(SHARES_DIR, "users", `${uid}.jsonl`), { force: true });
        sendJson(res, 200, { ok: true, deleted: true });
        return;
      }
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const shareMatch = url.pathname.match(/^\/share\/([A-Za-z0-9]{6})$/);
    if (req.method === "GET" && shareMatch) {
      if (!requireApiToken(req, res)) return;
      const hit = shares.get(shareMatch[1].toUpperCase());
      if (!hit) {
        sendJson(res, 404, { error: "share_not_found" });
        return;
      }
      sendJson(res, 200, { name: hit.name, tracks: hit.tracks });
      return;
    }

    // --- continue with existing search / playlist / meta / audio / LiveKit rooms ---

    if (req.method === "GET" && url.pathname === "/search") {
      if (!requireApiToken(req, res, { optional: true })) return;
      const q = url.searchParams.get("q") || "";
      if (!isValidSearchQuery(q)) {
        sendJson(res, 400, { error: "invalid_query" });
        return;
      }
      const limit = Number(url.searchParams.get("limit") || SEARCH_LIMIT_DEFAULT);
      const offset = Number(url.searchParams.get("offset") || 0);
      const typeRaw = (url.searchParams.get("type") || "video").toLowerCase();
      const type =
        typeRaw === "playlist" || typeRaw === "mix" || typeRaw === "song"
          ? typeRaw
          : "video";
      const results =
        type === "song"
          ? await searchYouTubeMusicSongs(q, { limit, offset })
          : await searchYouTube(q, { limit, offset, type });
      sendJson(res, 200, {
        results,
        type,
        limit: Math.min(
          Math.max(limit || SEARCH_LIMIT_DEFAULT, 1),
          SEARCH_LIMIT_MAX,
        ),
        offset: Math.max(offset || 0, 0),
        hasMore:
          results.length > 0 && offset + results.length < SEARCH_LIMIT_MAX,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/playlist") {
      if (!requireApiToken(req, res, { optional: true })) return;
      const pageUrl = url.searchParams.get("url") || "";
      if (!isAllowedMediaUrl(pageUrl) || !needsExtractor(pageUrl)) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      const limit = Number(url.searchParams.get("limit") || 40);
      const data = await listPlaylistEntries(pageUrl, { limit });
      sendJson(res, 200, data);
      return;
    }

    // Lazy metadata for MiniPlayer (cover + details on song click, not search).
    if (req.method === "GET" && url.pathname === "/meta") {
      if (!requireApiToken(req, res, { optional: true })) return;
      const pageUrl = url.searchParams.get("url") || "";
      if (!isAllowedMediaUrl(pageUrl) || !needsExtractor(pageUrl)) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      const data = await fetchVideoMeta(pageUrl);
      sendJson(res, 200, data);
      return;
    }

    // Signed-in YouTube Music for MiniPlayer ("Meet server" account mode).
    // The client signs each call (SAPISIDHASH) and sends its session cookie;
    // this host only relays allowlisted innertube calls. Nothing is stored.
    const ytmMatch = url.pathname.match(/^\/ytm\/(.+)$/);
    if (
      ytmMatch &&
      (req.method === "POST" || req.method === "GET") &&
      YTM_ENDPOINTS.has(ytmMatch[1])
    ) {
      if (!requireApiToken(req, res)) return;
      // GET carries the JSON body base64url-encoded in `b`: some mobile
      // networks stall POST bodies to this host while GETs go through.
      let body;
      if (req.method === "GET") {
        try {
          body = JSON.parse(
            Buffer.from(url.searchParams.get("b") || "", "base64url").toString("utf8"),
          );
        } catch {
          sendJson(res, 400, { error: "invalid_body" });
          return;
        }
      } else {
        body = await readBody(req, 64_000);
      }
      try {
        const upstream = (payload) =>
          fetch(
            `https://music.youtube.com/youtubei/v1/${ytmMatch[1]}?prettyPrint=false`,
            {
              method: "POST",
              headers: ytmForwardHeaders(req, { "Content-Type": "application/json" }),
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(20_000),
            },
          );
        // `pages=N` (browse): follow continuations here and answer
        // {"pages":[…]} — phones on slow/filtered links then make one small
        // request instead of several with long continuation tokens.
        const pages = Math.min(Number(url.searchParams.get("pages") || 0), 8);
        const skip = Math.min(Number(url.searchParams.get("skip") || 0), pages);
        let status;
        let text;
        if (ytmMatch[1] === "browse" && pages > 0) {
          const out = [];
          let next = body;
          for (let i = 0; i < pages && next; i++) {
            const r = await upstream(next);
            if (!r.ok) {
              if (out.length === 0) status = r.status;
              break;
            }
            const j = await r.json();
            if (i >= skip) out.push(j);
            const token = findContinuation(j);
            next = token ? { context: body.context, continuation: token } : null;
          }
          status ??= 200;
          text = JSON.stringify({ pages: out });
        } else {
          const r = await upstream(body);
          status = r.status;
          text = await r.text();
        }
        sendMaybeGzip(req, res, status, text);
      } catch {
        sendJson(res, 502, { error: "ytm_upstream_failed" });
      }
      return;
    }
    // ytcfg for the listener's session: live client version, visitor data,
    // datasync id and the player's signature timestamp (MiniPlayer needs
    // them to sign playable player calls / history). Nothing is stored.
    if (req.method === "GET" && url.pathname === "/ytm/config") {
      if (!requireApiToken(req, res)) return;
      try {
        const cookie = ytSessionHeader(req, "cookie");
        const page = await fetch("https://music.youtube.com/?cbrd=1&ucbcb=1", {
          headers: {
            "User-Agent": ytmForwardHeaders(req, {})["User-Agent"],
            "Accept-Language": "en-US,en;q=0.9",
            Cookie: typeof cookie === "string" ? `${cookie}; SOCS=CAI` : "SOCS=CAI",
          },
          signal: AbortSignal.timeout(15_000),
        }).then((r) => r.text());
        const pick = (re) => (page.match(re) || [])[1] || null;
        const out = {
          clientVersion: pick(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/),
          visitorData: pick(/"VISITOR_DATA":"([^"]+)"/),
          datasyncId: pick(/"DATASYNC_ID":"([^"]*)"/),
          signatureTimestamp: null,
        };
        const js = pick(/"jsUrl":"([^"]+)"/);
        if (js && /^\/s\/player\/[\w/.-]+\.js$/.test(js)) {
          const base = await fetch(`https://music.youtube.com${js}`, {
            signal: AbortSignal.timeout(20_000),
          }).then((r) => r.text());
          const sts = (base.match(/signatureTimestamp:?\D{0,4}(\d{5})/) || [])[1];
          if (sts) out.signatureTimestamp = Number(sts);
        }
        sendJson(res, 200, out);
      } catch {
        sendJson(res, 502, { error: "ytm_config_failed" });
      }
      return;
    }

    // History pings (videostats) — YouTube's own stats URLs only.
    if (req.method === "GET" && url.pathname === "/ytm/ping") {
      if (!requireApiToken(req, res)) return;
      let target;
      try {
        target = new URL(url.searchParams.get("url") || "");
      } catch {
        target = null;
      }
      if (
        !target ||
        target.protocol !== "https:" ||
        !/^(s|music|www)\.youtube\.com$/.test(target.hostname) ||
        !target.pathname.startsWith("/api/stats/")
      ) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      try {
        const r = await fetch(target, {
          headers: ytmForwardHeaders(req, {}),
          signal: AbortSignal.timeout(10_000),
        });
        res.writeHead(r.status === 204 ? 204 : r.status);
        res.end();
      } catch {
        sendJson(res, 502, { error: "ping_failed" });
      }
      return;
    }
    // Account/playlist artwork on Google image hosts (blocked for some users).
    if (req.method === "GET" && url.pathname === "/img") {
      if (!requireApiToken(req, res, { optional: true })) return;
      let target;
      try {
        target = new URL(url.searchParams.get("url") || "");
      } catch {
        target = null;
      }
      if (
        !target ||
        target.protocol !== "https:" ||
        !/(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com)$/.test(target.hostname)
      ) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) {
          sendJson(res, r.status, { error: "img_failed" });
          return;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          "Content-Type": r.headers.get("content-type") || "image/jpeg",
          "Content-Length": buf.length,
          "Cache-Control": "public, max-age=604800",
        });
        res.end(buf);
      } catch {
        sendJson(res, 502, { error: "img_failed" });
      }
      return;
    }

    // Proxy time-synced lyrics lookups for MiniPlayer (same reason as
    // /thumb: the lyric hosts can be unreachable from the client's network).
    // Fixed upstreams + allowlisted params only — never an open proxy.
    const lyricsRoute = LYRICS_ROUTES[url.pathname];
    if (req.method === "GET" && lyricsRoute) {
      if (!requireApiToken(req, res)) return;
      const target =
        typeof lyricsRoute.url === "function"
          ? lyricsRoute.url(url.searchParams)
          : lyricsRoute.url;
      if (!target) {
        sendJson(res, 400, { error: "invalid_params" });
        return;
      }
      const upstream = new URL(target);
      for (const key of lyricsRoute.params) {
        const v = url.searchParams.get(key);
        if (v) upstream.searchParams.set(key, v.slice(0, lyricsRoute.max || 300));
      }
      const cacheKey = upstream.toString();
      const hit = lyricsCache.get(cacheKey);
      if (hit && Date.now() - hit.at < LYRICS_CACHE_MS) {
        res.writeHead(hit.status, { "Content-Type": hit.type });
        res.end(hit.body);
        return;
      }
      try {
        const r = await fetch(upstream, {
          headers: { "User-Agent": "MiniPlayer lyrics proxy (meet music-bot)" },
          signal: AbortSignal.timeout(12_000),
        });
        const body = await r.text();
        // Cache answers and clean misses; don't pin transient upstream errors.
        if (r.status === 200 || r.status === 404) {
          lyricsCache.set(cacheKey, {
            at: Date.now(),
            status: r.status,
            type: r.headers.get("content-type") || "application/json",
            body,
          });
          if (lyricsCache.size > LYRICS_CACHE_MAX) {
            lyricsCache.delete(lyricsCache.keys().next().value);
          }
        }
        res.writeHead(r.status, {
          "Content-Type": r.headers.get("content-type") || "application/json",
        });
        res.end(body);
      } catch {
        sendJson(res, 502, { error: "lyrics_upstream_failed" });
      }
      return;
    }

    // Proxy YouTube thumbnails: i.ytimg.com is blocked for some MiniPlayer
    // users (e.g. Iran without VPN) while this host stays reachable.
    if (req.method === "GET" && url.pathname === "/thumb") {
      if (!requireApiToken(req, res, { optional: true })) return;
      const id = url.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
        sendJson(res, 400, { error: "invalid_id" });
        return;
      }
      for (const name of ["hqdefault", "mqdefault", "default"]) {
        try {
          const upstream = await fetch(
            `https://i.ytimg.com/vi/${id}/${name}.jpg`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!upstream.ok) continue;
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(200, {
            "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
            "Content-Length": body.length,
            "Cache-Control": "public, max-age=604800, immutable",
          });
          res.end(body);
          return;
        } catch {
          // try the next size
        }
      }
      sendJson(res, 404, { error: "thumb_not_found" });
      return;
    }

    // Proxy audio through this host so clients are not bound to the server's
    // googlevideo IP (needed for MiniPlayer on another network).
    // --- Share a clip: a 5–60 s MP3 piece of a song (title/artist/cover in).
    if (req.method === "GET" && url.pathname === "/clip") {
      if (!requireApiToken(req, res)) return;
      const p = clipParams(url.searchParams);
      if (!p) {
        sendJson(res, 400, { error: "invalid_clip" });
        return;
      }
      if ((globalThis.__clips || 0) >= 2) {
        sendJson(res, 429, { error: "busy" });
        return;
      }
      globalThis.__clips = (globalThis.__clips || 0) + 1;
      let made = null;
      try {
        made = await makeClip(p, {
          ytdlp: YTDLP_BIN,
          ffmpeg: FFMPEG_BIN,
          ytdlpArgs: [...ytdlpNetArgs(), ...ytdlpCookieArgs()],
        });
        const size = statSync(made.file).size;
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(made.name)}`,
        });
        const dir = made.dir;
        const stream = createReadStream(made.file);
        stream.on("close", () => rmSync(dir, { recursive: true, force: true }));
        stream.pipe(res);
      } catch (e) {
        if (made) rmSync(made.dir, { recursive: true, force: true });
        console.error("clip failed:", String(e).slice(0, 300));
        if (!res.headersSent) sendJson(res, 502, { error: "clip_failed" });
      } finally {
        globalThis.__clips -= 1;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/audio") {
      if (!requireApiToken(req, res)) return;
      const pageUrl = url.searchParams.get("url") || "";
      if (!isAllowedMediaUrl(pageUrl) || !needsExtractor(pageUrl)) {
        sendJson(res, 400, { error: "invalid_url" });
        return;
      }
      pipeExtractorAudio(
        pageUrl,
        req,
        res,
        userCookieArgs(ytSessionHeader(req, "cookie")),
        url.searchParams.get("q") || "",
      );
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
