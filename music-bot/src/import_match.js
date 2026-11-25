// Playlist import: fetch tracks from Spotify / Apple / SoundCloud / YouTube /
// CSV, then match each row to a YouTube video_id for MiniPlayer's library.
import { spawn } from "node:child_process";
import { scoreMatch } from "./song_info.js";

const IMPORT_LIMIT = 200;
const YT_ID = /^[\w-]{11}$/;

/** Detect which source a playlist URL belongs to. */
export function detectSource(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  let host = "";
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)(youtube|music\.youtube)\.com$/.test(host) || host === "youtu.be") return "youtube";
  if (/(^|\.)spotify\.com$/.test(host)) return "spotify";
  if (/(^|\.)soundcloud\.com$/.test(host)) return "soundcloud";
  if (/(^|\.)music\.apple\.com$/.test(host)) return "apple";
  return null;
}

/** Spotify playlist id from open.spotify.com / spotify:playlist:… */
export function parseSpotifyPlaylistId(url) {
  const s = String(url || "").trim();
  const m =
    /spotify\.com\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]+)/i.exec(s) ||
    /spotify:playlist:([A-Za-z0-9]+)/i.exec(s);
  return m?.[1] || null;
}

/** Apple Music catalog playlist: { storefront, id } from music.apple.com URL. */
export function parseApplePlaylist(url) {
  const s = String(url || "").trim();
  const m = /music\.apple\.com\/([a-z]{2})\/playlist\/[^/]*\/(pl\.[A-Za-z0-9_-]+)/i.exec(s)
    || /music\.apple\.com\/([a-z]{2})\/playlist\/(pl\.[A-Za-z0-9_-]+)/i.exec(s);
  if (!m) return null;
  return { storefront: m[1].toLowerCase(), id: m[2] };
}

/** Minimal CSV → rows. Headers: Title/Track Name, Artist/Artist Name, optional ISRC, Duration. */
export function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return { name: "Imported playlist", tracks: [] };
  const lines = [];
  let cur = "", inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      if (inQ && raw[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if ((c === "\n" || c === "\r") && !inQ) {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      if (cur.trim()) lines.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) lines.push(cur);

  const split = (line) => {
    const cells = [];
    let cell = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cell += '"'; i++; }
        else q = !q;
      } else if (c === "," && !q) { cells.push(cell.trim()); cell = ""; }
      else cell += c;
    }
    cells.push(cell.trim());
    return cells;
  };

  const header = split(lines[0]).map((h) => h.toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTitle = col("title", "track name", "track", "song", "name");
  const iArtist = col("artist", "artist name", "artists", "album artist");
  const iIsrc = col("isrc");
  const iDur = col("duration", "duration (ms)", "time", "length");
  if (iTitle < 0) throw new Error("csv_needs_title");

  const tracks = [];
  for (const line of lines.slice(1)) {
    if (tracks.length >= IMPORT_LIMIT) break;
    const cells = split(line);
    const title = cells[iTitle] || "";
    if (!title) continue;
    let durationS = null;
    if (iDur >= 0 && cells[iDur]) {
      const d = cells[iDur];
      if (/^\d+:\d{2}/.test(d)) {
        const p = d.split(":").map(Number);
        durationS = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
      } else {
        const n = Number(d);
        if (Number.isFinite(n)) durationS = n > 1000 ? Math.round(n / 1000) : Math.round(n);
      }
    }
    tracks.push({
      title: title.slice(0, 200),
      artist: (iArtist >= 0 ? cells[iArtist] : "")?.slice(0, 200) || "",
      durationS,
      isrc: iIsrc >= 0 && cells[iIsrc] ? String(cells[iIsrc]).replace(/\s/g, "").toUpperCase() : null,
      externalId: null,
      videoId: null,
    });
  }
  return { name: "Imported playlist", tracks };
}

/**
 * Flat playlist via yt-dlp (YouTube + SoundCloud). Returns rows with optional videoId.
 */
export function flatPlaylistViaYtdlp(pageUrl, { limit = IMPORT_LIMIT, ytdlpBin = "yt-dlp", spawnFn = spawn, extraArgs = [] } = {}) {
  const lim = Math.min(Math.max(Number(limit) || IMPORT_LIMIT, 1), IMPORT_LIMIT);
  return new Promise((resolve, reject) => {
    const child = spawnFn(
      ytdlpBin,
      [pageUrl, "--flat-playlist", "-J", "--no-warnings", "--no-download", "--yes-playlist", `--playlist-end=${lim}`, ...extraArgs],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* */ }
      reject(Object.assign(new Error("playlist_timeout"), { status: 504 }));
    }, 90_000);
    child.stdout?.on("data", (c) => { stdout += c; });
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error((stderr.trim().split("\n").pop() || "playlist_failed").slice(0, 200)), { status: 502 }));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const entries = Array.isArray(info.entries) ? info.entries : [];
        const tracks = [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const id = typeof entry.id === "string" ? entry.id : typeof entry.id === "number" ? String(entry.id) : null;
          const videoId = id && YT_ID.test(id) ? id
            : (typeof entry.url === "string" && YT_ID.test(entry.url) ? entry.url : null);
          const title = (typeof entry.title === "string" && entry.title.trim()) ? entry.title.trim() : (videoId || id || "");
          if (!title) continue;
          const artist =
            (typeof entry.uploader === "string" && entry.uploader)
            || (typeof entry.channel === "string" && entry.channel)
            || (typeof entry.creator === "string" && entry.creator)
            || "";
          const durationS = typeof entry.duration === "number" && Number.isFinite(entry.duration)
            ? Math.round(entry.duration) : null;
          tracks.push({
            title: title.slice(0, 200),
            artist: String(artist).slice(0, 200),
            durationS,
            isrc: null,
            externalId: videoId ? null : id,
            videoId,
          });
          if (tracks.length >= lim) break;
        }
        resolve({
          name: typeof info.title === "string" && info.title.trim() ? info.title.trim() : "Imported playlist",
          tracks,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad_playlist_json"));
      }
    });
  });
}

/** Fetch a public Spotify playlist's tracks (client-credentials). */
export async function fetchSpotifyPlaylist(client, playlistId) {
  const meta = await client.get(`/playlists/${playlistId}?fields=name`);
  const tracks = [];
  let path = `/playlists/${playlistId}/tracks?limit=100&fields=items(track(id,name,artists(name),duration_ms,external_ids)),next`;
  while (path && tracks.length < IMPORT_LIMIT) {
    const j = await client.get(path.startsWith("http") ? path.replace("https://api.spotify.com/v1", "") : path);
    for (const item of j.items ?? []) {
      const t = item?.track;
      if (!t || !t.name) continue;
      tracks.push({
        title: String(t.name).slice(0, 200),
        artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", ").slice(0, 200),
        durationS: t.duration_ms != null ? Math.round(t.duration_ms / 1000) : null,
        isrc: t.external_ids?.isrc ? String(t.external_ids.isrc).toUpperCase() : null,
        externalId: t.id || null,
        videoId: null,
      });
      if (tracks.length >= IMPORT_LIMIT) break;
    }
    if (!j.next || tracks.length >= IMPORT_LIMIT) break;
    path = j.next;
  }
  return { name: meta.name || "Spotify playlist", tracks };
}

/** Fetch an Apple Music catalog playlist (MusicKit developer token). */
export async function fetchApplePlaylist({ storefront, id, token, fetchImpl = fetch }) {
  if (!token) throw Object.assign(new Error("apple_disabled"), { status: 503 });
  const tracks = [];
  let url = `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${id}?include=tracks`;
  let name = "Apple Music playlist";
  // First page includes playlist attrs; tracks may be in relationships with next.
  const first = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (first.status === 401 || first.status === 403) throw Object.assign(new Error("apple_unauthorized"), { status: 503 });
  if (!first.ok) throw Object.assign(new Error(`apple_http_${first.status}`), { status: 502 });
  const j = await first.json();
  name = j.data?.[0]?.attributes?.name || name;
  const pushItems = (items) => {
    for (const t of items ?? []) {
      const a = t.attributes || {};
      if (!a.name) continue;
      tracks.push({
        title: String(a.name).slice(0, 200),
        artist: String(a.artistName || "").slice(0, 200),
        durationS: a.durationInMillis != null ? Math.round(a.durationInMillis / 1000) : null,
        isrc: a.isrc ? String(a.isrc).toUpperCase() : null,
        externalId: t.id || null,
        videoId: null,
      });
      if (tracks.length >= IMPORT_LIMIT) return false;
    }
    return true;
  };
  const rel = j.data?.[0]?.relationships?.tracks;
  pushItems(rel?.data);
  let next = rel?.next;
  while (next && tracks.length < IMPORT_LIMIT) {
    const r = await fetchImpl(next.startsWith("http") ? next : `https://api.music.apple.com${next}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) break;
    const page = await r.json();
    if (!pushItems(page.data)) break;
    next = page.next;
  }
  return { name, tracks };
}

/**
 * Match import rows to YouTube video ids.
 * @param {object} opts
 * @param {Array} opts.tracks
 * @param {object|null} opts.catalog
 * @param {(q: string, opts?: object) => Promise<Array>} opts.searchYtm
 */
export async function matchTracks({ tracks, catalog, searchYtm }) {
  const input = (tracks || []).slice(0, IMPORT_LIMIT);
  const matches = [];
  for (const row of input) {
    const base = {
      title: row.title || "",
      artist: row.artist || "",
      durationS: row.durationS ?? null,
      isrc: row.isrc || null,
      externalId: row.externalId || null,
    };
    // Already a YouTube id (YT playlist import).
    if (row.videoId && YT_ID.test(row.videoId)) {
      matches.push({
        input: base,
        videoId: row.videoId,
        title: base.title,
        artist: base.artist,
        score: 1,
        status: "matched",
        alternatives: [],
      });
      continue;
    }

    let hit = null;
    if (catalog) {
      if (row.externalId && typeof catalog.videoIdBySpotifyId === "function") {
        const id = catalog.videoIdBySpotifyId(row.externalId);
        if (id) hit = { videoId: id, title: base.title, artist: base.artist, score: 0.95, via: "spotify_id" };
      }
      if (!hit && row.isrc && typeof catalog.videoIdByIsrc === "function") {
        const id = catalog.videoIdByIsrc(row.isrc);
        if (id) hit = { videoId: id, title: base.title, artist: base.artist, score: 0.92, via: "isrc" };
      }
      if (!hit && base.title && base.artist && typeof catalog.findSongByName === "function") {
        const id = catalog.findSongByName(base.artist, base.title);
        if (id) hit = { videoId: id, title: base.title, artist: base.artist, score: 0.88, via: "catalog_name" };
      }
    }

    const alts = [];
    if (!hit || hit.score < 0.95) {
      const q = `${base.artist} ${base.title}`.trim();
      if (q && searchYtm) {
        try {
          const results = await searchYtm(q, { limit: 5 });
          for (const r of results || []) {
            const score = scoreMatch(
              { title: base.title, artist: base.artist, durationS: base.durationS },
              {
                title: r.title,
                artists: r.channel ? [r.channel] : [],
                durationS: r.duration ?? null,
              },
            );
            alts.push({
              videoId: r.id,
              title: r.title,
              artist: r.channel || "",
              score,
            });
          }
          alts.sort((a, b) => b.score - a.score);
          if (alts[0] && (!hit || alts[0].score > hit.score)) {
            hit = { ...alts[0], via: "ytm" };
          }
        } catch {
          // search failed — leave unmatched
        }
      }
    }

    let status = "unmatched";
    if (hit && hit.score >= 0.75) status = "matched";
    else if (hit && hit.score >= 0.45) status = "ambiguous";
    else if (alts[0]) {
      hit = alts[0];
      status = hit.score >= 0.45 ? "ambiguous" : "unmatched";
    }

    matches.push({
      input: base,
      videoId: hit?.videoId || null,
      title: hit?.title || base.title,
      artist: hit?.artist || base.artist,
      score: hit?.score ?? 0,
      status: hit?.videoId ? status : "unmatched",
      alternatives: alts.slice(0, 5).filter((a) => a.videoId !== hit?.videoId),
    });
  }
  return { matches };
}

export { IMPORT_LIMIT };
