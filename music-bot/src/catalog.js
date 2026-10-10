// Catalog of songs archived in the private Telegram channel, the shared
// download-job queue and play events. Home server only; peers use HTTP.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 864e5;
const LEASE_MS = 15 * MIN;
const EXCLUDE_MS = 24 * HOUR;
const MAX_ATTEMPTS = 6;
const BACKOFF = [2 * MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR];
const SOURCES = ["disk", "telegram", "youtube", "peer"];

// Ordered migrations; index + 1 is the schema version.
const MIGRATIONS = [
  `CREATE TABLE songs (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending','stored','failed','unavailable')),
    title TEXT, artist TEXT, artists_json TEXT, album TEXT, year INTEGER,
    duration_s REAL, isrc TEXT, yt_channel_id TEXT, yt_channel TEXT,
    thumb_url TEXT, tags_json TEXT, categories_json TEXT,
    tg_msg_id INTEGER, tg_size INTEGER, mime TEXT, codec TEXT, bitrate_kbps REAL,
    source_server TEXT, created_at INTEGER, stored_at INTEGER,
    plays INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER,
    error TEXT, meta_json TEXT
  );
  CREATE INDEX songs_status ON songs(status);
  CREATE INDEX songs_stored_at ON songs(stored_at);
  CREATE TABLE jobs (
    video_id TEXT PRIMARY KEY REFERENCES songs(video_id),
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
    server TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, excluded_json TEXT NOT NULL DEFAULT '[]',
    reason TEXT, error TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE INDEX jobs_state_next ON jobs(state, next_at);
  CREATE TABLE related (
    video_id TEXT NOT NULL, related_id TEXT NOT NULL, kind TEXT NOT NULL,
    rank INTEGER, PRIMARY KEY (video_id, related_id, kind)
  );
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL, at INTEGER NOT NULL, server TEXT, source TEXT, uid TEXT
  );
  CREATE INDEX plays_at ON plays(at);
  CREATE INDEX plays_video ON plays(video_id);`,
];

const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
const json = (v) => (v == null ? null : JSON.stringify(v));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export class Catalog {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  #migrate() {
    const db = this.db;
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    for (let v = row ? Number(row.value) : 0; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN");
      try {
        db.exec(MIGRATIONS[v]);
        db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(v + 1));
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
  }

  // Run fn inside a transaction (rolls back on throw).
  #tx(fn) {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  #q = new Map();
  #sql(text) {
    let s = this.#q.get(text);
    if (!s) this.#q.set(text, (s = this.db.prepare(text)));
    return s;
  }

  #song(row) {
    if (!row) return null;
    return {
      videoId: row.video_id, status: row.status, title: row.title, artist: row.artist,
      artists: parse(row.artists_json, []), album: row.album, year: row.year,
      durationS: row.duration_s, isrc: row.isrc, ytChannelId: row.yt_channel_id,
      ytChannel: row.yt_channel, thumbUrl: row.thumb_url, tags: parse(row.tags_json, []),
      categories: parse(row.categories_json, []), msgId: row.tg_msg_id, size: row.tg_size,
      mime: row.mime, codec: row.codec, bitrateKbps: row.bitrate_kbps,
      sourceServer: row.source_server, createdAt: row.created_at, storedAt: row.stored_at,
      plays: row.plays, lastPlayedAt: row.last_played_at, error: row.error,
      meta: parse(row.meta_json, {}),
    };
  }

  lookup(videoId) {
    return this.#song(this.#sql("SELECT * FROM songs WHERE video_id=?").get(videoId));
  }

  // Jobs whose lease ran out go back to the queue.
  #reap(now) {
    this.#sql(`UPDATE jobs SET state='queued', server=NULL, lease_until=NULL, updated_at=?
      WHERE state='running' AND lease_until<=?`).run(now, now);
  }

  #ensureSong(videoId, now) {
    this.#sql("INSERT OR IGNORE INTO songs(video_id,status,created_at) VALUES(?,'pending',?)").run(videoId, now);
  }

  // Excluded servers still within the 24 h window.
  #blocked(job, now) {
    return parse(job.excluded_json, []).filter((e) => e.at > now - EXCLUDE_MS).map((e) => e.server);
  }

  claim(videoId, server, now = Date.now()) {
    return this.#tx(() => {
      this.#reap(now);
      const song = this.lookup(videoId);
      if (song?.status === "stored") return { action: "stored", song };
      if (song?.status === "unavailable") return { action: "unavailable" };
      const job = this.#sql("SELECT * FROM jobs WHERE video_id=?").get(videoId);
      if (job?.state === "running" && job.lease_until > now && job.server !== server) {
        return { action: "wait", server: job.server };
      }
      this.#ensureSong(videoId, now);
      this.#sql("UPDATE songs SET status='pending' WHERE video_id=? AND status='failed'").run(videoId);
      this.#sql(`INSERT INTO jobs(video_id,state,server,lease_until,reason,created_at,updated_at)
        VALUES(?, 'running', ?, ?, 'play', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET state='running', server=excluded.server,
          lease_until=excluded.lease_until, updated_at=excluded.updated_at`)
        .run(videoId, server, now + LEASE_MS, now, now);
      return { action: "download" };
    });
  }

  stored(videoId, info = {}, now = Date.now()) {
    return this.#tx(() => {
      this.#ensureSong(videoId, now);
      // COALESCE keeps existing values where info has none.
      this.#sql(`UPDATE songs SET status='stored', stored_at=?, error=NULL,
        title=COALESCE(?,title), artist=COALESCE(?,artist), artists_json=COALESCE(?,artists_json),
        album=COALESCE(?,album), year=COALESCE(?,year), duration_s=COALESCE(?,duration_s),
        isrc=COALESCE(?,isrc), yt_channel_id=COALESCE(?,yt_channel_id), yt_channel=COALESCE(?,yt_channel),
        thumb_url=COALESCE(?,thumb_url), tags_json=COALESCE(?,tags_json),
        categories_json=COALESCE(?,categories_json), tg_msg_id=COALESCE(?,tg_msg_id),
        tg_size=COALESCE(?,tg_size), mime=COALESCE(?,mime), codec=COALESCE(?,codec),
        bitrate_kbps=COALESCE(?,bitrate_kbps), source_server=COALESCE(?,source_server),
        meta_json=COALESCE(?,meta_json)
        WHERE video_id=?`).run(
        now, info.title ?? null, info.artist ?? null, json(info.artists), info.album ?? null,
        info.year ?? null, info.durationS ?? null, info.isrc ?? null, info.ytChannelId ?? null,
        info.ytChannel ?? null, info.thumbUrl ?? null, json(info.tags), json(info.categories),
        info.msgId ?? null, info.size ?? null, info.mime ?? null, info.codec ?? null,
        info.bitrateKbps ?? null, info.server ?? null, json(info.meta), videoId);
      this.#sql(`UPDATE jobs SET state='done', lease_until=NULL, error=NULL, updated_at=? WHERE video_id=?`)
        .run(now, videoId);
      return this.lookup(videoId);
    });
  }

  failed(videoId, server, error, { blocked = false, unavailable = false } = {}, now = Date.now()) {
    this.#tx(() => {
      this.#ensureSong(videoId, now);
      this.#sql(`INSERT OR IGNORE INTO jobs(video_id,state,reason,created_at,updated_at)
        VALUES(?, 'queued', 'play', ?, ?)`).run(videoId, now, now);
      const job = this.#sql("SELECT * FROM jobs WHERE video_id=?").get(videoId);
      const msg = error == null ? null : String(error);
      if (unavailable) {
        this.#sql("UPDATE songs SET status='unavailable', error=? WHERE video_id=?").run(msg, videoId);
        this.#sql(`UPDATE jobs SET state='failed', server=NULL, lease_until=NULL, error=?, updated_at=?
          WHERE video_id=?`).run(msg, now, videoId);
        return;
      }
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const excluded = parse(job.excluded_json, []);
      if (blocked && server) excluded.push({ server, at: now });
      // One entry per server: keep the latest.
      const uniq = [...new Map(excluded.map((e) => [e.server, e])).values()];
      const nextAt = now + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
      this.#sql(`UPDATE jobs SET state=?, attempts=?, next_at=?, server=NULL, lease_until=NULL,
        error=?, excluded_json=?, updated_at=? WHERE video_id=?`)
        .run(dead ? "failed" : "queued", attempts, nextAt, msg, JSON.stringify(uniq), now, videoId);
      if (dead) this.#sql("UPDATE songs SET status='failed', error=? WHERE video_id=?").run(msg, videoId);
      else this.#sql("UPDATE songs SET error=? WHERE video_id=? AND status!='stored'").run(msg, videoId);
    });
  }

  nextJobs(server, limit = 2, now = Date.now()) {
    return this.#tx(() => {
      this.#reap(now);
      // retry/play before prefetch, then oldest first.
      const rows = this.#sql(`SELECT * FROM jobs WHERE state='queued' AND next_at<=?
        ORDER BY (reason='prefetch'), created_at, rowid`).all(now);
      const picked = [];
      for (const job of rows) {
        if (picked.length >= limit) break;
        if (this.#blocked(job, now).includes(server)) continue;
        this.#sql(`UPDATE jobs SET state='running', server=?, lease_until=?, updated_at=? WHERE video_id=?`)
          .run(server, now + LEASE_MS, now, job.video_id);
        picked.push(job.video_id);
      }
      return picked;
    });
  }

  enqueue(videoIds, reason = "prefetch", now = Date.now()) {
    return this.#tx(() => {
      let n = 0;
      for (const id of new Set(videoIds)) {
        if (this.lookup(id)) continue;
        this.#ensureSong(id, now);
        this.#sql(`INSERT INTO jobs(video_id,state,reason,created_at,updated_at)
          VALUES(?, 'queued', ?, ?, ?)`).run(id, reason, now, now);
        n++;
      }
      return n;
    });
  }

  retry(videoId, now = Date.now()) {
    return this.#tx(() => {
      const job = this.#sql("SELECT state FROM jobs WHERE video_id=?").get(videoId);
      if (!job || !["failed", "queued"].includes(job.state)) return false;
      this.#sql(`UPDATE jobs SET state='queued', next_at=?, attempts=0, excluded_json='[]',
        server=NULL, lease_until=NULL, reason='retry', error=NULL, updated_at=? WHERE video_id=?`)
        .run(now, now, videoId);
      this.#sql("UPDATE songs SET status='pending', error=NULL WHERE video_id=? AND status IN ('failed','pending')")
        .run(videoId);
      return true;
    });
  }

  recordPlays(events) {
    this.#tx(() => {
      for (const e of events) {
        const at = e.at ?? Date.now();
        this.#sql("INSERT INTO plays(video_id,at,server,source,uid) VALUES(?,?,?,?,?)")
          .run(e.videoId, at, e.server ?? null, e.source ?? null, e.uid ?? null);
        this.#sql(`UPDATE songs SET plays=plays+1, last_played_at=MAX(COALESCE(last_played_at,0),?)
          WHERE video_id=?`).run(at, e.videoId);
      }
    });
  }

  // Replace the related rows of one video for each kind present in items.
  setRelated(videoId, items) {
    this.#tx(() => {
      for (const kind of new Set(items.map((i) => i.kind))) {
        this.#sql("DELETE FROM related WHERE video_id=? AND kind=?").run(videoId, kind);
      }
      for (const [i, it] of items.entries()) {
        this.#sql("INSERT OR REPLACE INTO related(video_id,related_id,kind,rank) VALUES(?,?,?,?)")
          .run(videoId, it.id, it.kind, it.rank ?? i);
      }
    });
  }

  stats(days = 7, now = Date.now()) {
    const q = (t, ...a) => this.#sql(t).all(...a);
    const dayStart = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
    const t = q(`SELECT status, COUNT(*) n FROM songs GROUP BY status`);
    const cnt = (s) => t.find((r) => r.status === s)?.n ?? 0;
    const sum = this.#sql(`SELECT COALESCE(SUM(tg_size),0) bytes, COALESCE(SUM(duration_s),0) dur
      FROM songs WHERE status='stored'`).get();
    const byDay = [];
    const idx = new Map();
    for (let i = 0; i < days; i++) {
      const day = dayKey(dayStart + i * DAY);
      idx.set(day, byDay.length);
      byDay.push({ day, stored: 0, plays: Object.fromEntries(SOURCES.map((s) => [s, 0])) });
    }
    for (const r of q(`SELECT strftime('%Y-%m-%d', stored_at/1000, 'unixepoch') d, COUNT(*) n FROM songs
      WHERE status='stored' AND stored_at>=? AND stored_at<=? GROUP BY d`, dayStart, now)) {
      byDay[idx.get(r.d)].stored = r.n;
    }
    const sources = Object.fromEntries(SOURCES.map((s) => [s, 0]));
    for (const r of q(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch') d, source, COUNT(*) n FROM plays
      WHERE at>=? AND at<=? GROUP BY d, source`, dayStart, now)) {
      if (!(r.source in sources)) continue;
      byDay[idx.get(r.d)].plays[r.source] = r.n;
      sources[r.source] += r.n;
    }
    // Per-server stored + plays over the range.
    const srv = new Map();
    const row = (s) => srv.get(s) ?? srv.set(s, { server: s, stored: 0, plays: 0 }).get(s);
    for (const r of q(`SELECT source_server s, COUNT(*) n FROM songs WHERE status='stored'
      AND stored_at>=? AND stored_at<=? AND source_server IS NOT NULL GROUP BY s`, dayStart, now)) row(r.s).stored = r.n;
    for (const r of q(`SELECT server s, COUNT(*) n FROM plays WHERE at>=? AND at<=?
      AND server IS NOT NULL GROUP BY s`, dayStart, now)) row(r.s).plays = r.n;
    const jq = (s) => this.#sql("SELECT COUNT(*) n FROM jobs WHERE state=?").get(s).n;
    return {
      totals: {
        stored: cnt("stored"), pending: cnt("pending"), failed: cnt("failed"),
        unavailable: cnt("unavailable"), bytes: sum.bytes, durationS: sum.dur,
      },
      byDay,
      byServer: [...srv.values()].sort((a, b) => b.plays - a.plays || a.server.localeCompare(b.server)),
      sources,
      queue: { queued: jq("queued"), running: jq("running"), failed: jq("failed") },
      recent: q(`SELECT * FROM songs WHERE status='stored' ORDER BY stored_at DESC, rowid DESC LIMIT 20`)
        .map((r) => ({
          videoId: r.video_id, title: r.title, artist: r.artist, durationS: r.duration_s,
          size: r.tg_size, storedAt: r.stored_at, server: r.source_server, plays: r.plays,
        })),
      top: q(`SELECT p.video_id, s.title, s.artist, COUNT(*) n FROM plays p
        LEFT JOIN songs s ON s.video_id=p.video_id WHERE p.at>=? AND p.at<=?
        GROUP BY p.video_id ORDER BY n DESC, p.video_id LIMIT 20`, dayStart, now)
        .map((r) => ({ videoId: r.video_id, title: r.title, artist: r.artist, plays: r.n })),
      failedJobs: q(`SELECT j.*, s.title FROM jobs j LEFT JOIN songs s ON s.video_id=j.video_id
        WHERE j.state='failed' OR (j.state='queued' AND j.attempts>0)
        ORDER BY j.updated_at DESC, j.rowid DESC LIMIT 30`).map((r) => ({
          videoId: r.video_id, title: r.title, state: r.state, attempts: r.attempts,
          error: r.error, nextAt: r.next_at,
          excluded: parse(r.excluded_json, []).map((e) => e.server),
        })),
    };
  }

  close() { this.db.close(); }
}
