// Music-video archive helpers: download (yt-dlp + ffmpeg), caption, and
// Range-aware serving. Telegram is the only storage: files here are temporary.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { normalize, similarity, splitUploadTitle } from "./song_meta.js";
import { parseRange, serveFile } from "./disk_cache.js";

export const VIDEO_FORMAT =
  "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720][vcodec^=avc1][protocol^=m3u8]+ba[ext=m4a]/bv*[height<=720][vcodec^=avc1]+ba/18";

const BLOCKED_RE = /confirm you.?re not a bot|sign in to confirm|HTTP Error 429|too many requests/i;
const NONE_RE = /requested format is not available|no video formats|only images are available/i;
const UNAVAILABLE_RE = /private video|has been removed|account associated with this video has been terminated|copyright claim|members-only|no longer available because|video unavailable|this video is unavailable|confirm your age|age-restricted|inappropriate for some users/i;

/** Art tracks ("Topic" channel releases) are a still image: no video worth keeping. */
export function needsVideo(song) {
  return song?.sourceKind !== "ytm_track";
}

/** yt-dlp stderr → 'blocked' | 'none' | 'unavailable' | 'failed'. */
export function classifyYtdlpError(stderr) {
  const s = String(stderr || "");
  if (BLOCKED_RE.test(s)) return "blocked";
  if (NONE_RE.test(s)) return "none";
  if (UNAVAILABLE_RE.test(s)) return "unavailable";
  return "failed";
}

const fail = (stderr, fallback) => {
  const lines = String(stderr || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const msg = lines[lines.length - 1] || fallback;
  return Object.assign(new Error(msg.slice(0, 300)), { kind: classifyYtdlpError(stderr) });
};

function run(bin, args, { timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e?.message || e) });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", (e) => { err += String(e?.message || e); resolve({ code: -1, out, err }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Downloads a video to a temp mp4 (H.264 + AAC, moov first) plus a thumbnail.
 * The caller uploads it and then deletes `path` and `thumbPath`.
 */
export async function downloadVideo(id, { ytdlpBin, ffmpegBin, ffprobeBin = "ffprobe", ytdlpArgs = [], tmpDir }) {
  const base = join(tmpDir, `.v-${id}-${process.pid}-${randomBytes(3).toString("hex")}`);
  const raw = `${base}.raw.mp4`;
  const out = `${base}.mp4`;
  const meta = `${base}.json`;
  const thumb = `${base}.jpg`;
  const cleanup = (...keep) => {
    for (const f of [raw, out, meta, thumb]) if (!keep.includes(f)) rmSync(f, { force: true });
  };
  cleanup();
  try {
    const y = await run(ytdlpBin, ["-f", VIDEO_FORMAT, "--merge-output-format", "mp4", "--no-playlist", "--no-warnings",
      "--print-to-file", "%()j", meta, ...ytdlpArgs, "-o", raw, `https://www.youtube.com/watch?v=${id}`]);
    if (y.code !== 0 || !existsSync(raw)) throw fail(y.err, `yt-dlp exited ${y.code}`);

    let info = {};
    try {
      const lines = readFileSync(meta, "utf8").trim().split("\n").filter(Boolean);
      info = JSON.parse(lines[lines.length - 1]);
    } catch { /* no metadata */ }

    const probe = async (file) => {
      const p = await run(ffprobeBin, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 60_000 });
      if (p.code !== 0) throw Object.assign(new Error((p.err.trim().split("\n").pop() || "ffprobe failed").slice(0, 300)), { kind: "failed" });
      return JSON.parse(p.out);
    };
    const pr = await probe(raw);
    const v = pr.streams?.find((s) => s.codec_type === "video");
    const a = pr.streams?.find((s) => s.codec_type === "audio");
    if (!v) throw Object.assign(new Error("no video stream"), { kind: "none" });
    const aac = a?.codec_name === "aac";
    const f = await run(ffmpegBin, ["-y", "-v", "error", "-i", raw, "-c:v", "copy",
      ...(a ? (aac ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]) : ["-an"]),
      "-movflags", "+faststart", out]);
    if (f.code !== 0 || !existsSync(out)) throw Object.assign(new Error((f.err.trim().split("\n").pop() || "ffmpeg failed").slice(0, 300)), { kind: "failed" });
    rmSync(raw, { force: true });

    const fin = await probe(out);
    const fv = fin.streams?.find((s) => s.codec_type === "video") || v;
    const fa = fin.streams?.find((s) => s.codec_type === "audio");
    const durationS = Number(fin.format?.duration) || Number(info.duration) || 0;
    const at = Math.max(0, Math.min(30, durationS / 3));
    const t = await run(ffmpegBin, ["-y", "-v", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=320:-2", thumb], { timeoutMs: 60_000 });
    const thumbPath = t.code === 0 && existsSync(thumb) ? thumb : null;
    const artist = (Array.isArray(info.artists) && info.artists[0]) || info.artist || String(info.channel || info.uploader || "").replace(/\s+-\s+Topic$/i, "") || undefined;
    cleanup(out, thumb);
    return {
      path: out, width: fv.width, height: fv.height, vcodec: fv.codec_name, acodec: fa?.codec_name || null,
      fps: eval0(fv.avg_frame_rate), durationS, formatId: info.format_id ? String(info.format_id) : null,
      size: statSync(out).size, title: info.track || info.title, artist, thumbPath,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function eval0(r) {
  const m = /^(\d+)\/(\d+)$/.exec(String(r || ""));
  return m && Number(m[2]) ? Math.round((Number(m[1]) / Number(m[2])) * 100) / 100 : null;
}

const VCODEC = [[/^h264|^avc/i, "H264"], [/^hevc|^h265/i, "H265"], [/^vp9|^vp09/i, "VP9"], [/^av1|^av01/i, "AV1"]];
const ACODEC = [[/^aac|^mp4a/i, "AAC"], [/^opus/i, "Opus"], [/^mp3/i, "MP3"]];
const pretty = (tbl, c) => (c ? (tbl.find(([re]) => re.test(c)) || [0, c])[1] : null);
const mmss = (s) => {
  const n = Math.round(Number(s) || 0);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

/** Telegram caption for an archived video (≤1024 chars). v: {title, artist, width, height, vcodec, acodec, fps, size, durationS}. */
export function videoCaption(id, v = {}) {
  const lines = [`🎬 ${v.title || id}`];
  if (v.artist) lines.push(`👤 ${String(v.artist).slice(0, 200)}`);
  const q = [];
  if (v.width && v.height) q.push(`${v.width}×${v.height}`);
  const vc = pretty(VCODEC, v.vcodec);
  if (vc) q.push(vc);
  if (v.fps) q.push(`${Math.round(v.fps)} fps`);
  if (q.length) lines.push(`📺 ${q.join(" · ")}`);
  const ac = pretty(ACODEC, v.acodec);
  if (ac) lines.push(`🎧 ${ac}`);
  const d = [];
  if (v.size) d.push(`${(v.size / 1048576).toFixed(1)} MB`);
  if (v.durationS) d.push(mmss(v.durationS));
  if (d.length) lines.push(`💾 ${d.join(" · ")}`);
  lines.push(`youtu.be/${id}`);
  return lines.join("\n").slice(0, 1024);
}

/** Range-aware streaming straight from the channel; nothing is cached on disk. */
export async function serveVideoFromTelegram(req, res, tg, msgId, { size, mime = "video/mp4", source = "" } = {}) {
  const f = await tg.open(msgId);
  size = f.size || size;
  const head = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...(source ? { "X-MP-Source": source } : {}) };
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...head, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
    res.end();
    return true;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  res.writeHead(range ? 206 : 200, {
    ...head, "Content-Length": size ? end - start + 1 : 0,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || !size) {
    res.end();
    return true;
  }
  let gone = false;
  const onClose = () => (gone = true);
  res.on("close", onClose);
  req.on("close", () => { if (!res.writableEnded) gone = true; });
  try {
    for await (const chunk of f.read(start, end - start + 1)) {
      if (gone) break;
      if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]);
      if (gone) break;
    }
    res.end();
  } catch {
    res.destroy();
  }
  return true;
}

/** Range-aware serve of a local temp file. */
export function serveFileRange(req, res, path, { mime = "video/mp4", source } = {}) {
  serveFile(req, res, path, { mime, extraHeaders: source ? { "X-MP-Source": source } : {} });
}

/**
 * Picks the official music video for an audio track from YouTube Music
 * video-search rows [{videoId, title, subtitle, durationS}], or null.
 * The result's own song title must match ours (after splitting "Artist -
 * Title" and normalising Persian/Arabic letters), an artist must match the
 * title or the channel, the length must be close, and covers / lyric videos
 * / remixes / live versions are skipped unless the song itself is one.
 * Below the confidence bar there's no video: none beats a wrong one.
 * [exclude]: video ids reported as wrong for this song.
 */
export function pickOfficialVideo(rows, { title, artist, artists, durationS }, { exclude = [] } = {}) {
  const want = String(title || "").trim();
  if (!normalize(want)) return null;
  const wantArtists = (artists && artists.length ? artists : String(artist || "").split(/,|&| and | feat\.? | ft\.? /i))
    .map((a) => String(a).trim())
    .filter((a) => normalize(a).length >= 2);
  const VARIANT = /\b(lyrics?|cover|karaoke|instrumental|remix|live|reaction|slowed|sped ?up|reverb|8d|teaser|trailer|behind the scenes|making of|tutorial|piano version|acoustic)\b/i;
  let best = null;
  for (const r of rows || []) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(r.videoId || "") || exclude.includes(r.videoId)) continue;
    // Audio tracks with a still image and podcast episodes aren't videos.
    if (r.videoType === "ATV" || r.videoType === "PODCAST_EPISODE") continue;
    const rawTitle = String(r.title || "");
    const channel = String(r.subtitle || "").split("•")[0].trim();
    const split = splitUploadTitle(rawTitle, channel);
    const titleSim = Math.max(similarity(want, split.title), similarity(want, rawTitle) * 0.95);
    if (titleSim < 0.7) continue;
    const titleNorm = normalize(rawTitle);
    const artistSim = wantArtists.length
      ? Math.max(
          0,
          ...wantArtists.map((a) =>
            Math.max(similarity(a, split.artist || ""), similarity(a, channel), titleNorm.includes(normalize(a)) ? 0.95 : 0),
          ),
        )
      : 0.6;
    if (artistSim < 0.5) continue;
    if (VARIANT.test(rawTitle) && !VARIANT.test(want)) continue;
    let closeness = 0.6;
    if (durationS && r.durationS) {
      if (r.durationS < durationS * 0.8 || r.durationS > durationS * 1.6) continue;
      closeness = Math.max(0, 1 - Math.abs(r.durationS - durationS) / (durationS * 0.6));
    }
    let score = 0.45 * titleSim + 0.3 * artistSim + 0.15 * closeness;
    if (/official\s*(music\s*)?video|music\s*video|\bm\/?v\b|video\s*clip|\bclip\b/i.test(rawTitle)) score += 0.15;
    if (/official\s*(audio|track|visuali[sz]er)|\bvisuali[sz]er\b/i.test(rawTitle)) score -= 0.12;
    // YouTube Music's own label beats any title wording.
    if (r.videoType === "OMV") score += 0.2;
    else if (r.videoType === "UGC") score -= 0.1;
    if (score < 0.72) continue;
    if (!best || score > best.score) best = { videoId: r.videoId, title: rawTitle, score: Math.round(score * 100) / 100 };
  }
  return best;
}
