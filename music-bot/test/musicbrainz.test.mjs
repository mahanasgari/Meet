import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { Recommender } from "../src/recommend.js";
import { MusicBrainzClient, ListenBrainzClient, MusicBrainzEnricher } from "../src/musicbrainz.js";
import { isHomeOnlyPath } from "../src/home_routes.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const id = (c) => c.repeat(11);
const [A, B, C, D] = ["A", "B", "C", "D"].map(id);
const M = (n) => `00000000-0000-0000-0000-00000000000${n}`;
const quiet = { log() {}, error() {} };

// A fake clock: sleeping advances time.
function clock() {
  const c = { t: 1_000_000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

const rec = (n, title, artistName, artistN, score = 100, extra = {}) => ({
  id: M(n), title, score, length: 200000, "first-release-date": "2019-05-01",
  "artist-credit": [{ name: artistName, artist: { id: M(artistN), name: artistName } }], ...extra,
});

function mbFetch(state = {}) {
  const calls = [];
  const f = async (url, opts) => {
    const u = new URL(url);
    calls.push({ u, opts });
    if (state.status) return res(state.status, {});
    if (u.pathname.startsWith("/ws/2/isrc/")) {
      return res(200, { recordings: [rec(1, "Seed Song", "Art", 5, undefined, { releases: [{ date: "2020-01-01" }] })] });
    }
    if (u.pathname === "/ws/2/recording") {
      state.queries?.push(u.searchParams.get("query"));
      return res(200, { recordings: [
        rec(2, "Totally Wrong", "Art", 5, 99),
        rec(3, "Seed Song (Remix)", "Art", 5, 60),
        rec(4, "Other Song", "Other Artist", 6, 95, { isrcs: ["XX1"] }),
      ] });
    }
    if (u.pathname === "/ws/2/artist") {
      return res(200, { artists: [{ id: M(6), score: 95, name: "Other Artist", aliases: [] }] });
    }
    const m = u.pathname.match(/^\/ws\/2\/artist\/(.+)$/);
    if (m) {
      const isEbi = m[1] === M(5);
      return res(200, {
        id: m[1], name: isEbi ? "Ebi" : "Other Artist", "sort-name": isEbi ? "Ebi, X" : "Other Artist", type: "Person", country: "IR",
        "life-span": { begin: "1970-01-01" },
        aliases: isEbi ? [{ name: "ابی", locale: "fa" }, { name: "Ebrahim Hamedi", locale: "en" }] : [],
        genres: [{ name: "pop" }, { name: "persian pop" }],
      });
    }
    return res(404, {});
  };
  f.calls = calls;
  return f;
}

function lbFetch(state = {}) {
  const calls = [];
  const f = async (url, opts) => {
    const u = new URL(url);
    calls.push({ u, opts });
    if (state.status) return res(state.status, {});
    if (u.pathname === "/1/popularity/recording") {
      const body = JSON.parse(opts.body);
      return res(200, body.recording_mbids.filter((m) => m !== M(9)).map((m, i) => ({ recording_mbid: m, total_listen_count: 1000 * (i + 1), total_user_count: 100 * (i + 1) })));
    }
    if (u.pathname === "/similar-recordings/json") {
      // nested array shape, the seed itself first
      return res(200, [[{ recording_mbid: u.searchParams.get("recording_mbids"), score: 999 }],
        [{ recording_mbid: M(4), score: 10 }, { recording_mbid: M(7), score: 5 }, { recording_mbid: M(8), score: 1 }]]);
    }
    if (u.pathname === "/similar-artists/json") {
      return res(200, [{ artist_mbid: M(6), name: "Other Artist", score: 100 }, { artist_mbid: M(9), name: "Nope", score: 50 }]);
    }
    return res(404, {});
  };
  f.calls = calls;
  return f;
}

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const cat = new Catalog(join(dir, "c.db"));
  const t = cat.db.prepare("INSERT INTO tracks(video_id,title,artists_json,duration_s,first_seen) VALUES(?,?,?,?,?)");
  const a = cat.db.prepare("INSERT INTO artists(id,name,subscribers) VALUES(?,?,?)");
  const sa = cat.db.prepare("INSERT INTO song_artists(video_id,artist_id,position) VALUES(?,?,0)");
  a.run("art1", "Ebi", 500); a.run("art2", "Other Artist", 50);
  t.run(A, "Seed Song (Official Video)", JSON.stringify([{ id: "art1", name: "Ebi" }]), 100, 1); sa.run(A, "art1");
  t.run(B, "Other Song", JSON.stringify([{ id: "art2", name: "Other Artist" }]), 100, 2); sa.run(B, "art2");
  t.run(C, "Third", JSON.stringify([{ id: "art2", name: "Other Artist" }]), 100, 3); sa.run(C, "art2");
  t.run(D, "Fourth", JSON.stringify([{ id: "art1", name: "Ebi" }]), 100, 4); sa.run(D, "art1");
  return cat;
}

function enricher(cat, { mb = {}, lb = {}, c = clock(), log = quiet } = {}) {
  const mf = mbFetch(mb), lf = lbFetch(lb);
  const e = new MusicBrainzEnricher({
    catalog: cat, log, now: c.now,
    mb: new MusicBrainzClient({ fetch: mf, sleep: c.sleep, now: c.now }),
    lb: new ListenBrainzClient({ fetch: lf, sleep: c.sleep, now: c.now }),
  });
  return { e, mf, lf, c };
}

test("clients space requests at least 1.1 s apart and send the User-Agent", async () => {
  const c = clock();
  const f = mbFetch();
  const client = new MusicBrainzClient({ fetch: f, sleep: c.sleep, now: c.now });
  await Promise.all([client.artist(M(5)), client.artist(M(6)), client.recordingByIsrc("X")]);
  assert.equal(f.calls.length, 3);
  assert.equal(c.sleeps.length, 2);
  assert.ok(c.sleeps.every((ms) => ms >= 1000 && ms <= 1100));
  for (const { opts } of f.calls) assert.equal(opts.headers["User-Agent"], "MiniPlayer/1.0 ( https://music.cloudproducts.ir )");
  const lf = lbFetch();
  const c2 = clock();
  const lb = new ListenBrainzClient({ fetch: lf, sleep: c2.sleep, now: c2.now });
  await lb.similarRecordings(M(1)); await lb.similarArtists(M(5));
  assert.equal(c2.sleeps.length, 1);
});

test("503 and 429 are rate errors", async () => {
  await assert.rejects(new MusicBrainzClient({ fetch: mbFetch({ status: 503 }), sleep: async () => {} }).artist(M(5)), /rate/);
  await assert.rejects(new ListenBrainzClient({ fetch: lbFetch({ status: 429 }), sleep: async () => {} }).similarArtists(M(5)), /rate/);
});

test("ISRC path returns the recording with credits and earliest date", async () => {
  const client = new MusicBrainzClient({ fetch: mbFetch(), sleep: async () => {} });
  const r = await client.recordingByIsrc("IRABC");
  assert.equal(r.mbid, M(1));
  assert.deepEqual(r.artistMbids, [M(5)]);
  assert.equal(r.firstRelease, "2019-05-01");
  assert.equal(r.lengthMs, 200000);
});

test("search path filters by score and title and escapes Lucene", async () => {
  const queries = [];
  const client = new MusicBrainzClient({ fetch: mbFetch({ queries }), sleep: async () => {} });
  const r = await client.searchRecording("Other Artist", "Other Song");
  assert.equal(r.mbid, M(4));
  assert.deepEqual(r.isrcs, ["XX1"]);
  assert.equal(await client.searchRecording("Art", "Seed Song"), null); // remix scores 60, wrong one has the wrong title
  await client.searchRecording('A"rt (x)', 'Ti"tle: [1]');
  assert.equal(queries[0], 'recording:"Other Song" AND artist:"Other Artist"');
  assert.equal(queries[2], 'recording:"Ti\\"tle\\: \\[1\\]" AND artist:"A\\"rt \\(x\\)"');
});

test("labs parsers accept nested shapes and drop the seed", async () => {
  const lb = new ListenBrainzClient({ fetch: lbFetch(), sleep: async () => {} });
  assert.deepEqual(await lb.similarRecordings(M(1)), [{ mbid: M(4), score: 10 }, { mbid: M(7), score: 5 }, { mbid: M(8), score: 1 }]);
  assert.equal((await lb.similarArtists(M(5)))[0].name, "Other Artist");
  const empty = new ListenBrainzClient({ fetch: async () => res(200, []), sleep: async () => {} });
  assert.deepEqual(await empty.similarRecordings(M(1)), []);
});

test("enricher saves recording, artist and every alias (including Persian), then searches by alias", async () => {
  const cat = seeded();
  cat.songInfo(A);
  cat.saveSongInfo(A, { deezer: { isrc: "IRABC" } });
  const { e } = enricher(cat);
  await e.tick();
  const r = cat.db.prepare("SELECT * FROM mb_recordings WHERE video_id=?").get(A);
  assert.equal(r.mbid, M(1));
  const a = cat.db.prepare("SELECT * FROM mb_artists WHERE artist_id='art1'").get();
  assert.equal(a.mbid, M(5));
  assert.equal(a.country, "IR");
  assert.equal(a.begin, "1970-01-01");
  const norms = cat.db.prepare("SELECT alias_norm FROM mb_aliases WHERE artist_id='art1'").all().map((x) => x.alias_norm).sort();
  assert.deepEqual(norms, ["ebi", "ebi" + "x", "ebrahimhamedi", "ابی"].sort());
  assert.deepEqual(cat.artistsByAlias("ابی").map((x) => [x.id, x.name, x.alias, x.subscribers]), [["art1", "Ebi", "ابی", 500]]);
  assert.deepEqual(cat.artistsByAlias("Ebrahim").map((x) => x.id), ["art1"]); // prefix
  assert.deepEqual(cat.artistsByAlias("ebi").map((x) => x.id), ["art1"]); // exact, deduped with prefix hits
  assert.deepEqual(cat.artistsByAlias("zzz"), []);
  const info = cat.mbInfo(A);
  assert.equal(info.mb.mbid, M(1));
  assert.deepEqual(info.artist.aliases, ["ابی", "Ebrahim Hamedi"]);
  assert.deepEqual(info.artist.genres, ["pop", "persian pop"]);
});

test("search path is used without an ISRC; no match is saved with NULL mbid; artist is looked up once", async () => {
  const cat = seeded();
  const { e, mf } = enricher(cat);
  for (let i = 0; i < 4; i++) await e.tick();
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM mb_recordings").get().n, 4);
  assert.equal(cat.db.prepare("SELECT mbid FROM mb_recordings WHERE video_id=?").get(A).mbid, null);
  assert.equal(cat.db.prepare("SELECT mbid FROM mb_recordings WHERE video_id=?").get(B).mbid, M(4));
  // Ebi never matched a recording: artist search (score 95 but the name does not match) leaves mbid NULL.
  assert.equal(cat.db.prepare("SELECT mbid FROM mb_artists WHERE artist_id='art1'").get().mbid, null);
  assert.equal(mf.calls.filter((x) => x.u.pathname === "/ws/2/artist" ).length, 1);
  assert.equal(mf.calls.filter((x) => x.u.pathname === `/ws/2/artist/${M(6)}`).length, 1);
  assert.equal(cat.mbInfo(A).artist, undefined);
});

test("ListenBrainz similar recordings and artists map to our songs", async () => {
  const cat = seeded();
  cat.saveSongInfo(A, { deezer: { isrc: "IRABC" } });
  // Our songs B and C already known by mbid.
  cat.db.prepare("INSERT INTO mb_recordings(video_id,mbid,checked_at) VALUES(?,?,1)").run(B, M(4));
  cat.db.prepare("INSERT INTO mb_recordings(video_id,mbid,checked_at) VALUES(?,?,1)").run(C, M(7));
  cat.db.prepare("INSERT INTO mb_artists(artist_id,mbid,checked_at) VALUES('art2',?,1)").run(M(6));
  const { e } = enricher(cat);
  await e.tick();
  const sim = cat.db.prepare("SELECT similar_id, score FROM lb_similar WHERE video_id=? ORDER BY score DESC").all(A);
  assert.deepEqual(sim.map((r) => [r.similar_id, r.score]), [[B, 10], [C, 5]]); // M(8) unknown: dropped
  const asim = cat.db.prepare("SELECT similar_id, score FROM lb_artist_similar WHERE artist_id='art1'").all();
  assert.deepEqual(asim.map((r) => [r.similar_id, r.score]), [["art2", 100]]);
});

test("popularity batch updates counts and marks unknown recordings checked", async () => {
  const cat = seeded();
  const ins = cat.db.prepare("INSERT INTO mb_recordings(video_id,mbid,checked_at) VALUES(?,?,?)");
  ins.run(A, M(1), 1); ins.run(B, M(9), 2); ins.run(C, null, 3);
  const { e, lf } = enricher(cat);
  for (let i = 0; i < 60; i++) await e.tick(); // the 60th tick runs the popularity step
  const rows = Object.fromEntries(cat.db.prepare("SELECT video_id, lb_listens, lb_users, lb_checked_at FROM mb_recordings").all().map((r) => [r.video_id, r]));
  assert.equal(rows[A].lb_listens, 1000);
  assert.equal(rows[A].lb_users, 100);
  assert.ok(rows[A].lb_checked_at);
  assert.equal(rows[B].lb_listens, null);
  assert.ok(rows[B].lb_checked_at); // not found: not asked again
  assert.equal(rows[C].lb_checked_at, null); // no mbid
  assert.equal(lf.calls.filter((x) => x.u.pathname === "/1/popularity/recording").length, 1);
  assert.equal(cat.mbPopularityBatch(10).length, 0);
});

test("rate limit pauses for 15 minutes and the song is retried", async () => {
  const cat = seeded();
  const c = clock();
  const state = { status: 503 };
  const errors = [];
  const { e, mf } = enricher(cat, { mb: state, c, log: { log() {}, error: (...a) => errors.push(a.join(" ")) } });
  await e.tick();
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM mb_recordings").get().n, 0);
  const n = mf.calls.length;
  await e.tick();
  assert.equal(mf.calls.length, n); // paused
  delete state.status;
  c.t += 16 * 60_000;
  await e.tick();
  assert.equal(cat.db.prepare("SELECT COUNT(*) n FROM mb_recordings").get().n, 1);
  assert.ok(errors.some((m) => m.includes("rate")));
});

test("recommender returns a ListenBrainz-only neighbour (both directions); popularity uses lb_users", () => {
  const cat = seeded();
  const ins = cat.db.prepare("INSERT INTO lb_similar(video_id,similar_id,score) VALUES(?,?,?)");
  ins.run(A, B, 10); ins.run(A, D, 5); ins.run(C, A, 4); ins.run(C, B, 8);
  cat.db.prepare("INSERT INTO mb_recordings(video_id,mbid,lb_users,checked_at) VALUES(?,?,?,1)").run(B, M(4), 100000);
  const dir = mkdtempSync(join(tmpdir(), "mbr-"));
  mkdirSync(join(dir, "users"));
  const rec = new Recommender({ catalog: cat, usersDir: join(dir, "users"), now: () => Date.now() });
  const out = rec.similarTo(A);
  const b = out.find((s) => s.videoId === B), c = out.find((s) => s.videoId === C);
  assert.ok(b && c);
  assert.ok(b.score > c.score);
  assert.ok(b.reasons.some((r) => r.includes("ListenBrainz")));
});

test("/artists/search is a home-only path", () => {
  assert.ok(isHomeOnlyPath("/artists/search"));
  assert.ok(!isHomeOnlyPath("/artists/searchx"));
});
