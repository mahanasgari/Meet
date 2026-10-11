import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/catalog.js";
import { Recommender } from "../src/recommend.js";

const MIN = 6e4;
const DAY = 864e5;
const NOW = Date.UTC(2026, 5, 1, 12);
const id = (c) => c.repeat(11);
const [A, B, C, D, E, F, G] = ["A", "B", "C", "D", "E", "F", "G"].map(id);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  const usersDir = join(dir, "users");
  mkdirSync(usersDir);
  const catalog = new Catalog(join(dir, "c.db"));
  const rec = new Recommender({ catalog, usersDir, now: () => NOW });
  const cleanup = () => { catalog.close(); rmSync(dir, { recursive: true, force: true }); };
  return { catalog, usersDir, rec, cleanup };
}
// Plays of one listener, gap minutes apart, ending `endAgoMs` before NOW.
const seq = (uid, ids, { gap = 5, start = NOW - 20 * DAY } = {}) =>
  ids.map((videoId, i) => ({ videoId, uid, at: start + i * gap * MIN, source: "disk" }));

test("co-listening: closer and repeated pairs are more similar", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.recordPlays([...seq("x", [A, B, C]), ...seq("y", [A, B], { start: NOW - 10 * DAY })]);
  rec.build({ force: true });
  const nb = rec.similarTo(A).map((s) => s.videoId);
  assert.deepEqual(nb, [B, C]);
  const [b, c] = rec.similarTo(A);
  assert.ok(b.score > c.score);
  assert.equal(b.score, 1);
  assert.deepEqual(rec.stats().listeners, 2);
  assert.equal(rec.stats().sessions, 2);
  assert.equal(rec.stats().songsWithNeighbors, 3);
  assert.equal(rec.stats().pairs, 3);
  cleanup();
});

test("a 31 minute gap splits sessions, 30 does not", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.recordPlays([...seq("x", [A, B], { gap: 31 }), ...seq("y", [C, D], { gap: 30 })]);
  rec.build({ force: true });
  assert.equal(rec.stats().sessions, 3);
  assert.deepEqual(rec.similarTo(A), []);
  assert.deepEqual(rec.similarTo(C).map((s) => s.videoId), [D]);
  cleanup();
});

test("peer-sourced plays are ignored for sessions", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.recordPlays(seq("x", [A, B]).map((p) => ({ ...p, source: "peer" })));
  rec.build({ force: true });
  assert.equal(rec.stats().listeners, 0);
  cleanup();
});

test("sync files with yt_ prefix are used", () => {
  const { usersDir, rec, cleanup } = setup();
  const line = (idv, ts, extra = {}) => JSON.stringify({ t: "play", id: idv, ti: "T " + idv[3], a: "Art", ts, ...extra });
  writeFileSync(join(usersDir, "anon1.jsonl"), [
    line("yt_" + A, NOW - DAY), line("yt_" + B, NOW - DAY + 5 * MIN),
    JSON.stringify({ t: "skip", id: C, ts: NOW - DAY + 6 * MIN }), line("bad", NOW - DAY),
  ].join("\n") + "\n");
  rec.build({ force: true });
  assert.equal(rec.stats().listeners, 1);
  const s = rec.similarTo(A);
  assert.equal(s.length, 1);
  assert.equal(s[0].videoId, B);
  assert.equal(s[0].title, "T " + B[3]); // title fallback from sync file
  cleanup();
});

test("similarTo merges graph, co-listening and artist signals", () => {
  const { catalog, rec, cleanup } = setup();
  const art = { id: "UC1", name: "Seed Artist" };
  catalog.stored(A, { title: "Seed", artist: "Seed Artist", artists: [art], ytChannelId: "UC1" });
  catalog.stored(B, { title: "Same Artist Song", artist: "Seed Artist" });
  catalog.stored(C, { title: "Graph Song", artist: "Other" });
  catalog.stored(D, { title: "Friends Song", artist: "Third" });
  catalog.saveGraph(A, {
    upNext: [{ videoId: C, title: "Graph Song", artists: [{ id: "UC3", name: "Other" }] }],
    related: [{ videoId: E, title: "Crawled Only", artists: [{ id: "UC9", name: "Nine" }] }],
    similarArtists: [{ id: "UC2", name: "Like Artist" }],
  });
  catalog.saveGraph(F, { upNext: [{ videoId: G, title: "Like Song", artists: [{ id: "UC2", name: "Like Artist" }] }] });
  catalog.recordPlays([...seq("x", [A, D]), ...seq("y", [A, D, C], { start: NOW - 5 * DAY })]);
  catalog.stored(F, { title: "Whatever", artist: "Like Artist", artists: [{ id: "UC2", name: "Like Artist" }] });
  rec.build({ force: true });
  const res = rec.similarTo(A, { limit: 20 });
  const by = Object.fromEntries(res.map((r) => [r.videoId, r]));
  assert.ok(!by[A], "seed excluded");
  assert.ok(by[B] && by[C] && by[D] && by[E]);
  assert.equal(res[0].videoId, D); // strongest co-listening
  assert.ok(by[C].score > by[B].score); // graph + co-listening beats same artist
  assert.match(by[C].reasons.join("|"), /Up next after Seed on YouTube Music/);
  assert.match(by[C].reasons.join("|"), /Friends who play Seed also play this/);
  assert.match(by[D].reasons[0], /Friends who play Seed also play this/);
  assert.deepEqual(by[B].reasons, ["Also by Seed Artist"]);
  assert.match(by[E].reasons[0], /Related to Seed/);
  assert.equal(by[E].title, "Crawled Only"); // from tracks
  assert.equal(by[E].archived, false);
  assert.equal(by[B].archived, true);
  assert.ok(by[G] || by[F], "similar artist's songs appear");
  assert.match((by[F] ?? by[G]).reasons[0], /similar to Seed Artist/);
  assert.ok(res.every((r) => r.score >= 0 && r.score <= 1));
  assert.equal(res[0].score, 1);
  cleanup();
});

test("forUser: filters known songs, weights recency, limits two per artist", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.stored(A, { title: "Old Seed", artist: "S1" });
  catalog.stored(B, { title: "New Seed", artist: "S2" });
  const cs = ["C", "D", "E", "F", "G"].map(id);
  cs.forEach((v, i) => catalog.stored(v, { title: "Cand " + i, artist: "Same" }));
  catalog.stored(id("H"), { title: "Other Artist Song", artist: "Diff" });
  catalog.stored(id("I"), { title: "Gone", artist: "Diff2" });
  catalog.failed(id("I"), "s", "x", { unavailable: true });
  // me: old seed 40 days ago, new seed 1 day ago
  catalog.recordPlays([
    { videoId: A, uid: "me", at: NOW - 40 * DAY, source: "disk" },
    { videoId: B, uid: "me", at: NOW - DAY, source: "disk" },
  ]);
  // graph: both seeds lead to the same candidates and H, I
  for (const s of [A, B]) {
    catalog.setRelated(s, [...cs, id("H"), id("I")].map((c, i) => ({ id: c, kind: "related", rank: i })));
  }
  // recently played (C), over-played (D)
  catalog.recordPlays([
    { videoId: cs[0], uid: "me", at: NOW - 2 * DAY, source: "disk" },
    ...[30, 31, 32, 33].map((d) => ({ videoId: cs[1], uid: "me", at: NOW - d * DAY, source: "disk" })),
  ]);
  rec.build({ force: true });
  const res = rec.forUser("me");
  assert.equal(res.uid, "me");
  const seedW = Object.fromEntries(res.seeds.map((s) => [s.videoId, s.weight]));
  assert.ok(seedW[B] > seedW[A]);
  const ids = res.items.map((i) => i.videoId);
  assert.ok(!ids.includes(cs[0]) && !ids.includes(cs[1]), "known songs dropped");
  assert.ok(!ids.includes(id("I")), "unavailable dropped");
  assert.ok(ids.includes(id("H")));
  assert.equal(res.items.filter((i) => i.artist === "Same").length, 2);
  for (const it of res.items) assert.ok(it.reasons.length >= 1 && it.reasons.length <= 2);
  assert.match(res.items[0].reasons[0], /^Because you played /);
  assert.equal(res.items[0].score, 1);
  cleanup();
});

test("forUser cold start returns friends' popular songs", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.stored(A, { title: "Hit", artist: "X" });
  catalog.recordPlays([
    { videoId: A, uid: "f1", at: NOW - DAY, source: "disk" },
    { videoId: A, uid: "f2", at: NOW - DAY, source: "disk" },
    { videoId: B, uid: "f1", at: NOW - 2 * DAY, source: "disk" },
    { videoId: C, uid: "f1", at: NOW - 30 * DAY, source: "disk" }, // too old for popularity
  ]);
  const res = rec.forUser("newbie");
  assert.deepEqual(res.seeds, []);
  assert.deepEqual(res.items.map((i) => i.videoId), [A, B]);
  assert.deepEqual(res.items[0].reasons, ["Popular with friends"]);
  assert.equal(res.items[0].title, "Hit");
  assert.deepEqual(rec.users().map((u) => u.uid).sort(), ["f1", "f2"]);
  assert.equal(rec.users().find((u) => u.uid === "f1").plays, 3);
  cleanup();
});

test("model is cached for 30 minutes", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.recordPlays(seq("x", [A, B]));
  rec.build();
  const first = rec.stats().builtAt;
  catalog.recordPlays(seq("y", [C, D]));
  rec.build();
  assert.equal(rec.stats().listeners, 1);
  rec.build({ force: true });
  assert.equal(rec.stats().listeners, 2);
  assert.equal(rec.stats().builtAt, first);
  cleanup();
});
