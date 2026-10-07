// Song clips for sharing: a 5–60 s piece of a song as an MP3 with title,
// artist and the cover embedded (so chat apps show it as music).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clean = (s, n) =>
  String(s || "")
    .replace(/[\u0000-\u001f"\\]/g, "")
    .trim()
    .slice(0, n);

/** Validated clip request, or null. */
export function clipParams(q) {
  const url = q.get("url") || "";
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
  if (!m || !/^https:\/\/(www\.|music\.)?youtube\.com\/watch\?/.test(url)) return null;
  const start = Math.floor(Number(q.get("start")));
  const dur = Math.floor(Number(q.get("dur")));
  if (!Number.isFinite(start) || start < 0 || start > 36000) return null;
  if (!Number.isFinite(dur) || dur < 5 || dur > 60) return null;
  return {
    url: `https://www.youtube.com/watch?v=${m[1]}`,
    id: m[1],
    start,
    dur,
    title: clean(q.get("title"), 120) || "Clip",
    artist: clean(q.get("artist"), 120),
  };
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-2000);
    });
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(`${bin} failed (${code}): ${err.slice(-300)}`));
    });
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * Builds the clip; returns { dir, file, name }. The caller removes `dir`.
 * @param {ReturnType<typeof clipParams>} p
 */
export async function makeClip(p, { ytdlp, ffmpeg, ytdlpArgs = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "mp-clip-"));
  try {
    const end = p.start + p.dur;
    await run(
      ytdlp,
      [
        "-f", "bestaudio/best",
        "--no-playlist", "--no-warnings",
        "--download-sections", `*${p.start}-${end}`,
        ...ytdlpArgs,
        "-o", join(dir, "src.%(ext)s"),
        p.url,
      ],
      120_000,
    );
    const src = readdirSync(dir).find((f) => f.startsWith("src."));
    if (!src) throw new Error("no audio");
    // Cover art is optional: the clip still works without it.
    let cover = null;
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${p.id}/hqdefault.jpg`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        cover = join(dir, "cover.jpg");
        writeFileSync(cover, Buffer.from(await r.arrayBuffer()));
      }
    } catch {
      cover = null;
    }
    const out = join(dir, "clip.mp3");
    const fadeOut = Math.max(0, p.dur - 1);
    await run(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", join(dir, src),
        ...(cover ? ["-i", cover] : []),
        "-map", "0:a",
        ...(cover
          ? ["-map", "1:v", "-c:v", "mjpeg", "-vf", "crop=ih:ih", "-disposition:v", "attached_pic",
             "-metadata:s:v", "title=Cover"]
          : []),
        "-t", String(p.dur),
        "-af", `afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1`,
        "-c:a", "libmp3lame", "-b:a", "160k",
        "-id3v2_version", "3",
        "-metadata", `title=${p.title}`,
        ...(p.artist ? ["-metadata", `artist=${p.artist}`] : []),
        out,
      ],
      60_000,
    );
    if (statSync(out).size < 10_000) throw new Error("clip too small");
    const safe = `${p.artist ? p.artist + " - " : ""}${p.title}`.replace(/[\/\\:*?<>|]/g, "").slice(0, 100);
    return { dir, file: out, name: `${safe} (clip).mp3` };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
