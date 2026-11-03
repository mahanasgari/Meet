import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { Recommender } from "../src/recommend.js";
import { LastfmClient, LastfmEnricher, cleanTitle } from "../src/lastfm.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fakeFetch = (handler) => {
  const calls = [];
  const f = async (url, opts) => { calls.push(new URL(url)); return handler(new URL(url), opts); };
  f.calls = calls;
  return f;
};
const id = (c) => c.repeat(11);
const [A, B, C, D] = ["A", "B", "C", "D"].map(id);

test("cleanTitle strips YouTube noise and keeps Persian text", () => {
  assert.equal(cleanTitle("Ebi - Khalij Fars (Official Video)", "Ebi"), "Khalij Fars");
  assert.equal(cleanTitle("Song Name [Official Music Video]"), "Song Name");
  assert.equal(cleanTitle("Song (Lyrics)"), "Song");
  assert.equal(cleanTitle("Song | Lyric Video"), "Song");
  assert.equal(cleanTitle("Song (Audio)"), "Song");
  assert.equal(cleanTitle("Song HD"), "Song");
  assert.equal(cleanTitle("Song 4K"), "Song");
  assert.equal(cleanTitle("Song ft. Someone Else"), "Song");
  assert.equal(cleanTitle("Song (feat. Other)"), "Song");
  assert.equal(cleanTitle("Artist - Title", "Artist"), "Title");
  assert.equal(cleanTitle("Some - Thing", "Nobody"), "Some - Thing");
  assert.equal(cleanTitle("خلیج فارس"), "خلیج فارس");
  assert.equal(cleanTitle("ابی - خلیج فارس (موزیک ویدیو)", "ابی"), "خلیج فارس");
});

const lf = (extra = {}) => fakeFetch((u) => {
  const m = u.searchParams.get("method");
  const t = u.searchParams.get("track");
  if (extra.rate) return res(200, { error: 29, message: "Rate limit" });
  if (m === "track.getInfo") {
    if (t === "Missing") return res(200, { error: 6, message: "Track not found" });
    return res(200, { track: { name: t, mbid: "mb1", listeners: "1000", playcount: "5000", artist: { name: "Art" },
      toptags: { tag: [{ name: "pop" }, { name: "persian" }] } } });
  }
  if (m === "track.getSimilar") {
    return res(200, { similartracks: { track: [
      { name: "Other Song", match: 0.9, artist: { name: "Other Artist" } },
      { name: "Far Away", match: 0.5, artist: { name: "Nobody" } },
    ] } });
  }
  if (m === "artist.getInfo") return res(200, { artist: { mbid: "ma", stats: { listeners: "10", playcount: "20" }, tags: { tag: [{ name: "rock" }] } } });
  if (m === "artist.getSimilar") return res(200, { similarartists: { artist: [{ name: "other artist", match: "0.8" }, { name: "Unknown", match: "0.3" }] } });
  return res(404, {});
});

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "lf-"));
  const cat = new Catalog(join(dir, "c.db"));
  const t = cat.db.prepare("INSERT INTO tracks(video_id,title,artists_json,duration_s,first_seen) VALUES(?,?,?,?,?)");
  const a = cat.db.prepare("INSERT INTO artists(id,name) VALUES(?,?)");
  const sa = cat.db.prepare("INSERT INTO song_artists(video_id,artist_id,position) VALUES(?,?,0)");
  a.run("art1", "Art"); a.run("art2", "Other Artist");
  t.run(A, "Seed Song (Official Video)", JSON.stringify([{ id: "art1", name: "Art" }]), 100, 1); sa.run(A, "art1");
  t.run(B, "Other Song", JSON.stringify([{ id: "art2", name: "Other Artist" }]), 100, 2); sa.run(B, "art2");
  t.run(C, "Other Song (Lyrics)", JSON.stringify([{ id: "art2", name: "Other Artist" }]), 100, 3); sa.run(C, "art2");
  t.run(D, "Missing", JSON.stringify([{ id: "art1", name: "Art" }]), 100, 4); sa.run(D, "art1");
  return cat;
}
const quiet = { log() {}, error() {} };

test("client parses track and artist info; error 6 gives null/[]; rate errors throw", async () => {
  const f = lf();
  const c = new LastfmClient({ apiKey: "K", fetch: f });
  const ti = await c.trackInfo("Art", "Song");
  assert.deepEqual(ti, { mbid: "mb1", listeners: 1000, playcount: 5000, tags: ["pop", "persian"], artist: "Art", title: "Song" });
  assert.equal(f.calls[0].searchParams.get("autocorrect"), "1");
  assert.equal(f.calls[0].searchParams.get("format"), "json");
  assert.equal(await c.trackInfo("Art", "Missing"), null);
  assert.equal((await c.trackSimilar("Art", "Song")).length, 2);
  assert.equal((await c.artistInfo("Art")).listeners, 10);
  assert.deepEqual(await c.artistSimilar("Art"), [{ name: "other artist", match: 0.8 }, { name: "Unknown", match: 0.3 }]);
  const nf = new LastfmClient({ apiKey: "K", fetch: fakeFetch(() => res(200, { error: 6 })) });
  assert.deepEqual(await nf.trackSimilar("a", "b"), []);
  await assert.rejects(new LastfmClient({ apiKey: "K", fetch: lf({ rate: true }) }).trackInfo("a", "b"), /rate/);
  await assert.rejects(new LastfmClient({ apiKey: "K", fetch: fakeFetch(() => res(503, {})) }).trackInfo("a", "b"), /rate/);
});

test("enricher saves the track, maps similar songs and artists", async () => {
  const cat = seeded();
  cat.stored(C, { title: "Other Song (Lyrics)" }, 1); // archived copy is preferred over B
  const e = new LastfmEnricher({ catalog: cat, client: new LastfmClient({ apiKey: "K", fetch: lf() }), log: quiet });
  for (let i = 0; i < 4; i++) await e.tick();
  const t = cat.db.prepare("SELECT * FROM lastfm_tracks WHERE video_id=?").get(A);
  assert.equal(t.listeners, 1000);
  assert.deepEqual(JSON.parse(t.tags_json), ["pop", "persian"]);
  const sim = cat.db.prepare("SELECT similar_id, match FROM lastfm_similar WHERE video_id=?").all(A);
  assert.deepEqual(sim.map((r) => [r.similar_id, r.match]), [[C, 0.9]]);
  const names = cat.db.prepare("SELECT artist, title FROM lastfm_similar_names WHERE video_id=?").all(A);
  assert.deepEqual(names.map((r) => [r.artist, r.title]), [["Nobody", "Far Away"]]);
  const asim = cat.db.prepare("SELECT similar_id, match FROM lastfm_artist_similar WHERE artist_id='art1'").all();
  assert.deepEqual(asim.map((r) => [r.similar_id, r.match]), [["art2", 0.8]]);
  assert.equal(cat.db.prepare("SELECT listeners FROM lastfm_artists WHERE artist_id='art1'").get().listeners, 10);
  assert.equal(cat.lastfmInfo(A).listeners, 1000);
});

test("artist is looked up once; not-found track is saved with NULL listeners", async () => {
  const cat = seeded();
  const f = lf();
  const e = new LastfmEnricher({ catalog: cat, client: new LastfmClient({ apiKey: "K", fetch: f }), log: quiet });
  for (let i = 0; i < 4; i++) await e.tick();
  const row = cat.db.prepare("SELECT listeners FROM lastfm_tracks WHERE video_id=?").get(D);
  assert.ok(row);
  assert.equal(row.listeners, null);
  assert.equal(cat.lastfmInfo(D), null);
  assert.equal(f.calls.filter((u) => u.searchParams.get("method") === "artist.getInfo").length, 2); // Art, Other Artist
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM lastfm_tracks").get().n, 4);
});

test("rate limit pauses the enricher and the song is retried", async () => {
  const cat = seeded();
  let t = 1_000_000;
  let limited = true;
  const inner = lf();
  const f = fakeFetch((u, o) => (limited ? res(200, { error: 29 }) : inner(u.href, o)));
  const errors = [];
  const e = new LastfmEnricher({ catalog: cat, client: new LastfmClient({ apiKey: "K", fetch: f }), log: { log() {}, error: (...a) => errors.push(a.join(" ")) }, now: () => t });
  await e.tick();
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM lastfm_tracks").get().n, 0);
  const n = f.calls.length;
  await e.tick();
  assert.equal(f.calls.length, n); // paused
  limited = false;
  t += 16 * 60_000;
  await e.tick();
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM lastfm_tracks").get().n, 1);
  assert.ok(errors.some((m) => m.includes("rate")));
});

test("findSongByName prefers stored songs and tolerates noisy titles", () => {
  const cat = seeded();
  assert.equal(cat.findSongByName("other artist", "Other Song"), B);
  cat.stored(C, { title: "Other Song (Lyrics)" }, 1);
  assert.equal(cat.findSongByName("OTHER ARTIST", "other song"), C);
  assert.equal(cat.findSongByName("Other Artist", "Totally Different"), null);
  assert.equal(cat.findSongByName("Unknown Artist", "Other Song"), null);
});

test("recommender similarTo returns a Last.fm-only neighbour (both directions)", () => {
  const cat = seeded();
  cat.db.prepare("INSERT INTO lastfm_similar(video_id,similar_id,match) VALUES(?,?,?)").run(A, B, 0.8);
  cat.db.prepare("INSERT INTO lastfm_similar(video_id,similar_id,match) VALUES(?,?,?)").run(C, A, 0.5);
  const dir = mkdtempSync(join(tmpdir(), "lfr-"));
  mkdirSync(join(dir, "users"));
  const rec = new Recommender({ catalog: cat, usersDir: join(dir, "users"), now: () => Date.now() });
  const out = rec.similarTo(A);
  const b = out.find((s) => s.videoId === B);
  const c = out.find((s) => s.videoId === C);
  assert.ok(b && c);
  assert.ok(b.score > c.score);
  assert.ok(b.reasons.some((r) => r.includes("Last.fm")));
});
