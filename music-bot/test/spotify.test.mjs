import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { SpotifyClient, SpotifyEnricher, norm } from "../src/spotify.js";

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const item = (id, name, artist, ms) => ({
  id, name, duration_ms: ms, popularity: 50, explicit: false, track_number: 2,
  external_ids: { isrc: "IR" + id }, artists: [{ id: "ar" + id, name: artist }],
  album: { id: "al" + id, name: "Album", album_type: "album", release_date: "2020-01-01" },
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts, calls); };
  f.calls = calls;
  return f;
}

test("norm: case, punctuation, brackets and Persian letter variants", () => {
  assert.equal(norm("Hello, World! (Official Video) [HD] (feat. X)"), "helloworld");
  assert.equal(norm("علي كريمي"), norm("علی کریمی"));
});

test("token is cached and refreshed on 401", async () => {
  let t = 0, tokens = 0;
  const f = fakeFetch((url, opts) => {
    if (url.includes("/api/token")) {
      assert.equal(opts.body, "grant_type=client_credentials");
      assert.equal(opts.headers.Authorization, "Basic " + Buffer.from("id:sec").toString("base64"));
      return res(200, { access_token: "T" + ++tokens, expires_in: 3600 });
    }
    if (opts.headers.Authorization === "Bearer T1" && url.endsWith("/stale")) return res(401, {});
    return res(200, { ok: opts.headers.Authorization });
  });
  const c = new SpotifyClient({ clientId: "id", clientSecret: "sec", fetch: f, now: () => t });
  await c.get("/a"); await c.get("/b");
  assert.equal(tokens, 1);
  assert.deepEqual(await c.get("/stale"), { ok: "Bearer T2" });
  assert.equal(tokens, 2);
  t = 3600_000; // inside the last minute: fetch a new one
  await c.get("/c");
  assert.equal(tokens, 3);
});

test("429 sets retryAfterMs and throws", async () => {
  const f = fakeFetch((url) => url.includes("/api/token") ? res(200, { access_token: "T", expires_in: 3600 }) : res(429, {}, { "retry-after": "7" }));
  const c = new SpotifyClient({ clientId: "i", clientSecret: "s", fetch: f });
  await assert.rejects(c.get("/x"), /HTTP 429/);
  assert.equal(c.retryAfterMs, 7000);
});

const searchClient = (items) => new SpotifyClient({
  clientId: "i", clientSecret: "s",
  fetch: fakeFetch((url) => url.includes("/api/token") ? res(200, { access_token: "T", expires_in: 3600 }) : res(200, { tracks: { items } })),
});

test("searchTrack picks the right result and returns null when none is good", async () => {
  const c = searchClient([
    item("1", "Song", "Someone Else", 200_000),
    item("2", "Song", "Artist", 300_000),
    item("3", "Song", "Artist", 200_500),
  ]);
  const m = await c.searchTrack({ title: "Song (Official Video)", artist: "Artist", durationS: 200 });
  assert.equal(m.id, "3");
  assert.equal(m.isrc, "IR3");
  assert.equal(m.albumName, "Album");
  assert.deepEqual(m.artists, [{ id: "ar3", name: "Artist" }]);
  assert.equal(await searchClient([item("1", "Other", "Nobody", 100_000)]).searchTrack({ title: "Song", artist: "Artist", durationS: 200 }), null);
});

test("searchTrack matches Persian titles across letter variants, one request", async () => {
  const c = searchClient([item("9", "عشق كوچك", "رضا", 180_000)]);
  const m = await c.searchTrack({ title: "عشق کوچک", artist: "رضا", durationS: 181 });
  assert.equal(m.id, "9");
});

test("artists chunks by 50", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/api/token")) return res(200, { access_token: "T", expires_in: 3600 });
    const ids = new URL(url).searchParams.get("ids").split(",");
    return res(200, { artists: ids.map((id) => ({ id, name: id, genres: ["g"], popularity: 5, followers: { total: 9 } })) });
  });
  const c = new SpotifyClient({ clientId: "i", clientSecret: "s", fetch: f });
  const out = await c.artists(Array.from({ length: 120 }, (_, i) => "a" + i));
  assert.equal(out.length, 120);
  assert.equal(f.calls.filter((x) => x.url.includes("/artists")).length, 3);
  assert.deepEqual(out[0], { id: "a0", name: "a0", genres: ["g"], popularity: 5, followers: 9 });
});

function seeded() {
  const cat = new Catalog(join(mkdtempSync(join(tmpdir(), "sp-")), "c.db"));
  const ins = cat.db.prepare("INSERT INTO tracks(video_id,title,artists_json,duration_s,first_seen) VALUES(?,?,?,?,?)");
  ins.run("old", "Old", JSON.stringify([{ id: "x", name: "A1" }]), 100, 1);
  ins.run("new", "New", null, 100, 2);
  ins.run("played", "Played", JSON.stringify([{ id: "y", name: "A2" }]), 200, 3);
  ins.run("stored", "Stored", JSON.stringify([{ id: "z", name: "A3" }]), 300, 4);
  ins.run("untitled", null, null, null, 0);
  cat.db.prepare("INSERT INTO songs(video_id,status) VALUES('stored','stored')").run();
  const pl = cat.db.prepare("INSERT INTO plays(video_id,at) VALUES(?,?)");
  pl.run("played", 1); pl.run("played", 2); pl.run("old", 3);
  return cat;
}

test("catalog round trip", () => {
  const cat = seeded();
  // Archived songs first, then the rest in the order they were added; each
  // pick continues after the last one (no full sort of the catalog).
  const first = cat.nextSpotifyTracks(10);
  assert.deepEqual(first.map((t) => t.videoId), ["stored", "old", "new", "played"]);
  assert.deepEqual(first[0], { videoId: "stored", title: "Stored", artist: "A3", durationS: 300 });
  assert.equal(first.find((t) => t.videoId === "new").artist, null);
  assert.deepEqual(cat.nextSpotifyTracks(10).map((t) => t.videoId), ["stored"], "the rest was handed out; only the archived one again until saved");
  cat.saveSpotifyTrack("stored", { id: "s1", isrc: "I", popularity: 40, explicit: true, releaseDate: "2020", albumId: "al", albumName: "N", albumType: "single", trackNumber: 1, score: 0.9, artists: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }, 5);
  cat.saveSpotifyTrack("played", null, 6);
  assert.deepEqual(cat.nextSpotifyTracks(10), [], "end reached: waits before starting over");
  assert.deepEqual(cat.spotifyStats(), { checked: 2, matched: 1, artists: 2, artistsFetched: 0 });
  assert.deepEqual(cat.spotifyArtistsToFetch(10).sort(), ["a1", "a2"]);
  cat.saveSpotifyArtists([{ id: "a1", name: "One", genres: ["pop"], popularity: 7, followers: 99 }], 9);
  assert.deepEqual(cat.spotifyArtistsToFetch(10), ["a2"]);
  assert.equal(cat.db.prepare("SELECT genres_json g FROM spotify_artists WHERE spotify_id='a1'").get().g, '["pop"]');
  assert.equal(cat.spotifyStats().artistsFetched, 1);
  cat.close();
});

test("enricher saves matches and pauses on 429 without marking checked", async () => {
  const cat = seeded();
  const quiet = { log() {}, error() {} };
  let mode = "ok", t = 1000;
  const client = {
    retryAfterMs: 5000,
    async searchTrack() {
      if (mode === "429") throw new Error("spotify /search: HTTP 429");
      return { id: "s", artists: [{ id: "a1", name: "One" }], score: 1 };
    },
    async artists(ids) { return ids.map((id) => ({ id, genres: [], popularity: 1, followers: 1 })); },
  };
  const e = new SpotifyEnricher({ catalog: cat, client, log: quiet, now: () => t });
  await e.tick();
  assert.equal(cat.spotifyStats().checked, 1);
  mode = "429";
  await e.tick();
  assert.equal(cat.spotifyStats().checked, 1);
  mode = "ok";
  await e.tick(); // still paused
  assert.equal(cat.spotifyStats().checked, 1);
  t += 5001;
  await e.tick();
  assert.equal(cat.spotifyStats().checked, 2);
  cat.close();
});
