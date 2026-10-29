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

test("forUser cold start returns friends' popular songs (untitled ones are skipped)", () => {
  const { catalog, rec, cleanup } = setup();
  catalog.stored(A, { title: "Hit", artist: "X" });
  catalog.stored(B, { title: "Other", artist: "Y" });
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

// ---------- v2: skips, likes, dislikes ----------

const ev = (t, idv, ts, extra = {}) => JSON.stringify({ t, id: "yt_" + idv, ts, ...extra });
const writeSync = (usersDir, name, lines) => writeFileSync(join(usersDir, `${name}.jsonl`), lines.join("\n") + "\n");

test("a linked sync file replaces the invite's server plays where it covers them: skipped songs drop out", () => {
  const { catalog, usersDir, rec, cleanup } = setup();
  const t0 = NOW - 2 * DAY;
  // The server saw A, B, C played (B was really skipped after 3 s).
  catalog.recordPlays(seq("u1", [A, B, C], { start: t0 }));
  writeSync(usersDir, "abcdef0123456789", [ev("play", A, t0), ev("skip", B, t0 + 5 * MIN, { s: 3 }), ev("play", C, t0 + 10 * MIN)]);
  writeFileSync(join(usersDir, "links.json"), JSON.stringify({ abcdef0123456789: "u1" }));
  rec.build({ force: true });
  assert.equal(rec.stats().listeners, 1, "one listener, not two");
  assert.deepEqual(rec.similarTo(A).map((s) => s.videoId), [C], "B was skipped, so it isn't co-listened");
  assert.deepEqual(rec.stats().feedback, { listeners: 1, skips: 1, likes: 0 });
  cleanup();
});

test("songs most people skip rank lower; a skip right after a song weakens that pair", () => {
  const { catalog, usersDir, rec, cleanup } = setup();
  // A is followed by both B and C equally often on the server.
  catalog.recordPlays([...seq("x", [A, B]), ...seq("y", [A, C]), ...seq("z", [A, B], { start: NOW - 5 * DAY }), ...seq("w", [A, C], { start: NOW - 5 * DAY })]);
  const before = rec.similarTo(A).map((s) => s.videoId);
  assert.equal(before.length, 2);
  // Another listener plays A and skips C straight after, twice.
  writeSync(usersDir, "s1", [ev("play", A, NOW - DAY), ev("skip", C, NOW - DAY + MIN), ev("play", A, NOW - 3 * DAY), ev("skip", C, NOW - 3 * DAY + MIN)]);
  rec.build({ force: true });
  const [first, second] = rec.similarTo(A);
  assert.equal(first.videoId, B);
  assert.equal(second.videoId, C);
  assert.ok(second.score < 0.5, `C sinks (score ${second.score})`);
  cleanup();
});

test("forUser: no disliked, liked or skipped-only songs; songs like a disliked one sink", () => {
  const { catalog, usersDir, rec, cleanup } = setup();
  // Everyone else: A goes with B, C, D; E goes with D.
  catalog.recordPlays([
    ...seq("o1", [A, B, C, D]), ...seq("o2", [A, B, C, D], { start: NOW - 6 * DAY }),
    ...seq("o3", [E, D], { start: NOW - 4 * DAY }), ...seq("o4", [E, D], { start: NOW - 3 * DAY }),
  ]);
  for (const [v, a] of [[A, "a1"], [B, "a2"], [C, "a3"], [D, "a4"], [E, "a5"], [G, "a6"]]) catalog.stored(v, { title: `Song ${v[0]}`, artist: a });
  writeSync(usersDir, "me", [
    ev("play", A, NOW - 30 * DAY), ev("skip", B, NOW - 30 * DAY + MIN), ev("like", G, NOW - 29 * DAY), ev("dislike", E, NOW - 28 * DAY),
  ]);
  rec.build({ force: true });
  const ids = rec.forUser("me", { limit: 10 }).items.map((x) => x.videoId);
  assert.ok(!ids.includes(B), "skipped and never played through");
  assert.ok(!ids.includes(E), "disliked");
  assert.ok(!ids.includes(G), "already liked");
  assert.ok(ids.includes(C), "still suggests the rest");
  assert.ok(ids.indexOf(C) < ids.indexOf(D), "D is like the disliked E, so it comes after C");
  cleanup();
});

test("stats: how songs started from each place fare", () => {
  const { usersDir, rec, cleanup } = setup();
  writeSync(usersDir, "s1", [
    ev("play", A, NOW - DAY, { ctx: "picks" }), ev("skip", B, NOW - DAY + MIN, { ctx: "picks" }), ev("play", C, NOW - DAY + 2 * MIN, { ctx: "autoplay" }),
  ]);
  rec.build({ force: true });
  assert.deepEqual(rec.stats().origins, { picks: { plays: 1, skips: 1 }, autoplay: { plays: 1, skips: 0 } });
  cleanup();
});

test("a linked sync file keeps the listener's server plays from other devices", () => {
  const { catalog, usersDir, rec, cleanup } = setup();
  const t0 = NOW - 2 * DAY;
  // Phone (not syncing) plays D, E in the middle of the PC's synced stretch.
  catalog.recordPlays([...seq("u1", [A, B], { start: t0 }), ...seq("u1", [D, E], { start: t0 + DAY })]);
  writeSync(usersDir, "pc", [ev("play", A, t0 + 4 * MIN), ev("skip", B, t0 + 6 * MIN), ev("play", C, t0 + 2 * DAY)]);
  writeFileSync(join(usersDir, "links.json"), JSON.stringify({ pc: "u1" }));
  rec.build({ force: true });
  assert.deepEqual(rec.similarTo(D).map((s) => s.videoId), [E], "the phone's session survives");
  assert.deepEqual(rec.similarTo(A), [], "B was a skip, not a play");
  cleanup();
});
