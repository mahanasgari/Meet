// Discogs enrichment (home only, needs DISCOGS_TOKEN): release year, genres,
// styles, country and label per catalog song. Genres and styles become song
// tags. The authenticated limit is 60 requests per minute; we stay under it
// with one request per 1.1 s. A tick looks up one song (one request).

import { cleanTitle, normTitle } from "./lastfm.js";

const BASE = "https://api.discogs.com";
const UA = "MiniPlayer/1.0 +https://music.cloudproducts.ir";
const GAP_MS = 1100;
const PAUSE_MS = 15 * 60_000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

export class DiscogsClient {
  #chain = Promise.resolve(); #last = -Infinity;
  constructor({ token, fetch = globalThis.fetch, sleep = sleepReal, now = Date.now, gapMs = GAP_MS } = {}) {
    this.token = token; this._fetch = fetch; this.sleep = sleep; this.now = now; this.gapMs = gapMs;
  }

  #request(url) {
    const run = async () => {
      const wait = this.#last + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.#last = this.now();
      return this._fetch(url, { headers: {
        Authorization: `Discogs token=${this.token}`, "User-Agent": UA, Accept: "application/json",
      } });
    };
    const p = this.#chain.then(run);
    this.#chain = p.catch(() => {});
    return p;
  }

  /** Best release for an artist + track name, or null. Throws Error("discogs: rate ...") on 429. */
  async searchRelease(artist, title) {
    const want = normTitle(title, artist), who = normTitle(artist);
    if (!want && !who) return null;
    const q = new URLSearchParams({ type: "release", artist, track: title, per_page: "5" });
    const r = await this.#request(`${BASE}/database/search?${q}`);
    if (r.status === 429) throw new Error("discogs: rate limited HTTP 429");
    if (r.status === 404) return null;
    if (r.status >= 500) throw new Error(`discogs: server HTTP ${r.status}`);
    if (!r.ok) throw new Error(`discogs: HTTP ${r.status}`);
    let j = null;
    try { j = await r.json(); } catch { return null; }
    let best = null, bestScore = 0;
    for (const x of j?.results ?? []) {
      const have = normTitle(x?.title);
      if (!have) continue;
      const a = who.length >= 2 && have.includes(who), t = want.length >= 3 && have.includes(want);
      const score = (a ? 1 : 0) + (t ? 1 : 0);
      if (score > bestScore) { best = x; bestScore = score; }
    }
    if (!best) return null;
    const year = num(best.year);
    return {
      releaseId: num(best.id), masterId: num(best.master_id), year: year && year > 1800 ? year : null,
      genres: arr(best.genre), styles: arr(best.style), country: best.country || null,
      label: arr(best.label)[0] ?? null,
    };
  }
}

export class DiscogsEnricher {
  #n = 0; #found = 0; #pauseUntil = 0; #todo = []; #busy = false; #strikes = 0;

  constructor({ catalog, client, log = console, now = Date.now }) {
    this.catalog = catalog; this.client = client; this.log = log; this.now = now;
  }

  async tick() {
    if (this.#busy || this.now() < this.#pauseUntil) return;
    if (!this.#todo.length) this.#todo = this.catalog.nextDiscogs(50).reverse();
    const song = this.#todo.pop();
    if (!song) return;
    this.#busy = true;
    try { await this.#one(song); } finally { this.#busy = false; }
  }

  async #one(song) {
    const artist = song.artist ?? "";
    const title = cleanTitle(song.title, artist);
    let release = null;
    try {
      if (artist && title) release = await this.client.searchRelease(artist, title);
      this.#strikes = 0;
    } catch (e) {
      if (/rate/i.test(e.message)) {
        const ms = Math.min(PAUSE_MS, 30_000 * 2 ** this.#strikes++);
        this.#pauseUntil = this.now() + ms;
        this.#todo.push(song);
        this.log.error?.(`[discogs] rate limited, pausing ${Math.round(ms / 1000)} s`);
        return;
      }
      this.log.error?.("[discogs]", e.message);
    }
    this.catalog.saveDiscogs(song.videoId, release, this.now());
    this.#n++;
    if (release) this.#found++;
    if (this.#n % 500 === 0) this.log.log?.(`[discogs] ${this.#n} checked, ${this.#found} found`);
  }
}
