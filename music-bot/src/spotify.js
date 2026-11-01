// Spotify metadata (home only): popularity, ISRC, album, release date and the
// artists' genres for every song in the catalog, from the Spotify Web API
// (client-credentials flow: no user login, public catalog data only).
//
// One search per song, a few seconds apart; a result counts only when title,
// artist and duration agree well enough (a wrong match is worse than none).
// Backs off when Spotify answers 429, using its Retry-After.

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Comparable form of a title/name: no brackets, case, punctuation or Persian letter variants. */
export function norm(s) {
  return String(s ?? "")
    .replace(/[([{][^)\]}]*[)\]}]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const contains = (a, b) => a && b && (a.includes(b) || b.includes(a));

export class SpotifyClient {
  #id; #secret; #fetch; #now; #tok = null; #exp = 0;
  retryAfterMs = 0;

  constructor({ clientId, clientSecret, fetch = globalThis.fetch, now = Date.now }) {
    this.#id = clientId; this.#secret = clientSecret; this.#fetch = fetch; this.#now = now;
  }

  async token(force = false) {
    if (!force && this.#tok && this.#now() < this.#exp) return this.#tok;
    const r = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.#id}:${this.#secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) throw new Error(`spotify token: HTTP ${r.status}`);
    const j = await r.json();
    this.#tok = j.access_token;
    // A minute early, so a token never expires mid-request.
    this.#exp = this.#now() + (Number(j.expires_in) || 3600) * 1000 - 60_000;
    return this.#tok;
  }

  async get(path) {
    for (let retried = false; ; retried = true) {
      const r = await this.#fetch(API + path, { headers: { Authorization: `Bearer ${await this.token(retried)}` } });
      if (r.status === 401 && !retried) continue;
      if (r.status === 429) {
        this.retryAfterMs = (Number(r.headers?.get?.("retry-after")) || 0) * 1000;
        throw new Error(`spotify ${path}: HTTP 429`);
      }
      if (!r.ok) throw new Error(`spotify ${path}: HTTP ${r.status}`);
      return r.json();
    }
  }

  /** Best Spotify match for a song, or null when nothing is convincing. */
  async searchTrack({ title, artist, durationS }) {
    const q = artist ? `track:${title} artist:${artist}` : String(title);
    const j = await this.get(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
    const nt = norm(title), na = norm(artist);
    let best = null;
    for (const t of j?.tracks?.items ?? []) {
      const tt = norm(t.name);
      const title_ = tt && tt === nt ? 1 : contains(tt, nt) ? 0.7 : 0;
      const artist_ = (t.artists ?? []).some((a) => { const x = norm(a.name); return x === na || contains(x, na); }) ? 1 : 0;
      let dur = 0.5;
      if (Number.isFinite(durationS) && t.duration_ms != null) {
        const d = Math.abs(t.duration_ms / 1000 - durationS);
        dur = d <= 3 ? 1 : d <= 8 ? 0.5 : 0;
      }
      const score = 0.45 * title_ + 0.35 * artist_ + 0.2 * dur;
      if (!best || score > best.score) {
        best = {
          id: t.id, isrc: t.external_ids?.isrc ?? null, popularity: t.popularity ?? null,
          explicit: !!t.explicit, releaseDate: t.album?.release_date ?? null,
          albumId: t.album?.id ?? null, albumName: t.album?.name ?? null,
          albumType: t.album?.album_type ?? null, trackNumber: t.track_number ?? null,
          artists: (t.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
          durationMs: t.duration_ms ?? null, score,
        };
      }
    }
    return best && best.score >= 0.75 ? best : null;
  }

  async artists(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await this.get(`/artists?ids=${ids.slice(i, i + 50).join(",")}`);
      for (const a of j?.artists ?? []) {
        if (!a) continue;
        out.push({ id: a.id, name: a.name, genres: a.genres ?? [], popularity: a.popularity ?? null, followers: a.followers?.total ?? null });
      }
    }
    return out;
  }
}

export class SpotifyEnricher {
  #n = 0; #pauseUntil = 0;

  constructor({ catalog, client, log = console, now = Date.now }) {
    this.catalog = catalog; this.client = client; this.log = log; this.now = now;
  }

  async tick() {
    if (this.#busy || this.now() < this.#pauseUntil) return;
    // A batch at a time: picking the next song sorts the whole catalog,
    // too heavy to do every few seconds.
    if (!this.#todo.length) this.#todo = this.catalog.nextSpotifyTracks(200).reverse();
    const track = this.#todo.pop();
    if (!track) return;
    this.#busy = true;
    try {
      await this.#one(track);
    } finally {
      this.#busy = false;
    }
  }

  #todo = [];
  #busy = false;

  async #one(track) {
    let match = null;
    try {
      match = await this.client.searchTrack(track);
    } catch (e) {
      if (String(e.message).includes("HTTP 429")) {
        // Not marked checked: it is tried again after the pause.
        this.#pauseUntil = this.now() + (this.client.retryAfterMs || 60_000);
        this.#todo.push(track); // first again after the pause
        this.log.error?.(`[spotify] rate limited, pausing ${Math.round((this.#pauseUntil - this.now()) / 1000)}s`);
        return;
      }
      this.log.error?.("[spotify]", e.message);
    }
    this.catalog.saveSpotifyTrack(track.videoId, match, this.now());
    this.#n++;
    if (this.#n % 20 === 0) await this.#artists();
    if (this.#n % 500 === 0) {
      const s = this.catalog.spotifyStats();
      this.log.log?.(`[spotify] ${s.matched}/${s.checked} matched, ${s.artistsFetched} artists`);
    }
  }

  async #artists() {
    const ids = this.catalog.spotifyArtistsToFetch(50);
    if (!ids.length) return;
    try {
      this.catalog.saveSpotifyArtists(await this.client.artists(ids), this.now());
    } catch (e) {
      if (String(e.message).includes("HTTP 429")) this.#pauseUntil = this.now() + (this.client.retryAfterMs || 60_000);
      else this.log.error?.("[spotify]", e.message);
    }
  }
}
