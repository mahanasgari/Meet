import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { smartSearch } from "../src/smart_search.js";
import { normSearch } from "../src/search_text.js";

const id = (n) => `vid${String(n).padStart(8, "0")}`;
const mk = (tok) => new Catalog(join(mkdtempSync(join(tmpdir(), "ss-")), "c.db"), { ftsTokenizer: tok });
const song = (n, title, artists, extra = {}) => ({ videoId: id(n), title, artists, ...extra });

function seeded(opts) {
  const c = mk(opts);
  const graph = [
    song(1, "Khalij-e Fars", [{ id: "a1", name: "Ebi" }]),
    song(2, "خلیج فارس", [{ id: "a1", name: "Ebi" }]),
    song(3, "Shab Mahtab", [{ id: "a2", name: "Googoosh" }]),
    song(4, "Rain Song", [{ id: "a3", name: "Led Zeppelin" }]),
    song(5, "Dance Dance", [{ id: "a3", name: "Led Zeppelin" }]),
    song(6, "Kerman كرمان", [{ id: "a2", name: "Googoosh" }]),
  ];
  c.saveArtistPage("a1", { name: "Ebi", subscribers: 900, songs: graph.slice(0, 2) });
  c.saveArtistPage("a2", { name: "Googoosh", subscribers: 500, songs: [graph[2], graph[5]] });
  c.saveArtistPage("a3", { name: "Led Zeppelin", subscribers: 9000, songs: graph.slice(3, 5) });
  return c;
}

for (const tok of [undefined, "unicode61 remove_diacritics 2"]) {
  const label = tok ? "unicode61" : "default";

  test(`[${label}] tokenizer is what was asked for`, () => {
    const c = seeded(tok);
    assert.equal(c.ftsMode, tok ? "unicode61" : "trigram");
  });

  test(`[${label}] fts is current on insert; fill is batched with a cursor and idempotent`, () => {
    const c = seeded(tok);
    // saveArtistPage already indexed everything; a fresh fill only re-puts rows.
    assert.equal(c.ftsSearch('"rain"', 10).length >= 1 || c.ftsSearch('"rain"*', 10).length >= 1, true);
    const d = mk(tok);
    const ins = d.db.prepare("INSERT INTO tracks(video_id,title,artists_json,first_seen) VALUES(?,?,?,1)");
    for (let i = 0; i < 25; i++) ins.run(id(i), `Song number ${i}`, JSON.stringify([{ id: "x", name: "Band" }]));
    assert.equal(d.ftsStats().cursor, 0);
    assert.deepEqual(d.ftsFill(10), { n: 10, done: false });
    assert.equal(d.ftsStats().cursor, 10);
    assert.deepEqual(d.ftsFill(10), { n: 10, done: false });
    assert.deepEqual(d.ftsFill(10), { n: 5, done: false });
    assert.deepEqual(d.ftsFill(10), { n: 0, done: true });
    assert.equal(d.ftsStats().done, true);
    assert.equal(smartSearch(d, "song number 7").songs[0].videoId, id(7));
    assert.equal(d.db.prepare("SELECT COUNT(*) n FROM search_fts_docsize").get().n, 25);
  });

  test(`[${label}] updating a track replaces its fts row`, () => {
    const c = seeded(tok);
    c.saveArtistPage("a3", { songs: [song(4, "Stairway", [{ id: "a3", name: "Led Zeppelin" }])] });
    assert.equal(smartSearch(c, "stairway").songs[0].videoId, id(4));
    assert.equal(smartSearch(c, "rain song").songs.filter((s) => s.videoId === id(4) && s.why === "title" && s.title === "Rain Song").length, 0);
  });

  test(`[${label}] typo-ish and Persian queries`, () => {
    const c = seeded(tok);
    let r = smartSearch(c, "khalij fars");
    assert.equal(r.songs[0].videoId, id(1));
    assert.equal(r.songs[0].why, "title");
    r = smartSearch(c, "KHALIJ-E fars");
    assert.equal(r.songs[0].videoId, id(1));
    r = smartSearch(c, "خلیج فارس");
    assert.equal(r.songs[0].videoId, id(2));
    r = smartSearch(c, "led zepp"); // artist text
    assert.deepEqual(r.songs.map((s) => s.videoId).sort(), [id(4), id(5)]);
    assert.equal(r.songs[0].why, "artist");
    assert.equal(r.artists[0].name, "Led Zeppelin");
    assert.deepEqual(smartSearch(c, "").songs, []);
    assert.deepEqual(smartSearch(c, "zzzzzz qqqq").songs, []);
    assert.deepEqual(smartSearch(c, 'a"b* OR (').songs, []);
  });

  test(`[${label}] Persian normalization: Arabic ي/ك match ی/ک both ways`, () => {
    const c = seeded(tok);
    assert.equal(normSearch("كرمان"), normSearch("کرمان"));
    assert.equal(normSearch("خليج"), normSearch("خلیج"));
    assert.equal(normSearch("می‌رود"), normSearch("می رود")); // ZWNJ
    assert.equal(normSearch("سـلام"), "سلام"); // tatweel
    assert.equal(smartSearch(c, "خليج فارس").songs[0].videoId, id(2));
    assert.equal(smartSearch(c, "کرمان").songs[0].videoId, id(6)); // stored with Arabic kaf
    assert.equal(smartSearch(c, "كرمان").songs[0].videoId, id(6));
  });

  test(`[${label}] archived and played songs rank higher`, () => {
    const c = seeded(tok);
    c.saveArtistPage("a3", { songs: [song(10, "Dance Floor", [{ id: "a3", name: "Led Zeppelin" }]), song(11, "Dance Night", [{ id: "a3", name: "Led Zeppelin" }])] });
    c.stored(id(11), { title: "Dance Night" }, 5);
    assert.equal(smartSearch(c, "dance").songs[0].videoId, id(11));
    assert.equal(smartSearch(c, "dance").songs[0].archived, true);
  });

  test(`[${label}] tags, mood words and combos`, () => {
    const c = seeded(tok);
    c.saveLastfm({ videoId: id(1), track: { listeners: 5, tags: ["persian", "pop"] } }, 1);
    c.saveLastfm({ videoId: id(3), track: { listeners: 5, tags: ["persian", "folk"] } }, 1);
    c.saveLastfm({ videoId: id(4), track: { listeners: 5, tags: ["rock"] } }, 1);
    c.saveAnalysis(id(3), { sad: 0.9 }, "s", 1);
    c.saveAnalysis(id(5), { party: 0.8, happy: 0.7 }, "s", 1);
    let r = smartSearch(c, "persian");
    assert.deepEqual(r.tags, ["persian"]);
    assert.deepEqual(r.songs.filter((s) => s.why === "tag:persian").map((s) => s.videoId).sort(), [id(1), id(3)]);
    r = smartSearch(c, "sad persian");
    assert.deepEqual(r.tags, ["sad", "persian"]);
    const tagged = r.songs.filter((s) => s.why.startsWith("tag:"));
    assert.deepEqual(tagged.map((s) => s.videoId), [id(3)]);
    r = smartSearch(c, "غمگین");
    assert.deepEqual(r.tags, ["sad"]);
    assert.equal(r.songs[0].videoId, id(3));
    r = smartSearch(c, "dance");
    assert.deepEqual(r.tags, ["party"]);
    assert.ok(r.songs.some((s) => s.why === "tag:party" && s.videoId === id(5)) || r.songs[0].videoId === id(5));
    r = smartSearch(c, "rock sad"); // no song has both
    assert.deepEqual(r.songs.filter((s) => s.why.startsWith("tag:")), []);
  });

  test(`[${label}] alias artists (MusicBrainz) come first and bring their songs`, () => {
    const c = seeded(tok);
    c.db.prepare("INSERT INTO mb_aliases(alias_norm,artist_id,alias,locale) VALUES(?,?,?,?)").run("گوگوش", "a2", "گوگوش", "fa");
    const r = smartSearch(c, "گوگوش");
    assert.equal(r.artists[0].id, "a2");
    assert.equal(r.artists[0].alias, "گوگوش");
    assert.deepEqual(r.songs.filter((s) => s.why === "alias").map((s) => s.videoId).sort(), [id(3), id(6)]);
    const p = smartSearch(c, "googo");
    assert.equal(p.artists[0].name, "Googoosh"); // name prefix, NOCASE
  });
}

test("ranking: artist name/alias match puts that artist's songs first, stored first", () => {
  const c = seeded();
  c.db.prepare("INSERT INTO mb_aliases(alias_norm,artist_id,alias,locale) VALUES(?,?,?,?)").run("ابی", "a1", "ابی", "fa");
  c.saveArtistPage("a3", { songs: [song(20, "Ebi Tribute", [{ id: "a3", name: "Led Zeppelin" }]), song(21, "قابیل", [{ id: "a3", name: "Led Zeppelin" }])] });
  c.stored(id(2), { title: "خلیج فارس" }, 5);
  const r = smartSearch(c, "ابی");
  assert.deepEqual(r.songs.slice(0, 2).map((s) => s.videoId), [id(2), id(1)]); // archived Ebi song, then the other
  assert.ok(r.songs.findIndex((s) => s.videoId === id(21)) > 1); // substring of قابیل is far behind
  const e = smartSearch(c, "ebi");
  assert.deepEqual(e.songs.slice(0, 2).map((s) => s.videoId).sort(), [id(1), id(2)]);
});

test("ranking: whole word beats substring", () => {
  const c = mk();
  c.saveArtistPage("a1", { songs: [song(1, "Baranak Night", [{ id: "a1", name: "X" }]), song(2, "Bezan Baran", [{ id: "a1", name: "X" }])] });
  const r = smartSearch(c, "baran");
  assert.equal(r.songs[0].videoId, id(2));
});

test("ranking: several words need all of them; OR fallback only when nothing matches, weak results dropped", () => {
  const c = mk();
  c.saveArtistPage("a1", { songs: [
    song(1, "Khalij Fars", [{ id: "a1", name: "X" }]), song(2, "Persian Gulf Fars", [{ id: "a1", name: "X" }]),
    song(3, "Totally Unrelated Khalij", [{ id: "a1", name: "X" }]),
  ] });
  let r = smartSearch(c, "khalij fars");
  assert.deepEqual(r.songs.map((s) => s.videoId), [id(1)]); // not the one-word matches
  r = smartSearch(c, "khalij mars");
  assert.deepEqual(r.songs.map((s) => s.videoId).sort(), [id(1), id(3)]); // OR fallback
});
