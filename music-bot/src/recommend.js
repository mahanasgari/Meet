// In-house music recommender, version 2. No external calls: everything comes
// from the catalog (plays, YouTube Music song graph, similar artists) and the
// opt-in listening sync files (users/*.jsonl), whose skips, likes and
// dislikes steer it: a song you skipped or disliked isn't suggested to you,
// songs most people skip rank lower, and "A, then B skipped" weakens A→B.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIN = 6e4;
const DAY = 864e5;
const CACHE_MS = 30 * MIN;
const SESSION_GAP_MS = 30 * MIN;
const HISTORY_DAYS = 90;
const WINDOW = 5; // positions looked ahead when counting co-occurrence
const MAX_NEIGHBORS = 50;
const HALF_LIFE_DAYS = 14;
const LB_WEIGHT = 0.5; // ListenBrainz similar recordings (score normalised to 0..1)
const LASTFM_WEIGHT = 0.6; // Last.fm similarity (0..1) scale next to related 1.0 and co-listening 1.5*sim
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SAME_LISTEN_MS = 15 * MIN;
const FEEDBACK = new Set(["play", "skip", "complete", "like", "dislike", "fav", "unfav"]);

const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

const SOUND_FEATURES = ["energy", "danceability", "happy", "sad", "relaxed", "aggressive", "party", "valence", "arousal"];

export class Recommender {
  #catalog;
  #usersDir;
  #now;
  #m = null; // built model, see build()
  #sql = new Map();

  constructor({ catalog, usersDir, now = () => Date.now() }) {
    this.#catalog = catalog;
    this.#usersDir = usersDir;
    this.#now = now;
  }

  #q(text) {
    let s = this.#sql.get(text);
    if (!s) this.#sql.set(text, (s = this.#catalog.db.prepare(text)));
    return s;
  }

  // ---------------------------------------------------------------- model

  /**
   * Every listener's history of the last 90 days: server plays (catalog, by
   * invite) and the app's sync files (plays, skips, likes). A sync file
   * linked to an invite (users/links.json) joins that listener, and a server
   * play the app also reported is dropped for the app's event: a song
   * skipped after two seconds is still a "play" on the server. Other server
   * plays stay (the listener's other devices may not sync).
   */
  #loadListeners(now) {
    const from = now - HISTORY_DAYS * DAY;
    const plays = new Map(); // who -> [{ id, at }] from the catalog
    const events = new Map(); // who -> [{ t, id, at, ctx }] from sync files
    const titles = new Map(); // videoId -> { title, artist } from sync files
    const push = (map, who, x) => {
      let list = map.get(who);
      if (!list) map.set(who, (list = []));
      list.push(x);
    };
    // 'peer' rows are copies of plays another server already recorded.
    for (const r of this.#q(`SELECT video_id, at, uid FROM plays
      WHERE uid IS NOT NULL AND (source IS NULL OR source != 'peer') AND at >= ? AND at <= ?`).all(from, now)) {
      push(plays, r.uid, { id: r.video_id, at: r.at });
    }
    const links = parse(this.#read(join(this.#usersDir, "links.json")), {}) || {};
    let files = [];
    try { files = readdirSync(this.#usersDir).filter((f) => f.endsWith(".jsonl")); } catch { /* no sync yet */ }
    for (const f of files) {
      const path = join(this.#usersDir, f);
      try {
        if (statSync(path).mtimeMs < from) continue;
      } catch { continue; }
      const text = this.#read(path);
      if (!text) continue;
      const syncId = f.slice(0, -6);
      const who = typeof links[syncId] === "string" ? links[syncId] : syncId;
      for (const line of text.split("\n")) {
        if (!line) continue;
        const e = parse(line);
        if (!e || !FEEDBACK.has(e.t)) continue;
        const ts = Number(e.ts);
        if (!(ts >= from && ts <= now)) continue;
        const id = typeof e.id === "string" ? e.id.replace(/^yt_/, "") : "";
        if (!YT_ID.test(id)) continue;
        const secs = Number(e.s);
        push(events, who, {
          t: e.t, id, at: ts, ctx: e.ctx,
          s: Number.isFinite(secs) ? secs : undefined,
        });
        if (e.ti && !titles.has(id)) titles.set(id, { title: e.ti, artist: e.a ?? null });
      }
    }

    const listeners = new Map(); // who -> [{ id, at }] plays, oldest first
    const feedback = new Map(); // who -> { skips, full: Map(id -> n), liked: Map(id -> true|false) }
    const songFb = new Map(); // id -> { plays, skips } over everyone's sync
    const badNext = new Map(); // a -> Map(b -> times b was skipped right after a)
    // ctx -> plays/skips/completes: which home surfaces keep people listening.
    const origins = {};
    const inc = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);
    for (const who of new Set([...plays.keys(), ...events.keys()])) {
      const ev = (events.get(who) ?? []).sort((a, b) => a.at - b.at);
      // The app reports a song when it ends (or is skipped), the server when
      // it starts: the same listen is a server play up to 15 min before.
      const reported = new Map(); // id -> [at]
      for (const e of ev) if (e.t === "play" || e.t === "skip" || e.t === "complete") (reported.get(e.id) ?? reported.set(e.id, []).get(e.id)).push(e.at);
      const sameListen = (p) => (reported.get(p.id) ?? []).some((at) => p.at >= at - SAME_LISTEN_MS && p.at <= at + 2 * MIN);
      const list = (plays.get(who) ?? []).filter((p) => !sameListen(p));
      const fb = { skips: new Map(), full: new Map(), liked: new Map() };
      let prev = null; // last song played through
      let lastAt = 0;
      for (const e of ev) {
        if (e.at - lastAt > SESSION_GAP_MS) prev = null;
        lastAt = e.at;
        const sf = songFb.get(e.id) ?? songFb.set(e.id, { plays: 0, skips: 0 }).get(e.id);
        const o = e.ctx ? (origins[e.ctx] ??= { plays: 0, skips: 0, completes: 0, seconds: 0 }) : null;
        if (e.t === "play" || e.t === "complete") {
          list.push({ id: e.id, at: e.at });
          inc(fb.full, e.id);
          sf.plays++;
          if (o) {
            o.plays++;
            if (e.t === "complete") o.completes++;
            if (Number.isFinite(e.s)) o.seconds += e.s;
          }
          prev = e.id;
        } else if (e.t === "skip") {
          inc(fb.skips, e.id);
          sf.skips++;
          if (o) {
            o.skips++;
            if (Number.isFinite(e.s)) o.seconds += e.s;
          }
          if (prev && prev !== e.id) {
            const m = badNext.get(prev) ?? badNext.set(prev, new Map()).get(prev);
            inc(m, e.id);
          }
        } else if (e.t === "like" || e.t === "fav") {
          fb.liked.set(e.id, true);
        } else if (e.t === "dislike") {
          fb.liked.set(e.id, false);
        } else if (e.t === "unfav" && fb.liked.get(e.id) === true) {
          fb.liked.delete(e.id);
        }
      }
      list.sort((a, b) => a.at - b.at);
      if (list.length) listeners.set(who, list);
      if (ev.length) feedback.set(who, fb);
    }
    return { listeners, titles, feedback, songFb, badNext, origins };
  }

  #read(path) {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  }

  /**
   * (Re)build the co-listening model. Cached for 30 minutes unless force.
   * Returns the model's stats().
   */
  build({ force = false } = {}) {
    const now = this.#now();
    if (!force && this.#m && now - this.#m.builtAt < CACHE_MS) return this.stats();
    const { listeners, titles, feedback, songFb, badNext, origins } = this.#loadListeners(now);

    const co = new Map(); // a -> Map(b -> weighted co-occurrence), kept symmetric
    const n = new Map(); // song -> number of sessions containing it
    let sessionCount = 0;
    const bump = (a, b, w) => {
      let m = co.get(a);
      if (!m) co.set(a, (m = new Map()));
      m.set(b, (m.get(b) ?? 0) + w);
    };
    const flush = (session) => {
      if (!session.length) return;
      sessionCount++;
      for (const id of new Set(session)) n.set(id, (n.get(id) ?? 0) + 1);
      for (let i = 0; i < session.length; i++) {
        for (let d = 1; d <= WINDOW && i + d < session.length; d++) {
          const a = session[i], b = session[i + d];
          if (a === b) continue;
          bump(a, b, 1 / d);
          bump(b, a, 1 / d);
        }
      }
    };
    for (const list of listeners.values()) {
      let session = [];
      let last = null;
      for (const p of list) {
        if (last != null && p.at - last > SESSION_GAP_MS) { flush(session); session = []; }
        session.push(p.id);
        last = p.at;
      }
      flush(session);
    }

    // sim(a,b) = co / sqrt(n(a) n(b)); top 50 neighbours per song.
    const neighbors = new Map();
    let pairs = 0;
    for (const [a, m] of co) {
      const list = [];
      for (const [b, c] of m) list.push({ id: b, sim: c / Math.sqrt(n.get(a) * n.get(b)) });
      list.sort((x, y) => y.sim - x.sim || (x.id < y.id ? -1 : 1));
      pairs += list.length;
      neighbors.set(a, list.slice(0, MAX_NEIGHBORS));
    }

    // Per-listener recency-weighted play counts.
    const perUser = new Map();
    for (const [who, list] of listeners) {
      const songs = new Map(); // id -> { weight, count, last }
      for (const p of list) {
        const w = Math.pow(0.5, Math.max(0, now - p.at) / DAY / HALF_LIFE_DAYS);
        const s = songs.get(p.id) ?? { weight: 0, count: 0, last: 0 };
        s.weight += w;
        s.count++;
        s.last = Math.max(s.last, p.at);
        songs.set(p.id, s);
      }
      // A like counts like a few recent plays: a strong seed.
      for (const [id, liked] of feedback.get(who)?.liked ?? []) {
        if (!liked) continue;
        const s = songs.get(id) ?? { weight: 0, count: 0, last: 0 };
        s.weight += 2;
        songs.set(id, s);
      }
      perUser.set(who, songs);
    }

    this.#m = {
      builtAt: now, neighbors, perUser, titles, feedback, songFb, badNext, origins,
      listeners: listeners.size, sessions: sessionCount, pairs: pairs / 2,
      // plays of everyone in the last 14 days, for popularity
      recent: this.#recentCounts(listeners, now - 14 * DAY),
    };
    return this.stats();
  }

  #recentCounts(listeners, from) {
    const counts = new Map();
    for (const list of listeners.values()) {
      for (const p of list) if (p.at >= from) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
    return counts;
  }

  #model() {
    this.build();
    return this.#m;
  }

  stats() {
    const m = this.#m;
    if (!m) return { listeners: 0, sessions: 0, songsWithNeighbors: 0, pairs: 0, builtAt: null, surfaces: [] };
    let skips = 0;
    let likes = 0;
    for (const fb of m.feedback.values()) {
      for (const n of fb.skips.values()) skips += n;
      for (const v of fb.liked.values()) if (v) likes++;
    }
    // Per-surface rates so we can answer "which shelf skips more?"
    const surfaces = Object.entries(m.origins || {})
      .map(([ctx, o]) => {
        const plays = o.plays || 0;
        const sk = o.skips || 0;
        const completes = o.completes || 0;
        const starts = plays + sk;
        return {
          ctx,
          plays,
          skips: sk,
          completes,
          seconds: o.seconds || 0,
          skipRate: starts > 0 ? sk / starts : null,
          completeRate: starts > 0 ? completes / starts : null,
        };
      })
      .sort((a, b) => (b.plays + b.skips) - (a.plays + a.skips) || a.ctx.localeCompare(b.ctx));
    return {
      listeners: m.listeners, sessions: m.sessions, songsWithNeighbors: m.neighbors.size,
      pairs: m.pairs, builtAt: m.builtAt,
      feedback: { listeners: m.feedback.size, skips, likes },
      origins: m.origins,
      surfaces,
    };
  }

  /** Listeners seen in the catalog plays table, most active first. */
  users() {
    return this.#q(`SELECT uid, COUNT(*) plays, MAX(at) lastPlayed FROM plays
      WHERE uid IS NOT NULL GROUP BY uid ORDER BY plays DESC, uid`).all()
      .map((r) => ({ uid: r.uid, plays: r.plays, lastPlayed: r.lastPlayed }));
  }

  // ------------------------------------------------------------- metadata

  /** Title, artist and status for a song: songs row first, then crawled tracks, then sync files. */
  #meta(id) {
    const m = this.#m;
    const s = this.#q("SELECT title, artist, artists_json, status FROM songs WHERE video_id=?").get(id);
    const t = this.#q("SELECT title, artists_json FROM tracks WHERE video_id=?").get(id);
    const names = (json) => parse(json, []).map((a) => a?.name).filter(Boolean);
    const sync = m?.titles.get(id);
    const trackArtist = names(t?.artists_json).join(", ");
    const songArtist = s?.artist ?? (names(s?.artists_json).join(", ") || null);
    return {
      title: s?.title ?? t?.title ?? sync?.title ?? null,
      artist: songArtist ?? (trackArtist || null) ?? sync?.artist ?? null,
      archived: s?.status === "stored",
      unavailable: s?.status === "unavailable",
      failed: s?.status === "failed",
    };
  }

  /** Artists of a song: ids (from song_artists) and names (from every source). */
  #artistsOf(id) {
    const rows = this.#q(`SELECT sa.artist_id id, a.name FROM song_artists sa
      LEFT JOIN artists a ON a.id=sa.artist_id WHERE sa.video_id=? ORDER BY sa.position`).all(id);
    const ids = rows.map((r) => r.id);
    const names = new Set(rows.map((r) => r.name).filter(Boolean));
    const song = this.#q("SELECT artist, artists_json FROM songs WHERE video_id=?").get(id);
    if (song?.artist) names.add(song.artist);
    for (const a of parse(song?.artists_json, [])) if (a?.name) names.add(a.name);
    return { ids, names: [...names] };
  }

  // ------------------------------------------------------------ similarTo

  /** Raw (un-normalised) candidate scores for one seed: Map(id -> { score, reasons: Map(text -> weight) }). */
  #candidates(seed) {
    const m = this.#model();
    const cands = new Map();
    const add = (id, w, reason) => {
      if (id === seed || !YT_ID.test(id)) return;
      let c = cands.get(id);
      if (!c) cands.set(id, (c = { score: 0, reasons: new Map() }));
      c.score += w;
      c.reasons.set(reason, (c.reasons.get(reason) ?? 0) + w);
    };
    const seedTitle = this.#meta(seed).title ?? "this song";

    // 1. YouTube Music graph.
    for (const r of this.#q("SELECT related_id id, kind, rank FROM related WHERE video_id=?").all(seed)) {
      const decay = 1 / (1 + (r.rank ?? 0) / 10);
      if (r.kind === "related") add(r.id, 1.0 * decay, `Related to ${seedTitle} on YouTube Music`);
      else if (r.kind === "next") add(r.id, 0.7 * decay, `Up next after ${seedTitle} on YouTube Music`);
    }

    // 2. Co-listening.
    for (const nb of m.neighbors.get(seed) ?? []) {
      add(nb.id, 1.5 * nb.sim, `Friends who play ${seedTitle} also play this`);
    }

    // 2b. Last.fm similar songs, both directions (indexed by video_id / similar_id).
    for (const r of this.#q("SELECT similar_id id, match FROM lastfm_similar WHERE video_id=?").all(seed)) {
      add(r.id, LASTFM_WEIGHT * (r.match ?? 0), `Similar to ${seedTitle} on Last.fm`);
    }
    for (const r of this.#q("SELECT video_id id, match FROM lastfm_similar WHERE similar_id=?").all(seed)) {
      add(r.id, LASTFM_WEIGHT * (r.match ?? 0), `Similar to ${seedTitle} on Last.fm`);
    }

    // 2c. ListenBrainz similar recordings, both directions, normalised by the song's best score.
    const lbMax = this.#q("SELECT MAX(score) m FROM lb_similar WHERE video_id=?").get(seed)?.m;
    if (lbMax > 0) {
      for (const r of this.#q("SELECT similar_id id, score FROM lb_similar WHERE video_id=?").all(seed)) {
        add(r.id, LB_WEIGHT * Math.min(1, (r.score ?? 0) / lbMax), `Similar to ${seedTitle} on ListenBrainz`);
      }
    }
    for (const r of this.#q("SELECT video_id id, score FROM lb_similar WHERE similar_id=? LIMIT 100").all(seed)) {
      const m = this.#q("SELECT MAX(score) m FROM lb_similar WHERE video_id=?").get(r.id)?.m;
      if (m > 0) add(r.id, LB_WEIGHT * Math.min(1, (r.score ?? 0) / m), `Similar to ${seedTitle} on ListenBrainz`);
    }

    // 3. Same artist and similar artists.
    const { ids, names } = this.#artistsOf(seed);
    const label = names[0] ?? "this artist";
    const byArtist = (artistIds, artistName, limit) => {
      const out = new Set();
      for (const aid of artistIds) {
        for (const r of this.#q("SELECT video_id FROM song_artists WHERE artist_id=? LIMIT ?").all(aid, limit)) out.add(r.video_id);
      }
      if (artistName) {
        for (const r of this.#q("SELECT video_id FROM songs WHERE artist=? LIMIT ?").all(artistName, limit)) out.add(r.video_id);
      }
      return out;
    };
    const same = byArtist(ids, null, 40);
    for (const name of names) for (const id of byArtist([], name, 40)) same.add(id);
    for (const id of same) add(id, 0.3, `Also by ${label}`);
    const seenArtists = new Set(ids);
    for (const aid of ids) {
      for (const r of this.#q(`SELECT ar.related_id id, ar.rank, a.name FROM artist_related ar
        LEFT JOIN artists a ON a.id=ar.related_id WHERE ar.artist_id=? ORDER BY ar.rank LIMIT 20`).all(aid)) {
        if (seenArtists.has(r.id)) continue;
        seenArtists.add(r.id);
        const w = 0.4 / (1 + (r.rank ?? 0) / 5);
        for (const id of byArtist([r.id], r.name, 10)) {
          add(id, w, r.name ? `By ${r.name}, similar to ${label}` : `Similar to ${label}`);
        }
      }
    }
    // Last.fm similar artists (forward lookup by artist id).
    for (const aid of ids) {
      for (const r of this.#q("SELECT similar_id id, match FROM lastfm_artist_similar WHERE artist_id=? ORDER BY match DESC LIMIT 20").all(aid)) {
        if (seenArtists.has(r.id)) continue;
        seenArtists.add(r.id);
        const name = this.#q("SELECT name FROM artists WHERE id=?").get(r.id)?.name ?? null;
        const w = 0.4 * LASTFM_WEIGHT / 0.6 * (r.match ?? 0) * 0.75;
        for (const id of byArtist([r.id], name, 10)) {
          add(id, w, name ? `By ${name}, similar to ${label} on Last.fm` : `Similar to ${label} on Last.fm`);
        }
      }
    }
    // ListenBrainz similar artists (forward lookup, normalised by the best score).
    for (const aid of ids) {
      const rows = this.#q("SELECT similar_id id, score FROM lb_artist_similar WHERE artist_id=? ORDER BY score DESC LIMIT 20").all(aid);
      const max = rows[0]?.score;
      if (!(max > 0)) continue;
      for (const r of rows) {
        if (seenArtists.has(r.id)) continue;
        seenArtists.add(r.id);
        const name = this.#q("SELECT name FROM artists WHERE id=?").get(r.id)?.name ?? null;
        const w = 0.25 * Math.min(1, (r.score ?? 0) / max);
        for (const id of byArtist([r.id], name, 10)) {
          add(id, w, name ? `By ${name}, similar to ${label} on ListenBrainz` : `Similar to ${label} on ListenBrainz`);
        }
      }
    }
    return cands;
  }

  /** 0..1 log-scaled listeners (max of Last.fm listeners and ListenBrainz users) of a song (0 when unknown). */
  #lfPop(id) {
    const a = this.#q("SELECT listeners FROM lastfm_tracks WHERE video_id=?").get(id)?.listeners;
    const b = this.#q("SELECT lb_users FROM mb_recordings WHERE video_id=?").get(id)?.lb_users;
    const l = Math.max(a ?? 0, b ?? 0);
    return l ? Math.min(1, Math.log10(1 + l) / 7) : 0;
  }

  /**
   * How much listeners' skips hold a candidate back (1 = not at all): songs
   * most people skip, and songs skipped right after [seed].
   */
  #skipFactor(id, seed) {
    const m = this.#m;
    const f = m.songFb.get(id);
    // Two "free" plays so one early skip doesn't bury a song.
    const rate = f ? f.skips / (f.skips + f.plays + 2) : 0;
    const after = seed ? (m.badNext.get(seed)?.get(id) ?? 0) : 0;
    return (1 - 0.7 * rate) / (1 + after);
  }

  /** Sound-alike 0..1 between two analyzed songs (null when either has no analysis). */
  #soundSim(a, b) {
    if (!a || !b) return null;
    let sum = 0, n = 0;
    for (const f of SOUND_FEATURES) {
      if (a[f] == null || b[f] == null) continue;
      sum += Math.abs(a[f] - b[f]);
      n++;
    }
    return n ? 1 - sum / n : null;
  }

  #analysisRow(id) {
    return this.#q(`SELECT energy, danceability, happy, sad, relaxed, aggressive, party, valence, arousal
      FROM song_analysis WHERE video_id=? AND analyzed_at IS NOT NULL AND error IS NULL`).get(id);
  }

  /** Songs like this one: graph edges, co-listening and artist links merged into a 0..1 score. */
  similarTo(videoId, { limit = 20 } = {}) {
    const cands = this.#candidates(videoId);
    // Popular songs (Last.fm listeners, log-scaled) win ties by up to 5%.
    for (const [id, c] of cands) c.score *= this.#skipFactor(id, videoId) * (1 + 0.05 * this.#lfPop(id));
    // Songs that sound alike (energy, mood...) win ties by up to 15%.
    const seedSound = this.#analysisRow(videoId);
    if (seedSound) {
      for (const [id, c] of cands) {
        const sim = this.#soundSim(seedSound, this.#analysisRow(id));
        if (sim != null) c.score *= 1 + 0.15 * sim;
      }
    }
    let top = 0;
    for (const c of cands.values()) top = Math.max(top, c.score);
    const out = [];
    for (const [id, c] of cands) {
      const meta = this.#meta(id);
      out.push({
        videoId: id, title: meta.title, artist: meta.artist, score: top > 0 ? c.score / top : 0,
        reasons: [...c.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
        archived: meta.archived,
      });
    }
    return out.sort((a, b) => b.score - a.score || (a.videoId < b.videoId ? -1 : 1)).slice(0, limit);
  }

  /** One listener's history for "discover": played song ids and their most weighted songs. null when unknown. */
  historyOf(uid, { top = 10 } = {}) {
    const mine = uid ? this.#model().perUser.get(uid) : null;
    if (!mine || !mine.size) return null;
    const best = [...mine].sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1)).slice(0, top).map(([id]) => id);
    return { played: new Set(mine.keys()), top: best };
  }

  // -------------------------------------------------------------- forUser

  /**
   * Catalog songs for cold-start artist names (exact NOCASE match).
   * Prefer song_artists links; fall back to songs.artist text.
   * Returns [{ videoId, title, weight }] usable as forUser seeds.
   */
  #seedsFromArtists(names, { perArtist = 5 } = {}) {
    const out = [];
    const seen = new Set();
    const push = (id, label) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ videoId: id, title: this.#meta(id).title || label, weight: 1 });
    };
    for (const raw of names) {
      const name = String(raw || "").trim();
      if (!name) continue;
      let n = 0;
      const aids = this.#q("SELECT id, name FROM artists WHERE name = ? COLLATE NOCASE LIMIT 3").all(name);
      for (const a of aids) {
        const rows = this.#q(
          `SELECT sa.video_id id FROM song_artists sa
           LEFT JOIN songs s ON s.video_id = sa.video_id
           WHERE sa.artist_id = ?
           ORDER BY CASE WHEN s.status = 'stored' THEN 0 ELSE 1 END, COALESCE(s.plays, 0) DESC
           LIMIT ?`,
        ).all(a.id, perArtist);
        for (const r of rows) {
          push(r.id, a.name);
          n++;
        }
      }
      if (n > 0) continue;
      // Fallback: songs.artist string (no artist graph row yet).
      for (const r of this.#q(
        `SELECT video_id id FROM songs
         WHERE artist = ? COLLATE NOCASE AND status = 'stored'
         ORDER BY COALESCE(plays, 0) DESC LIMIT ?`,
      ).all(name, perArtist)) {
        push(r.id, name);
      }
    }
    return out;
  }

  /**
   * Blend long-term affinity with a short session window.
   * Confidence damps one-off plays: weight *= min(1, count/3).
   */
  #blendSeeds(mine, now) {
    const blended = new Map(); // id -> { weight, title, count, last }
    const touch = (id, w, s) => {
      const cur = blended.get(id) ?? {
        weight: 0,
        title: this.#meta(id).title,
        count: s?.count ?? 0,
        last: s?.last ?? 0,
      };
      cur.weight += w;
      cur.count = Math.max(cur.count, s?.count ?? 0);
      cur.last = Math.max(cur.last, s?.last ?? 0);
      blended.set(id, cur);
    };
    // Long-term: top by weight, damped by evidence.
    const long = [...mine].sort((a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1)).slice(0, 15);
    for (const [id, s] of long) {
      const conf = Math.min(1, (s.count || 1) / 3);
      touch(id, 0.65 * s.weight * conf, s);
    }
    // Short-term: last ~12 plays by recency (a binge can steer without wiping taste).
    const recent = [...mine]
      .filter(([, s]) => now - s.last < 6 * 3600_000) // within 6h
      .sort((a, b) => b[1].last - a[1].last || (a[0] < b[0] ? -1 : 1))
      .slice(0, 12);
    for (const [i, [id, s]] of recent.entries()) {
      touch(id, 0.35 * (1 / (1 + i)) * Math.max(s.weight, 0.4), s);
    }
    return [...blended]
      .map(([id, s]) => ({ videoId: id, title: s.title, weight: s.weight, count: s.count, last: s.last }))
      .sort((a, b) => b.weight - a.weight || (a.videoId < b.videoId ? -1 : 1))
      .slice(0, 15);
  }

  /** Per-friend suggestions with reasons. Optional seedArtists for cold start. */
  forUser(uid, { limit = 30, seedArtists = [] } = {}) {
    const m = this.#model();
    const now = this.#now();
    const mine = m.perUser.get(uid);
    const popMax = Math.max(1, ...m.recent.values());
    const pop = (id) => (m.recent.get(id) ?? 0) / popMax;
    const artistSeeds = Array.isArray(seedArtists)
      ? seedArtists.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 12)
      : [];

    // Final pass shared by both paths: drop unplayable / untitled / failed rows, cap two per artist.
    const finish = (list) => {
      const perArtist = new Map();
      const items = [];
      for (const c of list) {
        const meta = this.#meta(c.videoId);
        // No title anywhere yet: nothing to show in the app.
        if (meta.unavailable || meta.failed || !meta.title) continue;
        if (/^(unknown|untitled|n\/?a)$/i.test(meta.title.trim())) continue;
        const key = (meta.artist ?? "").split(",")[0].trim().toLowerCase();
        if (key) {
          const k = perArtist.get(key) ?? 0;
          if (k >= 2) continue;
          perArtist.set(key, k + 1);
        }
        items.push({
          videoId: c.videoId, title: meta.title, artist: meta.artist, score: c.score,
          reasons: c.reasons.slice(0, 2), archived: meta.archived,
        });
        if (items.length >= limit) break;
      }
      const top = items[0]?.score || 0;
      for (const it of items) it.score = top > 0 ? it.score / top : 0;
      return items;
    };
    const popular = (known = new Map()) => [...m.recent].filter(([id]) => !known.has(id))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id, c]) => ({ videoId: id, score: c, reasons: ["Popular with friends"] }));

    // Cold start: optional seed artists first, else friends' popular.
    if (!mine || !mine.size) {
      const cold = artistSeeds.length ? this.#seedsFromArtists(artistSeeds) : [];
      if (!cold.length) return { uid, seeds: [], items: finish(popular()) };
      const cands = new Map();
      const touch = (id) => cands.get(id) ?? cands.set(id, { score: 0, seeds: new Map(), signals: new Map() }).get(id);
      const inc = (map, k, w) => map.set(k, (map.get(k) ?? 0) + w);
      for (const seed of cold) {
        const seedTitle = seed.title ?? "a seed artist";
        for (const s of this.similarTo(seed.videoId, { limit: 40 })) {
          const w = s.score * seed.weight;
          const c = touch(s.videoId);
          c.score += w;
          inc(c.seeds, seedTitle, w);
          if (s.reasons[0]) inc(c.signals, s.reasons[0], w);
        }
      }
      for (const [id] of m.recent) {
        const c = touch(id);
        const w = 0.08 * pop(id);
        c.score += w;
        inc(c.signals, "Popular with friends", w);
      }
      const knownCold = new Set(cold.map((s) => s.videoId));
      const list = [...cands]
        .filter(([id]) => !knownCold.has(id))
        .map(([id, c]) => {
          const top = (map) => [...map].sort((a, b) => b[1] - a[1]).map(([t]) => t);
          const seedReasons = top(c.seeds).map((t) => `Because you like ${t}`);
          const reasons = seedReasons.slice(0, 1).concat(top(c.signals).slice(0, 1));
          return { videoId: id, score: c.score, reasons };
        })
        .sort((a, b) => b.score - a.score || (a.videoId < b.videoId ? -1 : 1));
      return { uid, seeds: cold.slice(0, 10), items: finish(list) };
    }

    const seeds = this.#blendSeeds(mine, now);

    // Candidates: similarTo of each seed weighted by seed weight, plus a popularity prior.
    // id -> { score, seeds: Map(seed title -> weight), signals: Map(reason -> weight) }
    const cands = new Map();
    const touch = (id) => cands.get(id) ?? cands.set(id, { score: 0, seeds: new Map(), signals: new Map() }).get(id);
    const inc = (map, k, w) => map.set(k, (map.get(k) ?? 0) + w);
    for (const seed of seeds) {
      const seedTitle = seed.title ?? "a song you played";
      for (const s of this.similarTo(seed.videoId, { limit: 50 })) {
        const w = s.score * seed.weight;
        const c = touch(s.videoId);
        c.score += w;
        inc(c.seeds, seedTitle, w);
        if (s.reasons[0]) inc(c.signals, s.reasons[0], w);
      }
    }
    for (const [id] of m.recent) {
      const c = touch(id);
      const w = 0.1 * pop(id);
      c.score += w;
      inc(c.signals, "Popular with friends", w);
    }

    // Songs like ones the listener disliked, or keeps skipping, sink.
    const fb = m.feedback.get(uid);
    const rejected = (id) => fb?.liked.get(id) === false || ((fb?.skips.get(id) ?? 0) > 0 && !fb?.full.get(id));
    if (fb) {
      const negatives = [...fb.liked].filter(([, v]) => v === false).map(([id]) => [id, 0.5]);
      for (const [id, n] of fb.skips) if (n >= 2 && !fb.full.get(id)) negatives.push([id, 0.25]);
      for (const [neg, strength] of negatives.slice(0, 20)) {
        for (const s of this.similarTo(neg, { limit: 30 })) {
          const c = cands.get(s.videoId);
          if (c) c.score *= 1 - strength * s.score;
        }
      }
    }

    // Songs the listener already knows or liked, disliked, or skipped
    // without ever playing through are not suggestions.
    const known = (id) => {
      const s = mine.get(id);
      return (s && (now - s.last < 7 * DAY || s.count > 3)) || rejected(id) || fb?.liked.get(id) === true;
    };
    const list = [...cands]
      .filter(([id]) => !known(id))
      .map(([id, c]) => {
        const top = (map) => [...map].sort((a, b) => b[1] - a[1]).map(([t]) => t);
        // Best seed first, then the strongest signal (or the next seed).
        const seedReasons = top(c.seeds).map((t) => `Because you played ${t}`);
        const reasons = seedReasons.slice(0, 1).concat(top(c.signals).slice(0, 1));
        if (reasons.length < 2) reasons.push(...seedReasons.slice(1, 2));
        return { videoId: id, score: c.score, reasons };
      })
      .sort((a, b) => b.score - a.score || (a.videoId < b.videoId ? -1 : 1));
    return { uid, seeds: seeds.slice(0, 10), items: finish(list) };
  }
}
