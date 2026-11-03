import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { DiscogsClient, DiscogsEnricher } from "../src/discogs.js";
import { SongLinks, OdesliBusy } from "../src/odesli.js";
import { cleanTag } from "../src/search_text.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const quiet = { log() {}, error() {} };
const id = (c) => c.repeat(11);
const [A, B, C] = ["A", "B", "C"].map(id);
const DAY = 864e5;

function clock() {
  const c = { t: 1_000_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}
const mk = () => new Catalog(join(mkdtempSync(join(tmpdir(), "dg-")), "c.db"));
function seeded() {
  const cat = mk();
  const t = cat.db.prepare("INSERT INTO tracks(video_id,title,artists_json,duration_s,first_seen) VALUES(?,?,?,?,?)");
  t.run(A, "Seed Song (Official Video)", JSON.stringify([{ id: "art1", name: "Art" }]), 100, 1);
  t.run(B, "Other Song", JSON.stringify([{ id: "art2", name: "Other" }]), 100, 2);
  t.run(C, "Third", JSON.stringify([{ id: "art2", name: "Other" }]), 100, 3);
  return cat;
}

const results = [
  { id: 1, title: "Nobody - Unrelated", year: "1999", genre: ["Rock"], style: [] },
  { id: 2, master_id: 22, title: "Art - Seed Song", year: "2005", country: "Iran", genre: ["Pop", "Electronic"], style: ["Synth-pop"], label: ["Lab One", "Lab Two"] },
];

test("client: headers, pacing, best result by artist/track, rate error", async () => {
  const c = clock(), calls = [];
  const f = async (url, opts) => { calls.push({ u: new URL(url), opts, t: c.t }); return res(200, { results }); };
  const cl = new DiscogsClient({ token: "TK", fetch: f, sleep: c.sleep, now: c.now });
  const r = await cl.searchRelease("Art", "Seed Song");
  assert.deepEqual(r, { releaseId: 2, masterId: 22, year: 2005, genres: ["Pop", "Electronic"], styles: ["Synth-pop"], country: "Iran", label: "Lab One" });
  assert.equal(calls[0].opts.headers.Authorization, "Discogs token=TK");
  assert.match(calls[0].opts.headers["User-Agent"], /MiniPlayer\/1\.0/);
  assert.equal(calls[0].u.searchParams.get("type"), "release");
  assert.equal(calls[0].u.searchParams.get("per_page"), "5");
  await cl.searchRelease("Art", "Seed Song");
  assert.ok(calls[1].t - calls[0].t >= 1100);
  const none = new DiscogsClient({ token: "x", fetch: async () => res(200, { results: [results[0]] }), sleep: c.sleep, now: c.now });
  assert.equal(await none.searchRelease("Art", "Seed Song"), null);
  const rate = new DiscogsClient({ token: "x", fetch: async () => res(429, {}), sleep: c.sleep, now: c.now });
  await assert.rejects(rate.searchRelease("Art", "Seed Song"), /rate/);
});

test("enricher saves releases (even not found) and tags; rate limit backs off with doubling", async () => {
  const cat = seeded(), c = clock();
  const f = async (url) => {
    const a = new URL(url).searchParams.get("artist");
    return res(200, { results: a === "Art" ? results : [] });
  };
  const e = new DiscogsEnricher({ catalog: cat, client: new DiscogsClient({ token: "t", fetch: f, sleep: c.sleep, now: c.now }), log: quiet, now: c.now });
  for (let i = 0; i < 4; i++) await e.tick();
  assert.equal(cat.discogsInfo(A).year, 2005);
  assert.equal(cat.discogsInfo(B), null);
  assert.equal(cat.discogsStats().checked, 3);
  assert.equal(cat.discogsStats().found, 1);
  assert.deepEqual(cat.tagsOf(A).map((t) => t.tag).sort(), ["electronic", "pop", "synth-pop"]);
  assert.ok(cat.tagsOf(A).every((t) => t.src === "discogs" && t.weight === 1));
  // rate limit
  const cat2 = seeded();
  let calls = 0;
  const e2 = new DiscogsEnricher({ catalog: cat2, client: { searchRelease: async () => { calls++; throw new Error("discogs: rate limited HTTP 429"); } }, log: quiet, now: c.now });
  await e2.tick(); await e2.tick();
  assert.equal(calls, 1); // paused
  c.t += 31_000; await e2.tick();
  c.t += 31_000; await e2.tick(); // second pause is 60 s
  assert.equal(calls, 2);
  c.t += 60_000; await e2.tick();
  assert.equal(calls, 3);
  assert.equal(cat2.discogsStats().checked, 0);
});

test("tags: junk filter", () => {
  for (const j of ["seen live", "Favorites", "albums i own", "2010", "1999s", "x".repeat(41), "", "  "]) assert.equal(cleanTag(j), null, j);
  assert.equal(cleanTag("  Persian Pop "), "persian pop");
});

test("song_tags from lastfm (weight by position), analysis genres and one mood", () => {
  const cat = seeded();
  cat.saveLastfm({ videoId: A, track: { listeners: 10, playcount: 20, tags: ["Pop", "seen live", "Persian", "rock"] } }, 5);
  const t = Object.fromEntries(cat.tagsOf(A).map((x) => [x.tag, x.weight]));
  assert.deepEqual(Object.keys(t).sort(), ["persian", "pop", "rock"]);
  assert.equal(t.pop, 1);
  assert.ok(Math.abs(t.rock - 0.3) < 1e-9);
  cat.saveAnalysis(B, { bpm: 100, happy: 0.3, sad: 0.8, relaxed: 0.7, genres: [{ name: "Jazz", p: 0.5 }] }, "srv", 5);
  const u = cat.tagsOf(B);
  const sadTag = u.find((x) => x.src === "mood"); // felt label of a one-song catalog
  assert.deepEqual(u.filter((x) => x.src !== "mood").map((x) => [x.tag, x.src, x.weight]), [["jazz", "analysis", 0.5]]);
  assert.ok(sadTag && ["sad", "happy", "relaxed", "party", "aggressive"].includes(sadTag.tag), JSON.stringify(u));
  cat.saveAnalysis(C, { happy: 0.5, sad: 0.5 }, "srv", 5);
  assert.ok(cat.tagsOf(C).every((x) => x.src === "mood")); // no genres
  // re-saving replaces that source's tags
  cat.saveLastfm({ videoId: A, track: { listeners: 1, tags: ["metal"] } }, 6);
  assert.deepEqual(cat.tagsOf(A).map((x) => x.tag).sort(), ["metal"]);
});

test("backfill copies old lastfm and analysis rows in windows, remembers progress, stops", () => {
  const cat = seeded();
  const ins = cat.db.prepare("INSERT INTO lastfm_tracks(video_id,listeners,tags_json,checked_at) VALUES(?,?,?,1)");
  for (let i = 0; i < 25; i++) ins.run(`vid${String(i).padStart(8, "0")}`, 5, JSON.stringify(["pop", "tag" + i]));
  ins.run("nulltags0001", null, null);
  cat.db.prepare("INSERT INTO song_analysis(video_id,genres_json,sad,happy,analyzed_at) VALUES(?,?,?,?,1)").run(B, JSON.stringify([{ name: "Jazz", p: 0.4 }]), 0.9, 0.1);
  cat.db.prepare("INSERT INTO song_analysis(video_id,lease_until) VALUES(?,5)").run(C);
  let ticks = 0, n = 0, r;
  do { r = cat.backfillSongTags(10); n += r.n; ticks++; } while (!r.done && ticks < 20);
  assert.equal(n, 26);
  assert.equal(ticks, 3 + 1 + 1); // 26 rows in windows of 10, analysis window, final done tick
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM song_tags WHERE tag='pop'").get().n, 25);
  assert.deepEqual(cat.tagsOf(B).map((x) => x.tag).sort(), ["jazz", "sad"]);
  assert.deepEqual(cat.tagsOf(C), []);
  assert.deepEqual(cat.backfillSongTags(10), { done: true, n: 0 });
  assert.ok(JSON.parse(cat.db.prepare("SELECT value FROM meta WHERE key='song_tags_backfill'").get().value).d);
});

const odesliBody = { pageUrl: "https://song.link/y/abc", linksByPlatform: {
  spotify: { url: "https://open.spotify.com/track/1" }, appleMusic: { url: "https://music.apple.com/x" },
  youtube: { url: "https://youtube.com/watch?v=a" }, napster: { url: "https://n" } } };

test("odesli: fetch, cache 30 days, empty on 404, no key", async () => {
  const cat = seeded(), c = clock(), calls = [];
  const f = async (url) => { calls.push(new URL(url)); return url.includes(B) ? res(404, {}) : res(200, odesliBody); };
  const s = new SongLinks({ catalog: cat, fetch: f, sleep: c.sleep, now: c.now });
  const r = await s.get(A);
  assert.equal(r.pageUrl, "https://song.link/y/abc");
  assert.deepEqual(Object.keys(r.links).sort(), ["appleMusic", "spotify", "youtube"]);
  assert.equal(calls[0].searchParams.get("url"), `https://music.youtube.com/watch?v=${A}`);
  assert.equal(calls[0].searchParams.get("key"), null);
  await s.get(A);
  assert.equal(calls.length, 1); // cached
  c.t += 31 * DAY;
  await s.get(A);
  assert.equal(calls.length, 2); // expired
  assert.deepEqual((await s.get(B)).links, {});
  await s.get(B);
  assert.equal(calls.length, 3); // empty result cached too
});

test("odesli: calls are 6 s apart; too long a queue gives busy", async () => {
  const cat = seeded(), c = clock(), at = [];
  const f = async () => { at.push(c.t); return res(200, odesliBody); };
  const s = new SongLinks({ catalog: cat, fetch: f, sleep: c.sleep, now: c.now });
  const ids = ["a", "b", "c", "d"].map((x) => x.repeat(11));
  const first = [s.get(ids[0]), s.get(ids[1]), s.get(ids[2]), s.get(ids[3])]; // waits 0, 6, 12, 18 s
  await assert.rejects(s.get("e".repeat(11)), (e) => e instanceof OdesliBusy); // would wait 24 s
  await Promise.all(first);
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 6000);
});
