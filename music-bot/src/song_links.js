// Public song links: a friend shares one song as music.cloudproducts.ir/s/<code>
// and anyone with the link can play that song in a browser (no invite, no
// app). A link plays only its own song and expires after 90 days.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";

const DAY = 864e5;
export const LINK_TTL_MS = 90 * DAY;
const MAX_LINKS = 20_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const LINK_CODE = /^[A-Za-z2-9]{8}$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class SongLinks {
  /** @param {{ file: string, now?: () => number }} o */
  constructor({ file, now = () => Date.now() }) {
    this.file = file;
    this.now = now;
    /** @type {Map<string, {id: string, title: string, artist: string, by: string|null, at: number}>} */
    this.links = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) this.links.set(k, v);
    } catch {
      // first run
    }
    this.timer = null;
  }

  /**
   * A link for song [id]; the same sharer sharing the same song again gets
   * the same link (renewed). Null for a bad id.
   */
  create({ id, title, artist, by = null }) {
    if (!YT_ID.test(id || "")) return null;
    const clean = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const now = this.now();
    for (const [code, l] of this.links) {
      if (l.id === id && l.by === by && now - l.at < LINK_TTL_MS) {
        l.at = now;
        this.#saveSoon();
        return code;
      }
    }
    if (this.links.size >= MAX_LINKS) this.links.delete(this.links.keys().next().value);
    let code;
    do {
      code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    } while (this.links.has(code));
    this.links.set(code, { id, title: clean(title, 200) || "Unknown song", artist: clean(artist, 120), by, at: now });
    this.#saveSoon();
    return code;
  }

  /** The live link for [code] (case-insensitive), or null (unknown or expired). */
  get(code) {
    if (!LINK_CODE.test(code || "")) return null;
    const l = this.links.get(code.toUpperCase());
    if (!l || this.now() - l.at >= LINK_TTL_MS) return null;
    return l;
  }

  #saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.links)));
      } catch (e) {
        console.error("[song-links] save failed", e?.message);
      }
    }, 1000);
    this.timer.unref?.();
  }
}

/**
 * The page a song link opens: cover, title, artist and a player. [base] is
 * the public origin (for the Telegram/WhatsApp preview), [code] the link.
 */
export function renderSongPage(link, { base, code }) {
  const title = esc(link.title);
  const artist = esc(link.artist);
  const page = `${base}/s/${code}`;
  const cover = `${page}/cover`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}${artist ? ` · ${artist}` : ""}</title>
<meta name="description" content="Listen to ${title}${artist ? ` by ${artist}` : ""}, shared with MiniPlayer.">
<meta property="og:type" content="music.song">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${artist ? `${artist} · ` : ""}Tap to listen, no app needed">
<meta property="og:image" content="${esc(cover)}">
<meta property="og:url" content="${esc(page)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#000000">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.png">
<style>
  :root { --bg: #0b0b0d; --fg: #f4f4f6; --muted: #a0a0a8; --accent: #ff2d55; --card: #17171b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Vazirmatn, Tahoma, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: max(28px, env(safe-area-inset-top)) 20px 32px;
    display: flex; flex-direction: column; align-items: center; text-align: center; }
  .cover { width: min(320px, 80vw); aspect-ratio: 1; border-radius: 18px; overflow: hidden; background: var(--card);
    box-shadow: 0 18px 50px rgba(0,0,0,.55); }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  h1 { margin: 24px 0 4px; font-size: 22px; line-height: 1.25; unicode-bidi: plaintext; }
  .artist { color: var(--muted); font-size: 16px; unicode-bidi: plaintext; }
  .play { margin-top: 26px; width: 72px; height: 72px; border-radius: 50%; border: 0; background: var(--accent);
    color: #fff; display: grid; place-items: center; cursor: pointer; }
  .play svg { width: 34px; height: 34px; fill: currentColor; }
  .bar { width: 100%; margin-top: 22px; display: flex; align-items: center; gap: 10px; color: var(--muted);
    font-size: 12px; font-variant-numeric: tabular-nums; }
  .bar input { flex: 1; accent-color: var(--accent); }
  .status { min-height: 20px; margin-top: 12px; color: var(--muted); font-size: 13px; }
  footer { margin-top: 36px; color: var(--muted); font-size: 13px; }
  footer a { color: var(--fg); }
</style>
</head>
<body>
<main>
  <div class="cover"><img src="${esc(cover)}" alt="" onerror="this.style.visibility='hidden'"></div>
  <h1>${title}</h1>
  <div class="artist">${artist}</div>
  <button class="play" id="play" aria-label="Play">
    <svg id="icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
  </button>
  <div class="bar">
    <span id="cur">0:00</span>
    <input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="Position">
    <span id="dur">0:00</span>
  </div>
  <div class="status" id="status"></div>
  <audio id="audio" preload="none" src="${esc(page)}/audio"></audio>
  <footer>Shared with MiniPlayer · <a href="/">Get the app</a> (needs an invite from a friend)</footer>
</main>
<script>
  var a = document.getElementById('audio'), btn = document.getElementById('play'), icon = document.getElementById('icon');
  var seek = document.getElementById('seek'), cur = document.getElementById('cur'), dur = document.getElementById('dur');
  var status = document.getElementById('status'), dragging = false;
  var PLAY = 'M8 5v14l11-7z', PAUSE = 'M6 5h4v14H6zM14 5h4v14h-4z';
  function fmt(s) { s = Math.floor(s || 0); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  btn.onclick = function () {
    if (a.paused) {
      status.textContent = a.readyState < 2 ? 'Loading\\u2026' : '';
      a.play().catch(function () { status.textContent = 'Couldn\\u2019t play. Try again in a moment.'; });
    } else a.pause();
  };
  a.onplay = function () { icon.firstChild.setAttribute('d', PAUSE); btn.setAttribute('aria-label', 'Pause'); };
  a.onpause = function () { icon.firstChild.setAttribute('d', PLAY); btn.setAttribute('aria-label', 'Play'); };
  a.onplaying = function () { status.textContent = ''; };
  a.onwaiting = function () { status.textContent = 'Loading\\u2026'; };
  a.onerror = function () { status.textContent = 'Couldn\\u2019t load the song. Try again in a moment.'; };
  a.ondurationchange = function () { if (isFinite(a.duration)) { seek.max = a.duration; dur.textContent = fmt(a.duration); } };
  a.ontimeupdate = function () { if (!dragging) seek.value = a.currentTime; cur.textContent = fmt(a.currentTime); };
  seek.oninput = function () { dragging = true; cur.textContent = fmt(seek.value); };
  seek.onchange = function () { a.currentTime = +seek.value; dragging = false; };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ${JSON.stringify(link.title).replace(/</g, "\\u003c")},
      artist: ${JSON.stringify(link.artist).replace(/</g, "\\u003c")},
      artwork: [{ src: ${JSON.stringify(cover).replace(/</g, "\\u003c")}, sizes: '720x720', type: 'image/jpeg' }]
    });
  }
</script>
</body>
</html>`;
}

export function expiredPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link expired</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f6;
font:16px -apple-system,system-ui,sans-serif;text-align:center;padding:20px}p{color:#a0a0a8}</style></head>
<body><div><h1>This song link has expired</h1><p>Ask your friend to share it again.</p></div></body></html>`;
}
