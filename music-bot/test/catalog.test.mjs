import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 864e5;
// Fixed instant: 2026-10-10T11:30:00Z.
const NOW = Date.UTC(2026, 9, 10, 11, 30);
const tmp = () => join(mkdtempSync(join(tmpdir(), "cat-")), "sub", "catalog.db");
const open = () => new Catalog(tmp());

test("claim: download, wait on other server, same server re-claims", () => {
  const c = open();
  assert.equal(c.lookup("a"), null);
  assert.deepEqual(c.claim("a", "s1", NOW), { action: "download" });
  assert.equal(c.lookup("a").status, "pending");
  assert.deepEqual(c.claim("a", "s2", NOW + MIN), { action: "wait", server: "s1" });
  assert.deepEqual(c.claim("a", "s1", NOW + MIN), { action: "download" });
  c.close();
});

test("claim: expired lease can be taken over", () => {
  const c = open();
  c.claim("a", "s1", NOW);
  assert.equal(c.claim("a", "s2", NOW + 16 * MIN).action, "download");
  assert.deepEqual(c.claim("a", "s1", NOW + 17 * MIN), { action: "wait", server: "s2" });
  c.close();
});

test("claim: stored and unavailable short-circuit", () => {
  const c = open();
  c.stored("a", { msgId: 5, title: "T" }, NOW);
  const r = c.claim("a", "s1", NOW);
  assert.equal(r.action, "stored");
  assert.equal(r.song.msgId, 5);
  c.failed("b", "s1", "gone", { unavailable: true }, NOW);
  assert.deepEqual(c.claim("b", "s2", NOW), { action: "unavailable" });
  c.close();
});

test("stored upserts, keeps old metadata, parses JSON, finishes job", () => {
  const c = open();
  c.claim("a", "s1", NOW);
  c.stored("a", {
    msgId: 9, size: 1000, mime: "audio/ogg", codec: "opus", bitrateKbps: 128, durationS: 200.5,
    title: "Song", artist: "Art", artists: ["Art", "Guest"], album: "Alb", year: 2020,
    tags: ["x"], categories: ["Music"], server: "s1", meta: { k: 1 },
  }, NOW + 1);
  const s = c.stored("a", { msgId: 10, title: null, server: "s2" }, NOW + 2);
  assert.equal(s.status, "stored");
  assert.equal(s.msgId, 10);
  assert.equal(s.title, "Song");
  assert.deepEqual(s.artists, ["Art", "Guest"]);
  assert.deepEqual(s.tags, ["x"]);
  assert.deepEqual(s.meta, { k: 1 });
  assert.equal(s.sourceServer, "s2");
  assert.equal(s.createdAt, NOW);
  assert.equal(s.storedAt, NOW + 2);
  assert.equal(c.stats(1, NOW + 3).queue.running, 0);
  assert.equal(c.stored("new", { msgId: 1 }, NOW).status, "stored");
  c.close();
});

test("failed: backoff, 6 attempts, blocked exclusion unique", () => {
  const c = open();
  c.claim("a", "s1", NOW);
  c.failed("a", "s1", "boom", {}, NOW);
  let f = c.stats(1, NOW).failedJobs[0];
  assert.equal(f.state, "queued");
  assert.equal(f.attempts, 1);
  assert.equal(f.nextAt, NOW + 2 * MIN);
  assert.equal(f.error, "boom");
  assert.deepEqual(c.nextJobs("s1", 2, NOW + MIN), []);
  assert.deepEqual(c.nextJobs("s1", 2, NOW + 2 * MIN), ["a"]);
  const waits = [10 * MIN, HOUR, 6 * HOUR, 24 * HOUR];
  for (const w of waits) {
    c.failed("a", "s1", "boom", {}, NOW);
    assert.equal(c.stats(1, NOW).failedJobs[0].nextAt, NOW + w);
  }
  c.failed("a", "s1", "last", {}, NOW);
  f = c.stats(1, NOW).failedJobs[0];
  assert.equal(f.state, "failed");
  assert.equal(c.lookup("a").status, "failed");
  assert.equal(c.stats(1, NOW).queue.failed, 1);
  c.close();
});

test("failed blocked adds the server once; unavailable is final", () => {
  const c = open();
  c.claim("a", "s1", NOW);
  c.failed("a", "s1", "bot", { blocked: true }, NOW);
  c.failed("a", "s1", "bot", { blocked: true }, NOW + 1);
  assert.deepEqual(c.stats(1, NOW).failedJobs[0].excluded, ["s1"]);
  c.failed("a", "s2", "gone", { unavailable: true }, NOW);
  assert.equal(c.lookup("a").status, "unavailable");
  assert.equal(c.stats(1, NOW).failedJobs[0].state, "failed");
  assert.deepEqual(c.nextJobs("s3", 5, NOW + 30 * DAY), []);
  c.close();
});

test("nextJobs: ordering, limit, exclusion and 24h expiry", () => {
  const c = open();
  c.enqueue(["p1"], "prefetch", NOW);
  c.enqueue(["p2"], "prefetch", NOW + 1);
  c.claim("r1", "s9", NOW + 2);
  c.failed("r1", "s9", "x", {}, NOW + 2); // play job, queued with backoff
  c.enqueue(["p3"], "prefetch", NOW + 3);
  const t = NOW + HOUR;
  assert.deepEqual(c.nextJobs("s1", 2, t), ["r1", "p1"]);
  assert.deepEqual(c.nextJobs("s1", 5, t), ["p2", "p3"]);
  assert.deepEqual(c.nextJobs("s1", 5, t), []);
  c.close();

  const d = open();
  d.claim("a", "s1", NOW);
  d.failed("a", "s1", "bot", { blocked: true }, NOW);
  assert.deepEqual(d.nextJobs("s1", 2, NOW + 3 * HOUR), []);
  assert.deepEqual(d.nextJobs("s1", 2, NOW + 25 * HOUR), ["a"]);
  d.close();
  const e = open();
  e.claim("a", "s1", NOW);
  e.failed("a", "s1", "bot", { blocked: true }, NOW);
  assert.deepEqual(e.nextJobs("s2", 2, NOW + 3 * HOUR), ["a"]);
  e.close();
});

test("nextJobs re-queues expired leases", () => {
  const c = open();
  c.enqueue(["a"], "prefetch", NOW);
  assert.deepEqual(c.nextJobs("s1", 1, NOW), ["a"]);
  assert.deepEqual(c.nextJobs("s2", 1, NOW + 10 * MIN), []);
  assert.deepEqual(c.nextJobs("s2", 1, NOW + 16 * MIN), ["a"]);
  c.close();
});

test("enqueue skips existing songs and duplicates", () => {
  const c = open();
  c.stored("s", { msgId: 1 }, NOW);
  c.claim("c", "s1", NOW);
  assert.equal(c.enqueue(["s", "c", "n", "n", "m"], "prefetch", NOW), 2);
  assert.equal(c.enqueue(["n"], "prefetch", NOW), 0);
  assert.equal(c.stats(1, NOW).queue.queued, 2);
  c.close();
});

test("retry resets failed jobs but not stored or unknown", () => {
  const c = open();
  c.claim("a", "s1", NOW);
  for (let i = 0; i < 6; i++) c.failed("a", "s1", "x", { blocked: true }, NOW);
  assert.equal(c.lookup("a").status, "failed");
  assert.equal(c.retry("a", NOW + DAY), true);
  assert.equal(c.lookup("a").status, "pending");
  assert.deepEqual(c.nextJobs("s1", 1, NOW + DAY), ["a"]);
  c.stored("a", {}, NOW);
  assert.equal(c.retry("a", NOW), false);
  assert.equal(c.lookup("a").status, "stored");
  assert.equal(c.retry("zzz", NOW), false);
  c.close();
});

test("recordPlays counts plays and last_played_at; setRelated replaces", () => {
  const c = open();
  c.stored("a", {}, NOW);
  c.recordPlays([
    { videoId: "a", at: NOW, server: "s1", source: "disk", uid: "u" },
    { videoId: "a", at: NOW + 5, server: "s2", source: "peer", uid: null },
    { videoId: "unknown", at: NOW, server: "s1", source: "youtube" },
  ]);
  const s = c.lookup("a");
  assert.equal(s.plays, 2);
  assert.equal(s.lastPlayedAt, NOW + 5);
  c.setRelated("a", [{ id: "x", kind: "related", rank: 0 }, { id: "y", kind: "next", rank: 0 }]);
  c.setRelated("a", [{ id: "z", kind: "related", rank: 0 }]);
  const rows = c.db.prepare("SELECT related_id, kind FROM related WHERE video_id='a' ORDER BY kind").all();
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.related_id}`), ["next:y", "related:z"]);
  c.close();
});

test("stats shape, zero-filled days, top, byServer", () => {
  const c = open();
  c.stored("a", { size: 100, durationS: 10, title: "A", artist: "X", server: "s1" }, NOW);
  c.stored("b", { size: 50, durationS: 5, title: "B", server: "s2" }, NOW - DAY);
  c.stored("old", { size: 1, server: "s1" }, NOW - 30 * DAY);
  c.claim("p", "s1", NOW);
  c.recordPlays([
    { videoId: "a", at: NOW, server: "s1", source: "disk" },
    { videoId: "a", at: NOW, server: "s1", source: "telegram" },
    { videoId: "b", at: NOW - 2 * DAY, server: "s2", source: "youtube" },
    { videoId: "b", at: NOW - 2 * DAY, server: "s2", source: "peer" },
    { videoId: "a", at: NOW - 20 * DAY, server: "s1", source: "disk" },
  ]);
  const s = c.stats(7, NOW);
  assert.deepEqual(s.totals, { stored: 3, pending: 1, failed: 0, unavailable: 0, bytes: 151, durationS: 15 });
  assert.equal(s.byDay.length, 7);
  assert.equal(s.byDay[0].day, "2026-10-04");
  assert.equal(s.byDay[6].day, "2026-10-10");
  assert.deepEqual(s.byDay[0].plays, { disk: 0, telegram: 0, youtube: 0, peer: 0 });
  assert.equal(s.byDay[6].stored, 1);
  assert.equal(s.byDay[5].stored, 1);
  assert.deepEqual(s.byDay[4].plays, { disk: 0, telegram: 0, youtube: 1, peer: 1 });
  assert.deepEqual(s.sources, { disk: 1, telegram: 1, youtube: 1, peer: 1 });
  assert.deepEqual(s.byServer, [
    { server: "s1", stored: 1, plays: 2 },
    { server: "s2", stored: 1, plays: 2 },
  ].sort((x, y) => x.server.localeCompare(y.server)));
  assert.deepEqual(s.queue, { queued: 0, running: 1, failed: 0 });
  assert.equal(s.recent[0].videoId, "a");
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0].plays, 3);
  assert.deepEqual(s.top[0], { videoId: "a", title: "A", artist: "X", plays: 2, sourceKind: null });
  assert.deepEqual(s.failedJobs, []);
  c.close();
});

test("reopen persists data and migration is idempotent", () => {
  const file = tmp();
  const c = new Catalog(file);
  c.stored("a", { title: "T", msgId: 3 }, NOW);
  c.enqueue(["q"], "prefetch", NOW);
  c.close();
  const d = new Catalog(file);
  assert.equal(d.lookup("a").title, "T");
  assert.equal(d.stats(1, NOW).queue.queued, 1);
  assert.equal(d.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  d.close();
});

test("v1 database upgrades in place to v2 and keeps old rows", () => {
  const file = tmp();
  mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key,value) VALUES('schema_version','1');
    CREATE TABLE songs (
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
    CREATE INDEX plays_video ON plays(video_id);
    INSERT INTO songs(video_id,status,title,codec,bitrate_kbps,tg_size,created_at,stored_at)
      VALUES('old','stored','Old Song','opus',128,77,${NOW},${NOW});
  `);
  raw.close();

  const c = new Catalog(file);
  const cols = c.db.prepare("PRAGMA table_info(songs)").all().map((r) => r.name);
  for (const n of ["source_kind", "quality_label", "sample_rate", "channels", "format_id", "container"]) {
    assert.ok(cols.includes(n), `missing column ${n}`);
  }
  assert.ok(c.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='songs_source_kind'").get());
  const s = c.lookup("old");
  assert.equal(s.title, "Old Song");
  assert.equal(s.codec, "opus");
  assert.equal(s.bitrateKbps, 128);
  assert.equal(s.size, 77);
  assert.equal(s.sourceKind, null);
  assert.equal(s.quality.label, null);
  assert.deepEqual(c.missingMeta(), ["old"]);
  assert.equal(c.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  c.close();
});

test("stored round-trips sourceKind and quality; COALESCE keeps old quality", () => {
  const c = open();
  const s = c.stored("q", {
    sourceKind: "ytm_track", codec: "ignored", bitrateKbps: 1,
    quality: {
      codec: "mp4a.40.2", codecRaw: "mp4a.40.2", bitrateKbps: 131.4, sampleRate: 44100,
      channels: 2, formatId: "140", container: "m4a", label: "AAC 128 kbps",
    },
  }, NOW);
  assert.equal(s.sourceKind, "ytm_track");
  assert.equal(s.codec, "mp4a.40.2");
  assert.equal(s.bitrateKbps, 131.4);
  assert.deepEqual(s.quality, {
    label: "AAC 128 kbps", codec: "mp4a.40.2", bitrateKbps: 131.4, sampleRate: 44100,
    channels: 2, formatId: "140", container: "m4a",
  });

  c.stored("q", { title: "Later" }, NOW + 1);
  let u = c.lookup("q");
  assert.equal(u.title, "Later");
  assert.equal(u.sourceKind, "ytm_track");
  assert.equal(u.quality.label, "AAC 128 kbps");
  assert.equal(u.quality.formatId, "140");
  assert.equal(u.codec, "mp4a.40.2");

  c.stored("q", { quality: { label: "AAC 160 kbps" } }, NOW + 2);
  u = c.lookup("q");
  assert.equal(u.quality.label, "AAC 160 kbps");
  assert.equal(u.quality.sampleRate, 44100);
  assert.equal(u.quality.container, "m4a");
  assert.equal(u.codec, "mp4a.40.2");
  assert.equal(u.sourceKind, "ytm_track");
  c.close();
});

test("missingMeta: stored songs without source kind, oldest first", () => {
  const c = open();
  c.stored("m1", { title: "1" }, NOW);
  c.stored("m2", { sourceKind: "youtube" }, NOW + 2);
  c.stored("m3", {}, NOW + 1);
  c.enqueue(["u"], "prefetch", NOW);
  assert.deepEqual(c.missingMeta(), ["m1", "m3"]);
  assert.deepEqual(c.missingMeta(1), ["m1"]);
  c.stored("m1", { sourceKind: "ytm_track" }, NOW + 3);
  assert.deepEqual(c.missingMeta(), ["m3"]);
  c.close();
});

test("stats: byKind, byQuality, kindPlays, recent and top kinds", () => {
  const c = open();
  c.stored("a", {
    sourceKind: "ytm_track", title: "A", artist: "X",
    quality: { codecRaw: "mp4a.40.2", bitrateKbps: 130, label: "AAC 128 kbps" },
  }, NOW);
  c.stored("b", { sourceKind: "youtube", title: "B", codec: "opus", bitrateKbps: 125.7 }, NOW - DAY);
  c.stored("c", { codec: "mp4a.40.5", bitrateKbps: 61 }, NOW - DAY);
  c.stored("d", { sourceKind: "ytm_track", codec: "mp4a.40.2" }, NOW - 2 * DAY);
  c.stored("e", { sourceKind: "ytm_video", codec: "mp4a.40.2", bitrateKbps: 130 }, NOW - 30 * DAY);
  c.claim("p", "s1", NOW);
  c.recordPlays([
    { videoId: "a", at: NOW, source: "disk" },
    { videoId: "a", at: NOW, source: "telegram" },
    { videoId: "b", at: NOW - 2 * DAY, source: "youtube" },
    { videoId: "c", at: NOW - DAY, source: "peer" },
    { videoId: "zz", at: NOW, source: "youtube" },
    { videoId: "e", at: NOW - 20 * DAY, source: "disk" },
  ]);

  const s = c.stats(7, NOW);
  assert.deepEqual(s.byKind, { ytm_track: 2, ytm_video: 1, youtube: 1, unknown: 1 });
  assert.deepEqual(s.byQuality, [
    { label: "AAC 128 kbps", count: 2 },
    { label: "AAC", count: 1 },
    { label: "HE-AAC 64 kbps", count: 1 },
    { label: "Opus 128 kbps", count: 1 },
  ]);
  assert.deepEqual(s.kindPlays, { ytm_track: 2, ytm_video: 0, youtube: 1, unknown: 2 });

  const byId = Object.fromEntries(s.recent.map((r) => [r.videoId, r]));
  assert.equal(byId.a.sourceKind, "ytm_track");
  assert.equal(byId.a.quality, "AAC 128 kbps");
  assert.equal(byId.c.sourceKind, null);
  assert.equal(byId.c.quality, null);
  assert.deepEqual(s.top[0], { videoId: "a", title: "A", artist: "X", plays: 2, sourceKind: "ytm_track" });
  c.close();
});
