// Cross-platform links of a song through Odesli (song.link), on demand and
// cached for 30 days. No key: one request per 6 s for the whole server.
// Callers queue behind each other; when the wait would pass 20 s they get
// a "busy" error (the route answers 503).

const API = "https://api.song.link/v1-alpha.1/links";
const TTL_MS = 30 * 864e5;
const GAP_MS = 6000;
const MAX_WAIT_MS = 20_000;
const PLATFORMS = ["spotify", "appleMusic", "deezer", "soundcloud", "tidal", "amazonMusic", "youtube", "youtubeMusic"];
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class OdesliBusy extends Error {
  constructor() { super("odesli busy"); this.busy = true; }
}

export class SongLinks {
  #chain = Promise.resolve(); #nextSlot = -Infinity; #inflight = new Map();
  constructor({ catalog, fetch = globalThis.fetch, sleep = sleepReal, now = Date.now, gapMs = GAP_MS, maxWaitMs = MAX_WAIT_MS }) {
    Object.assign(this, { catalog, _fetch: fetch, sleep, now, gapMs, maxWaitMs });
  }

  /** { pageUrl, links }. Throws OdesliBusy, or Error on upstream failure. */
  async get(videoId) {
    const row = this.catalog.linksExt(videoId);
    if (row && this.now() - row.fetchedAt < TTL_MS) return { pageUrl: row.pageUrl, links: row.links };
    let p = this.#inflight.get(videoId);
    if (!p) {
      const slot = Math.max(this.now(), this.#nextSlot);
      if (slot - this.now() > this.maxWaitMs) throw new OdesliBusy();
      this.#nextSlot = slot + this.gapMs; // slots are one gap apart, whoever asks
      p = this.#fetchOne(videoId, slot).finally(() => this.#inflight.delete(videoId));
      this.#inflight.set(videoId, p);
    }
    return p;
  }

  #fetchOne(videoId, slot) {
    const run = async () => {
      const wait = slot - this.now();
      if (wait > 0) await this.sleep(wait);
      const url = `${API}?${new URLSearchParams({ url: `https://music.youtube.com/watch?v=${videoId}` })}`;
      const r = await this._fetch(url, { headers: { Accept: "application/json", "User-Agent": "MiniPlayer/1.0" } });
      if (r.status === 429) throw new OdesliBusy();
      if (r.status === 404 || r.status === 400) { this.catalog.saveLinksExt(videoId, null, {}, this.now()); return { pageUrl: null, links: {} }; }
      if (!r.ok) throw new Error(`odesli: HTTP ${r.status}`);
      let j = null;
      try { j = await r.json(); } catch { /* empty */ }
      const links = {};
      for (const k of PLATFORMS) { const u = j?.linksByPlatform?.[k]?.url; if (typeof u === "string" && u) links[k] = u; }
      const pageUrl = typeof j?.pageUrl === "string" ? j.pageUrl : null;
      this.catalog.saveLinksExt(videoId, pageUrl, links, this.now());
      return { pageUrl, links };
    };
    const p = this.#chain.then(run);
    this.#chain = p.catch(() => {});
    return p;
  }
}
