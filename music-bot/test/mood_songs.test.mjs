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
  // prob(i) in 0..1 drives a clearly happy (high) or clearly sad (low) profile.
  for (let i = 0; i < n; i++) {
    const h = prob(i);
    c.saveAnalysis(id(i), { happy: h, sad: 1 - h, valence: h, arousal: 0.5, relaxed: 0.5, energy: 0.5, aggressive: 0.1, party: 0.5,
      danceability: 0.9, scale: h > 0.5 ? "major" : "minor" }, "t");
  }
  c.mood.ensureCalibrated(Date.now(), true); // percentiles over the whole seeded set
  return c;
}

test("moodSongs ranks by felt score: happy ones for happy, sad ones for sad, errors ignored", () => {
  const c = seeded(10, (i) => (i < 4 ? 0.95 - i * 0.01 : 0.05 + i * 0.01));
  c.saveAnalysisError(id(11), "boom");
  assert.deepEqual(c.moodSongs("happy", 20).map((x) => x.videoId), [id(0), id(1), id(2), id(3)]);
  assert.ok(c.moodSongs("sad", 20).length >= 5);
  assert.deepEqual(c.moodSongs("relaxed", 20), c.moodSongs("chill", 20)); // old names still work
  assert.equal(c.moodSongs("nope", 20).length, 0);
});

test("seeded shuffle is deterministic and seed-dependent; shelf is cached", () => {
  const a = Array.from({ length: 30 }, (_, i) => i);
  assert.deepEqual(seededShuffle(a, 5), seededShuffle(a, 5));
  assert.notDeepEqual(seededShuffle(a, 5), seededShuffle(a, 6));
  assert.deepEqual(seededShuffle(a, 5).sort((x, y) => x - y), a);
  _clearMoodCache();
  const c = seeded(30, (i) => 0.7 + i / 100);
  const s1 = moodShelf(c, "happy", 10, 3);
  assert.equal(s1.songs.length, 10);
  assert.deepEqual(Object.keys(s1.songs[0]).sort(), ["album", "archived", "artists", "durationS", "title", "videoId"]);
  assert.equal(moodShelf(c, "happy", 10, 3), s1); // cached object
  assert.notDeepEqual(moodShelf(c, "happy", 10, 4).songs.map((x) => x.videoId), s1.songs.map((x) => x.videoId));
});

test("moodSongs on 100k analysis rows: calibration bounded, warm calls fast", () => {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "mood-")), "c.db"));
  c.db.exec("BEGIN");
  const ins = c.db.prepare(`INSERT INTO song_analysis(video_id, happy, sad, valence, arousal, danceability, analyzed_at) VALUES(?,?,?,?,?,?,1)`);
  const sg = c.db.prepare(`INSERT INTO songs(video_id, title, artists_json, status, plays) VALUES(?,?,?,?,?)`);
  for (let i = 0; i < 100000; i++) {
    const x = (i * 7919 % 1000) / 1000;
    ins.run(id(i), x, 1 - x, x, 0.5, 0.9);
    if (i % 5 === 0 || i % 20 === 19) sg.run(id(i), `S${i}`, "[]", i % 2 ? "stored" : "pending", i % 9);
  }
  c.db.exec("COMMIT");
  let t = performance.now();
  c.mood.ensureCalibrated();
  const cold = performance.now() - t;
  t = performance.now();
  const r = c.moodSongs("happy", 160);
  const ms = performance.now() - t;
  console.log(`mood calibration 100k rows: ${cold.toFixed(1)} ms; moodSongs warm: ${ms.toFixed(1)} ms, ${r.length} cards`);
  assert.ok(cold < 250, `${cold} ms`);
  assert.ok(ms < 150, `${ms} ms`);
});
