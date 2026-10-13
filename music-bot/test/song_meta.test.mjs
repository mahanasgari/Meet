import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalize, similarity, songMeta, splitUploadTitle } from "../src/song_meta.js";

test("normalize unifies Arabic letters to Persian", () => {
  assert.equal(normalize("كيارش"), "کیارش");
  assert.equal(normalize("يك"), "یک");
  assert.equal(normalize("مدرسة"), "مدرسه");
});

test("normalize removes diacritics and tatweel", () => {
  assert.equal(normalize("سَلام"), "سلام");
  assert.equal(normalize("سـلام"), "سلام");
});

test("normalize drops brackets, official video, lyrics and 4k", () => {
  assert.equal(normalize("Song (Official Video) [4K]"), "song");
  assert.equal(normalize("Title {Lyrics} Official Video"), "title");
  assert.equal(normalize("Cheshmoon Siah I Lyrics Video"), "cheshmoon siah i");
});

test("normalize removes feat. tail", () => {
  assert.equal(normalize("Maslak - Vaghti Az Hame Khastam feat. Darab"), "maslak vaghti az hame khastam");
  assert.equal(normalize("Track ft Someone"), "track");
});

test("similarity: identical is 1", () => {
  assert.equal(similarity("In Eshghe", "In Eshghe"), 1);
  assert.equal(similarity("كيارش", "کیارش"), 1);
});

test("similarity: word order does not matter", () => {
  assert.ok(similarity("Vaghti Az Hame Khastam", "Khastam Az Hame Vaghti") >= 0.9);
});

test("similarity: containment counts", () => {
  assert.ok(similarity("In Eshghe", "Sami Beigi - In Eshghe I Official Video") >= 0.8);
});

test("similarity: unrelated or empty is 0", () => {
  assert.equal(similarity("Oftadi Mese Ashk", "Chi Mishe Badet"), 0);
  assert.equal(similarity("", "anything"), 0);
  assert.equal(similarity(null, "x"), 0);
});

test("splitUploadTitle: quoted title with bilingual suffix", () => {
  assert.deepEqual(
    splitUploadTitle('Sogand - "Bilite Yektarafe" OFFICIAL VIDEO | سوگند - بلیط یک طرفه'),
    { title: "Bilite Yektarafe", artist: "Sogand" },
  );
});

test("splitUploadTitle: feat and bracket noise", () => {
  assert.deepEqual(
    splitUploadTitle("Maslak - Vaghti Az Hame Khastam (Ft. Darab) [OFFICIAL VISUALIZER] [Produced by Omid Honarvar]"),
    { title: "Vaghti Az Hame Khastam", artist: "Maslak" },
  );
});

test("splitUploadTitle: lyric video with Persian parenthesis", () => {
  assert.deepEqual(
    splitUploadTitle("Naser Zeynali - Cheshmoon Siah I Lyrics Video ( ناصر زینلی - چشمون سیاه )"),
    { title: "Cheshmoon Siah", artist: "Naser Zeynali" },
  );
});

test("splitUploadTitle: no separator uses channel as artist, with Topic suffix stripped", () => {
  assert.deepEqual(splitUploadTitle("Tarsidam Azat", "The Don - Topic"), { title: "Tarsidam Azat", artist: "The Don" });
  assert.deepEqual(splitUploadTitle("Tarsidam Azat"), { title: "Tarsidam Azat", artist: null });
});

test("splitUploadTitle: reversed 'Title - Artist' when the right side is the channel", () => {
  assert.deepEqual(splitUploadTitle("Tarsidam Azat - The Don", "The Don - Topic"), { title: "Tarsidam Azat", artist: "The Don" });
});

test("songMeta: ytm_track keeps title, artist and artists", () => {
  assert.deepEqual(
    songMeta({ sourceKind: "ytm_track", title: "T", artist: "A", artists: ["A", "B"], album: "Al", durationS: 200 }),
    { title: "T", artist: "A", artists: ["A", "B"], album: "Al", durationS: 200 },
  );
  assert.deepEqual(songMeta({ sourceKind: "ytm_video", title: "T", artist: "A" }).artists, ["A"]);
});

test("songMeta: youtube kind splits meta.videoTitle", () => {
  const m = songMeta({
    sourceKind: "youtube",
    title: "fallback",
    ytChannel: "Sogand",
    meta: { videoTitle: 'Sogand - "Bilite Yektarafe" OFFICIAL VIDEO | سوگند - بلیط یک طرفه' },
    durationS: 210,
  });
  assert.equal(m.title, "Bilite Yektarafe");
  assert.equal(m.artist, "Sogand");
  assert.deepEqual(m.artists, ["Sogand"]);
  assert.equal(m.durationS, 210);
});

test("songMeta: null gives null", () => {
  assert.equal(songMeta(null), null);
  assert.equal(songMeta(undefined), null);
});
