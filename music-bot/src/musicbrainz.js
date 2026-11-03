// MusicBrainz + ListenBrainz enrichment (home only, no API keys): canonical
// recording / artist ids, artist aliases (for search in any script), listen
// counts and "similar" lists that feed the recommender.
//
// One tick handles one song (a few requests). MusicBrainz allows 1 request per
// second and ListenBrainz is paced the same way: each client holds its own queue.
// Songs are picked like the Last.fm enricher: archived and most played first,
// then a rowid cursor over tracks, so nothing here scans the big tables.

import { cleanTitle, normTitle } from "./lastfm.js";

const UA = "MiniPlayer/1.0 ( https://music.cloudproducts.ir )";
const MB = "https://musicbrainz.org/ws/2/";
const LB = "https://api.listenbrainz.org/1/";
const LABS = "https://labs.api.listenbrainz.org/";
const GAP_MS = 1100;
const PAUSE_MS = 15 * 60_000;
const POP_EVERY = 60;
const POP_BATCH = 100;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIM_REC_ALGO = "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30";
const SIM_ART_ALGO = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const lucene = (s) => String(s ?? "").replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, "\\$&");
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Requests one at a time, at least [gap] ms apart, whoever calls. */
class Paced {
  #chain = Promise.resolve(); #last = -Infinity;
  constructor({ fetch = globalThis.fetch, sleep = sleepReal, now = Date.now, gapMs = GAP_MS } = {}) {
    this._fetch = fetch; this.sleep = sleep; this.now = now; this.gapMs = gapMs;
  }

  _request(url, init = {}) {
    const run = async () => {
      const wait = this.#last + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.#last = this.now();
      return this._fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init.headers } });
    };
    const p = this.#chain.then(run);
    this.#chain = p.catch(() => {});
    return p;
  }
}

async function readJson(r, who) {
  if (r.status === 429 || r.status === 503) throw new Error(`${who}: rate limited HTTP ${r.status}`);
  if (r.status === 404 || r.status === 204) return null;
  if (r.status >= 500) throw new Error(`${who}: server HTTP ${r.status}`);
  if (!r.ok) throw new Error(`${who}: HTTP ${r.status}`);
  try { return await r.json(); } catch { return null; }
}

const credits = (rec) => (rec?.["artist-credit"] ?? []).map((c) => ({
  mbid: c?.artist?.id ?? null, name: c?.artist?.name ?? c?.name ?? null,
})).filter((c) => c.mbid);

function recordingOut(rec, score) {
  const cr = credits(rec);
  const releases = (rec.releases ?? []).map((x) => x?.date).filter(Boolean).sort();
  return {
    mbid: rec.id, title: rec.title ?? null, artistMbids: cr.map((c) => c.mbid), credits: cr,
    firstRelease: rec["first-release-date"] || releases[0] || null,
    lengthMs: num(rec.length), isrcs: Array.isArray(rec.isrcs) ? rec.isrcs : [],
    score: score ?? num(rec.score),
  };
}

export class MusicBrainzClient extends Paced {
  async #get(path, params) {
    const q = new URLSearchParams({ ...params, fmt: "json" });
    return readJson(await this._request(`${MB}${path}?${q}`), "musicbrainz");
  }

  /** Best recording of an ISRC (the one whose title matches [title] when given, else the first). */
  async recordingByIsrc(isrc, title = "") {
    const j = await this.#get(`isrc/${encodeURIComponent(isrc)}`, { inc: "artist-credits+releases" });
    const recs = j?.recordings ?? [];
    if (!recs.length) return null;
    const want = normTitle(title);
    const pick = (want && recs.find((r) => normTitle(r.title) === want)) || recs[0];
    return recordingOut(pick, 100);
  }

  async searchRecording(artist, title) {
    const want = normTitle(title, artist);
    if (!want) return null;
    const query = `recording:"${lucene(title)}" AND artist:"${lucene(artist)}"`;
    const j = await this.#get("recording", { query, limit: "5" });
    for (const r of j?.recordings ?? []) {
      if ((num(r.score) ?? 0) < 85) continue;
      const have = normTitle(r.title, artist);
      if (!have) continue;
      if (have === want || (have.length >= 4 && want.length >= 4 && (have.includes(want) || want.includes(have)))) {
        return recordingOut(r);
      }
    }
    return null;
  }

  /** Artist mbid by name: score >= 90 and the name or an alias equals it once normalised. */
  async searchArtist(name) {
    const want = normTitle(name);
    if (!want) return null;
    const j = await this.#get("artist", { query: `artist:"${lucene(name)}"`, limit: "3" });
    for (const a of j?.artists ?? []) {
      if ((num(a.score) ?? 0) < 90) continue;
      const names = [a.name, a["sort-name"], ...(a.aliases ?? []).map((x) => x?.name)];
      if (names.some((n) => n && normTitle(n) === want)) return a.id;
    }
    return null;
  }

  async artist(mbid) {
    const a = await this.#get(`artist/${encodeURIComponent(mbid)}`, { inc: "aliases+genres+tags" });
    if (!a?.id) return null;
    return {
      mbid: a.id, name: a.name ?? null, sortName: a["sort-name"] ?? null, type: a.type ?? null,
      country: a.country ?? null, begin: a["life-span"]?.begin ?? null, end: a["life-span"]?.end ?? null,
      aliases: (a.aliases ?? []).map((x) => ({ name: x?.name, locale: x?.locale ?? null })).filter((x) => x.name),
      genres: (a.genres ?? []).map((g) => g?.name).filter(Boolean),
    };
  }
}

/** Every object under [node] (any nesting) that has one of [keys] as an mbid, with its score. */
function collect(node, keys, seedMbid, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) { for (const x of node) collect(x, keys, seedMbid, out, depth + 1); return out; }
  if (typeof node !== "object") return out;
  const k = keys.find((key) => typeof node[key] === "string" && MBID.test(node[key]));
  if (k) {
    const score = num(node.score);
    if (node[k] !== seedMbid && score != null) out.push({ mbid: node[k], name: node.name ?? node.artist_name ?? null, score });
  } else {
    for (const v of Object.values(node)) if (v && typeof v === "object") collect(v, keys, seedMbid, out, depth + 1);
  }
  return out;
}

const dedupe = (rows) => {
  const best = new Map();
  for (const r of rows) if (!best.has(r.mbid) || best.get(r.mbid).score < r.score) best.set(r.mbid, r);
  return [...best.values()].sort((a, b) => b.score - a.score);
};

export class ListenBrainzClient extends Paced {
  /** Map(mbid -> { listens, users }) for up to 100 recording mbids. */
  async popularity(mbids) {
    const out = new Map();
    if (!mbids.length) return out;
    const r = await this._request(`${LB}popularity/recording`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording_mbids: mbids.slice(0, POP_BATCH) }),
    });
    const j = await readJson(r, "listenbrainz");
    const rows = Array.isArray(j) ? j : (j?.payload ?? j?.recordings ?? []);
    for (const x of Array.isArray(rows) ? rows : []) {
      const mbid = x?.recording_mbid;
      if (mbid) out.set(mbid, { listens: num(x.total_listen_count) ?? 0, users: num(x.total_user_count) ?? 0 });
    }
    return out;
  }

  async similarRecordings(mbid) {
    const q = new URLSearchParams({ recording_mbids: mbid, algorithm: SIM_REC_ALGO });
    const j = await readJson(await this._request(`${LABS}similar-recordings/json?${q}`), "listenbrainz");
    return dedupe(collect(j, ["recording_mbid", "mbid"], mbid)).map(({ mbid, score }) => ({ mbid, score }));
  }

  async similarArtists(mbid) {
    const q = new URLSearchParams({ artist_mbids: mbid, algorithm: SIM_ART_ALGO });
    const j = await readJson(await this._request(`${LABS}similar-artists/json?${q}`), "listenbrainz");
    return dedupe(collect(j, ["artist_mbid", "mbid"], mbid));
  }
}

export class MusicBrainzEnricher {
  #n = 0; #found = 0; #ticks = 0; #pauseUntil = 0; #todo = []; #busy = false;

  constructor({ catalog, mb, lb, log = console, now = Date.now }) {
    this.catalog = catalog; this.mb = mb; this.lb = lb; this.log = log; this.now = now;
  }

  #strikes = 0;

  /** Rate limited: back off 30 s, doubling per strike in a row, up to 15 min. */
  #rate(e, undo) {
    if (!/rate/i.test(e.message)) return false;
    const ms = Math.min(PAUSE_MS, 30_000 * 2 ** this.#strikes++);
    this.#pauseUntil = this.now() + ms;
    undo?.();
    this.log.error?.(`[musicbrainz] rate limited, pausing ${Math.round(ms / 1000)} s`);
    return true;
  }

  async tick() {
    if (this.#busy || this.now() < this.#pauseUntil) return;
    this.#busy = true;
    try {
      if (++this.#ticks % POP_EVERY === 0) { await this.#popularity(); return; }
      if (!this.#todo.length) this.#todo = this.catalog.nextMbRecordings(50).reverse();
      const song = this.#todo.pop();
      if (song) await this.#one(song);
    } finally { this.#busy = false; }
  }

  async #popularity() {
    const rows = this.catalog.mbPopularityBatch(POP_BATCH);
    if (!rows.length) return;
    const mbids = [...new Set(rows.map((r) => r.mbid))];
    try {
      const pop = await this.lb.popularity(mbids);
      this.catalog.saveMbPopularity(mbids, pop, this.now());
    } catch (e) {
      if (this.#rate(e)) return;
      this.log.error?.("[musicbrainz] popularity:", e.message);
      this.catalog.saveMbPopularity(mbids, new Map(), this.now());
    }
  }

  async #one(song) {
    const artist = song.artist ?? "";
    const title = cleanTitle(song.title, artist);
    const rec = { videoId: song.videoId, recording: null };
    try {
      if (!artist || !title) throw Object.assign(new Error("no artist/title"), { skip: true });
      const isrc = this.catalog.songInfo(song.videoId)?.isrc;
      let recording = isrc ? await this.mb.recordingByIsrc(isrc, title) : null;
      if (!recording) recording = await this.mb.searchRecording(artist, title);
      rec.recording = recording;

      const artistId = this.catalog.firstArtistId(song.videoId);
      let artistMbid = null;
      if (artistId && !this.catalog.hasMbArtist(artistId)) {
        rec.artistId = artistId;
        const want = normTitle(artist);
        artistMbid = recording
          ? (recording.credits.find((c) => normTitle(c.name) === want) ?? recording.credits[0])?.mbid ?? null
          : null;
        artistMbid ??= await this.mb.searchArtist(artist);
        rec.artist = artistMbid ? await this.mb.artist(artistMbid) : null;
      }

      if (recording?.mbid) {
        const sim = await this.lb.similarRecordings(recording.mbid);
        rec.lbSimilar = [];
        const seen = new Set([song.videoId]);
        for (const s of sim) {
          for (const id of this.catalog.videoIdsByMbid(s.mbid)) {
            if (!seen.has(id)) { seen.add(id); rec.lbSimilar.push({ id, score: s.score }); }
          }
        }
      }
      if (rec.artist?.mbid) {
        const sim = await this.lb.similarArtists(rec.artist.mbid);
        rec.lbArtistSimilar = [];
        const seen = new Set([artistId]);
        for (const s of sim) {
          for (const id of this.catalog.artistIdsByMbid(s.mbid)) {
            if (!seen.has(id)) { seen.add(id); rec.lbArtistSimilar.push({ id, score: s.score }); }
          }
        }
      }
    } catch (e) {
      if (this.#rate(e, () => this.#todo.push(song))) return;
      if (!e.skip) this.log.error?.("[musicbrainz]", e.message);
      // Keep what was learned before the failure, but never save a half-known artist.
      delete rec.artist; delete rec.artistId; delete rec.lbSimilar; delete rec.lbArtistSimilar;
    }
    this.catalog.saveMusicBrainz(rec, this.now());
    this.#strikes = 0;
    this.#n++;
    if (rec.recording?.mbid) this.#found++;
    if (this.#n % 500 === 0) this.log.log?.(`[musicbrainz] ${this.#n} checked, ${this.#found} found`);
  }
}
