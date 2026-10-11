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
const KINDS = ["ytm_track", "ytm_video", "youtube"];

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
  `ALTER TABLE songs ADD COLUMN source_kind TEXT;
  ALTER TABLE songs ADD COLUMN quality_label TEXT;
  ALTER TABLE songs ADD COLUMN sample_rate INTEGER;
  ALTER TABLE songs ADD COLUMN channels INTEGER;
  ALTER TABLE songs ADD COLUMN format_id TEXT;
  ALTER TABLE songs ADD COLUMN container TEXT;
  CREATE INDEX songs_source_kind ON songs(source_kind);`,
  `CREATE TABLE tracks (
    video_id TEXT PRIMARY KEY, title TEXT, artists_json TEXT, album TEXT, album_id TEXT,
    year INTEGER, duration_s REAL, first_seen INTEGER, last_seen INTEGER
  );
  CREATE TABLE artists (
    id TEXT PRIMARY KEY, name TEXT, subscribers INTEGER, description TEXT,
    first_seen INTEGER, last_seen INTEGER
  );
  CREATE TABLE song_artists (
    video_id TEXT NOT NULL, artist_id TEXT NOT NULL, position INTEGER,
    PRIMARY KEY (video_id, artist_id)
  );
  CREATE INDEX song_artists_artist ON song_artists(artist_id);
  CREATE TABLE artist_related (
    artist_id TEXT NOT NULL, related_id TEXT NOT NULL, rank INTEGER, seen_at INTEGER,
    PRIMARY KEY (artist_id, related_id)
  );
  CREATE TABLE albums (
    id TEXT PRIMARY KEY, title TEXT, kind TEXT, year INTEGER, artist_id TEXT
  );
  CREATE TABLE crawl (
    video_id TEXT PRIMARY KEY, crawled_at INTEGER, ok INTEGER, error TEXT,
    up_next INTEGER, related INTEGER
  );
  CREATE INDEX crawl_at ON crawl(crawled_at);`,
  `ALTER TABLE plays ADD COLUMN ctx TEXT;
  ALTER TABLE songs ADD COLUMN backup_msg_id INTEGER;
  ALTER TABLE songs ADD COLUMN backup_at INTEGER;
  CREATE TABLE videos (
    video_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('stored','failed','none')),
    tg_msg_id INTEGER, size INTEGER, width INTEGER, height INTEGER, vcodec TEXT, acodec TEXT,
    duration_s REAL, format_id TEXT, source_server TEXT, stored_at INTEGER, error TEXT,
    backup_msg_id INTEGER, backup_at INTEGER, lease_server TEXT, lease_until INTEGER,
    plays INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX videos_status ON videos(status);`,
];
const VIDEO_LEASE_MS = 10 * MIN;
const VIDEO_RETRY_MS = HOUR;
const CTX_RE = /^[a-z_]{1,20}$/;
const CRAWL_OK_MS = 30 * DAY;
const CRAWL_FAIL_MS = DAY;

const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
const json = (v) => (v == null ? null : JSON.stringify(v));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const kindCounts = () => Object.fromEntries([...KINDS, "unknown"].map((k) => [k, 0]));

// Short codec name for the quality breakdown.
const codecShort = (codec) => {
  if (!codec) return "Unknown";
  if (codec === "mp4a.40.5") return "HE-AAC";
  if (codec === "mp4a.40.2" || codec === "mp4a.40.02" || codec.startsWith("mp4a")) return "AAC";
  if (codec === "opus") return "Opus";
  return codec;
};
const qualityLabel = (codec, kbps) => {
  const short = codecShort(codec);
  return kbps > 0 ? `${short} ${Math.round(kbps / 16) * 16} kbps` : short;
};

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
      sourceKind: row.source_kind,
      quality: {
        label: row.quality_label, codec: row.codec, bitrateKbps: row.bitrate_kbps,
        sampleRate: row.sample_rate, channels: row.channels, formatId: row.format_id,
        container: row.container,
      },
      sourceServer: row.source_server, createdAt: row.created_at, storedAt: row.stored_at,
      plays: row.plays, lastPlayedAt: row.last_played_at, error: row.error,
      meta: parse(row.meta_json, {}),
    };
  }

  lookup(videoId) {
    return this.#song(this.#sql("SELECT * FROM songs WHERE video_id=?").get(videoId));
  }

  // Stored songs with no source kind yet, oldest first.
  missingMeta(limit = 20) {
    return this.#sql(`SELECT video_id FROM songs WHERE status='stored' AND source_kind IS NULL
      ORDER BY stored_at, rowid LIMIT ?`).all(limit).map((r) => r.video_id);
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
    const q = info.quality ?? {};
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
        meta_json=COALESCE(?,meta_json), source_kind=COALESCE(?,source_kind),
        quality_label=COALESCE(?,quality_label), sample_rate=COALESCE(?,sample_rate),
        channels=COALESCE(?,channels), format_id=COALESCE(?,format_id), container=COALESCE(?,container)
        WHERE video_id=?`).run(
        now, info.title ?? null, info.artist ?? null, json(info.artists), info.album ?? null,
        info.year ?? null, info.durationS ?? null, info.isrc ?? null, info.ytChannelId ?? null,
        info.ytChannel ?? null, info.thumbUrl ?? null, json(info.tags), json(info.categories),
        info.msgId ?? null, info.size ?? null, info.mime ?? null, q.codecRaw ?? info.codec ?? null,
        q.bitrateKbps ?? info.bitrateKbps ?? null, info.server ?? null, json(info.meta),
        info.sourceKind ?? null, q.label ?? null, q.sampleRate ?? null, q.channels ?? null,
        q.formatId ?? null, q.container ?? null, videoId);
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
      this.#sql("UPDATE songs SET status='pending', error=NULL WHERE video_id=? AND status IN ('failed','pending','unavailable')")
        .run(videoId);
      return true;
    });
  }

  recordPlays(events) {
    this.#tx(() => {
      for (const e of events) {
        const at = e.at ?? Date.now();
        const ctx = typeof e.ctx === "string" && CTX_RE.test(e.ctx) ? e.ctx : null;
        this.#sql("INSERT INTO plays(video_id,at,server,source,uid,ctx) VALUES(?,?,?,?,?,?)")
          .run(e.videoId, at, e.server ?? null, e.source ?? null, e.uid ?? null, ctx);
        this.#sql(`UPDATE songs SET plays=plays+1, last_played_at=MAX(COALESCE(last_played_at,0),?)
          WHERE video_id=?`).run(at, e.videoId);
      }
    });
  }

  // Stored songs not yet copied to the backup channel, oldest first.
  needsBackup(limit = 5) {
    return this.#sql(`SELECT video_id, tg_msg_id FROM songs WHERE status='stored' AND tg_msg_id IS NOT NULL
      AND backup_msg_id IS NULL ORDER BY stored_at, rowid LIMIT ?`).all(limit)
      .map((r) => ({ videoId: r.video_id, msgId: r.tg_msg_id }));
  }

  markBackup(videoId, backupMsgId, now = Date.now()) {
    this.#sql("UPDATE songs SET backup_msg_id=?, backup_at=? WHERE video_id=?").run(backupMsgId, now, videoId);
  }

  #video(r) {
    if (!r) return null;
    return {
      videoId: r.video_id, status: r.status, msgId: r.tg_msg_id, size: r.size, width: r.width,
      height: r.height, vcodec: r.vcodec, acodec: r.acodec, durationS: r.duration_s,
      formatId: r.format_id, sourceServer: r.source_server, storedAt: r.stored_at, error: r.error,
      backupMsgId: r.backup_msg_id, backupAt: r.backup_at, leaseServer: r.lease_server,
      leaseUntil: r.lease_until, plays: r.plays,
    };
  }

  videoLookup(videoId) {
    return this.#video(this.#sql("SELECT * FROM videos WHERE video_id=?").get(videoId));
  }

  // For status 'failed', stored_at holds the time of the failure (retry clock).
  videoClaim(videoId, server, now = Date.now()) {
    return this.#tx(() => {
      const v = this.videoLookup(videoId);
      if (v?.status === "stored") return { action: "stored", video: v };
      if (v?.status === "none") return { action: "none" };
      if (v?.status === "failed" && (v.storedAt ?? 0) > now - VIDEO_RETRY_MS) {
        return { action: "none", failed: true, error: v.error, retryAt: v.storedAt + VIDEO_RETRY_MS };
      }
      if (v?.leaseServer && v.leaseUntil > now && v.leaseServer !== server) {
        return { action: "wait", server: v.leaseServer };
      }
      this.#sql(`INSERT INTO videos(video_id,status,lease_server,lease_until) VALUES(?, 'failed', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET lease_server=excluded.lease_server, lease_until=excluded.lease_until`)
        .run(videoId, server, now + VIDEO_LEASE_MS);
      return { action: "download" };
    });
  }

  videoStored(videoId, info = {}, now = Date.now()) {
    this.#sql(`INSERT INTO videos(video_id,status,tg_msg_id,size,width,height,vcodec,acodec,duration_s,
        format_id,source_server,stored_at,error,lease_server,lease_until)
      VALUES(?, 'stored', ?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)
      ON CONFLICT(video_id) DO UPDATE SET status='stored', tg_msg_id=excluded.tg_msg_id, size=excluded.size,
        width=excluded.width, height=excluded.height, vcodec=excluded.vcodec, acodec=excluded.acodec,
        duration_s=excluded.duration_s, format_id=excluded.format_id, source_server=excluded.source_server,
        stored_at=excluded.stored_at, error=NULL, lease_server=NULL, lease_until=NULL`)
      .run(videoId, info.msgId ?? null, info.size ?? null, info.width ?? null, info.height ?? null,
        info.vcodec ?? null, info.acodec ?? null, info.durationS ?? null, info.formatId ?? null,
        info.server ?? null, now);
    return this.videoLookup(videoId);
  }

  videoFailed(videoId, server, error, { none = false } = {}, now = Date.now()) {
    const msg = error == null ? null : String(error);
    this.#sql(`INSERT INTO videos(video_id,status,error,stored_at,source_server) VALUES(?,?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET status=excluded.status, error=excluded.error,
        stored_at=excluded.stored_at, lease_server=NULL, lease_until=NULL`)
      .run(videoId, none ? "none" : "failed", msg, now, server ?? null);
  }

  videoPlay(videoId) {
    this.#sql("UPDATE videos SET plays=plays+1 WHERE video_id=?").run(videoId);
  }

  videoNeedsBackup(limit = 5) {
    return this.#sql(`SELECT video_id, tg_msg_id FROM videos WHERE status='stored' AND tg_msg_id IS NOT NULL
      AND backup_msg_id IS NULL ORDER BY stored_at, rowid LIMIT ?`).all(limit)
      .map((r) => ({ videoId: r.video_id, msgId: r.tg_msg_id }));
  }

  videoMarkBackup(videoId, backupMsgId, now = Date.now()) {
    this.#sql("UPDATE videos SET backup_msg_id=?, backup_at=? WHERE video_id=?").run(backupMsgId, now, videoId);
  }

  videoStats() {
    const r = this.#sql(`SELECT
      COALESCE(SUM(status='stored'),0) stored, COALESCE(SUM(status='failed'),0) failed,
      COALESCE(SUM(status='none'),0) none,
      COALESCE(SUM(CASE WHEN status='stored' THEN size END),0) bytes,
      COALESCE(SUM(plays),0) plays,
      COALESCE(SUM(status='stored' AND backup_msg_id IS NOT NULL),0) backedUp FROM videos`).get();
    return { stored: r.stored, failed: r.failed, none: r.none, bytes: r.bytes, plays: r.plays, backedUp: r.backedUp };
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

  // Stored songs that still need a graph crawl: never crawled first, then oldest.
  needsCrawl(limit = 1, now = Date.now()) {
    return this.#sql(`SELECT s.video_id FROM songs s LEFT JOIN crawl c ON c.video_id=s.video_id
      WHERE s.status='stored' AND (c.video_id IS NULL
        OR (c.ok=1 AND c.crawled_at<=?) OR (c.ok=0 AND c.crawled_at<=?))
      ORDER BY (c.video_id IS NOT NULL), c.crawled_at, s.stored_at, s.rowid LIMIT ?`)
      .all(now - CRAWL_OK_MS, now - CRAWL_FAIL_MS, limit).map((r) => r.video_id);
  }

  markCrawl(videoId, ok, error = null, now = Date.now()) {
    this.#sql(`INSERT INTO crawl(video_id,crawled_at,ok,error,up_next,related) VALUES(?,?,?,?,0,0)
      ON CONFLICT(video_id) DO UPDATE SET crawled_at=excluded.crawled_at, ok=excluded.ok,
        error=excluded.error`).run(videoId, now, ok ? 1 : 0, ok || error == null ? null : String(error));
  }

  #upsertTrack(t, now) {
    this.#sql(`INSERT INTO tracks(video_id,title,artists_json,album,album_id,year,duration_s,first_seen,last_seen)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET title=COALESCE(excluded.title,title),
        artists_json=COALESCE(excluded.artists_json,artists_json), album=COALESCE(excluded.album,album),
        album_id=COALESCE(excluded.album_id,album_id), year=COALESCE(excluded.year,year),
        duration_s=COALESCE(excluded.duration_s,duration_s), last_seen=excluded.last_seen`)
      .run(t.videoId, t.title ?? null, t.artists?.length ? json(t.artists) : null, t.album?.name ?? null,
        t.album?.id ?? null, t.year ?? null, t.durationS ?? null, now, now);
    for (const [i, a] of (t.artists ?? []).entries()) {
      if (!a?.id) continue;
      this.#upsertArtist(a, now);
      this.#sql("INSERT OR REPLACE INTO song_artists(video_id,artist_id,position) VALUES(?,?,?)")
        .run(t.videoId, a.id, i);
    }
  }

  #upsertArtist(a, now) {
    this.#sql(`INSERT INTO artists(id,name,subscribers,first_seen,last_seen) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name,name),
        subscribers=COALESCE(excluded.subscribers,subscribers), last_seen=excluded.last_seen`)
      .run(a.id, a.name ?? null, a.subscribers ?? null, now, now);
  }

  // Store one crawl result atomically.
  saveGraph(videoId, { upNext = [], related = [], similarArtists = [], albums = [], description = null } = {}, now = Date.now()) {
    this.#tx(() => {
      this.#sql("DELETE FROM related WHERE video_id=? AND kind IN ('next','related')").run(videoId);
      const edge = (kind, list) => {
        for (const [i, s] of list.entries()) {
          this.#upsertTrack(s, now);
          this.#sql("INSERT OR REPLACE INTO related(video_id,related_id,kind,rank) VALUES(?,?,?,?)")
            .run(videoId, s.videoId, kind, s.rank ?? i);
        }
      };
      edge("next", upNext);
      edge("related", related);
      // Main artist: the song's own UC channel, else the first up-next artist.
      const row = this.#sql("SELECT yt_channel_id, artists_json FROM songs WHERE video_id=?").get(videoId);
      let main = row?.yt_channel_id?.startsWith("UC") ? row.yt_channel_id : null;
      if (!main) main = parse(row?.artists_json, []).find((a) => a?.id?.startsWith?.("UC"))?.id ?? null;
      if (!main) main = this.#sql("SELECT artist_id FROM song_artists WHERE video_id=? ORDER BY position LIMIT 1")
        .get(videoId)?.artist_id ?? null;
      if (main) {
        this.#upsertArtist({ id: main, name: null }, now);
        this.#sql("INSERT OR IGNORE INTO song_artists(video_id,artist_id,position) VALUES(?,?,0)").run(videoId, main);
        for (const [i, a] of similarArtists.entries()) {
          if (!a?.id || a.id === main) continue;
          this.#upsertArtist(a, now);
          this.#sql("INSERT OR REPLACE INTO artist_related(artist_id,related_id,rank,seen_at) VALUES(?,?,?,?)")
            .run(main, a.id, a.rank ?? i, now);
        }
        for (const al of albums) {
          if (!al?.id) continue;
          this.#sql(`INSERT INTO albums(id,title,kind,year,artist_id) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title,title), kind=COALESCE(excluded.kind,kind),
              year=COALESCE(excluded.year,year), artist_id=COALESCE(artist_id,excluded.artist_id)`)
            .run(al.id, al.title ?? null, al.kind ?? null, al.year ?? null, main);
        }
        if (description) this.#sql("UPDATE artists SET description=? WHERE id=?").run(description, main);
      }
      this.#sql(`INSERT INTO crawl(video_id,crawled_at,ok,error,up_next,related) VALUES(?,?,1,NULL,?,?)
        ON CONFLICT(video_id) DO UPDATE SET crawled_at=excluded.crawled_at, ok=1, error=NULL,
          up_next=excluded.up_next, related=excluded.related`).run(videoId, now, upNext.length, related.length);
    });
  }

  graphStats() {
    const n = (t, ...a) => this.#sql(t).get(...a).n;
    return {
      crawled: n("SELECT COUNT(*) n FROM crawl WHERE ok=1"),
      failed: n("SELECT COUNT(*) n FROM crawl WHERE ok=0"),
      pending: n(`SELECT COUNT(*) n FROM songs s LEFT JOIN crawl c ON c.video_id=s.video_id
        WHERE s.status='stored' AND c.video_id IS NULL`),
      edges: {
        next: n("SELECT COUNT(*) n FROM related WHERE kind='next'"),
        related: n("SELECT COUNT(*) n FROM related WHERE kind='related'"),
      },
      tracks: n("SELECT COUNT(*) n FROM tracks"),
      artists: n("SELECT COUNT(*) n FROM artists"),
      artistLinks: n("SELECT COUNT(*) n FROM artist_related"),
      albums: n("SELECT COUNT(*) n FROM albums"),
    };
  }

  neighbors(videoId, limit = 20) {
    const edges = (kind) => this.#sql(`SELECT r.related_id id, r.rank, t.title tt, t.artists_json ta,
        s.title st, s.artists_json sa, s.status FROM related r
        LEFT JOIN tracks t ON t.video_id=r.related_id LEFT JOIN songs s ON s.video_id=r.related_id
        WHERE r.video_id=? AND r.kind=? ORDER BY r.rank LIMIT ?`).all(videoId, kind, limit).map((r) => ({
        videoId: r.id, title: r.tt ?? r.st ?? null, artists: parse(r.ta ?? r.sa, []),
        rank: r.rank, archived: r.status === "stored",
      }));
    return {
      next: edges("next"),
      related: edges("related"),
      artists: this.#sql(`SELECT a.id, a.name FROM song_artists sa JOIN artists a ON a.id=sa.artist_id
        WHERE sa.video_id=? ORDER BY sa.position`).all(videoId).map((r) => ({ id: r.id, name: r.name })),
      similarArtists: this.#sql(`SELECT a.id, a.name, a.subscribers FROM song_artists sa
        JOIN artist_related ar ON ar.artist_id=sa.artist_id JOIN artists a ON a.id=ar.related_id
        WHERE sa.video_id=? ORDER BY sa.position, ar.rank LIMIT ?`).all(videoId, limit)
        .map((r) => ({ id: r.id, name: r.name, subscribers: r.subscribers })),
    };
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
    // Stored songs per source kind (all time, like totals); unrecognised -> unknown.
    const byKind = kindCounts();
    for (const r of q(`SELECT source_kind k, COUNT(*) n FROM songs WHERE status='stored' GROUP BY k`)) {
      byKind[Object.hasOwn(byKind, r.k) ? r.k : "unknown"] += r.n;
    }
    // Stored songs grouped by codec + bitrate, collapsed to a short label.
    const qual = new Map();
    for (const r of q(`SELECT codec, bitrate_kbps kbps, COUNT(*) n FROM songs WHERE status='stored'
      GROUP BY codec, bitrate_kbps`)) {
      const label = qualityLabel(r.codec, r.kbps);
      qual.set(label, (qual.get(label) ?? 0) + r.n);
    }
    const byQuality = [...qual].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    // Plays in range by the song's source kind.
    const kindPlays = kindCounts();
    for (const r of q(`SELECT s.source_kind k, COUNT(*) n FROM plays p
      LEFT JOIN songs s ON s.video_id=p.video_id WHERE p.at>=? AND p.at<=? GROUP BY k`, dayStart, now)) {
      kindPlays[Object.hasOwn(kindPlays, r.k) ? r.k : "unknown"] += r.n;
    }
    const ctxPlays = q(`SELECT ctx, COUNT(*) plays FROM plays WHERE at>=? AND at<=? AND ctx IS NOT NULL
      GROUP BY ctx ORDER BY plays DESC, ctx`, dayStart, now).map((r) => ({ ctx: r.ctx, plays: r.plays }));
    const backup = this.#sql(`SELECT COALESCE(SUM(backup_msg_id IS NOT NULL),0) done,
      COALESCE(SUM(backup_msg_id IS NULL),0) pending FROM songs WHERE status='stored' AND tg_msg_id IS NOT NULL`).get();
    const jq = (s) => this.#sql("SELECT COUNT(*) n FROM jobs WHERE state=?").get(s).n;
    return {
      totals: {
        stored: cnt("stored"), pending: cnt("pending"), failed: cnt("failed"),
        unavailable: cnt("unavailable"), bytes: sum.bytes, durationS: sum.dur,
      },
      byDay,
      byServer: [...srv.values()].sort((a, b) => b.plays - a.plays || a.server.localeCompare(b.server)),
      sources,
      byKind,
      byQuality,
      kindPlays,
      backup: { done: backup.done, pending: backup.pending },
      ctxPlays,
      queue: { queued: jq("queued"), running: jq("running"), failed: jq("failed") },
      recent: q(`SELECT * FROM songs WHERE status='stored' ORDER BY stored_at DESC, rowid DESC LIMIT 20`)
        .map((r) => ({
          videoId: r.video_id, title: r.title, artist: r.artist, durationS: r.duration_s,
          size: r.tg_size, storedAt: r.stored_at, server: r.source_server, plays: r.plays,
          sourceKind: r.source_kind ?? null, quality: r.quality_label ?? null,
        })),
      top: q(`SELECT p.video_id, s.title, s.artist, s.source_kind, COUNT(*) n FROM plays p
        LEFT JOIN songs s ON s.video_id=p.video_id WHERE p.at>=? AND p.at<=?
        GROUP BY p.video_id ORDER BY n DESC, p.video_id LIMIT 20`, dayStart, now)
        .map((r) => ({
          videoId: r.video_id, title: r.title, artist: r.artist, plays: r.n,
          sourceKind: r.source_kind ?? null,
        })),
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
