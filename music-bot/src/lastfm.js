// Last.fm enrichment (home only, needs LASTFM_API_KEY): listeners, tags,
// similar songs and similar artists per catalog song. The similar lists feed
// the recommender as one more neighbour source.
//
// One tick looks up one song (about 2-4 requests). Songs are picked like the
// other enrichers: archived and most played first, then a rowid cursor over
// tracks, so nothing here scans or sorts the big tables.

const BASE = "https://ws.audioscrobbler.com/2.0/";
const UA = "MiniPlayer/1.0 (+https://music.cloudproducts.ir)";
const PAUSE_MS = 15 * 60_000;

const NOISE_WORDS = /\b(official|video|music|lyrics?|lyric|audio|hd|4k|visuali[sz]er|clip|mv|full|hq|remastered)\b|ویدیو|موزیک|کلیپ|لیریک|متن/i;

/** Strip YouTube noise from a title: "(Official Video)", "| Lyrics", "ft. X", "Artist - ". */
export function cleanTitle(title, artist = "") {
  let t = String(title ?? "");
  // Bracketed groups: drop noise ones and featuring ones.
  t = t.replace(/[(\[{]([^)\]}]*)[)\]}]/g, (m, inner) =>
    NOISE_WORDS.test(inner) || /^\s*(ft|feat|featuring|with)\b\.?/i.test(inner) ? "" : m);
  // "| Lyric Video" style segments.
  t = t.split(/\s*\|\s*/).filter((seg, i) => i === 0 || !NOISE_WORDS.test(seg)).join(" | ");
  // Featuring outside brackets: drop to the end.
  t = t.replace(/\s+(ft|feat|featuring)\b\.?\s+.*$/i, "");
  // Trailing bare quality tags.
  t = t.replace(/\s+(HD|HQ|4K|1080p|720p)\s*$/i, "");
  t = t.replace(/\s+/g, " ").trim().replace(/[\s|\-–—]+$/, "");
  // "Artist - Title" when the title repeats the artist.
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m && artist) {
    const a = looseKey(artist), h = looseKey(m[1]);
    if (a && h && (h === a || h.includes(a) || a.includes(h))) t = m[2].trim();
  }
  return t.trim();
}

const looseKey = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Comparison key of a title: cleaned, lowercased, punctuation and spaces gone. */
export function normTitle(title, artist = "") {
  return looseKey(cleanTitle(title, artist));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export class LastfmClient {
  #key; #fetch;
  constructor({ apiKey, fetch = globalThis.fetch } = {}) { this.#key = apiKey; this.#fetch = fetch; }

  async #get(params) {
    const q = new URLSearchParams({ ...params, api_key: this.#key, format: "json" });
    const r = await this.#fetch(`${BASE}?${q}`, { headers: { "User-Agent": UA } });
    if (r.status === 429 || r.status >= 500) throw new Error(`lastfm: rate/server HTTP ${r.status}`);
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (j?.error) {
      if (j.error === 29) throw new Error("lastfm: rate limit exceeded");
      if (j.error === 6) return null;
      throw new Error(`lastfm: error ${j.error} ${j.message ?? ""}`.trim());
    }
    if (!r.ok) throw new Error(`lastfm: HTTP ${r.status}`);
    return j;
  }

  async trackInfo(artist, title) {
    const j = await this.#get({ method: "track.getInfo", artist, track: title, autocorrect: "1" });
    const t = j?.track;
    if (!t) return null;
    return {
      mbid: t.mbid || null, listeners: num(t.listeners), playcount: num(t.playcount),
      tags: asArray(t.toptags?.tag).map((x) => x?.name).filter(Boolean).slice(0, 10),
      artist: t.artist?.name ?? null, title: t.name ?? null,
    };
  }

  async trackSimilar(artist, title, limit = 50) {
    const j = await this.#get({ method: "track.getSimilar", artist, track: title, limit: String(limit), autocorrect: "1" });
    return asArray(j?.similartracks?.track).map((x) => ({
      artist: x.artist?.name, title: x.name, match: num(x.match) ?? 0,
    })).filter((x) => x.artist && x.title);
  }

  async artistInfo(name) {
    const j = await this.#get({ method: "artist.getInfo", artist: name, autocorrect: "1" });
    const a = j?.artist;
    if (!a) return null;
    return {
      mbid: a.mbid || null, listeners: num(a.stats?.listeners), playcount: num(a.stats?.playcount),
      tags: asArray(a.tags?.tag).map((x) => x?.name).filter(Boolean).slice(0, 10),
    };
  }

  async artistSimilar(name, limit = 50) {
    const j = await this.#get({ method: "artist.getSimilar", artist: name, limit: String(limit), autocorrect: "1" });
    return asArray(j?.similarartists?.artist).map((x) => ({ name: x.name, match: num(x.match) ?? 0 })).filter((x) => x.name);
  }
}

export class LastfmEnricher {
  #n = 0; #found = 0; #pauseUntil = 0; #todo = []; #busy = false;

  constructor({ catalog, client, log = console, now = Date.now }) {
    this.catalog = catalog; this.client = client; this.log = log; this.now = now;
  }

  async tick() {
    if (this.#busy || this.now() < this.#pauseUntil) return;
    if (!this.#todo.length) this.#todo = this.catalog.nextLastfmTracks(50).reverse();
    const song = this.#todo.pop();
    if (!song) return;
    this.#busy = true;
    try { await this.#one(song); } finally { this.#busy = false; }
  }

  async #one(song) {
    const artist = song.artist ?? "";
    const title = cleanTitle(song.title, artist);
    let rec = { videoId: song.videoId, track: null };
    try {
      if (!artist || !title) throw Object.assign(new Error("no artist/title"), { skip: true });
      const track = await this.client.trackInfo(artist, title);
      const similarRaw = track ? await this.client.trackSimilar(artist, title, 50) : [];
      const similar = [], names = [], seen = new Set();
      for (const s of similarRaw) {
        const id = this.catalog.findSongByName(s.artist, s.title);
        if (id && id !== song.videoId) { if (!seen.has(id)) { seen.add(id); similar.push({ id, match: s.match }); } }
        else if (!id) names.push(s);
      }
      rec = { videoId: song.videoId, track, similar, names };
      const artistId = this.catalog.firstArtistId(song.videoId);
      if (artistId && !this.catalog.hasLastfmArtist(artistId)) {
        const info = await this.client.artistInfo(artist);
        const sim = info ? await this.client.artistSimilar(artist, 50) : [];
        const artistSimilar = [], got = new Set();
        for (const s of sim) {
          for (const id of this.catalog.artistIdsByName(s.name)) {
            if (id !== artistId && !got.has(id)) { got.add(id); artistSimilar.push({ id, match: s.match }); }
          }
        }
        rec = { ...rec, artistId, artist: info, artistSimilar };
      }
    } catch (e) {
      if (/rate/i.test(e.message)) {
        this.#pauseUntil = this.now() + PAUSE_MS;
        this.#todo.push(song);
        this.log.error?.("[lastfm] rate limited, pausing 15 min");
        return;
      }
      if (!e.skip) this.log.error?.("[lastfm]", e.message);
      rec = { videoId: song.videoId, track: null };
    }
    this.catalog.saveLastfm(rec, this.now());
    this.#n++;
    if (rec.track) this.#found++;
    if (this.#n % 500 === 0) this.log.log?.(`[lastfm] ${this.#n} checked, ${this.#found} found`);
  }
}
