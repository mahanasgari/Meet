import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { Calibration, feltMood, textPriors, tagPriors, lyricPriors, MoodModel } from "../src/mood_model.js";
import { isHomeOnlyPath } from "../src/home_routes.js";

// A small catalog shaped like ours: almost everything "danceable", more happy than sad.
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const synth = Array.from({ length: 220 }, () => ({
  sad: 0.9 * rnd() ** 2, happy: 0.9 * rnd() ** 1.2, relaxed: rnd() ** 0.8, aggressive: rnd() ** 3, party: rnd(),
  danceability: 0.3 + 0.7 * rnd() ** 0.35, energy: rnd(), valence: 0.25 + 0.5 * rnd(), arousal: 0.25 + 0.5 * rnd(),
}));
const cal = new Calibration(synth);
const ex = (title, sad, happy, danceability, relaxed, valence, arousal, scale) =>
  feltMood({ sad, happy, danceability, relaxed, valence, arousal, scale, energy: arousal, aggressive: 0.1, party: 0.5 }, { cal, title });

test("percentiles: midrank, empty column is 0.5", () => {
  const c = new Calibration([{ sad: 0.1 }, { sad: 0.2 }, { sad: 0.3 }, { sad: 0.4 }]);
  assert.equal(c.pct("sad", 0.25), 0.5);
  assert.equal(c.pct("sad", 0.2), 0.375);
  assert.equal(c.pct("sad", 9), 1);
  assert.equal(c.pct("happy", 0.3), 0.5);
});

test("the five real examples", () => {
  const delam = ex("Delam Az Donya Gerefte", 0.18, 0.24, 0.99, 0.73, 0.53, 0.61, "minor");
  const gham = ex("Gham Gerefte Hame Kooche Haye Ma Ro", 0.35, 0.63, 0.65, 0.79, 0.43, 0.56, "minor");
  const bandar = ex("Dar Del Bandar", 0.83, 0.36, 0.25, 0.94, 0.34, 0.34, "minor");
  const delEy = ex("Del Ey Del", 0.17, 0.70, 0.97, 0.45, 0.62, 0.59, "major");
  const baraye = ex("Sadegh & Amir Khalvat - Baraye", 0.11, 0.73, 1.0, 0.26, 0.40, 0.63, "minor");
  assert.equal(delam.label, "sad");
  assert.equal(gham.label, "sad");
  assert.equal(bandar.label, "sad");
  assert.ok(["happy", "dance"].includes(delEy.label), delEy.label);
  assert.notEqual(baraye.label, "sad");
  assert.ok(delam.dance < 0.2 && gham.dance < 0.2, "sad songs are not danceable-felt");
  assert.ok(delEy.dance > 0.5);
  // Even without a title (numbers only), the clearly sad ones stay above the happy one.
  assert.ok(ex("", 0.35, 0.63, 0.65, 0.79, 0.43, 0.56, "minor").sad > ex("", 0.17, 0.70, 0.97, 0.45, 0.62, 0.59, "major").sad);
  for (const f of [delam, gham, bandar, delEy, baraye]) for (const k of ["sad", "happy", "chill", "energetic", "dance"]) assert.ok(f[k] >= 0 && f[k] <= 1);
});

test("label is mixed under 0.5 and confidence is the gap", () => {
  const P = { sad: 0.3, happy: 0.3, valence: 0.5, relaxed: 0.3, arousal: 0.5, energy: 0.4, aggressive: 0.5, party: 0.5, danceability: 0.3 };
  const f = feltMood({ scale: "x" }, { cal: { pct: (c) => P[c] ?? 0.5 } });
  assert.equal(f.label, "mixed");
  assert.ok(f.confidence >= 0);
});

test("text, tag and lyric cues", () => {
  assert.ok(textPriors("دلم گرفته").sad > 0.3);
  assert.ok(textPriors("Tanhaei (Official Video)").sad > 0.3);
  assert.ok(textPriors("Tanhaei").happy < 0);
  assert.ok(textPriors("Aroosi Party Mix").dance > 0.2);
  assert.ok(textPriors("Lofi beats to sleep").chill > 0.3);
  assert.deepEqual(textPriors("Hello World"), {});
  assert.deepEqual(textPriors("Sadegh"), {}); // whole words only
  assert.ok(textPriors("غمگینم").sad > 0); // Persian suffix
  assert.ok(tagPriors([{ tag: "Melancholic", weight: 1, src: "lastfm" }]).sad > 0.2);
  assert.deepEqual(tagPriors([{ tag: "sad", weight: 1, src: "mood" }]), {}); // our own tag is ignored
  assert.ok(lyricPriors("غم و اشک و تنهایی و درد و جدایی دل من را گرفته است امشب").sad > 0.1);
  assert.ok(lyricPriors("shad shadi raghs jashn khande dance happy smile party dance").happy > 0.1);
  assert.deepEqual(lyricPriors("short"), {});
});

test("votes dominate with 2+ votes or the asker's own", () => {
  const row = { sad: 0.1, happy: 0.9, valence: 0.9, arousal: 0.5, energy: 0.5, relaxed: 0.3, aggressive: 0.1, party: 0.5, danceability: 0.9, scale: "major" };
  assert.equal(feltMood(row, { cal }).label, "happy");
  const one = { counts: { sad: 1 }, mine: null };
  assert.equal(feltMood(row, { cal, votes: one }).label, "happy"); // one stranger's vote does not count
  assert.equal(feltMood(row, { cal, votes: { counts: { sad: 2 }, mine: null } }).label, "sad");
  assert.equal(feltMood(row, { cal, votes: { counts: { sad: 1 }, mine: "sad" } }).label, "sad");
});

function seeded() {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "mm-")), "c.db"));
  c.saveArtistPage("a1", { name: "A", subscribers: 1, songs: ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((videoId, i) => ({ videoId, title: i === 0 ? "Gham Gerefte" : `S${i}`, artists: [{ id: "a1", name: "A" }] })) });
  c.saveAnalysis("aaaaaaaaaaa", { sad: 0.4, happy: 0.5, valence: 0.45, arousal: 0.5, danceability: 0.9, scale: "minor" }, "t");
  c.saveAnalysis("bbbbbbbbbbb", { sad: 0.1, happy: 0.8, valence: 0.8, arousal: 0.6, danceability: 0.9, scale: "major" }, "t");
  c.saveAnalysis("ccccccccccc", { sad: 0.2, happy: 0.4, valence: 0.5, arousal: 0.4, danceability: 0.9, scale: "major" }, "t");
  return c;
}

test("schema v22 votes, felt via the catalog, tags follow the felt label", () => {
  const c = seeded();
  assert.ok(c.db.prepare("SELECT 1 FROM sqlite_master WHERE name='mood_votes'").get());
  const f = c.mood.feltFor("aaaaaaaaaaa");
  assert.equal(f.label, "sad"); // title cue
  assert.ok(c.hasTag("sad", "aaaaaaaaaaa"));
  assert.equal(c.mood.feltFor("zzzzzzzzzzz"), null);
  c.voteMood("aaaaaaaaaaa", "u1", "dance");
  assert.equal(c.mood.feltFor("aaaaaaaaaaa", { uid: "u1" }).label, "dance");
  assert.equal(c.mood.feltFor("aaaaaaaaaaa", { uid: "u2" }).label, "sad"); // one stranger's vote
  c.voteMood("aaaaaaaaaaa", "u2", "dance");
  assert.equal(c.mood.feltFor("aaaaaaaaaaa", { uid: "u3" }).label, "dance");
  assert.ok(c.hasTag("party", "aaaaaaaaaaa"));
  c.voteMood("aaaaaaaaaaa", "u1", "happy"); // replaces
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM mood_votes").get().n, 2);
  assert.throws(() => c.voteMood("aaaaaaaaaaa", "u1", "bogus"), /invalid_vote/);
  assert.throws(() => c.voteMood("aaaaaaaaaaa", "", "sad"), /invalid_vote/);
});

test("one-off re-tag runs in slices and finishes", () => {
  const c = seeded();
  c.db.exec("DELETE FROM song_tags WHERE src='mood'");
  let r = c.retagMoods(2);
  assert.equal(r.done, false);
  while (!r.done) r = c.retagMoods(2);
  assert.ok(c.hasTag("sad", "aaaaaaaaaaa"));
  assert.deepEqual(c.retagMoods(2), { done: true, n: 0 });
});

test("calibration is cached for 30 minutes", () => {
  const c = seeded();
  const m = new MoodModel({ catalog: c });
  const a = m.ensureCalibrated(1000);
  assert.equal(m.ensureCalibrated(1000 + 29 * 60_000), a);
  assert.notEqual(m.ensureCalibrated(1000 + 31 * 60_000), a);
});

test("/mood/vote is home-only", () => assert.ok(isHomeOnlyPath("/mood/vote")));
