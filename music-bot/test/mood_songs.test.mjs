import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { moodShelf, seededShuffle, _clearMoodCache } from "../src/mood_songs.js";

const id = (n) => `vid${String(n).padStart(8, "0")}`;
function seeded(n, prob) {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "mood-")), "c.db"));
  const songs = [];
  for (let i = 0; i < n; i++) songs.push({ videoId: id(i), title: `Song ${i}`, artists: [{ id: "a1", name: "A" }] });
  c.saveArtistPage("a1", { name: "A", subscribers: 1, songs });
  for (let i = 0; i < n; i++) c.saveAnalysis(id(i), { happy: prob(i), sad: 0.1, danceability: 0.9 }, "t");
  return c;
}

test("moodSongs keeps only songs at or above 0.55, ignores errors", () => {
  const c = seeded(10, (i) => (i < 4 ? 0.9 - i * 0.01 : 0.54));
  c.saveAnalysisError(id(11), "boom");
  const r = c.moodSongs("happy", 20);
  assert.deepEqual(r.map((x) => x.videoId), [id(0), id(1), id(2), id(3)]);
  assert.equal(c.moodSongs("sad", 20).length, 0);
  assert.equal(c.moodSongs("dance", 20).length, 10);
  assert.equal(c.moodSongs("nope", 20).length, 0);
});

test("seeded shuffle is deterministic and seed-dependent; shelf is cached", () => {
  const a = Array.from({ length: 30 }, (_, i) => i);
  assert.deepEqual(seededShuffle(a, 5), seededShuffle(a, 5));
  assert.notDeepEqual(seededShuffle(a, 5), seededShuffle(a, 6));
  assert.deepEqual(seededShuffle(a, 5).sort((x, y) => x - y), a);
  _clearMoodCache();
  const c = seeded(30, () => 0.8);
  const s1 = moodShelf(c, "happy", 10, 3);
  assert.equal(s1.songs.length, 10);
  assert.deepEqual(Object.keys(s1.songs[0]).sort(), ["album", "archived", "artists", "durationS", "title", "videoId"]);
  assert.equal(moodShelf(c, "happy", 10, 3), s1); // cached object
  assert.notDeepEqual(moodShelf(c, "happy", 10, 4).songs.map((x) => x.videoId), s1.songs.map((x) => x.videoId));
});

test("moodSongs on 100k analysis rows is fast", () => {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "mood-")), "c.db"));
  c.db.exec("BEGIN");
  const ins = c.db.prepare(`INSERT INTO song_analysis(video_id, happy, analyzed_at) VALUES(?,?,1)`);
  const sg = c.db.prepare(`INSERT INTO songs(video_id, title, artists_json, status, plays) VALUES(?,?,?,?,?)`);
  for (let i = 0; i < 100000; i++) {
    ins.run(id(i), (i * 7919 % 1000) / 1000);
    if (i % 5 === 0) sg.run(id(i), `S${i}`, "[]", i % 2 ? "stored" : "pending", i % 9);
  }
  c.db.exec("COMMIT");
  const t = performance.now();
  const r = c.moodSongs("happy", 160);
  const ms = performance.now() - t;
  console.log(`moodSongs 100k rows: ${ms.toFixed(1)} ms, ${r.length} cards`);
  assert.ok(ms < 50, `${ms} ms`);
});
