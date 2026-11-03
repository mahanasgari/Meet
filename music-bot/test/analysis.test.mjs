import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/catalog.js";
import { handleAnalysis } from "../src/analysis_routes.js";
import { Recommender } from "../src/recommend.js";

const NOW = Date.UTC(2026, 5, 1, 12);
const MIN = 6e4;
const id = (c) => c.repeat(11);
const [A, B, C, D] = ["A", "B", "C", "D"].map(id);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "an-"));
  const c = new Catalog(join(dir, "c.db"));
  return { c, dir, done: () => { c.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const good = { bpm: 120.5, key: "F#", scale: "minor", keyStrength: 0.8, loudness: -9, energy: 0.6, danceability: 0.7,
  happy: 0.2, sad: 0.1, relaxed: 0.3, aggressive: 0.05, party: 0.4, acoustic: 0.1, electronic: 0.9, instrumental: 0.5,
  valence: 0.55, arousal: 0.65, genres: [{ name: "House", p: 0.6 }], model: "effnet-1" };

test("lease: most played first, no double lease, expiry re-offers", () => {
  const { c, done } = setup();
  c.stored(A, { title: "a", durationS: 200 }, NOW);
  c.stored(B, { title: "b", durationS: 200 }, NOW);
  c.stored(C, { title: "long", durationS: 20 * 60 }, NOW);
  c.claim(D, "x", NOW); // pending, never stored
  c.recordPlays([{ videoId: B, at: NOW, source: "disk" }]);
  const j1 = c.leaseAnalysis("s1", 1, NOW);
  assert.deepEqual(j1.map((j) => j.videoId), [B]);
  assert.equal(j1[0].durationS, 200);
  const j2 = c.leaseAnalysis("s2", 5, NOW + MIN);
  assert.deepEqual(j2.map((j) => j.videoId), [A]); // B leased, C too long, D not stored
  assert.deepEqual(c.leaseAnalysis("s2", 5, NOW + 2 * MIN), []);
  // after 30 min the leases expire and the songs are offered again
  const j3 = c.leaseAnalysis("s3", 5, NOW + 32 * MIN);
  assert.deepEqual(j3.map((j) => j.videoId).sort(), [A, B].sort());
  assert.equal(c.analysisStats(NOW + 33 * MIN).leased, 2);
  done();
});

test("save: stored, clamped, validated; analyzed songs are not re-leased", () => {
  const { c, done } = setup();
  c.stored(A, { title: "a", durationS: 200 }, NOW);
  c.leaseAnalysis("s", 1, NOW);
  assert.equal(c.analysisInfo(A), null);
  c.saveAnalysis(A, { ...good, happy: 1.7, sad: -0.2 }, "s", NOW);
  const i = c.analysisInfo(A);
  assert.equal(i.bpm, 120.5);
  assert.equal(i.key, "F#");
  assert.equal(i.mood.happy, 1);
  assert.equal(i.mood.sad, 0);
  assert.deepEqual(i.genres, [{ name: "House", p: 0.6 }]);
  assert.deepEqual(c.leaseAnalysis("s", 1, NOW + 60 * MIN), []);
  assert.deepEqual(c.analysisStats(NOW), { analyzed: 1, failed: 0, leased: 0 });
  for (const bad of [{ bpm: 5 }, { bpm: "x" }, { key: "H" }, { key: "Cb#" }, { scale: "dorian" }, { loudness: 500 }, { genres: "x" }]) {
    assert.throws(() => c.saveAnalysis(A, { ...good, ...bad }, "s", NOW), /invalid_/);
  }
  assert.equal(c.analysisInfo(A).bpm, 120.5); // bad posts changed nothing
  done();
});

test("error result: marked done with the error, never re-offered", () => {
  const { c, done } = setup();
  c.stored(A, { title: "a", durationS: 200 }, NOW);
  c.leaseAnalysis("s", 1, NOW);
  c.saveAnalysisError(A, "decode failed", NOW);
  assert.equal(c.analysisInfo(A), null);
  assert.deepEqual(c.leaseAnalysis("s", 1, NOW + 99 * MIN), []);
  assert.deepEqual(c.analysisStats(NOW), { analyzed: 0, failed: 1, leased: 0 });
  done();
});

function call(catalog, { method = "POST", path, body = {}, isMaster = true, headers = {} }) {
  const out = {};
  const res = {};
  const sendJson = (_r, status, json) => { out.status = status; out.json = json; };
  const req = { method, headers };
  const url = new URL(`http://x${path}`);
  return handleAnalysis({ req, res, url, catalog, archive: null, isMaster, readBody: async () => body, sendJson, now: () => NOW })
    .then(() => out);
}

test("routes: master token only; lease and result round trip", async () => {
  const { c, done } = setup();
  c.stored(A, { title: "a", durationS: 200 }, NOW);
  assert.equal((await call(c, { path: "/analysis/lease", isMaster: false })).status, 401);
  assert.equal((await call(c, { path: "/analysis/result", isMaster: false, body: { videoId: A, ...good } })).status, 401);
  assert.equal((await call(c, { method: "GET", path: `/analysis/audio?id=${A}`, isMaster: false })).status, 401);
  assert.equal((await call(null, { path: "/analysis/lease" })).status, 404);
  const lease = await call(c, { path: "/analysis/lease", body: { n: 2 }, headers: { "x-mp-server": "de1" } });
  assert.equal(lease.status, 200);
  assert.deepEqual(lease.json.jobs, [{ videoId: A, durationS: 200 }]);
  assert.equal((await call(c, { path: "/analysis/result", body: { videoId: "bad", ...good } })).status, 400);
  assert.equal((await call(c, { path: "/analysis/result", body: { videoId: A, ...good, bpm: 9999 } })).json.error, "invalid_bpm");
  assert.equal((await call(c, { path: "/analysis/result", body: { videoId: A, ...good } })).status, 200);
  assert.equal(c.analysisInfo(A).scale, "minor");
  assert.equal((await call(c, { method: "GET", path: `/analysis/audio?id=${A}` })).json.error, "not_stored");
  assert.equal((await call(c, { path: "/analysis/result", body: { videoId: B, error: "boom" } })).status, 200);
  assert.equal((await call(c, { path: "/analysis/nope" })).status, 404);
  done();
});

test("recommender: sound-alike factor breaks ties by up to 15%", () => {
  const { c, dir, done } = setup();
  for (const x of [A, B, C]) c.stored(x, { title: x, durationS: 200 }, NOW);
  c.setRelated(A, [{ id: B, kind: "related", rank: 0 }, { id: C, kind: "related", rank: 0 }]);
  const rec = new Recommender({ catalog: c, usersDir: dir, now: () => NOW });
  const plain = rec.similarTo(A);
  assert.equal(plain.length, 2);
  assert.equal(plain[0].score, plain[1].score);
  const calm = { ...good, energy: 0.2, danceability: 0.2, happy: 0.5, sad: 0.5, relaxed: 0.9, aggressive: 0, party: 0.1, valence: 0.5, arousal: 0.2 };
  const loud = { ...calm, energy: 0.95, relaxed: 0.1, aggressive: 0.8, party: 0.9, arousal: 0.9 };
  c.saveAnalysis(A, calm, "s", NOW);
  c.saveAnalysis(B, calm, "s", NOW);
  c.saveAnalysis(C, loud, "s", NOW);
  const r = rec.similarTo(A);
  assert.equal(r[0].videoId, B);
  assert.equal(r[0].score, 1);
  const ratio = r[1].score / r[0].score;
  assert.ok(ratio < 1 && ratio > 1.0 / 1.15 - 1e-9, `ratio ${ratio}`);
  // a candidate without analysis is neither boosted nor dropped
  c.saveAnalysisError(C, "x", NOW);
  assert.equal(rec.similarTo(A).length, 2);
  done();
});
