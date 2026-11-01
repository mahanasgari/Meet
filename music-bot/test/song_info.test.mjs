import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { DeezerClient, ItunesClient, SongInfoEnricher, scoreMatch } from "../src/song_info.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fakeFetch = (handler) => {
  const calls = [];
  const f = async (url) => { calls.push(url); return handler(url); };
  f.calls = calls;
  return f;
};
const dz = (id, title, artist, duration) => ({ id, title, duration, rank: 1000, artist: { name: artist }, album: { title: "Alb" } });

test("scoreMatch weights title, artist and duration", () => {
  const t = { title: "Song", artist: "Artist", durationS: 200 };
  assert.equal(scoreMatch(t, { title: "Song", artists: ["Artist"], durationS: 200 }), 1);
  assert.ok(scoreMatch(t, { title: "Other", artists: ["Nobody"], durationS: 100 }) < 0.75);
});

test("Deezer picks the right candidate and reads track details (bpm 0 = null)", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/search")) {
      assert.ok(url.includes(encodeURIComponent("Artist Song")));
      return res(200, { data: [dz(1, "Song", "Someone Else", 200), dz(2, "Song", "Artist", 300), dz(3, "Song", "Artist", 201)] });
    }
    assert.ok(url.endsWith("/track/3"));
    return res(200, { isrc: "IR3", bpm: 0, release_date: "2020-01-02", rank: 555, album: { title: "Real Album" } });
  });
  const m = await new DeezerClient({ fetch: f }).search({ title: "Song", artist: "Artist", durationS: 200 });
  assert.equal(m.deezerId, 3);
  assert.equal(m.isrc, "IR3");
  assert.equal(m.bpm, null);
  assert.equal(m.rank, 555);
  assert.equal(m.releaseDate, "2020-01-02");
  assert.equal(m.album, "Real Album");
});

test("Deezer quota error and HTTP errors", async () => {
  const quota = fakeFetch(() => res(200, { error: { code: 4, message: "Quota limit exceeded" } }));
  await assert.rejects(new DeezerClient({ fetch: quota }).search({ title: "S", artist: "A" }), /HTTP 429/);
  const bad = fakeFetch(() => res(500, {}));
  await assert.rejects(new DeezerClient({ fetch: bad }).search({ title: "S", artist: "A" }), /deezer: HTTP 500/);
});

test("iTunes matches with 'A & B' artists; null when nothing is good; 403 = 429", async () => {
  const it = (name, artist, ms) => ({ trackId: 7, trackName: name, artistName: artist, primaryGenreName: "Pop", releaseDate: "2019-05-06T07:00:00Z", trackTimeMillis: ms, collectionName: "Coll" });
  const ok = new ItunesClient({ fetch: fakeFetch(() => res(200, { results: [it("Song", "Artist & Other", 200_000)] })) });
  assert.deepEqual(await ok.search({ title: "Song", artist: "Other", durationS: 200 }),
    { itunesId: 7, genre: "Pop", releaseDate: "2019-05-06", album: "Coll", score: 1 });
  const none = new ItunesClient({ fetch: fakeFetch(() => res(200, { results: [it("Nope", "Nobody", 10_000)] })) });
  assert.equal(await none.search({ title: "Song", artist: "Artist", durationS: 200 }), null);
  await assert.rejects(new ItunesClient({ fetch: fakeFetch(() => res(403, {})) }).search({ title: "S", artist: "A" }), /HTTP 429/);
});

function seeded() {
  const cat = new Catalog(join(mkdtempSync(join(tmpdir(), "si-")), "c.db"));
  const ins = cat.db.prepare("INSERT INTO tracks(video_id,title,artists_json,duration_s,first_seen) VALUES(?,?,?,?,?)");
  ins.run("a", "A", JSON.stringify([{ id: "x", name: "Art" }]), 100, 1);
  ins.run("b", "B", null, 100, 2);
  return cat;
}

test("catalog save/read round trip, including both null", () => {
  const cat = seeded();
  assert.deepEqual(cat.nextSongInfo(10).map((t) => t.videoId), ["a", "b"]);
  assert.equal(cat.songInfo("a"), null);
  cat.saveSongInfo("a", {
    deezer: { deezerId: 1, isrc: "I", rank: 9, bpm: 120.5, releaseDate: null, album: null, score: 1 },
    itunes: { itunesId: 2, genre: "Pop", releaseDate: "2020-01-01", album: "Alb", score: 0.9 },
  }, 5);
  cat.saveSongInfo("b", { deezer: null, itunes: null }, 6);
  assert.deepEqual(cat.songInfo("a"), { isrc: "I", rank: 9, bpm: 120.5, releaseDate: "2020-01-01", genre: "Pop", album: "Alb", deezerId: 1, itunesId: 2 });
  assert.deepEqual(cat.songInfo("b"), { isrc: null, rank: null, bpm: null, releaseDate: null, genre: null, album: null, deezerId: null, itunesId: null });
  assert.deepEqual(cat.nextSongInfo(10), []);
  assert.deepEqual(cat.songInfoStats(), { checked: 2, deezer: 1, itunes: 1 });
});

test("enricher saves a lookup, and pauses on 429 without saving", async () => {
  const cat = seeded();
  let t = 0, quota = true;
  const deezer = { search: async () => { if (quota) throw new Error("deezer: HTTP 429 (quota)"); return { deezerId: 1, isrc: "I", score: 1 }; } };
  const itunes = { search: async () => null };
  const log = { error() {}, log() {} };
  const e = new SongInfoEnricher({ catalog: cat, deezer, itunes, log, now: () => t });
  await e.tick();
  assert.equal(cat.songInfoStats().checked, 0);
  quota = false;
  await e.tick(); // still paused
  assert.equal(cat.songInfoStats().checked, 0);
  t = 10 * 60_000 + 1;
  await e.tick();
  assert.deepEqual(cat.songInfoStats(), { checked: 1, deezer: 1, itunes: 0 });
  assert.equal(cat.songInfo("a").isrc, "I"); // the paused track was put back first
});
