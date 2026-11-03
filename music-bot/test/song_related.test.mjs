import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { songRelated, _clearRelatedCache } from "../src/song_related.js";

const id = (n) => `vid${String(n).padStart(8, "0")}`;
const song = (n, title, artists) => ({ videoId: id(n), title, artists });
const A1 = [{ id: "a1", name: "Ebi" }], A2 = [{ id: "a2", name: "Googoosh" }], A3 = [{ id: "a3", name: "Hayedeh" }];

function seeded() {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "rel-")), "c.db"));
  const songs = [];
  for (let i = 1; i <= 20; i++) songs.push(song(i, `Ebi song ${i}`, A1));
  for (let i = 21; i <= 40; i++) songs.push(song(i, `Googoosh song ${i}`, A2));
  for (let i = 41; i <= 50; i++) songs.push(song(i, `Hayedeh song ${i}`, A3));
  c.saveArtistPage("a1", { name: "Ebi", subscribers: 900, songs: songs.slice(0, 20), related: [{ id: "a2", name: "Googoosh" }] });
  c.saveArtistPage("a2", { name: "Googoosh", subscribers: 500, songs: songs.slice(20, 40) });
  c.saveArtistPage("a3", { name: "Hayedeh", subscribers: 300, songs: songs.slice(40) });
  c.db.prepare("INSERT INTO lastfm_artist_similar(artist_id,similar_id,match) VALUES('a1','a3',0.9),('a1','a2',0.8)").run();
  c.db.prepare("INSERT INTO lastfm_artists(artist_id,listeners,playcount) VALUES('a1',12345,99)").run();
  c.db.prepare("INSERT INTO mb_artists(artist_id,mbid,name,country,begin,genres_json) VALUES('a1','m1','Ebi','IR','1970','[\"pop\"]')").run();
  // every song analysed as clearly sad
  const ins = c.db.prepare("INSERT INTO song_analysis(video_id,sad,happy,relaxed,aggressive,party,danceability,energy,valence,arousal,scale,analyzed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)");
  for (let i = 1; i <= 50; i++) ins.run(id(i), 0.9 - i / 1000, 0.1, 0.5, 0.1, 0.1, 0.3, 0.2, 0.1, 0.2, "minor");
  return c;
}
const rec = (log = []) => ({
  similarTo(v, { limit }) { log.push(v); if (v === id(999)) return []; return [21, 22, 23, 41, 42, 1].map((n) => ({ videoId: id(n), title: "x", artist: "y", score: 1 })).slice(0, limit); },
  historyOf(uid) { return uid === "u1" ? { played: new Set([id(21), id(41)]), top: [id(41)] } : null; },
});

test("related: shape, exclusions and fans", () => {
  _clearRelatedCache();
  const c = seeded();
  const r = songRelated(c, rec(), id(1), null);
  assert.deepEqual(Object.keys(r).sort(), ["artist", "discover", "fansAlsoLike", "mood", "moreFromArtist", "similar"]);
  assert.ok(r.similar.length > 0 && !r.similar.some((s) => s.videoId === id(1)));
  assert.deepEqual(Object.keys(r.similar[0]).sort(), ["album", "archived", "artists", "durationS", "title", "videoId"]);
  assert.equal(r.artist.name, "Ebi");
  assert.equal(r.artist.listeners, 12345);
  assert.equal(r.artist.country, "IR");
  assert.deepEqual(r.artist.genres, ["pop"]);
  assert.equal(r.moreFromArtist.length, 15);
  assert.ok(!r.moreFromArtist.some((s) => s.videoId === id(1)));
  assert.deepEqual(r.fansAlsoLike.map((a) => a.id), ["a2", "a3"]);
  assert.equal(r.mood.label, "Sad");
  assert.ok(r.mood.songs.length > 0 && r.mood.songs.length <= 15);
  assert.ok(!r.mood.songs.some((s) => s.videoId === id(1)));
  assert.ok(!r.mood.songs.some((s) => s.artists[0].id === "a1"), "other artists preferred");
  assert.ok(r.discover.length <= 10 && r.discover.length > 0);
});

test("related: discover skips played songs and top artists for a known user", () => {
  _clearRelatedCache();
  const c = seeded();
  const r = songRelated(c, rec(), id(1), "u1");
  const ids = r.discover.map((s) => s.videoId);
  assert.ok(!ids.includes(id(21)) && !ids.includes(id(41)));
  assert.ok(!r.discover.some((s) => s.artists[0].id === "a3"), "top artist avoided");
  assert.ok(r.discover.some((s) => s.artists[0].id === "a2"));
});

test("related: unknown song and bad id give empties; cached per (id, uid) for 20 min", () => {
  _clearRelatedCache();
  const c = seeded();
  for (const bad of ["nope", "", null, id(999)]) {
    const r = songRelated(c, rec(), bad, null);
    assert.deepEqual(r.similar, []);
    assert.equal(r.artist, null);
    assert.equal(r.mood.label, null);
  }
  const log = [];
  const t = 1_000_000;
  songRelated(c, rec(log), id(2), null, t);
  songRelated(c, rec(log), id(2), null, t + 19 * 60_000);
  assert.equal(log.length, 1);
  songRelated(c, rec(log), id(2), "u1", t + 1000);
  assert.equal(log.length, 2);
  songRelated(c, rec(log), id(2), null, t + 21 * 60_000);
  assert.equal(log.length, 3);
});

test("related: a throwing recommender still answers", () => {
  _clearRelatedCache();
  const c = seeded();
  const r = songRelated(c, { similarTo() { throw new Error("boom"); } }, id(1), null);
  assert.deepEqual(r.similar, []);
  assert.equal(r.moreFromArtist.length, 15);
});
