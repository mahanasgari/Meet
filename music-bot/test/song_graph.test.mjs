import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { SongGraph, parseNext, parseRelated } from "../src/song_graph.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const NEXT = fx("ytm_next.json");
const REL = fx("ytm_related.json");
const open = () => new Catalog(join(mkdtempSync(join(tmpdir(), "sg-")), "c.db"));
const quiet = { error() {}, log() {} };
const transport = async (path) => (path === "next" ? NEXT : REL);

test("parseNext on real sample", () => {
  const r = parseNext(NEXT);
  assert.equal(r.upNext.length, 49);
  const f = r.upNext[0];
  assert.equal(f.title, "Messle Khodet");
  assert.equal(f.artists[0].name, "Kamran & Hooman");
  assert.match(f.artists[0].id, /^UC/);
  assert.equal(f.album.name, "Shenasnameh");
  assert.match(f.album.id, /^MPREb_/);
  assert.equal(f.year, 2011);
  assert.equal(f.durationS, 281);
  assert.equal(f.rank, 0);
  assert.match(r.relatedBrowseId, /^MPTRt_/);
});

test("parseNext handles wrapped items", () => {
  const item = (v) => ({ playlistPanelVideoRenderer: { videoId: v, title: { runs: [{ text: v }] } } });
  const contents = [item("seed"), { playlistPanelVideoWrapperRenderer: { primaryRenderer: item("w1") } }];
  const tab = { tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: { contents } } } } } };
  const j = { contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [tab] } } } } };
  assert.deepEqual(parseNext(j).upNext.map((x) => x.videoId), ["w1"]);
});

test("parseRelated on real sample", () => {
  const r = parseRelated(REL);
  assert.equal(r.songs.length, 20);
  assert.equal(r.songs[0].videoId, "2tad61oses0");
  assert.match(r.songs[0].artists[0].id, /^UC/);
  assert.equal(r.artists.length, 10);
  assert.equal(r.artists[0].name, "Shahab Tiam");
  assert.match(r.artists[0].id, /^UC/);
  assert.equal(r.artists[0].subscribers, 9890);
  assert.ok(r.albums.some((a) => a.title === "Shenasnameh" && a.kind === "Album" && a.year === 2011));
  assert.ok(r.albums.some((a) => a.kind === "EP"));
});

test("parsers never throw on odd input", () => {
  for (const x of [{}, null, undefined, 5, "x", [], { contents: { sectionListRenderer: { contents: [null, 1, {}] } } }]) {
    assert.deepEqual(parseNext(x), { upNext: [], relatedBrowseId: null });
    assert.deepEqual(parseRelated(x), { songs: [], artists: [], albums: [], description: null });
  }
});

test("crawl stores graph visible via neighbors and graphStats", async () => {
  const c = open();
  c.stored("seed", { title: "Seed", ytChannelId: "UCmain" }, 1000);
  const calls = [];
  const g = new SongGraph({ catalog: c, transport: async (p, b) => (calls.push([p, b]), transport(p)), log: quiet });
  assert.deepEqual(await g.crawl("seed"), { upNext: 49, related: 20, artists: 10 });
  assert.deepEqual(calls[0], ["next", { videoId: "seed", playlistId: "RDAMVMseed", isAudioOnly: true }]);
  assert.equal(calls[1][0], "browse");
  const n = c.neighbors("seed", 100);
  assert.equal(n.next.length, 49);
  assert.equal(n.next[0].title, "Messle Khodet");
  assert.equal(n.next[0].archived, false);
  assert.equal(n.related.length, 20);
  assert.equal(n.similarArtists.length, 10);
  assert.equal(n.similarArtists[0].name, "Shahab Tiam");
  assert.deepEqual(n.artists.map((a) => a.id), ["UCmain"]);
  const s = c.graphStats();
  assert.equal(s.crawled, 1);
  assert.equal(s.pending, 0);
  assert.equal(s.edges.next, 49);
  assert.equal(s.edges.related, 20);
  assert.equal(s.artistLinks, 10);
  assert.ok(s.albums >= 1 && s.tracks >= 49 && s.artists >= 11);
  c.close();
});

test("crawl failure marks crawl failed and rethrows", async () => {
  const c = open();
  c.stored("a", {}, 1000);
  const g = new SongGraph({ catalog: c, transport: async () => { throw new Error("boom"); }, log: quiet });
  await assert.rejects(g.crawl("a"), /boom/);
  assert.equal(c.graphStats().failed, 1);
  assert.deepEqual(c.needsCrawl(1), []);
  c.close();
});

test("tick crawls the next needed song and survives errors", async () => {
  const c = open();
  c.stored("a", {}, 1000);
  c.stored("b", {}, 2000);
  const g = new SongGraph({ catalog: c, transport, log: quiet });
  await g.tick();
  assert.equal(c.graphStats().crawled, 1);
  assert.equal(c.needsCrawl(5).length, 1);
  const bad = new SongGraph({ catalog: c, transport: async () => { throw new Error("x"); }, log: quiet });
  assert.equal(await bad.tick(), null);
  assert.equal(c.graphStats().failed, 1);
  c.close();
});
