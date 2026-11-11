import { strict as assert } from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { ChangeFeed, decodeRows, encodeRows, pullOnce, syncPosition, syncPositions, syncTables } from "../src/catalog_sync.js";

const NOW = Date.UTC(2026, 10, 11, 12);
const dir = () => mkdtempSync(join(tmpdir(), "csync-"));
const node = (d, origin, file = join(d, `${origin}.db`)) => {
  const c = new Catalog(file);
  return { c, feed: new ChangeFeed({ db: c.db, outFile: join(d, `${origin}-out.db`), origin }), file };
};
const ship = (from, to) => to.feed.apply(from.feed.origin, decodeRows(encodeRows(from.feed.read(syncPosition(to.c.db, from.feed.origin)))));

test("synced tables leave out server-local ones and the search index", () => {
  const { c } = node(dir(), "home");
  const t = syncTables(c.db);
  assert.ok(t.includes("songs") && t.includes("video_map") && t.includes("lyrics") && t.includes("video_votes"));
  for (const local of ["meta", "jobs", "crawl"]) assert.ok(!t.includes(local), local);
  assert.ok(!t.some((x) => x.startsWith("search_fts")));
});

test("a song stored at home reaches the copy; nothing echoes back", () => {
  const d = dir();
  const home = node(d, "home");
  const de = node(d, "germany");
  home.c.stored("song0000001", { msgId: 42, title: "In Eshghe", artist: "Sami Beigi" }, NOW);
  home.c.videoMapSet("song0000001", "official001", "Official", NOW);
  assert.ok(home.c.lyricsPut("song0000001", { source: "LRCLIB", sync: "line", lines: [{ t: 1000, text: "hello" }] }, {}, NOW));
  assert.ok(home.feed.flush(NOW) >= 3);
  assert.equal(de.c.lookup("song0000001"), null);
  ship(home, de);
  const s = de.c.lookup("song0000001");
  assert.equal(s.msgId, 42);
  assert.equal(s.status, "stored");
  assert.equal(de.c.videoMapGet("song0000001").srcId, "official001");
  assert.ok(de.c.lyricsGet("song0000001"));
  assert.equal(syncPosition(de.c.db, "home"), home.feed.lastSeq());
  // Applied changes are not recorded on the copy.
  de.feed.flush(NOW);
  assert.equal(de.feed.lastSeq(), 0);
  // Shipping again changes nothing.
  ship(home, de);
  assert.equal(de.c.lookup("song0000001").msgId, 42);
});

test("both ways: each server's own changes reach the other, the later change of a row wins", () => {
  const d = dir();
  const a = node(d, "home");
  const b = node(d, "germany");
  a.c.stored("aaaaaaaaaaa", { msgId: 1, title: "A" }, NOW);
  b.c.stored("bbbbbbbbbbb", { msgId: 2, title: "B" }, NOW);
  a.feed.flush(NOW);
  b.feed.flush(NOW);
  ship(a, b);
  ship(b, a);
  for (const x of [a, b]) {
    assert.equal(x.c.lookup("aaaaaaaaaaa").msgId, 1);
    assert.equal(x.c.lookup("bbbbbbbbbbb").msgId, 2);
  }
  // Both change the same video choice; germany's change is applied last at home.
  a.c.videoMapSet("aaaaaaaaaaa", "fromhome001", null, NOW + 1);
  b.c.videoMapSet("aaaaaaaaaaa", "fromgerman1", null, NOW + 2);
  a.feed.flush(NOW + 3);
  b.feed.flush(NOW + 3);
  ship(b, a);
  assert.equal(a.c.videoMapGet("aaaaaaaaaaa").srcId, "fromgerman1");
});

test("a copy of the catalog file carries its positions: a new server goes on from there", () => {
  const d = dir();
  const home = node(d, "home");
  home.c.stored("song0000001", { msgId: 1 }, NOW);
  home.feed.flush(NOW);
  // The nightly snapshot is taken here.
  const snap = join(d, "snapshot.db");
  home.c.db.exec(`VACUUM INTO '${snap}'`);
  home.c.stored("song0000002", { msgId: 2 }, NOW + 1);
  home.feed.flush(NOW + 1);
  const copy = join(d, "us.db");
  copyFileSync(snap, copy);
  const us = node(d, "us", copy);
  assert.deepEqual(syncPositions(us.c.db), { home: 1 });
  assert.equal(us.c.lookup("song0000001").msgId, 1);
  assert.equal(us.c.lookup("song0000002"), null);
  ship(home, us);
  assert.equal(us.c.lookup("song0000002").msgId, 2);
});

test("pullOnce fetches in rounds over HTTP frames and reports peers that don't answer", async () => {
  const d = dir();
  const home = node(d, "home");
  const de = node(d, "germany");
  for (let i = 0; i < 5; i++) {
    home.c.stored(`song000000${i}`, { msgId: i + 1 }, NOW + i);
    home.feed.flush(NOW + i);
  }
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.startsWith("http://down")) throw new Error("connect refused");
    const since = Number(new URL(url).searchParams.get("since"));
    const rows = home.feed.read(since, { maxRows: 2 });
    const more = rows.length && rows.at(-1).seq < home.feed.lastSeq();
    return new Response(encodeRows(rows), { headers: { "x-sync-origin": "home", "x-sync-more": more ? "1" : "0" } });
  };
  const r = await pullOnce(de.feed, [{ origin: "home", url: "http://home" }, { origin: "us", url: "http://down" }], { fetchImpl, token: "t" });
  assert.equal(r.home.applied, home.feed.lastSeq());
  assert.ok(r.us.error);
  assert.equal(asked.filter((u) => u.startsWith("http://home")).length, 3, "three rounds of two");
  for (let i = 0; i < 5; i++) assert.equal(de.c.lookup(`song000000${i}`).msgId, i + 1);
});

test("old outbox rows are pruned", () => {
  const d = dir();
  const home = node(d, "home");
  home.c.stored("song0000001", { msgId: 1 }, NOW);
  home.feed.flush(NOW - 8 * 864e5);
  home.c.stored("song0000002", { msgId: 2 }, NOW);
  home.feed.flush(NOW);
  assert.ok(home.feed.prune(NOW) >= 1);
  assert.ok(home.feed.firstSeq() > 1);
});
