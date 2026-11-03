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
  assert.deepEqual(Object.keys(r).sort(), ["artist", "discover", "famousArtists", "fansAlsoLike", "hiddenGems", "mood", "moreFromArtist", "newArtists", "newFromArtist", "newLikeThis", "popularNow", "similar", "unknownArtists"]);
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

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

function rich() {
  const c = seeded();
  // more artists: a4 (tiny), a5 (huge), a6 (mid)
  const mk = (aid, name, subs, from, n) => c.saveArtistPage(aid, {
    name, subscribers: subs, songs: Array.from({ length: n }, (_, i) => song(from + i, `${name} song ${i}`, [{ id: aid, name }])),
  });
  mk("a4", "Tiny", 800, 100, 5); mk("a5", "Huge", 9_000_000, 200, 5); mk("a6", "Mid", 120_000, 300, 5);
  c.db.prepare("INSERT INTO lastfm_artist_similar(artist_id,similar_id,match) VALUES('a1','a4',0.7),('a1','a5',0.6),('a1','a6',0.5)").run();
  const si = c.db.prepare("INSERT INTO song_info(video_id,release_date) VALUES(?,?)");
  // Ebi: 4 new songs in last 18 months, 1 old, rest unknown (song 1 is the current one)
  si.run(id(2), iso(30)); si.run(id(3), iso(100)); si.run(id(4), iso(400)); si.run(id(5), iso(900)); si.run(id(6), "2005");
  c.db.prepare("INSERT INTO mb_recordings(video_id,mbid,first_release,lb_users) VALUES(?,?,?,?)").run(id(7), "mbx", iso(60), 10);
  // similar songs 21,22,23 (Googoosh), 41,42 (Hayedeh): recent + gems
  si.run(id(21), iso(10)); si.run(id(22), iso(200)); si.run(id(23), iso(2000)); si.run(id(41), iso(5));
  const lf = c.db.prepare("INSERT INTO lastfm_tracks(video_id,listeners) VALUES(?,?)");
  lf.run(id(21), 500000); lf.run(id(22), 300); lf.run(id(23), 90000); lf.run(id(41), 100); lf.run(id(42), 1500);
  c.db.prepare("INSERT INTO lastfm_artists(artist_id,listeners) VALUES('a5',2000000),('a4',300)").run();
  return c;
}

test("related: newFromArtist is the artist's last 18 months, newest first", () => {
  _clearRelatedCache();
  const r = songRelated(rich(), rec(), id(1), null);
  assert.deepEqual(r.newFromArtist.map((s) => s.videoId), [id(2), id(7), id(3), id(4)]);
  assert.ok(r.newFromArtist.every((s) => s.artists[0].id === "a1"));
});

test("related: newLikeThis, popularNow and hiddenGems from the candidate pool", () => {
  _clearRelatedCache();
  const r = songRelated(rich(), rec(), id(1), null);
  const nl = r.newLikeThis.map((s) => s.videoId);
  assert.ok(nl.includes(id(21)) && nl.includes(id(22)) && nl.includes(id(41)) && !nl.includes(id(23)));
  assert.ok(!nl.includes(id(1)));
  assert.equal(r.popularNow[0].videoId, id(21));
  assert.ok(r.popularNow.length <= 15);
  const g = r.hiddenGems.map((s) => s.videoId);
  assert.ok(g.includes(id(22)) && g.includes(id(41)) && g.includes(id(42)));
  assert.ok(!g.includes(id(21)) && !g.includes(id(23)));
  assert.ok(!r.hiddenGems.some((s) => s.artists[0]?.id === "a1"), "not the current artist");
  const u = songRelated(rich(), rec(), id(1), "u1");
  assert.ok(!u.hiddenGems.some((s) => s.videoId === id(41) || s.videoId === id(21)), "played songs excluded");
});

test("related: new, unknown and famous artists, no repeats, user's artists skipped", () => {
  _clearRelatedCache();
  const r = songRelated(rich(), rec(), id(1), null);
  assert.ok(r.unknownArtists.some((a) => a.id === "a4"));
  assert.ok(!r.unknownArtists.some((a) => a.id === "a5" || a.id === "a6"));
  assert.deepEqual(r.famousArtists.map((a) => a.id), ["a5"]);
  assert.ok(r.famousArtists.every((a) => a.subscribers >= 500_000 || a.listeners >= 100_000) || r.famousArtists.length === 0);
  const ids = [...r.newArtists, ...r.unknownArtists, ...r.famousArtists].map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "no artist repeats");
  assert.deepEqual(Object.keys(r.famousArtists[0]).sort(), ["id", "listeners", "name", "subscribers", "topSong"]);
  assert.ok(r.famousArtists[0].topSong?.videoId);
  const u = songRelated(rich(), rec(), id(1), "u1"); // u1 played Googoosh and Hayedeh songs
  const all = [...u.newArtists, ...u.famousArtists].map((a) => a.id);
  assert.ok(!all.includes("a2") && !all.includes("a3"));
});

test("related: ~100k songs answers in under 150 ms warm", () => {
  _clearRelatedCache();
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "relbig-")), "c.db"));
  const N = 100_000, NA = 5_000;
  c.db.exec("BEGIN");
  const iA = c.db.prepare("INSERT INTO artists(id,name,subscribers) VALUES(?,?,?)");
  const iT = c.db.prepare("INSERT INTO tracks(video_id,title,artists_json,year,duration_s) VALUES(?,?,?,?,200)");
  const iS = c.db.prepare("INSERT INTO songs(video_id,status,title,artists_json,plays) VALUES(?,'stored',?,?,?)");
  const iSA = c.db.prepare("INSERT INTO song_artists(video_id,artist_id,position) VALUES(?,?,0)");
  const iL = c.db.prepare("INSERT INTO lastfm_tracks(video_id,listeners) VALUES(?,?)");
  const iR = c.db.prepare("INSERT INTO artist_related(artist_id,related_id,rank) VALUES(?,?,?)");
  for (let a = 0; a < NA; a++) {
    iA.run(`art${a}`, `Artist ${a}`, a * 311);
    for (let k = 1; k <= 12; k++) iR.run(`art${a}`, `art${(a + k * 7) % NA}`, k);
  }
  for (let n = 0; n < N; n++) {
    const aid = `art${n % NA}`, aj = JSON.stringify([{ id: aid, name: `Artist ${n % NA}` }]);
    iT.run(id(n), `Song ${n}`, aj, 2000 + (n % 26)); iS.run(id(n), `Song ${n}`, aj, n % 5); iSA.run(id(n), aid);
    if (n % 3 === 0) iL.run(id(n), (n * 37) % 200000);
  }
  c.db.exec("COMMIT");
  const sim = (v, { limit }) => Array.from({ length: limit }, (_, i) => ({ videoId: id((Number(v.slice(3)) + 1 + i * 13) % N), score: 1 - i / 100 }));
  const r = { similarTo: sim, historyOf: () => ({ played: new Set(Array.from({ length: 1000 }, (_, i) => id(i * 7))), top: [id(7)] }) };
  songRelated(c, r, id(12345), "u"); // cold
  const times = [];
  for (let i = 0; i < 5; i++) { _clearRelatedCache(); const t = performance.now(); const out = songRelated(c, r, id(20000 + i), "u"); times.push(performance.now() - t); assert.ok(out.similar.length > 0); }
  times.sort((a, b) => a - b);
  console.log("related timing ms", times.map((x) => x.toFixed(1)).join(" "));
  assert.ok(times[2] < 150, `median ${times[2]}`);
});
