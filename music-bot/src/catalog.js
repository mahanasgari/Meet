// Catalog of songs archived in the private Telegram channel, the shared
// download-job queue and play events. Home server only; peers use HTTP.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { similarity, splitUploadTitle } from "./song_meta.js";
import { dirname } from "node:path";
import { normSearch, cleanTag } from "./search_text.js";
import { MoodModel, MOOD_FELT, FELT_TAG } from "./mood_model.js";

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 864e5;
const LEASE_MS = 15 * MIN;
const EXCLUDE_MS = 24 * HOUR;
const REFUSED_RESET_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 6;
const BACKOFF = [2 * MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR];
const SOURCES = ["disk", "telegram", "youtube", "peer"];
const KINDS = ["ytm_track", "ytm_video", "youtube"];

// Ordered migrations; index + 1 is the schema version.
const ANALYSIS_LEASE_MS = 30 * 60_000;
const ANALYSIS_MAX_S = 15 * 60;

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
  // v5: official audio tracks (YouTube Music "art tracks") map to the
  // song's real music video, which has a different video id.
  `CREATE TABLE video_map (
    video_id TEXT PRIMARY KEY, src_id TEXT, title TEXT, checked_at INTEGER NOT NULL
  );`,
  // v6: copies in any number of backup channels.
  `CREATE TABLE backups (
    kind TEXT NOT NULL, video_id TEXT NOT NULL, channel TEXT NOT NULL, msg_id INTEGER, at INTEGER,
    PRIMARY KEY (kind, video_id, channel)
  );`,
  // v7: music videos reported as wrong for a song (never picked again).
  `ALTER TABLE video_map ADD COLUMN rejected_json TEXT;`,
  // v8: lyrics one listener found, shared with everyone (the app's own JSON).
  `CREATE TABLE IF NOT EXISTS lyrics (
    video_id TEXT PRIMARY KEY, body TEXT, sig TEXT, picked INTEGER NOT NULL DEFAULT 0,
    rejected_json TEXT, updated_at INTEGER NOT NULL
  );`,
  // v9: artist pages fetched (the artist crawler): when, ok, songs found.
  `ALTER TABLE artists ADD COLUMN page_at INTEGER;
  ALTER TABLE artists ADD COLUMN page_ok INTEGER;
  ALTER TABLE artists ADD COLUMN page_songs INTEGER;
  CREATE INDEX artists_page ON artists(page_at);`,
  // v10: the artist crawl's songs wait last, most popular first (weight).
  `ALTER TABLE jobs ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX jobs_crawl ON jobs(reason, state, weight);`,
  // v11: Spotify metadata per song (spotify_id NULL = looked, no match).
  `CREATE TABLE spotify_tracks (
    video_id TEXT PRIMARY KEY, spotify_id TEXT, isrc TEXT, popularity INTEGER, explicit INTEGER,
    release_date TEXT, album_id TEXT, album_name TEXT, album_type TEXT, track_number INTEGER,
    score REAL, checked_at INTEGER
  );
  CREATE TABLE spotify_artists (
    spotify_id TEXT PRIMARY KEY, name TEXT, genres_json TEXT, popularity INTEGER,
    followers INTEGER, fetched_at INTEGER
  );
  CREATE TABLE spotify_track_artists (
    video_id TEXT, spotify_artist_id TEXT, position INTEGER,
    PRIMARY KEY (video_id, spotify_artist_id)
  );
  CREATE INDEX spotify_tracks_id ON spotify_tracks(spotify_id);
  CREATE INDEX spotify_tracks_isrc ON spotify_tracks(isrc);`,
  // v12: Deezer + iTunes info per song (NULL ids = looked, no match).
  `CREATE TABLE song_info (
    video_id TEXT PRIMARY KEY, deezer_id INTEGER, isrc TEXT, rank INTEGER, bpm REAL,
    release_date TEXT, genre TEXT, album TEXT, itunes_id INTEGER,
    deezer_score REAL, itunes_score REAL, checked_at INTEGER
  );
  CREATE INDEX song_info_isrc ON song_info(isrc);`,
  // v13: picking the next download must not walk the crawl's ~800k jobs.
  `CREATE INDEX IF NOT EXISTS jobs_queued_main ON jobs(next_at) WHERE state='queued' AND reason IS NOT 'crawl';`,
  // v14: Last.fm per song (listeners NULL = looked, not found), similar songs/artists.
  `CREATE TABLE lastfm_tracks (video_id TEXT PRIMARY KEY, mbid TEXT, listeners INTEGER, playcount INTEGER,
    tags_json TEXT, lf_artist TEXT, lf_title TEXT, checked_at INTEGER);
  CREATE TABLE lastfm_similar (video_id TEXT NOT NULL, similar_id TEXT NOT NULL, match REAL,
    PRIMARY KEY (video_id, similar_id));
  CREATE INDEX lastfm_similar_rev ON lastfm_similar(similar_id);
  CREATE TABLE lastfm_similar_names (video_id TEXT NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL, match REAL,
    PRIMARY KEY (video_id, artist, title));
  CREATE TABLE lastfm_artists (artist_id TEXT PRIMARY KEY, mbid TEXT, listeners INTEGER, playcount INTEGER,
    tags_json TEXT, checked_at INTEGER);
  CREATE TABLE lastfm_artist_similar (artist_id TEXT NOT NULL, similar_id TEXT NOT NULL, match REAL,
    PRIMARY KEY (artist_id, similar_id));
  CREATE INDEX IF NOT EXISTS artists_name_nocase ON artists(name COLLATE NOCASE);`,
  // v15: MusicBrainz + ListenBrainz (mbid NULL = looked, no match), artist aliases for search.
  `CREATE TABLE mb_recordings (video_id TEXT PRIMARY KEY, mbid TEXT, artist_mbids_json TEXT, title TEXT,
    first_release TEXT, length_ms INTEGER, isrcs_json TEXT, score INTEGER,
    lb_listens INTEGER, lb_users INTEGER, lb_checked_at INTEGER, checked_at INTEGER);
  CREATE INDEX mb_recordings_mbid ON mb_recordings(mbid);
  CREATE INDEX mb_recordings_lb ON mb_recordings(checked_at) WHERE mbid IS NOT NULL AND lb_checked_at IS NULL;
  CREATE TABLE mb_artists (artist_id TEXT PRIMARY KEY, mbid TEXT, name TEXT, sort_name TEXT, type TEXT, country TEXT,
    begin TEXT, end TEXT, aliases_json TEXT, genres_json TEXT, checked_at INTEGER);
  CREATE INDEX mb_artists_mbid ON mb_artists(mbid);
  CREATE TABLE mb_aliases (alias_norm TEXT NOT NULL, artist_id TEXT NOT NULL, alias TEXT, locale TEXT,
    PRIMARY KEY (alias_norm, artist_id));
  CREATE TABLE lb_similar (video_id TEXT NOT NULL, similar_id TEXT NOT NULL, score REAL, PRIMARY KEY (video_id, similar_id));
  CREATE INDEX lb_similar_rev ON lb_similar(similar_id);
  CREATE TABLE lb_artist_similar (artist_id TEXT NOT NULL, similar_id TEXT NOT NULL, score REAL, PRIMARY KEY (artist_id, similar_id));
  CREATE INDEX lb_artist_similar_rev ON lb_artist_similar(similar_id);
  CREATE INDEX IF NOT EXISTS lastfm_artist_similar_rev ON lastfm_artist_similar(similar_id);`,
  // v16: audio analysis by the analyzer containers (BPM, key, mood, genres); lease_until = job handed out.
  `CREATE TABLE song_analysis (video_id TEXT PRIMARY KEY, bpm REAL, key TEXT, scale TEXT, key_strength REAL,
    loudness REAL, energy REAL, danceability REAL, happy REAL, sad REAL, relaxed REAL, aggressive REAL, party REAL,
    acoustic REAL, electronic REAL, instrumental REAL, valence REAL, arousal REAL, genres_json TEXT,
    model TEXT, server TEXT, lease_until INTEGER, analyzed_at INTEGER, error TEXT);
  CREATE INDEX song_analysis_lease ON song_analysis(lease_until) WHERE analyzed_at IS NULL;`,
  // v17: Discogs, Odesli links, tags per song. Empty tables only (no backfill here: background tickers fill them).
  // search_fts is created outside the migrations (see #initFts) because its tokenizer depends on the SQLite build.
  `CREATE TABLE discogs_releases (video_id TEXT PRIMARY KEY, release_id INTEGER, master_id INTEGER, year INTEGER,
    genres_json TEXT, styles_json TEXT, country TEXT, label TEXT, checked_at INTEGER);
  CREATE TABLE discogs_artists (artist_id TEXT PRIMARY KEY, discogs_id INTEGER, profile TEXT, checked_at INTEGER);
  CREATE TABLE song_links_ext (video_id TEXT PRIMARY KEY, page_url TEXT, links_json TEXT, fetched_at INTEGER);
  CREATE TABLE song_tags (tag TEXT NOT NULL, video_id TEXT NOT NULL, weight REAL, src TEXT,
    PRIMARY KEY (tag, video_id));
  CREATE INDEX song_tags_video ON song_tags(video_id);
  CREATE INDEX song_tags_tag_w ON song_tags(tag, weight DESC);`,
  // v18: the recommender looks up songs by artist name and plays by listener;
  // without these each lookup read all ~840k songs (up to 30 s, server frozen).
  `CREATE INDEX IF NOT EXISTS songs_artist ON songs(artist);
  CREATE INDEX IF NOT EXISTS plays_uid ON plays(uid, at);`,
  // v19: the dashboard's "failed downloads" list walked all ~834k jobs.
  `CREATE INDEX IF NOT EXISTS jobs_problems ON jobs(updated_at) WHERE state='failed' OR (state='queued' AND attempts>0);`,
  // v20: the artist crawl's next pick sorted every not-yet-fetched artist.
  `CREATE INDEX IF NOT EXISTS artists_page_todo ON artists(first_seen) WHERE page_at IS NULL;`,
  // v21: /mood/songs filters song_analysis by one mood probability (partial = only usable rows).
  ["happy", "sad", "relaxed", "aggressive", "party", "danceability", "energy"].map((c) =>
    `CREATE INDEX IF NOT EXISTS song_analysis_${c} ON song_analysis(${c}) WHERE analyzed_at IS NOT NULL AND error IS NULL;`).join("\n  "),
  // v22: listeners' own answer to "how does this song feel" (one per user and song).
  `CREATE TABLE mood_votes (video_id TEXT NOT NULL, uid TEXT NOT NULL, mood TEXT NOT NULL, at INTEGER, PRIMARY KEY (video_id, uid));
  CREATE INDEX mood_votes_video ON mood_votes(video_id);`
];
export const MOOD_COLUMNS = { happy: "happy", sad: "sad", relaxed: "relaxed", aggressive: "aggressive", party: "party", dance: "danceability", energy: "energy" };
const VIDEO_LEASE_MS = 10 * MIN;
const VIDEO_RETRY_MS = HOUR;
const CTX_RE = /^[a-z_]{1,20}$/;
const CRAWL_OK_MS = 30 * DAY;
const CRAWL_FAIL_MS = DAY;

import { normTitle } from "./lastfm.js";
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

const LYRICS_SYNC = ["none", "line", "word"];
const LYRICS_MAX_BYTES = 400_000;

/**
 * The app's lyrics JSON ({source, sync, score?, lines: [...]}) checked and
 * re-serialised, or null when it isn't one.
 */
export function cleanLyrics(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { source, sync, score, lines } = body;
  if (typeof source !== "string" || !/^[A-Za-z0-9 ._-]{1,40}$/.test(source)) return null;
  if (!LYRICS_SYNC.includes(sync)) return null;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 3000) return null;
  if (!lines.every((l) => l && typeof l === "object" && !Array.isArray(l))) return null;
  const out = { source, sync, ...(typeof score === "number" && score >= 0 && score <= 1 ? { score } : {}), lines };
  const text = JSON.stringify(out);
  return Buffer.byteLength(text) <= LYRICS_MAX_BYTES ? text : null;
}

/** Identity of a set of lyrics: source + the words (timings ignored). */
function lyricsSig(text) {
  const { source, lines } = JSON.parse(text);
  const words = lines.map((l) => String(l.x ?? l.text ?? "")).join("\n");
  return `${source}|${createHash("sha1").update(words).digest("hex").slice(0, 16)}`;
}

const JOB_ORDER = ["play", "retry", "next", "interest", "prefetch", "crawl"];
/** SQL rank of a job's reason (lower runs first). */
const JOB_PRIORITY = `CASE reason ${JOB_ORDER.map((r, i) => `WHEN '${r}' THEN ${i >= 1 ? i - 1 : 0}`).join(" ")} ELSE 9 END`;
const jobPriority = (reason) => Math.max(0, JOB_ORDER.indexOf(reason) - 1);

const OTHER_VERSION_RE = /\b(live|unplugged|acoustic|remix|cover|karaoke|teaser|trailer|behind the scenes)\b|لایو|آنپلاگد|ریمیکس|کاور|تیزر/i;

const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 300;

/**
 * node:sqlite is synchronous: a slow statement freezes the whole server. Log
 * every statement slower than SLOW_QUERY_MS with its SQL, so the culprit is
 * named in the logs instead of guessed.
 */
function watchSlowQueries(db) {
  const slow = (sql, ms) => console.error(`[slow-sql] ${Math.round(ms)} ms ${String(sql).replace(/\s+/g, " ").slice(0, 160)}`);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prepare(sql);
    for (const m of ["all", "get", "run"]) {
      const f = st[m].bind(st);
      st[m] = (...a) => {
        const t = performance.now();
        try { return f(...a); } finally {
          const ms = performance.now() - t;
          if (ms > SLOW_QUERY_MS) slow(sql, ms);
        }
      };
    }
    return st;
  };
  const exec = db.exec.bind(db);
  db.exec = (sql) => {
    const t = performance.now();
    try { return exec(sql); } finally {
      const ms = performance.now() - t;
      if (ms > SLOW_QUERY_MS) slow(sql, ms);
    }
  };
}

/**
 * A song's artists for cards: the tracks table's [{name, id}] first (YouTube
 * Music, with channel ids); archived songs keep plain names ["A", "B"] from
 * yt-dlp. Unnamed and repeated entries are dropped.
 */
function cardArtists(tracksJson, songsJson) {
  const out = [];
  const seen = new Set();
  for (const src of [tracksJson, songsJson]) {
    for (const a of parse(src, [])) {
      const name = typeof a === "string" ? a : a?.name;
      const key = String(name ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: typeof a === "object" ? a?.id ?? null : null, name: String(name).trim() });
    }
    if (out.length) break;
  }
  return out.slice(0, 6);
}

export class Catalog {
  /**
   * Artists with at least [min] plays since [since], most played first.
   * Small pieces with pauses between them: as one join this froze the server
   * for 30-80 s every hour on a cold cache, and audio streams on this thread.
   */
  async topPlayedArtists(since, { min = 3, limit = 40, chunk = 100, pauseMs = 50 } = {}) {
    const songs = this.#sql("SELECT video_id id, COUNT(*) n FROM plays WHERE at > ? GROUP BY video_id").all(since);
    const counts = new Map();
    for (let i = 0; i < songs.length; i += chunk) {
      const part = songs.slice(i, i + chunk);
      const plays = new Map(part.map((s) => [s.id, s.n]));
      const marks = part.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT video_id, artist_id FROM song_artists WHERE video_id IN (${marks})`).all(...part.map((s) => s.id));
      for (const r of rows) counts.set(r.artist_id, (counts.get(r.artist_id) ?? 0) + plays.get(r.video_id));
      if (i + chunk < songs.length) await new Promise((done) => setTimeout(done, pauseMs));
    }
    return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, n]) => ({ id, n }));
  }

  /** ftsTokenizer: override (tests) e.g. "unicode61 remove_diacritics 2" to force the fallback. */
  constructor(file, { ftsTokenizer, readOnly = false } = {}) {
    if (readOnly) {
      // A second, read-only connection (stats worker): no migrations, no writes.
      this.db = new DatabaseSync(file, { readOnly: true });
      const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='search_fts'").get();
      this.ftsMode = fts ? (/trigram/i.test(fts.sql) ? "trigram" : "unicode61") : null;
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // synchronous=NORMAL: in WAL mode a commit no longer waits for a disk sync
    // (only checkpoints do). On home's slow disk those syncs froze the whole
    // server for ~30 s, cutting audio. A power cut can lose the last commits,
    // never corrupt the database.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    watchSlowQueries(this.db);
    this.#migrate();
    this.#initFts(ftsTokenizer);
  }

  /** "trigram", "unicode61" or null (no fts5). Chosen at runtime, remembered by the table's own SQL. */
  ftsMode = null;
  #ftsDone = false;

  #initFts(want) {
    const db = this.db;
    const exists = db.prepare("SELECT sql FROM sqlite_master WHERE name='search_fts'").get();
    const mode = (sql) => (/trigram/i.test(sql) ? "trigram" : "unicode61");
    if (exists) { this.ftsMode = mode(exists.sql); return; }
    const tries = want ? [want] : ["trigram", "unicode61 remove_diacritics 2"];
    if (!want || want === "trigram") tries.push("unicode61 remove_diacritics 2");
    for (const tok of tries) {
      try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(video_id UNINDEXED, title, artists, tokenize='${tok}')`);
        this.ftsMode = mode(tok);
        return;
      } catch { /* try the next tokenizer */ }
    }
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
  #cursor = {}; // per enricher: last tracks rowid handed out
  #cursorIdle = {};
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

  /** Which of [videoIds] are stored in the channel (at most 200 asked). */
  archivedIds(videoIds) {
    const ids = [...new Set(videoIds)].filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)).slice(0, 200);
    if (!ids.length) return [];
    return this.#sql(`SELECT video_id FROM songs WHERE status='stored' AND video_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids)
      .map((r) => r.video_id);
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

  // Artists a server's country refuses (Germany and much Persian music): after
  // two refusals that server stops getting the artist's background songs, which
  // otherwise use up its hour asking YouTube for songs it can't have. In memory,
  // forgotten daily (and on restart), so an artist gets another chance.
  #refused = new Map(); // server -> Map(artistId -> count)
  #refusedSince = 0;

  #noteRefused(server, videoId, now) {
    if (now - this.#refusedSince > REFUSED_RESET_MS) {
      this.#refused.clear();
      this.#refusedSince = now;
    }
    const a = this.firstArtistId(videoId);
    if (!a) return;
    let m = this.#refused.get(server);
    if (!m) this.#refused.set(server, (m = new Map()));
    if (m.size < 50_000) m.set(a, (m.get(a) || 0) + 1);
  }

  #refusedFor(server, videoId) {
    const m = this.#refused.get(server);
    if (!m?.size) return false;
    const a = this.firstArtistId(videoId);
    return !!a && (m.get(a) || 0) >= 2;
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

  failed(videoId, server, error, { blocked = false, unavailable = false, refused = false } = {}, now = Date.now()) {
    if (refused && server) this.#noteRefused(server, videoId, now);
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

  /**
   * Claim up to [limit] queued downloads. Plays and retries first, then
   * songs about to play ("next"), then what listeners opened ("interest",
   * newest first: the freshest intent), then background prefetch.
   * [urgentOnly] skips interest and prefetch (the hourly budget is nearly
   * used up and up-next songs need the room).
   */
  nextJobs(server, limit = 2, now = Date.now(), { urgentOnly = false } = {}) {
    return this.#tx(() => {
      this.#reap(now);
      // The artist crawl's songs (hundreds of thousands) are looked at only
      // when nothing else waits, through their own index.
      const rows = this.#sql(`SELECT * FROM jobs INDEXED BY jobs_queued_main
        WHERE state='queued' AND next_at<=? AND reason IS NOT 'crawl'
        ${urgentOnly ? "AND reason IN ('play','retry','next')" : ""}
        ORDER BY ${JOB_PRIORITY},
          CASE WHEN reason IN ('next','interest') THEN -created_at ELSE created_at END, rowid`).all(now);
      const picked = [];
      const take = (job) => {
        if (picked.length >= limit || this.#blocked(job, now).includes(server)) return;
        if ((job.reason === "crawl" || job.reason === "prefetch") && this.#refusedFor(server, job.video_id)) return;
        this.#sql(`UPDATE jobs SET state='running', server=?, lease_until=?, updated_at=? WHERE video_id=?`)
          .run(server, now + LEASE_MS, now, job.video_id);
        picked.push(job.video_id);
      };
      for (const job of rows) take(job);
      if (picked.length < limit && !urgentOnly) {
        // Straight down the (reason, state, weight) index: stops after a few rows.
        const crawl = this.#sql(`SELECT * FROM jobs INDEXED BY jobs_crawl
          WHERE reason='crawl' AND state='queued' AND next_at<=?
          ORDER BY weight DESC LIMIT ?`).all(now, (limit - picked.length) * 10 + 20);
        for (const job of crawl) take(job);
      }
      return picked;
    });
  }

  /** [weights]: video id → weight (crawl jobs: higher goes first). */
  enqueue(videoIds, reason = "prefetch", now = Date.now(), weights = null) {
    return this.#tx(() => {
      let n = 0;
      for (const id of new Set(videoIds)) {
        if (this.lookup(id)) {
          // Already waiting with a lower priority: move it up, as fresh.
          const r = this.#sql(`UPDATE jobs SET reason=?, created_at=?, updated_at=?
            WHERE video_id=? AND state='queued' AND ${JOB_PRIORITY} > ${jobPriority(reason)}`)
            .run(reason, now, now, id);
          n += Number(r.changes);
          continue;
        }
        this.#ensureSong(id, now);
        this.#sql(`INSERT INTO jobs(video_id,state,reason,created_at,updated_at,weight)
          VALUES(?, 'queued', ?, ?, ?, ?)`).run(id, reason, now, now, Math.round(weights?.get?.(id) ?? 0));
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

  /**
   * Stored songs archived after [since] (stored_at, ms), oldest first. Mirrors
   * keep their own copy, so a song starts without asking home (whose disk can
   * hang for 30 s).
   */
  storedSince(since = 0, limit = 5000) {
    return this.#sql(`SELECT video_id, tg_msg_id, tg_size, stored_at FROM songs INDEXED BY songs_stored_at
      WHERE stored_at > ? AND status='stored' AND tg_msg_id IS NOT NULL ORDER BY stored_at LIMIT ?`)
      .all(since, limit)
      .map((r) => ({ id: r.video_id, msgId: r.tg_msg_id, size: r.tg_size, at: r.stored_at }));
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

  /** Archived songs/videos not yet copied to [channel]: [{kind, videoId, msgId}]. */
  needsBackupIn(channel, limit = 5) {
    const ch = String(channel);
    const songs = this.#sql(`SELECT 'song' kind, video_id, tg_msg_id FROM songs s WHERE status='stored' AND tg_msg_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.kind='song' AND b.video_id=s.video_id AND b.channel=?)
      ORDER BY stored_at, rowid LIMIT ?`).all(ch, limit);
    const vids = this.#sql(`SELECT 'video' kind, video_id, tg_msg_id FROM videos v WHERE status='stored' AND tg_msg_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.kind='video' AND b.video_id=v.video_id AND b.channel=?)
      ORDER BY stored_at, rowid LIMIT ?`).all(ch, limit);
    return [...songs, ...vids].slice(0, limit).map((r) => ({ kind: r.kind, videoId: r.video_id, msgId: r.tg_msg_id }));
  }

  markBackupIn(kind, videoId, channel, msgId, now = Date.now()) {
    this.#sql(`INSERT OR REPLACE INTO backups(kind, video_id, channel, msg_id, at) VALUES(?,?,?,?,?)`)
      .run(kind, videoId, String(channel), msgId, now);
  }

  /** Per channel: {channel, songs, videos} copied, plus totals to copy. */
  backupStats(channels) {
    const songs = this.#sql("SELECT COUNT(*) n FROM songs WHERE status='stored' AND tg_msg_id IS NOT NULL").get().n;
    const videos = this.#sql("SELECT COUNT(*) n FROM videos WHERE status='stored' AND tg_msg_id IS NOT NULL").get().n;
    return {
      songs,
      videos,
      channels: channels.map((c) => ({
        channel: String(c),
        songs: this.#sql("SELECT COUNT(*) n FROM backups WHERE kind='song' AND channel=?").get(String(c)).n,
        videos: this.#sql("SELECT COUNT(*) n FROM backups WHERE kind='video' AND channel=?").get(String(c)).n,
      })),
    };
  }

  /** The matched music video for an audio track: {srcId|null, title, checkedAt} or null (never checked). */
  videoMapGet(videoId) {
    const r = this.#sql("SELECT src_id, title, checked_at, rejected_json FROM video_map WHERE video_id=?").get(videoId);
    if (!r) return null;
    let rejected = [];
    try {
      rejected = JSON.parse(r.rejected_json || "[]");
    } catch {
      rejected = [];
    }
    return { srcId: r.src_id, title: r.title, checkedAt: r.checked_at, rejected };
  }

  /** "Wrong video": remember the current pick as rejected and force a fresh match. */
  videoMapReject(videoId, now = Date.now()) {
    const cur = this.videoMapGet(videoId);
    const rejected = [...new Set([...(cur?.rejected || []), ...(cur?.srcId ? [cur.srcId] : [])])].slice(-20);
    this.#sql(`INSERT INTO video_map(video_id, src_id, title, checked_at, rejected_json) VALUES(?, NULL, NULL, 0, ?)
      ON CONFLICT(video_id) DO UPDATE SET src_id=NULL, title=NULL, checked_at=0, rejected_json=excluded.rejected_json`)
      .run(videoId, JSON.stringify(rejected));
    return rejected;
  }

  /** Forget all matches (keeps rejections) so they're redone with a better matcher. */
  videoMapResetMatches() {
    this.#sql("DELETE FROM video_map WHERE rejected_json IS NULL OR rejected_json='[]'").run();
    this.#sql("UPDATE video_map SET src_id=NULL, title=NULL, checked_at=0").run();
  }

  videoMapSet(videoId, srcId, title = null, now = Date.now()) {
    this.#sql(`INSERT INTO video_map(video_id, src_id, title, checked_at) VALUES(?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET src_id=excluded.src_id, title=excluded.title, checked_at=excluded.checked_at`)
      .run(videoId, srcId, title, now);
  }

  /**
   * Official videos from an artist's page → video matches for that artist's
   * songs with the same title. Never overrides an existing match or a
   * rejected video. Returns how many songs got a match.
   */
  matchArtistVideos(artistId, videos, now = Date.now()) {
    if (!videos?.length) return 0;
    const name = this.#sql("SELECT name FROM artists WHERE id=?").get(artistId)?.name || "";
    const songs = this.#sql(`SELECT t.video_id id, t.title FROM song_artists sa JOIN tracks t ON t.video_id=sa.video_id
      WHERE sa.artist_id=?`).all(artistId);
    let n = 0;
    this.#tx(() => {
      for (const v of videos) {
        const want = splitUploadTitle(v.title, name).title;
        // A live / unplugged / remix video isn't the studio song's video.
        const version = OTHER_VERSION_RE.test(v.title);
        let best = null;
        let bestScore = 0.85;
        for (const s of songs) {
          if (version && !OTHER_VERSION_RE.test(s.title || "")) continue;
          const sc = similarity(s.title, want);
          if (sc >= bestScore) [best, bestScore] = [s, sc];
        }
        if (!best || best.id === v.videoId) continue;
        const cur = this.videoMapGet(best.id);
        if (cur?.srcId || cur?.rejected.includes(v.videoId)) continue;
        this.#sql(`INSERT INTO video_map(video_id, src_id, title, checked_at) VALUES(?,?,?,?)
          ON CONFLICT(video_id) DO UPDATE SET src_id=excluded.src_id, title=excluded.title, checked_at=excluded.checked_at`)
          .run(best.id, v.videoId, v.title, now);
        n++;
      }
    });
    return n;
  }

  /** Stored YouTube Music songs with no video match yet, most played first. */
  nextVideoMatches(limit = 100) {
    return this.#sql(`SELECT s.video_id FROM songs s LEFT JOIN plays p ON p.video_id=s.video_id
      WHERE s.status='stored' AND s.source_kind='ytm_track'
        AND NOT EXISTS (SELECT 1 FROM video_map m WHERE m.video_id=s.video_id)
      GROUP BY s.video_id ORDER BY COUNT(p.id) DESC, s.stored_at DESC LIMIT ?`).all(limit).map((r) => r.video_id);
  }

  // --- Shared lyrics ----------------------------------------------------

  /** {lyrics (parsed) | null, picked, updatedAt} or null when nobody has looked yet. */
  lyricsGet(videoId) {
    const r = this.#sql("SELECT body, picked, updated_at FROM lyrics WHERE video_id=?").get(videoId);
    if (!r) return null;
    return { lyrics: parse(r.body), picked: r.picked === 1, updatedAt: r.updated_at };
  }

  /**
   * Keep [body] for the song. A listener's own pick replaces anything; an
   * automatic find only fills an empty slot. Lyrics reported wrong are refused.
   * Returns true when stored.
   */
  lyricsPut(videoId, body, { picked = false } = {}, now = Date.now()) {
    const text = cleanLyrics(body);
    if (!text) return false;
    const sig = lyricsSig(text);
    const cur = this.#sql("SELECT body, picked, rejected_json FROM lyrics WHERE video_id=?").get(videoId);
    if (cur) {
      if (parse(cur.rejected_json, []).includes(sig)) return false;
      if (cur.body && !picked) return false;
    }
    this.#sql(`INSERT INTO lyrics(video_id, body, sig, picked, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET body=excluded.body, sig=excluded.sig, picked=excluded.picked,
        updated_at=excluded.updated_at`)
      .run(videoId, text, sig, picked ? 1 : 0, now);
    return true;
  }

  /**
   * "Wrong lyrics": never take [lyrics] for the song again, and drop the
   * shared copy when it's those. Without [lyrics], the shared copy is meant.
   */
  lyricsReject(videoId, lyrics = null, now = Date.now()) {
    const cur = this.#sql("SELECT sig, rejected_json FROM lyrics WHERE video_id=?").get(videoId);
    const text = lyrics ? cleanLyrics(lyrics) : null;
    const sig = text ? lyricsSig(text) : cur?.sig;
    if (!sig) return;
    const rejected = [...new Set([...parse(cur?.rejected_json, []), sig])].slice(-20);
    if (!cur) {
      this.#sql("INSERT INTO lyrics(video_id, rejected_json, updated_at) VALUES(?,?,?)").run(videoId, JSON.stringify(rejected), now);
    } else if (cur.sig === sig) {
      this.#sql("UPDATE lyrics SET body=NULL, sig=NULL, picked=0, rejected_json=?, updated_at=? WHERE video_id=?")
        .run(JSON.stringify(rejected), now, videoId);
    } else {
      this.#sql("UPDATE lyrics SET rejected_json=? WHERE video_id=?").run(JSON.stringify(rejected), videoId);
    }
  }

  lyricsStats() {
    return { ...this.#sql("SELECT COALESCE(SUM(body IS NOT NULL),0) songs, COALESCE(SUM(picked),0) picked FROM lyrics").get() };
  }

  videoStats() {
    const r = this.#sql(`SELECT
      COALESCE(SUM(status='stored'),0) stored,
      -- A claim leaves a 'failed' placeholder until the download finishes;
      -- only rows with a recorded failure time count as failed.
      COALESCE(SUM(status='failed' AND stored_at IS NOT NULL),0) failed,
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
    const old = this.ftsMode ? this.#sql("SELECT title, artists_json FROM tracks WHERE video_id=?").get(t.videoId) : null;
    this.#sql(`INSERT INTO tracks(video_id,title,artists_json,album,album_id,year,duration_s,first_seen,last_seen)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET title=COALESCE(excluded.title,title),
        artists_json=COALESCE(excluded.artists_json,artists_json), album=COALESCE(excluded.album,album),
        album_id=COALESCE(excluded.album_id,album_id), year=COALESCE(excluded.year,year),
        duration_s=COALESCE(excluded.duration_s,duration_s), last_seen=excluded.last_seen`)
      .run(t.videoId, t.title ?? null, t.artists?.length ? json(t.artists) : null, t.album?.name ?? null,
        t.album?.id ?? null, t.year ?? null, t.durationS ?? null, now, now);
    if (this.ftsMode) {
      const r = this.#sql("SELECT rowid r, title, artists_json FROM tracks WHERE video_id=?").get(t.videoId);
      if (r && (!old || old.title !== r.title || old.artists_json !== r.artists_json)) this.#ftsPut(r.r, t.videoId, r.title, r.artists_json);
    }
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

  // ---- Artist pages (artist_crawl.js) ----

  /** Artists known since before [cutoff] whose page hasn't been fetched. */
  nextArtistPages(limit = 1, cutoff = Date.now()) {
    return this.#sql(`SELECT id FROM artists INDEXED BY artists_page_todo WHERE page_at IS NULL AND first_seen<=?
      ORDER BY first_seen, rowid LIMIT ?`).all(cutoff, limit).map((r) => r.id);
  }

  /** One artist page: its details, songs, albums and similar artists. */
  saveArtistPage(id, { name = null, subscribers = null, description = null, songs = [], albums = [], related = [] } = {}, now = Date.now()) {
    this.#tx(() => {
      this.#upsertArtist({ id, name, subscribers }, now);
      if (description) this.#sql("UPDATE artists SET description=? WHERE id=?").run(description, id);
      for (const t of songs) {
        if (!t?.videoId) continue;
        this.#upsertTrack(t, now);
        // The page's own artist, even when the song credits another channel.
        const at = (t.artists ?? []).findIndex((a) => a?.id === id);
        this.#sql("INSERT OR IGNORE INTO song_artists(video_id,artist_id,position) VALUES(?,?,?)")
          .run(t.videoId, id, at >= 0 ? at : 9);
      }
      for (const al of albums) {
        if (!al?.id) continue;
        this.#sql(`INSERT INTO albums(id,title,kind,year,artist_id) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title,title), kind=COALESCE(excluded.kind,kind),
            year=COALESCE(excluded.year,year), artist_id=COALESCE(artist_id,excluded.artist_id)`)
          .run(al.id, al.title ?? null, al.kind ?? null, al.year ?? null, id);
      }
      for (const [i, a] of related.entries()) {
        if (!a?.id || a.id === id) continue;
        this.#upsertArtist(a, now);
        this.#sql("INSERT OR REPLACE INTO artist_related(artist_id,related_id,rank,seen_at) VALUES(?,?,?,?)")
          .run(id, a.id, a.rank ?? i, now);
      }
      this.#sql("UPDATE artists SET page_at=?, page_ok=1, page_songs=? WHERE id=?").run(now, songs.length, id);
    });
  }

  markArtistPageFailed(id, now = Date.now()) {
    this.#sql("UPDATE artists SET page_at=?, page_ok=0 WHERE id=?").run(now, id);
  }

  artistPageStats(cutoff = Date.now()) {
    const n = (sql, ...a) => this.#sql(sql).get(...a).n;
    return {
      fetched: n("SELECT COUNT(*) n FROM artists WHERE page_ok=1"),
      failed: n("SELECT COUNT(*) n FROM artists WHERE page_ok=0"),
      pending: n("SELECT COUNT(*) n FROM artists WHERE page_at IS NULL AND first_seen<=?", cutoff),
      artists: n("SELECT COUNT(*) n FROM artists"),
      songs: n("SELECT COUNT(*) n FROM tracks"),
    };
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

  /** Tracks not yet looked up on Spotify: archived + most played first, then the rest. */
  // Picks without sorting the whole catalog (the artist crawl makes it
  // hundreds of thousands of songs; a full sort froze the server for a
  // minute): archived songs first, most played first, then the rest in
  // insertion order from where the last pick stopped.
  nextSpotifyTracks(limit) {
    const row = (r) => ({
      videoId: r.video_id, title: r.title,
      artist: parse(r.artists_json, [])[0]?.name ?? null, durationS: r.duration_s,
    });
    const out = this.#sql(`SELECT t.video_id, t.title, t.artists_json, t.duration_s
      FROM songs s JOIN tracks t ON t.video_id = s.video_id
      WHERE s.status = 'stored' AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM spotify_tracks x WHERE x.video_id = t.video_id)
      ORDER BY (SELECT COUNT(*) FROM plays p WHERE p.video_id = s.video_id) DESC
      LIMIT ?`).all(limit).map(row);
    if (out.length >= limit || Date.now() < (this.#cursorIdle.spotify_tracks ?? 0)) return out;
    const seen = new Set(out.map((t) => t.videoId));
    const rest = this.#sql(`SELECT t.rowid r, t.video_id, t.title, t.artists_json, t.duration_s
      FROM tracks t
      WHERE t.rowid > ? AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM spotify_tracks x WHERE x.video_id = t.video_id)
      ORDER BY t.rowid LIMIT ?`).all(this.#cursor.spotify_tracks ?? 0, limit - out.length);
    if (rest.length) this.#cursor.spotify_tracks = rest.at(-1).r;
    else {
      // Reached the end: start over later, for songs added since.
      this.#cursor.spotify_tracks = 0;
      this.#cursorIdle.spotify_tracks = Date.now() + 30 * 60_000;
    }
    for (const r of rest) if (!seen.has(r.video_id)) out.push(row(r));
    return out;
  }


  /** [match]: null = looked, nothing found (not looked up again). */
  saveSpotifyTrack(videoId, match, now = Date.now()) {
    this.#tx(() => {
      if (!match) {
        this.#sql("INSERT OR REPLACE INTO spotify_tracks(video_id, checked_at) VALUES(?, ?)").run(videoId, now);
        return;
      }
      this.#sql(`INSERT OR REPLACE INTO spotify_tracks(video_id, spotify_id, isrc, popularity, explicit,
        release_date, album_id, album_name, album_type, track_number, score, checked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        videoId, match.id, match.isrc ?? null, match.popularity ?? null, match.explicit ? 1 : 0,
        match.releaseDate ?? null, match.albumId ?? null, match.albumName ?? null,
        match.albumType ?? null, match.trackNumber ?? null, match.score ?? null, now);
      (match.artists ?? []).forEach((a, i) => {
        this.#sql("INSERT OR IGNORE INTO spotify_artists(spotify_id, name) VALUES(?, ?)").run(a.id, a.name ?? null);
        this.#sql("INSERT OR REPLACE INTO spotify_track_artists(video_id, spotify_artist_id, position) VALUES(?,?,?)").run(videoId, a.id, i);
      });
    });
  }

  spotifyArtistsToFetch(limit) {
    return this.#sql("SELECT spotify_id FROM spotify_artists WHERE fetched_at IS NULL LIMIT ?").all(limit).map((r) => r.spotify_id);
  }

  saveSpotifyArtists(list, now = Date.now()) {
    this.#tx(() => {
      for (const a of list) {
        this.#sql(`INSERT INTO spotify_artists(spotify_id, name, genres_json, popularity, followers, fetched_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(spotify_id) DO UPDATE SET
          name=COALESCE(excluded.name, name), genres_json=excluded.genres_json,
          popularity=excluded.popularity, followers=excluded.followers, fetched_at=excluded.fetched_at`)
          .run(a.id, a.name ?? null, JSON.stringify(a.genres ?? []), a.popularity ?? null, a.followers ?? null, now);
      }
    });
  }

  spotifyStats() {
    const n = (q) => this.#sql(q).get().n;
    return {
      checked: n("SELECT COUNT(*) n FROM spotify_tracks"),
      matched: n("SELECT COUNT(*) n FROM spotify_tracks WHERE spotify_id IS NOT NULL"),
      artists: n("SELECT COUNT(*) n FROM spotify_artists"),
      artistsFetched: n("SELECT COUNT(*) n FROM spotify_artists WHERE fetched_at IS NOT NULL"),
    };
  }

  /** Tracks without Deezer/iTunes info yet: archived + most played first, then the rest. */
  // Picks without sorting the whole catalog (the artist crawl makes it
  // hundreds of thousands of songs; a full sort froze the server for a
  // minute): archived songs first, most played first, then the rest in
  // insertion order from where the last pick stopped.
  nextSongInfo(limit) {
    const row = (r) => ({
      videoId: r.video_id, title: r.title,
      artist: parse(r.artists_json, [])[0]?.name ?? null, durationS: r.duration_s,
    });
    const out = this.#sql(`SELECT t.video_id, t.title, t.artists_json, t.duration_s
      FROM songs s JOIN tracks t ON t.video_id = s.video_id
      WHERE s.status = 'stored' AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM song_info x WHERE x.video_id = t.video_id)
      ORDER BY (SELECT COUNT(*) FROM plays p WHERE p.video_id = s.video_id) DESC
      LIMIT ?`).all(limit).map(row);
    if (out.length >= limit || Date.now() < (this.#cursorIdle.song_info ?? 0)) return out;
    const seen = new Set(out.map((t) => t.videoId));
    const rest = this.#sql(`SELECT t.rowid r, t.video_id, t.title, t.artists_json, t.duration_s
      FROM tracks t
      WHERE t.rowid > ? AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM song_info x WHERE x.video_id = t.video_id)
      ORDER BY t.rowid LIMIT ?`).all(this.#cursor.song_info ?? 0, limit - out.length);
    if (rest.length) this.#cursor.song_info = rest.at(-1).r;
    else {
      // Reached the end: start over later, for songs added since.
      this.#cursor.song_info = 0;
      this.#cursorIdle.song_info = Date.now() + 30 * 60_000;
    }
    for (const r of rest) if (!seen.has(r.video_id)) out.push(row(r));
    return out;
  }


  /** [deezer]/[itunes]: null = looked, nothing found (not looked up again). */
  saveSongInfo(videoId, { deezer = null, itunes = null } = {}, now = Date.now()) {
    this.#sql(`INSERT OR REPLACE INTO song_info(video_id, deezer_id, isrc, rank, bpm, release_date,
      genre, album, itunes_id, deezer_score, itunes_score, checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      videoId, deezer?.deezerId ?? null, deezer?.isrc ?? null, deezer?.rank ?? null, deezer?.bpm ?? null,
      deezer?.releaseDate ?? itunes?.releaseDate ?? null, itunes?.genre ?? null,
      deezer?.album ?? itunes?.album ?? null, itunes?.itunesId ?? null,
      deezer?.score ?? null, itunes?.score ?? null, now);
  }

  songInfo(videoId) {
    const r = this.#sql("SELECT * FROM song_info WHERE video_id = ?").get(videoId);
    if (!r) return null;
    return {
      isrc: r.isrc, rank: r.rank, bpm: r.bpm, releaseDate: r.release_date, genre: r.genre,
      album: r.album, deezerId: r.deezer_id, itunesId: r.itunes_id,
    };
  }

  songInfoStats() {
    const n = (q) => this.#sql(q).get().n;
    return {
      checked: n("SELECT COUNT(*) n FROM song_info"),
      deezer: n("SELECT COUNT(*) n FROM song_info WHERE deezer_id IS NOT NULL"),
      itunes: n("SELECT COUNT(*) n FROM song_info WHERE itunes_id IS NOT NULL"),
    };
  }

  // ------------------------------------------------------------ Last.fm

  /** Songs not yet looked up on Last.fm: archived + most played first, then a rowid cursor over tracks. */
  nextLastfmTracks(limit) {
    const row = (r) => ({
      videoId: r.video_id, title: r.title,
      artist: parse(r.artists_json, [])[0]?.name ?? r.artist ?? null,
    });
    const out = this.#sql(`SELECT s.video_id, COALESCE(s.title, t.title) title, s.artist, COALESCE(s.artists_json, t.artists_json) artists_json
      FROM songs s LEFT JOIN tracks t ON t.video_id = s.video_id
      WHERE s.status = 'stored' AND COALESCE(s.title, t.title, '') != ''
        AND NOT EXISTS (SELECT 1 FROM lastfm_tracks x WHERE x.video_id = s.video_id)
      ORDER BY s.plays DESC
      LIMIT ?`).all(limit).map(row);
    if (out.length >= limit || Date.now() < (this.#cursorIdle.lastfm ?? 0)) return out;
    const seen = new Set(out.map((t) => t.videoId));
    const rest = this.#sql(`SELECT t.rowid r, t.video_id, t.title, t.artists_json
      FROM tracks t
      WHERE t.rowid > ? AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM lastfm_tracks x WHERE x.video_id = t.video_id)
      ORDER BY t.rowid LIMIT ?`).all(this.#cursor.lastfm ?? 0, limit - out.length);
    if (rest.length) this.#cursor.lastfm = rest.at(-1).r;
    else {
      this.#cursor.lastfm = 0;
      this.#cursorIdle.lastfm = Date.now() + 30 * 60_000;
    }
    for (const r of rest) if (!seen.has(r.video_id)) out.push(row(r));
    return out;
  }

  /** First artist id of a song (song_artists primary key prefix: indexed). */
  firstArtistId(videoId) {
    return this.#sql("SELECT artist_id FROM song_artists WHERE video_id=? ORDER BY position LIMIT 1").get(videoId)?.artist_id ?? null;
  }

  hasLastfmArtist(artistId) {
    return !!this.#sql("SELECT 1 FROM lastfm_artists WHERE artist_id=?").get(artistId);
  }

  /** Our artist ids by name (NOCASE index). */
  artistIdsByName(name) {
    return this.#sql("SELECT id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 5").all(name).map((r) => r.id);
  }

  /**
   * Our video_id for a (artist, title) pair: artists by name (NOCASE index),
   * their songs via song_artists, then title comparison. Stored songs first, then most plays.
   */
  findSongByName(artist, title) {
    const want = normTitle(title, artist);
    if (!want || !artist) return null;
    const rows = this.#ftsDone ? this.#songsByNameFts(artist, title) : this.#sql(`SELECT sa.video_id, COALESCE(s.title, t.title) title, s.status, s.plays
      FROM artists a JOIN song_artists sa ON sa.artist_id = a.id
      LEFT JOIN songs s ON s.video_id = sa.video_id
      LEFT JOIN tracks t ON t.video_id = sa.video_id
      WHERE a.name = ? COLLATE NOCASE LIMIT 100`).all(artist);
    let best = null;
    for (const r of rows) {
      const have = normTitle(r.title, artist);
      if (!have) continue;
      const ok = have === want || (have.length >= 4 && want.length >= 4 && (have.includes(want) || want.includes(have)));
      if (!ok) continue;
      const rank = [have === want ? 1 : 0, r.status === "stored" ? 1 : 0, r.plays ?? 0];
      if (!best || rank[1] > best.rank[1] || (rank[1] === best.rank[1] && (rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[2] > best.rank[2])))) best = { id: r.video_id, rank };
    }
    return best?.id ?? null;
  }

  /**
   * Candidates for findSongByName from the finished search index: a few index
   * reads, where walking a big artist's songs took 30 s on home's disk. Most
   * Last.fm names aren't in the catalog, so a miss must be cheap too.
   */
  #songsByNameFts(artist, title) {
    const phrase = normSearch(title).replace(/"/g, " ").trim();
    const who = normSearch(artist);
    if (phrase.length < 3 || !who) return [];
    const ids = this.ftsSearch(`"${phrase}"`, 60, false).filter((r) => r.artists?.includes(who)).slice(0, 20);
    return ids.map((r) => {
      const song = this.#sql("SELECT status, plays FROM songs WHERE video_id=?").get(r.videoId);
      return { video_id: r.videoId, title: r.title, status: song?.status, plays: song?.plays };
    });
  }

  /** Write everything one Last.fm tick learned, in one transaction. */
  saveLastfm({ videoId, track, similar = [], names = [], artistId = null, artist = null, artistSimilar = [] }, now = Date.now()) {
    this.#tx(() => {
      this.#sql(`INSERT OR REPLACE INTO lastfm_tracks(video_id,mbid,listeners,playcount,tags_json,lf_artist,lf_title,checked_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(videoId, track?.mbid ?? null, track?.listeners ?? null, track?.playcount ?? null,
        track ? json(track.tags ?? []) : null, track?.artist ?? null, track?.title ?? null, now);
      if (track?.tags?.length) this.#lastfmTags(videoId, track.tags);
      this.#sql("DELETE FROM lastfm_similar WHERE video_id=?").run(videoId);
      this.#sql("DELETE FROM lastfm_similar_names WHERE video_id=?").run(videoId);
      for (const s of similar) this.#sql("INSERT OR REPLACE INTO lastfm_similar(video_id,similar_id,match) VALUES(?,?,?)").run(videoId, s.id, s.match);
      for (const s of names.slice(0, 50)) this.#sql("INSERT OR REPLACE INTO lastfm_similar_names(video_id,artist,title,match) VALUES(?,?,?,?)").run(videoId, s.artist, s.title, s.match);
      if (artistId) {
        this.#sql(`INSERT OR REPLACE INTO lastfm_artists(artist_id,mbid,listeners,playcount,tags_json,checked_at)
          VALUES(?,?,?,?,?,?)`).run(artistId, artist?.mbid ?? null, artist?.listeners ?? null, artist?.playcount ?? null,
          artist ? json(artist.tags ?? []) : null, now);
        for (const s of artistSimilar) this.#sql("INSERT OR REPLACE INTO lastfm_artist_similar(artist_id,similar_id,match) VALUES(?,?,?)").run(artistId, s.id, s.match);
      }
    });
  }

  lastfmInfo(videoId) {
    const r = this.#sql("SELECT listeners, playcount, tags_json FROM lastfm_tracks WHERE video_id=?").get(videoId);
    if (!r || r.listeners == null) return null;
    return { listeners: r.listeners, playcount: r.playcount, tags: parse(r.tags_json, []) };
  }

  lastfmStats() {
    const n = (q) => this.#sql(q).get().n;
    return {
      checked: n("SELECT COUNT(*) n FROM lastfm_tracks"),
      found: n("SELECT COUNT(*) n FROM lastfm_tracks WHERE listeners IS NOT NULL"),
    };
  }

  // ------------------------------------------------------------ MusicBrainz / ListenBrainz

  /** Songs not yet looked up on MusicBrainz: archived + most played first, then a rowid cursor over tracks. */
  nextMbRecordings(limit) {
    const row = (r) => ({
      videoId: r.video_id, title: r.title,
      artist: parse(r.artists_json, [])[0]?.name ?? r.artist ?? null,
    });
    const out = this.#sql(`SELECT s.video_id, COALESCE(s.title, t.title) title, s.artist, COALESCE(s.artists_json, t.artists_json) artists_json
      FROM songs s LEFT JOIN tracks t ON t.video_id = s.video_id
      WHERE s.status = 'stored' AND COALESCE(s.title, t.title, '') != ''
        AND NOT EXISTS (SELECT 1 FROM mb_recordings x WHERE x.video_id = s.video_id)
      ORDER BY s.plays DESC
      LIMIT ?`).all(limit).map(row);
    if (out.length >= limit || Date.now() < (this.#cursorIdle.musicbrainz ?? 0)) return out;
    const seen = new Set(out.map((t) => t.videoId));
    const rest = this.#sql(`SELECT t.rowid r, t.video_id, t.title, t.artists_json
      FROM tracks t
      WHERE t.rowid > ? AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM mb_recordings x WHERE x.video_id = t.video_id)
      ORDER BY t.rowid LIMIT ?`).all(this.#cursor.musicbrainz ?? 0, limit - out.length);
    if (rest.length) this.#cursor.musicbrainz = rest.at(-1).r;
    else {
      this.#cursor.musicbrainz = 0;
      this.#cursorIdle.musicbrainz = Date.now() + 30 * 60_000;
    }
    for (const r of rest) if (!seen.has(r.video_id)) out.push(row(r));
    return out;
  }

  hasMbArtist(artistId) {
    return !!this.#sql("SELECT 1 FROM mb_artists WHERE artist_id=?").get(artistId);
  }

  /** Our songs with a MusicBrainz recording id (few per id). */
  videoIdsByMbid(mbid) {
    return this.#sql("SELECT video_id FROM mb_recordings WHERE mbid=? LIMIT 3").all(mbid).map((r) => r.video_id);
  }

  artistIdsByMbid(mbid) {
    return this.#sql("SELECT artist_id FROM mb_artists WHERE mbid=? LIMIT 3").all(mbid).map((r) => r.artist_id);
  }

  /** Recordings waiting for listen counts (partial index mb_recordings_lb). */
  mbPopularityBatch(limit) {
    return this.#sql(`SELECT video_id, mbid FROM mb_recordings
      WHERE mbid IS NOT NULL AND lb_checked_at IS NULL ORDER BY checked_at LIMIT ?`).all(limit);
  }

  /** Store listen counts for [mbids]; ones missing from [pop] are marked checked with NULL counts. */
  saveMbPopularity(mbids, pop, now = Date.now()) {
    this.#tx(() => {
      const up = this.#sql("UPDATE mb_recordings SET lb_listens=?, lb_users=?, lb_checked_at=? WHERE mbid=?");
      for (const m of mbids) {
        const p = pop.get(m);
        up.run(p?.listens ?? null, p?.users ?? null, now, m);
      }
    });
  }

  /** Write everything one MusicBrainz tick learned, in one transaction. */
  saveMusicBrainz({ videoId, recording, artistId = null, artist = null, lbSimilar = null, lbArtistSimilar = null }, now = Date.now()) {
    this.#tx(() => {
      const r = recording;
      this.#sql(`INSERT OR REPLACE INTO mb_recordings(video_id,mbid,artist_mbids_json,title,first_release,length_ms,isrcs_json,score,
        lb_listens,lb_users,lb_checked_at,checked_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)`).run(
        videoId, r?.mbid ?? null, r ? json(r.artistMbids ?? []) : null, r?.title ?? null, r?.firstRelease ?? null,
        r?.lengthMs ?? null, r ? json(r.isrcs ?? []) : null, r?.score ?? null, now);
      if (lbSimilar) {
        this.#sql("DELETE FROM lb_similar WHERE video_id=?").run(videoId);
        for (const s of lbSimilar) this.#sql("INSERT OR REPLACE INTO lb_similar(video_id,similar_id,score) VALUES(?,?,?)").run(videoId, s.id, s.score);
      }
      if (artistId) {
        this.#sql(`INSERT OR REPLACE INTO mb_artists(artist_id,mbid,name,sort_name,type,country,begin,end,aliases_json,genres_json,checked_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(artistId, artist?.mbid ?? null, artist?.name ?? null, artist?.sortName ?? null,
          artist?.type ?? null, artist?.country ?? null, artist?.begin ?? null, artist?.end ?? null,
          artist ? json(artist.aliases ?? []) : null, artist ? json(artist.genres ?? []) : null, now);
        if (artist) {
          const ins = this.#sql("INSERT OR IGNORE INTO mb_aliases(alias_norm,artist_id,alias,locale) VALUES(?,?,?,?)");
          const all = [...(artist.aliases ?? []), { name: artist.name }, { name: artist.sortName }];
          for (const a of all) {
            const norm = a?.name ? normTitle(a.name) : "";
            if (norm) ins.run(norm, artistId, a.name, a.locale ?? null);
          }
        }
        if (lbArtistSimilar) {
          this.#sql("DELETE FROM lb_artist_similar WHERE artist_id=?").run(artistId);
          for (const s of lbArtistSimilar) this.#sql("INSERT OR REPLACE INTO lb_artist_similar(artist_id,similar_id,score) VALUES(?,?,?)").run(artistId, s.id, s.score);
        }
      }
    });
  }

  /** What /song/info shows: the recording and, for the first artist, country/type/genres/aliases. */
  mbInfo(videoId) {
    const r = this.#sql("SELECT mbid, first_release, lb_listens, lb_users FROM mb_recordings WHERE video_id=?").get(videoId);
    const out = {};
    if (r?.mbid) out.mb = { mbid: r.mbid, firstRelease: r.first_release, listens: r.lb_listens, users: r.lb_users };
    const aid = this.firstArtistId(videoId);
    const a = aid ? this.#sql("SELECT mbid, country, type, begin, genres_json, aliases_json FROM mb_artists WHERE artist_id=?").get(aid) : null;
    if (a?.mbid) {
      out.artist = {
        country: a.country, type: a.type, begin: a.begin, genres: parse(a.genres_json, []),
        aliases: parse(a.aliases_json, []).map((x) => x?.name).filter(Boolean).slice(0, 10),
      };
    }
    return out;
  }

  /** Artists whose name or alias (any script) equals or starts with the query; PK prefix of mb_aliases. */
  artistsByAlias(query) {
    const q = normTitle(query);
    if (!q) return [];
    const exact = this.#sql("SELECT artist_id, alias FROM mb_aliases WHERE alias_norm = ? LIMIT 20").all(q);
    const prefix = this.#sql(`SELECT artist_id, alias FROM mb_aliases
      WHERE alias_norm >= ? AND alias_norm < ? || char(0x10FFFF) LIMIT 20`).all(q, q);
    const seen = new Set(), out = [];
    for (const r of [...exact, ...prefix]) {
      if (seen.has(r.artist_id)) continue;
      seen.add(r.artist_id);
      const a = this.#sql("SELECT id, name, subscribers FROM artists WHERE id=?").get(r.artist_id);
      if (a) out.push({ id: a.id, name: a.name, alias: r.alias, subscribers: a.subscribers });
      if (out.length >= 20) break;
    }
    return out;
  }

  mbStats() {
    const n = (q) => this.#sql(q).get().n;
    return {
      checked: n("SELECT COUNT(*) n FROM mb_recordings"),
      found: n("SELECT COUNT(*) n FROM mb_recordings WHERE mbid IS NOT NULL"),
    };
  }

  // ------------------------------------------------------------ audio analysis

  /**
   * Hand [n] stored songs to analyzer [server]: expired leases first, then
   * never-offered songs, most played first. Skips songs over 15 minutes.
   */
  leaseAnalysis(server, n, now = Date.now()) {
    n = Math.max(1, Math.min(Math.floor(Number(n)) || 1, 10));
    const until = now + ANALYSIS_LEASE_MS;
    return this.#tx(() => {
      const out = this.#sql(`SELECT a.video_id, s.duration_s FROM song_analysis a JOIN songs s ON s.video_id = a.video_id
        WHERE a.analyzed_at IS NULL AND a.lease_until < ? AND s.status = 'stored'
          AND (s.duration_s IS NULL OR s.duration_s <= ?)
        ORDER BY a.lease_until LIMIT ?`).all(now, ANALYSIS_MAX_S, n);
      if (out.length < n) {
        out.push(...this.#sql(`SELECT s.video_id, s.duration_s FROM songs s
          WHERE s.status = 'stored' AND (s.duration_s IS NULL OR s.duration_s <= ?)
            AND NOT EXISTS (SELECT 1 FROM song_analysis x WHERE x.video_id = s.video_id)
          ORDER BY s.plays DESC LIMIT ?`).all(ANALYSIS_MAX_S, n - out.length));
      }
      const up = this.#sql(`INSERT INTO song_analysis(video_id, server, lease_until) VALUES(?,?,?)
        ON CONFLICT(video_id) DO UPDATE SET server=excluded.server, lease_until=excluded.lease_until`);
      for (const r of out) up.run(r.video_id, String(server || "?").slice(0, 40), until);
      return out.map((r) => ({ videoId: r.video_id, durationS: r.duration_s ?? null }));
    });
  }

  /** Store an analyzer's result; throws Error("invalid_...") on bad values. */
  saveAnalysis(videoId, result, server, now = Date.now()) {
    const r = result || {};
    const num = (v, lo, hi, name, { clamp = false, required = false } = {}) => {
      if (v == null) {
        if (required) throw new Error(`invalid_${name}`);
        return null;
      }
      const x = Number(v);
      if (typeof v === "boolean" || !Number.isFinite(x)) throw new Error(`invalid_${name}`);
      if (clamp) return Math.min(hi, Math.max(lo, x));
      if (x < lo || x > hi) throw new Error(`invalid_${name}`);
      return x;
    };
    const p = (name) => num(r[name], 0, 1, name, { clamp: true });
    const bpm = num(r.bpm, 30, 300, "bpm");
    const strength = num(r.keyStrength, 0, 1, "keyStrength", { clamp: true });
    const loudness = num(r.loudness, -100, 20, "loudness");
    let key = null, scale = null;
    if (r.key != null) {
      if (!/^[A-G][#b]?$/.test(String(r.key))) throw new Error("invalid_key");
      key = String(r.key);
    }
    if (r.scale != null) {
      if (r.scale !== "major" && r.scale !== "minor") throw new Error("invalid_scale");
      scale = r.scale;
    }
    let genres = null;
    if (r.genres != null) {
      if (!Array.isArray(r.genres)) throw new Error("invalid_genres");
      genres = r.genres.slice(0, 5).map((g) => ({
        name: String(g?.name ?? "").slice(0, 100),
        p: Math.min(1, Math.max(0, Number(g?.p) || 0)),
      })).filter((g) => g.name);
    }
    const row = [bpm, key, scale, strength, loudness, p("energy"), p("danceability"), p("happy"), p("sad"), p("relaxed"),
      p("aggressive"), p("party"), p("acoustic"), p("electronic"), p("instrumental"), p("valence"), p("arousal"),
      genres ? JSON.stringify(genres) : null, r.model == null ? null : String(r.model).slice(0, 80),
      String(server || "?").slice(0, 40), now];
    this.#tx(() => {
    this.#sql(`INSERT INTO song_analysis(video_id, bpm, key, scale, key_strength, loudness, energy, danceability, happy,
      sad, relaxed, aggressive, party, acoustic, electronic, instrumental, valence, arousal, genres_json, model, server,
      analyzed_at, lease_until, error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
      ON CONFLICT(video_id) DO UPDATE SET bpm=excluded.bpm, key=excluded.key, scale=excluded.scale,
        key_strength=excluded.key_strength, loudness=excluded.loudness, energy=excluded.energy,
        danceability=excluded.danceability, happy=excluded.happy, sad=excluded.sad, relaxed=excluded.relaxed,
        aggressive=excluded.aggressive, party=excluded.party, acoustic=excluded.acoustic,
        electronic=excluded.electronic, instrumental=excluded.instrumental, valence=excluded.valence,
        arousal=excluded.arousal, genres_json=excluded.genres_json, model=excluded.model, server=excluded.server,
        analyzed_at=excluded.analyzed_at, lease_until=NULL, error=NULL`).run(videoId, ...row);
    this.mood.invalidate(videoId);
    this.#analysisTags(videoId, genres);
    });
  }

  /** The song could not be analyzed: marked done so it is not offered again. */
  saveAnalysisError(videoId, error, now = Date.now()) {
    this.#sql(`INSERT INTO song_analysis(video_id, analyzed_at, error) VALUES(?,?,?)
      ON CONFLICT(video_id) DO UPDATE SET analyzed_at=excluded.analyzed_at, error=excluded.error, lease_until=NULL`)
      .run(videoId, now, String(error || "error").slice(0, 300));
  }

  /** null until analyzed successfully. */
  analysisInfo(videoId) {
    const r = this.#sql("SELECT * FROM song_analysis WHERE video_id=?").get(videoId);
    if (!r || r.analyzed_at == null || r.error != null) return null;
    return {
      bpm: r.bpm, key: r.key, scale: r.scale, keyStrength: r.key_strength, loudness: r.loudness,
      energy: r.energy, danceability: r.danceability,
      mood: { happy: r.happy, sad: r.sad, relaxed: r.relaxed, aggressive: r.aggressive, party: r.party },
      valence: r.valence, arousal: r.arousal, acoustic: r.acoustic, electronic: r.electronic,
      instrumental: r.instrumental, genres: parse(r.genres_json, []),
    };
  }

  analysisStats(now = Date.now()) {
    const n = (q, ...a) => this.#sql(q).get(...a).n;
    return {
      analyzed: n("SELECT COUNT(*) n FROM song_analysis WHERE analyzed_at IS NOT NULL AND error IS NULL"),
      failed: n("SELECT COUNT(*) n FROM song_analysis WHERE error IS NOT NULL"),
      leased: n("SELECT COUNT(*) n FROM song_analysis WHERE analyzed_at IS NULL AND lease_until >= ?", now),
    };
  }

  // ------------------------------------------------------------ tags per song (song_tags)

  /** Replace what [src] said about a song; tags already given by another source keep the higher weight. */
  #setTags(videoId, src, list) {
    this.#sql("DELETE FROM song_tags WHERE video_id=? AND src=?").run(videoId, src);
    const ins = this.#sql(`INSERT INTO song_tags(tag,video_id,weight,src) VALUES(?,?,?,?)
      ON CONFLICT(tag,video_id) DO UPDATE SET weight=MAX(COALESCE(weight,0),COALESCE(excluded.weight,0))`);
    const seen = new Set();
    for (const { tag, weight } of list) {
      const t = cleanTag(tag);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      ins.run(t, videoId, weight, src);
    }
  }

  /** Last.fm tags in order: weight 1 for the first down to 0.3 for the last. */
  #lastfmTags(videoId, tags) {
    const n = tags.length;
    this.#setTags(videoId, "lastfm", tags.map((tag, i) => ({ tag, weight: n > 1 ? 1 - (0.7 * i) / (n - 1) : 1 })));
  }

  #analysisTags(videoId, genres) {
    // Essentia genres read "Hip Hop---Trap": tag both the family and the style.
    const tags = (genres ?? []).flatMap((g) =>
      String(g?.name ?? "").split("---").map((t) => t.trim()).filter(Boolean).map((tag) => ({ tag, weight: g.p })));
    this.#setTags(videoId, "analysis", tags);
    // The mood tag is the felt label (title, tags, lyrics, votes and the catalog's own percentiles).
    const f = this.mood.feltFor(videoId);
    this.#setTags(videoId, "mood", f && f.label !== "mixed" ? [{ tag: FELT_TAG[f.label], weight: f[f.label] }] : []);
  }

  // ------------------------------------------------------------ felt mood

  get mood() { return (this.#moodModel ??= new MoodModel({ catalog: this })); }
  #moodModel = null;

  /** Raw numbers of every analyzed song (calibration and candidate lists). */
  analysisMoodRows(cap = 10_000) {
    // Above [cap] rows only every stride-th rowid is read, so the pass stays bounded (a sample is plenty for percentiles).
    const stride = Math.max(1, Math.ceil((this.#sql("SELECT MAX(rowid) m FROM song_analysis").get().m ?? 0) / cap));
    return this.#sql(`SELECT video_id id, sad, happy, relaxed, aggressive, party, danceability, energy, valence, arousal, scale
      FROM song_analysis WHERE analyzed_at IS NOT NULL AND error IS NULL AND rowid % ? = 0`.replace("rowid % ? = 0", stride > 1 ? "rowid % ? = 0" : "? > 0")).all(stride);
  }

  /** What the felt model reads about one song; null without analysis. */
  moodInputs(videoId) {
    const row = this.#sql(`SELECT video_id id, sad, happy, relaxed, aggressive, party, danceability, energy, valence, arousal, scale
      FROM song_analysis WHERE video_id=? AND analyzed_at IS NOT NULL AND error IS NULL`).get(videoId);
    if (!row) return null;
    const s = this.#sql("SELECT title FROM songs WHERE video_id=?").get(videoId) ?? this.#sql("SELECT title FROM tracks WHERE video_id=?").get(videoId);
    const tags = this.#sql("SELECT tag, weight, src FROM song_tags WHERE video_id=? LIMIT 50").all(videoId);
    const l = this.#sql("SELECT body FROM lyrics WHERE video_id=? AND body IS NOT NULL").get(videoId);
    let lyrics = null;
    if (l) {
      const lines = parse(l.body, {})?.lines;
      if (Array.isArray(lines)) lyrics = lines.map((x) => String(x?.x ?? x?.text ?? "")).join("\n");
    }
    return { row, title: s?.title ?? "", tags, lyrics };
  }

  /** {counts, mine} of the votes on a song; [uid] = the asker. */
  moodVotes(videoId, uid = null) {
    const counts = {};
    let mine = null;
    for (const r of this.#sql("SELECT uid, mood FROM mood_votes WHERE video_id=?").all(videoId)) {
      counts[r.mood] = (counts[r.mood] ?? 0) + 1;
      if (uid && r.uid === uid) mine = r.mood;
    }
    return Object.keys(counts).length ? { counts, mine } : null;
  }

  /** One vote per user and song (a new one replaces the old). */
  voteMood(videoId, uid, mood, now = Date.now()) {
    if (!["sad", "happy", "chill", "energetic", "dance"].includes(mood) || !uid) throw new Error("invalid_vote");
    this.#sql(`INSERT INTO mood_votes(video_id, uid, mood, at) VALUES(?,?,?,?)
      ON CONFLICT(video_id, uid) DO UPDATE SET mood=excluded.mood, at=excluded.at`).run(videoId, String(uid), mood, now);
    this.mood.invalidate(videoId);
    if (this.analysisInfo(videoId)) this.#tx(() => this.#analysisTags(videoId, parse(this.#sql("SELECT genres_json FROM song_analysis WHERE video_id=?").get(videoId)?.genres_json, [])));
  }

  /** One slice of the one-off re-tag of analyzed songs with the felt label: { done, n }. */
  retagMoods(limit = 500) {
    const key = "mood_retag_v1";
    const st = parse(this.#sql("SELECT value FROM meta WHERE key=?").get(key)?.value, { a: 0, d: false });
    if (st.d) return { done: true, n: 0 };
    let n = 0;
    this.#tx(() => {
      const maxA = this.#sql("SELECT MAX(rowid) m FROM song_analysis").get().m ?? 0;
      if (st.a < maxA) {
        const rows = this.#sql(`SELECT video_id, genres_json FROM song_analysis
          WHERE rowid > ? AND rowid <= ? AND analyzed_at IS NOT NULL AND error IS NULL`).all(st.a, st.a + limit);
        for (const r of rows) { this.#analysisTags(r.video_id, parse(r.genres_json, [])); n++; }
        st.a += limit;
      } else st.d = true;
      this.#sql("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(st));
    });
    return { done: st.d, n };
  }

  tagsOf(videoId) {
    return this.#sql("SELECT tag, weight, src FROM song_tags WHERE video_id=? ORDER BY weight DESC LIMIT 50").all(videoId);
  }

  tagExists(tag) { return !!this.#sql("SELECT 1 FROM song_tags WHERE tag=? LIMIT 1").get(tag); }

  /** Songs having [tag], at most [cap] counted (index song_tags_tag_w). */
  tagCount(tag, cap = 2001) {
    return this.#sql("SELECT COUNT(*) n FROM (SELECT 1 FROM song_tags WHERE tag=? LIMIT ?)").get(tag, cap).n;
  }

  /** Best weighted songs of a tag (index song_tags_tag_w). */
  tagTop(tag, limit) {
    return this.#sql("SELECT video_id, weight FROM song_tags WHERE tag=? ORDER BY weight DESC LIMIT ?").all(tag, limit)
      .map((r) => ({ videoId: r.video_id, weight: r.weight }));
  }

  hasTag(tag, videoId) { return !!this.#sql("SELECT 1 FROM song_tags WHERE tag=? AND video_id=?").get(tag, videoId); }

  /**
   * One slice of the one-off copy of old Last.fm tags and analysis into song_tags:
   * a window of [limit] rowids per call, progress remembered in meta. { done, n }.
   */
  backfillSongTags(limit = 1000) {
    const key = "song_tags_backfill";
    const st = parse(this.#sql("SELECT value FROM meta WHERE key=?").get(key)?.value, { l: 0, a: 0, d: false });
    if (st.d) return { done: true, n: 0 };
    let n = 0;
    this.#tx(() => {
      const maxL = this.#sql("SELECT MAX(rowid) m FROM lastfm_tracks").get().m ?? 0;
      if (st.l < maxL) {
        const rows = this.#sql(`SELECT video_id, tags_json FROM lastfm_tracks WHERE rowid > ? AND rowid <= ?`).all(st.l, st.l + limit);
        for (const r of rows) {
          const tags = parse(r.tags_json, []);
          if (Array.isArray(tags) && tags.length) { this.#lastfmTags(r.video_id, tags); n++; }
        }
        st.l += limit;
      } else {
        const maxA = this.#sql("SELECT MAX(rowid) m FROM song_analysis").get().m ?? 0;
        if (st.a < maxA) {
          const rows = this.#sql(`SELECT video_id, genres_json, happy, sad, relaxed, aggressive, party FROM song_analysis
            WHERE rowid > ? AND rowid <= ? AND analyzed_at IS NOT NULL AND error IS NULL`).all(st.a, st.a + limit);
          for (const r of rows) { this.#analysisTags(r.video_id, parse(r.genres_json, [])); n++; }
          st.a += limit;
        } else st.d = true;
      }
      this.#sql("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify(st));
    });
    return { done: st.d, n };
  }

  // ------------------------------------------------------------ Discogs

  /** Songs not yet looked up on Discogs: archived + most played first, then a rowid cursor over tracks. */
  nextDiscogs(limit) {
    const row = (r) => ({
      videoId: r.video_id, title: r.title,
      artist: parse(r.artists_json, [])[0]?.name ?? r.artist ?? null,
    });
    const out = this.#sql(`SELECT s.video_id, COALESCE(s.title, t.title) title, s.artist, COALESCE(s.artists_json, t.artists_json) artists_json
      FROM songs s LEFT JOIN tracks t ON t.video_id = s.video_id
      WHERE s.status = 'stored' AND COALESCE(s.title, t.title, '') != ''
        AND NOT EXISTS (SELECT 1 FROM discogs_releases x WHERE x.video_id = s.video_id)
      ORDER BY s.plays DESC
      LIMIT ?`).all(limit).map(row);
    if (out.length >= limit || Date.now() < (this.#cursorIdle.discogs ?? 0)) return out;
    const seen = new Set(out.map((t) => t.videoId));
    const rest = this.#sql(`SELECT t.rowid r, t.video_id, t.title, t.artists_json
      FROM tracks t
      WHERE t.rowid > ? AND t.title IS NOT NULL AND t.title != ''
        AND NOT EXISTS (SELECT 1 FROM discogs_releases x WHERE x.video_id = t.video_id)
      ORDER BY t.rowid LIMIT ?`).all(this.#cursor.discogs ?? 0, limit - out.length);
    if (rest.length) this.#cursor.discogs = rest.at(-1).r;
    else {
      this.#cursor.discogs = 0;
      this.#cursorIdle.discogs = Date.now() + 30 * 60_000;
    }
    for (const r of rest) if (!seen.has(r.video_id)) out.push(row(r));
    return out;
  }

  /** release null = looked, nothing found. Genres and styles also become song tags. */
  saveDiscogs(videoId, release, now = Date.now()) {
    this.#tx(() => {
      this.#sql(`INSERT OR REPLACE INTO discogs_releases(video_id,release_id,master_id,year,genres_json,styles_json,country,label,checked_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(videoId, release?.releaseId ?? null, release?.masterId ?? null, release?.year ?? null,
        release ? json(release.genres ?? []) : null, release ? json(release.styles ?? []) : null,
        release?.country ?? null, release?.label ?? null, now);
      if (release) this.#setTags(videoId, "discogs", [...(release.genres ?? []), ...(release.styles ?? [])].map((tag) => ({ tag, weight: 1 })));
    });
  }

  discogsInfo(videoId) {
    const r = this.#sql("SELECT * FROM discogs_releases WHERE video_id=?").get(videoId);
    if (!r || r.release_id == null) return null;
    return { releaseId: r.release_id, masterId: r.master_id, year: r.year, genres: parse(r.genres_json, []),
      styles: parse(r.styles_json, []), country: r.country, label: r.label };
  }

  discogsStats() {
    const n = (q) => this.#sql(q).get().n;
    return {
      checked: n("SELECT COUNT(*) n FROM discogs_releases"),
      found: n("SELECT COUNT(*) n FROM discogs_releases WHERE release_id IS NOT NULL"),
    };
  }

  // ------------------------------------------------------------ Odesli links

  linksExt(videoId) {
    const r = this.#sql("SELECT page_url, links_json, fetched_at FROM song_links_ext WHERE video_id=?").get(videoId);
    return r ? { pageUrl: r.page_url, links: parse(r.links_json, {}), fetchedAt: r.fetched_at } : null;
  }

  saveLinksExt(videoId, pageUrl, links, now = Date.now()) {
    this.#sql("INSERT OR REPLACE INTO song_links_ext(video_id,page_url,links_json,fetched_at) VALUES(?,?,?,?)")
      .run(videoId, pageUrl ?? null, JSON.stringify(links ?? {}), now);
  }

  // ------------------------------------------------------------ smart search (search_fts)

  #ftsPut(rowid, videoId, title, artistsJson) {
    this.#sql("DELETE FROM search_fts WHERE rowid=?").run(rowid);
    if (!title) return;
    const artists = parse(artistsJson, []).map((a) => a?.name).filter(Boolean).join(" ");
    this.#sql("INSERT INTO search_fts(rowid,video_id,title,artists) VALUES(?,?,?,?)")
      .run(rowid, videoId, normSearch(title), normSearch(artists));
  }

  /** Index one slice of tracks (rowid cursor in meta search_fts_cursor). { n, done }. */
  ftsFill(limit = 2000) {
    if (!this.ftsMode || this.#ftsDone) return { n: 0, done: true };
    const cur = Number(this.#sql("SELECT value FROM meta WHERE key='search_fts_cursor'").get()?.value) || 0;
    const rows = this.#sql("SELECT rowid r, video_id, title, artists_json FROM tracks WHERE rowid > ? ORDER BY rowid LIMIT ?").all(cur, limit);
    if (!rows.length) { this.#ftsDone = true; return { n: 0, done: true }; }
    this.#tx(() => {
      for (const r of rows) this.#ftsPut(r.r, r.video_id, r.title, r.artists_json);
      this.#sql("INSERT OR REPLACE INTO meta(key,value) VALUES('search_fts_cursor',?)").run(String(rows.at(-1).r));
    });
    return { n: rows.length, done: false };
  }

  ftsStats() {
    const cursor = Number(this.#sql("SELECT value FROM meta WHERE key='search_fts_cursor'").get()?.value) || 0;
    const max = this.#sql("SELECT MAX(rowid) m FROM tracks").get().m ?? 0;
    return { mode: this.ftsMode, cursor, maxRowid: max, done: cursor >= max };
  }

  /** Raw FTS hits for a MATCH expression: { videoId, title, artists, rank }. Ordered by bm25 only when asked. */
  ftsSearch(expr, limit, ranked = true) {
    if (!this.ftsMode) return [];
    const q = ranked
      ? "SELECT video_id, title, artists, bm25(search_fts) rank FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?"
      : "SELECT video_id, title, artists, 0 rank FROM search_fts WHERE search_fts MATCH ? LIMIT ?";
    try {
      return this.#sql(q).all(expr, limit).map((r) => ({ videoId: r.video_id, title: r.title, artists: r.artists, rank: r.rank }));
    } catch { return []; } // malformed expression
  }

  /** Cards for result songs: three batched primary key lookups (tracks, songs, lastfm_tracks). */
  songCards(videoIds) {
    const out = new Map();
    const ids = [...new Set(videoIds)];
    const rows = (table, cols, chunk) => {
      const q = `SELECT video_id, ${cols} FROM ${table} WHERE video_id IN (${chunk.map(() => "?").join(",")})`;
      return this.db.prepare(q).all(...chunk);
    };
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const T = new Map(rows("tracks", "title, artists_json, album, duration_s", chunk).map((r) => [r.video_id, r]));
      const S = new Map(rows("songs", "status, plays, title, artists_json, album, duration_s", chunk).map((r) => [r.video_id, r]));
      const L = new Map(rows("lastfm_tracks", "listeners", chunk).map((r) => [r.video_id, r]));
      for (const id of chunk) {
        const t = T.get(id), s = S.get(id);
        if (!t && !s) continue;
        const src = t ?? s;
        out.set(id, {
          videoId: id, title: s?.title ?? t?.title ?? null,
          artists: cardArtists(t?.artists_json, s?.artists_json),
          album: src.album ?? s?.album ?? null, durationS: src.duration_s ?? s?.duration_s ?? null,
          archived: s?.status === "stored", plays: s?.plays ?? 0, listeners: L.get(id)?.listeners ?? 0,
        });
      }
    }
    return out;
  }

  /**
   * Candidates for a mood shelf: analyzed songs whose FELT score for [mood] is at least [min], best first
   * (score, then archived, then plays). Candidate lists come from the model's calibration pass (in memory);
   * only the best few hundred are re-scored with title, tags, lyrics and votes.
   */
  moodSongs(mood, n, min = 0.55) {
    const felt = MOOD_FELT[mood];
    if (!felt) return [];
    const top = this.mood.candidates(felt).slice(0, Math.max(200, n * 4));
    const rows = [];
    for (const c of top) {
      const f = this.mood.feltFor(c.id);
      if (!f || f[felt] < min) continue;
      const s = this.#sql("SELECT status, plays FROM songs WHERE video_id=?").get(c.id);
      rows.push({ id: c.id, p: f[felt], status: s?.status, plays: s?.plays });
    }
    const score = (r) => r.p + (r.status === "stored" ? 0.15 : 0) + Math.min(0.2, Math.log10(1 + (r.plays ?? 0)) * 0.07);
    rows.sort((x, y) => score(y) - score(x));
    const cards = this.songCards(rows.slice(0, n * 2).map((r) => r.id));
    const out = [];
    for (const r of rows.slice(0, n * 2)) {
      const c = cards.get(r.id);
      if (c?.title) out.push(c);
      if (out.length >= n) break;
    }
    return out;
  }

  /** Artists whose name starts with the query, any case (index artists_name_nocase). */
  artistsByNamePrefix(query, limit = 20) {
    const q = String(query ?? "").trim();
    if (q.length < 2) return [];
    return this.#sql(`SELECT id, name, subscribers FROM artists
      WHERE name COLLATE NOCASE >= ? AND name COLLATE NOCASE < ? || char(0x10FFFF) LIMIT 200`).all(q, q)
      .sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0)).slice(0, limit)
      .map((a) => ({ id: a.id, name: a.name, alias: null, subscribers: a.subscribers }));
  }

  /** A few songs of an artist (index song_artists_artist). */
  songIdsOfArtist(artistId, limit = 100) {
    return this.#sql("SELECT video_id, position FROM song_artists WHERE artist_id=? LIMIT ?").all(artistId, limit)
      .map((r) => ({ videoId: r.video_id, position: r.position ?? 0 }));
  }

  /** Artist facts for the player's "About": artists row, MusicBrainz country/begin/genres, Last.fm listeners (PK lookups). */
  artistBrief(artistId) {
    const a = this.#sql("SELECT id, name, subscribers FROM artists WHERE id=?").get(artistId);
    if (!a) return null;
    const m = this.#sql("SELECT country, begin, genres_json FROM mb_artists WHERE artist_id=? AND mbid IS NOT NULL").get(artistId);
    const l = this.#sql("SELECT listeners FROM lastfm_artists WHERE artist_id=?").get(artistId);
    return {
      id: a.id, name: a.name, subscribers: a.subscribers ?? null, listeners: l?.listeners ?? null,
      country: m?.country ?? null, genres: parse(m?.genres_json, []).filter((g) => typeof g === "string").slice(0, 6), begin: m?.begin ?? null,
    };
  }

  /** Similar artists: YouTube Music's related first, then Last.fm, then ListenBrainz; unique, with names. */
  similarArtists(artistId, limit = 12) {
    const out = [], seen = new Set([artistId]);
    const take = (rows) => {
      for (const r of rows) {
        if (out.length >= limit) return;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const a = this.#sql("SELECT name, subscribers FROM artists WHERE id=?").get(r.id);
        if (a?.name) out.push({ id: r.id, name: a.name, subscribers: a.subscribers ?? null });
      }
    };
    const n = limit * 2;
    take(this.#sql("SELECT related_id id FROM artist_related WHERE artist_id=? ORDER BY rank LIMIT ?").all(artistId, n));
    take(this.#sql("SELECT similar_id id FROM lastfm_artist_similar WHERE artist_id=? ORDER BY match DESC LIMIT ?").all(artistId, n));
    take(this.#sql("SELECT similar_id id FROM lb_artist_similar WHERE artist_id=? ORDER BY score DESC LIMIT ?").all(artistId, n));
    return out;
  }

  /** Release facts for result songs, batched primary key lookups: Map id -> {date: "YYYY-.."|null, users}. */
  songFacts(videoIds) {
    const out = new Map();
    const ids = [...new Set(videoIds)];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400), ph = chunk.map(() => "?").join(",");
      const q = (sql) => this.#sql(sql.replace("?", ph)).all(...chunk);
      const I = new Map(q("SELECT video_id, release_date FROM song_info WHERE video_id IN (?)").map((r) => [r.video_id, r]));
      const M = new Map(q("SELECT video_id, first_release, lb_users FROM mb_recordings WHERE video_id IN (?)").map((r) => [r.video_id, r]));
      const T = new Map(q("SELECT video_id, year FROM tracks WHERE video_id IN (?)").map((r) => [r.video_id, r]));
      for (const id of chunk) {
        const y = T.get(id)?.year;
        out.set(id, {
          date: I.get(id)?.release_date || M.get(id)?.first_release || (y ? String(y) : null) || null,
          users: M.get(id)?.lb_users ?? 0,
        });
      }
    }
    return out;
  }

  /** Subscribers and Last.fm listeners per artist id (batched primary key lookups): Map id -> {name, subscribers, listeners}. */
  artistFacts(artistIds) {
    const out = new Map();
    const ids = [...new Set(artistIds)];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400), ph = chunk.map(() => "?").join(",");
      const A = this.#sql(`SELECT id, name, subscribers FROM artists WHERE id IN (${ph})`).all(...chunk);
      const L = new Map(this.#sql(`SELECT artist_id, listeners FROM lastfm_artists WHERE artist_id IN (${ph})`).all(...chunk).map((r) => [r.artist_id, r.listeners]));
      for (const a of A) out.set(a.id, { name: a.name, subscribers: a.subscribers ?? null, listeners: L.get(a.id) ?? null });
    }
    return out;
  }

  /** Artist ids of the given songs (batched index lookups), for "artists the listener has played". */
  artistIdsOfSongs(videoIds, max = 1500) {
    const out = new Set();
    const ids = [...videoIds].slice(0, max);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.#sql(`SELECT DISTINCT artist_id FROM song_artists WHERE video_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk)) out.add(r.artist_id);
    }
    return out;
  }

  close() { this.db.close(); }
}
