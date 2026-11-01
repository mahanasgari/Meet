// Song info from Deezer and iTunes (home only): ISRC, tempo, release date,
// genre, album and Deezer's popularity rank. Both APIs are free and keyless.
//
// One lookup per song, a few seconds apart; a result counts only when title,
// artist and duration agree well enough (a wrong match is worse than none).
// Pauses when either service says it is over quota.

import { norm } from "./spotify.js";

const contains = (a, b) => a && b && (a.includes(b) || b.includes(a));

/** 0..1 agreement between a catalog song and a candidate (same weights as the Spotify match). */
export function scoreMatch({ title, artist, durationS }, cand) {
  const nt = norm(title), na = norm(artist);
  const tt = norm(cand.title);
  const title_ = tt && tt === nt ? 1 : contains(tt, nt) ? 0.7 : 0;
  const artist_ = (cand.artists ?? []).some((a) => { const x = norm(a); return x === na || contains(x, na); }) ? 1 : 0;
  let dur = 0.5;
  if (Number.isFinite(durationS) && cand.durationS != null) {
    const d = Math.abs(cand.durationS - durationS);
    dur = d <= 3 ? 1 : d <= 8 ? 0.5 : 0;
  }
  return 0.45 * title_ + 0.35 * artist_ + 0.2 * dur;
}

const query = (t) => `${t.artist ?? ""} ${t.title ?? ""}`.trim();

export class DeezerClient {
  #fetch;
  constructor({ fetch = globalThis.fetch } = {}) { this.#fetch = fetch; }

  async #get(url) {
    const r = await this.#fetch(url);
    if (!r.ok) throw new Error(`deezer: HTTP ${r.status}`);
    const j = await r.json();
    if (j?.error) {
      // Error code 4 = quota exceeded.
      if (j.error.code === 4) throw new Error("deezer: HTTP 429 (quota)");
      throw new Error(`deezer: ${j.error.message || j.error.code}`);
    }
    return j;
  }

  async search(track) {
    const j = await this.#get(`https://api.deezer.com/search?limit=5&q=${encodeURIComponent(query(track))}`);
    let best = null;
    for (const t of j?.data ?? []) {
      const score = scoreMatch(track, {
        title: t.title, artists: [t.artist?.name], durationS: t.duration ?? null,
      });
      if (!best || score > best.score) best = { t, score };
    }
    if (!best || best.score < 0.75) return null;
    const d = await this.#get(`https://api.deezer.com/track/${best.t.id}`);
    return {
      deezerId: best.t.id,
      isrc: d.isrc ?? null,
      rank: d.rank ?? best.t.rank ?? null,
      bpm: d.bpm ? d.bpm : null,
      releaseDate: d.release_date ?? null,
      album: d.album?.title ?? best.t.album?.title ?? null,
      score: best.score,
    };
  }
}

export class ItunesClient {
  #fetch;
  constructor({ fetch = globalThis.fetch } = {}) { this.#fetch = fetch; }

  async search(track) {
    const r = await this.#fetch(`https://itunes.apple.com/search?entity=song&limit=5&term=${encodeURIComponent(query(track))}`);
    if (r.status === 403 || r.status === 429) throw new Error(`itunes: HTTP 429 (status ${r.status})`);
    if (!r.ok) throw new Error(`itunes: HTTP ${r.status}`);
    const j = await r.json();
    let best = null;
    for (const t of j?.results ?? []) {
      const score = scoreMatch(track, {
        title: t.trackName,
        artists: String(t.artistName ?? "").split(/ & |, /),
        durationS: t.trackTimeMillis != null ? t.trackTimeMillis / 1000 : null,
      });
      if (!best || score > best.score) best = { t, score };
    }
    if (!best || best.score < 0.75) return null;
    const t = best.t;
    return {
      itunesId: t.trackId,
      genre: t.primaryGenreName ?? null,
      releaseDate: t.releaseDate ? String(t.releaseDate).slice(0, 10) : null,
      album: t.collectionName ?? null,
      score: best.score,
    };
  }
}

const PAUSE_MS = 10 * 60_000;

export class SongInfoEnricher {
  #n = 0; #deezer = 0; #itunes = 0; #pauseUntil = 0; #todo = []; #busy = false;

  constructor({ catalog, deezer, itunes, log = console, now = Date.now }) {
    this.catalog = catalog; this.deezer = deezer; this.itunes = itunes; this.log = log; this.now = now;
  }

  async tick() {
    if (this.#busy || this.now() < this.#pauseUntil) return;
    // A batch at a time: picking the next song sorts the whole catalog.
    if (!this.#todo.length) this.#todo = this.catalog.nextSongInfo(200).reverse();
    const track = this.#todo.pop();
    if (!track) return;
    this.#busy = true;
    try {
      await this.#one(track);
    } finally {
      this.#busy = false;
    }
  }

  async #one(track) {
    let deezer = null, itunes = null;
    try {
      deezer = await this.deezer.search(track);
      itunes = await this.itunes.search(track);
    } catch (e) {
      if (String(e.message).includes("HTTP 429")) {
        // Not saved: it is tried again after the pause.
        this.#pauseUntil = this.now() + PAUSE_MS;
        this.#todo.push(track);
        this.log.error?.("[song-info] rate limited, pausing 10 min");
        return;
      }
      this.log.error?.("[song-info]", e.message);
    }
    this.catalog.saveSongInfo(track.videoId, { deezer, itunes }, this.now());
    this.#n++;
    if (deezer) this.#deezer++;
    if (itunes) this.#itunes++;
    if (this.#n % 500 === 0) {
      this.log.log?.(`[song-info] ${this.#n} checked, ${this.#deezer} on Deezer, ${this.#itunes} on iTunes`);
    }
  }
}
