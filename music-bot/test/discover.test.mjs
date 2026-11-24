import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/catalog.js";
import { discoverNew, discoverTrending, guessLang } from "../src/discover.js";

const DAY = 864e5;
const NOW = Date.UTC(2026, 5, 1, 12);
const id = (c) => c.repeat(11);

test("guessLang: persian / english / turkish", () => {
  assert.equal(guessLang("سلام", "گوگوش"), "fa");
  assert.equal(guessLang("Hello", "Adele"), "en");
  assert.equal(guessLang("Şarkı", "Tarkan"), "tr");
});

test("discoverNew prefers release_date and labels stored honestly", () => {
  const dir = mkdtempSync(join(tmpdir(), "disc-"));
  const catalog = new Catalog(join(dir, "c.db"));
  const A = id("A");
  const B = id("B");
  catalog.stored(A, { title: "Fresh Release", artist: "Band" });
  catalog.stored(B, { title: "Just Archived", artist: "Other" });
  catalog.db.prepare(
    `INSERT OR REPLACE INTO spotify_tracks(video_id, spotify_id, release_date, checked_at)
     VALUES(?,?,?,?)`,
  ).run(A, "sp1", "2026-05-20", NOW);
  catalog.db.prepare("UPDATE songs SET stored_at=? WHERE video_id=?").run(NOW - DAY, A);
  catalog.db.prepare("UPDATE songs SET stored_at=? WHERE video_id=?").run(NOW - 2 * DAY, B);

  const items = discoverNew(catalog, { limit: 10, now: NOW });
  assert.ok(items.some((x) => x.id === `yt_${A}` && x.dateKind === "release"));
  const archived = items.find((x) => x.id === `yt_${B}`);
  assert.ok(archived);
  assert.equal(archived.dateKind, "stored");
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

test("discoverTrending scores recent growth over lifetime", () => {
  const dir = mkdtempSync(join(tmpdir(), "disc-"));
  const catalog = new Catalog(join(dir, "c.db"));
  const HOT = id("H");
  const OLD = id("O");
  catalog.stored(HOT, { title: "Rising", artist: "NewAct" });
  catalog.stored(OLD, { title: "Classic", artist: "OldAct" });
  // Classic: many plays last month only (outside 14d) — should not dominate.
  catalog.recordPlays([
    ...[20, 25, 30, 35].map((d) => ({ videoId: OLD, uid: "u1", at: NOW - d * DAY, source: "disk" })),
    ...[20, 25, 30].map((d) => ({ videoId: OLD, uid: "u2", at: NOW - d * DAY, source: "disk" })),
    // Rising: burst this week
    { videoId: HOT, uid: "u1", at: NOW - DAY, source: "disk" },
    { videoId: HOT, uid: "u2", at: NOW - DAY, source: "disk" },
    { videoId: HOT, uid: "u3", at: NOW - 2 * DAY, source: "disk" },
  ]);

  const { items, mode } = discoverTrending(catalog, { limit: 10, now: NOW, windowMs: 7 * DAY });
  assert.ok(mode === "growth" || mode === "recent_plays");
  assert.ok(items.length >= 1);
  assert.equal(items[0].id, `yt_${HOT}`);
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});
