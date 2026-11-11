import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog, VIDEO_VOTES_TO_DEFAULT } from "../src/catalog.js";
import { videoCandidates, videoKind } from "../src/video.js";

const want = { title: "In Eshghe", artist: "Sami Beigi", durationS: 225 };
const rows = [
  { videoId: "lyrics00001", title: "Sami Beigi - In Eshghe (Lyrics)", subtitle: "Sami Beigi • 1M views", durationS: 226 },
  { videoId: "official001", title: "Sami Beigi - In Eshghe I Official Video", subtitle: "Sami Beigi • 1.2M views", durationS: 232, videoType: "OMV" },
  { videoId: "live0000001", title: "Sami Beigi - In Eshghe Live in Concert", subtitle: "Sami Beigi", durationS: 290 },
  { videoId: "cover000001", title: "Sami Beigi - In Eshghe Piano Cover", subtitle: "Piano Fan", durationS: 220 },
  { videoId: "fancover001", title: "In Eshghe (Sami Beigi cover)", subtitle: "Some Fan", durationS: 220 },
  { videoId: "other000001", title: "Sami Beigi - Divoone", subtitle: "Sami Beigi", durationS: 225 },
  { videoId: "wrongart001", title: "Other Singer - In Eshghe", subtitle: "Other Singer", durationS: 225 },
  { videoId: "official001", title: "duplicate", subtitle: "Sami Beigi", durationS: 232 },
  { videoId: "pod00000001", title: "Sami Beigi In Eshghe talk", subtitle: "Sami Beigi", videoType: "PODCAST_EPISODE" },
];

test("videos list: this song's versions, official first, other songs left out", () => {
  const list = videoCandidates(rows, want);
  assert.equal(list[0].videoId, "official001");
  assert.deepEqual(new Set(list.map((x) => x.videoId)), new Set(["official001", "live0000001", "lyrics00001", "cover000001"]),
    "other songs, another singer and a fan's cover (artist only in brackets) are left out");
  assert.equal(list.at(-1).kind, "cover", "covers last");
  assert.deepEqual(Object.fromEntries(list.map((x) => [x.videoId, x.kind])),
    { official001: "official", live0000001: "live", lyrics00001: "lyrics", cover000001: "cover" });
  assert.equal(list[0].channel, "Sami Beigi");
  assert.ok(!videoCandidates(rows, want, { exclude: ["official001"] }).some((x) => x.videoId === "official001"));
  assert.equal(videoCandidates(rows, want, { limit: 2 }).length, 2);
  assert.deepEqual(videoCandidates(rows, { title: "" }), []);
});

test("a song stored under its upload title only lists that song", () => {
  const rows2 = [
    { videoId: "official001", title: "Sami Beigi - In Eshghe I Official Video ( سامی بیگی - این عشقه )", subtitle: "Sami Beigi", durationS: 232 },
    { videoId: "lyrics00001", title: "Sami Beigi - In Eshghe I Lyric Video ( سامی بیگی - این عشقه )", subtitle: "Sami Beigi", durationS: 225 },
    { videoId: "cheshmat001", title: "Sami Beigi - Cheshmat I Official Audio ( سامی بیگی - چشمات )", subtitle: "Sami Beigi", durationS: 178 },
    { videoId: "sultan00001", title: "Sami Beigi - Sultan Feat Dynatonic OFFICIAL TRACK - KING ALBUM", subtitle: "Sami Beigi", durationS: 204 },
  ];
  const list = videoCandidates(rows2, { title: "Sami Beigi - In Eshghe I Official Video ( سامی بیگی - این عشقه )", artist: "Sami Beigi", durationS: 232 });
  assert.deepEqual(list.map((x) => x.videoId), ["official001", "lyrics00001"]);
});

test("video kinds", () => {
  assert.equal(videoKind({ title: "X - Y (Official Audio)" }), "audio");
  assert.equal(videoKind({ title: "X - Y", videoType: "ATV" }), "audio");
  assert.equal(videoKind({ title: "X - Y | موزیک ویدیو" }), "official");
  assert.equal(videoKind({ title: "X - Y", videoType: "OMV" }), "official");
  assert.equal(videoKind({ title: "X - Y" }), "fan");
});

test("a video chosen by enough listeners becomes the song's default", () => {
  const c = new Catalog(join(mkdtempSync(join(tmpdir(), "vv-")), "c.db"));
  assert.deepEqual(c.videoVote("song0000001", "u1", "live0000001", "Live"), { votes: 1, isDefault: false });
  assert.equal(c.videoMapGet("song0000001"), null, "one listener changes only their own");
  // u1 changes their mind: still one vote in all.
  c.videoVote("song0000001", "u1", "official001", "Official");
  assert.deepEqual(c.videoVotes("song0000001", "u1"), { counts: { official001: 1 }, mine: "official001" });
  for (let i = 2; i <= VIDEO_VOTES_TO_DEFAULT; i++) c.videoVote("song0000001", `u${i}`, "official001", "Official");
  assert.equal(c.videoMapGet("song0000001").srcId, "official001");
  assert.equal(c.videoVotes("song0000001").counts.official001, VIDEO_VOTES_TO_DEFAULT);
});

test("video download progress: video stream then audio, colour codes ignored, never goes back", async () => {
  const { progressTracker } = await import("../src/video.js");
  const got = [];
  const t = progressTracker((p) => got.push(p));
  for (const l of ["MPPROG \x1b[0;94m  10.0%\x1b[0m", "noise", "MPPROG  50.0%", "MPPROG 100.0%", "MPPROG   5.0%", "MPPROG  4.0%", "MPPROG 100%"]) t(l);
  assert.deepEqual(got, [0.08, 0.4, 0.8, 0.81, 0.9]);
});
