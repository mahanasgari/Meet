import { test } from "node:test";
import assert from "node:assert/strict";
import { Releases, parseAgo, songTitle, norm } from "../src/releases.js";

const NOW = Date.UTC(2026, 9, 30, 18);
const YAS = "UCRyLZKf3KdF8AZ6TTxSiB3Q";

const video = (videoId, title, owner, ago, length = "4:10", verified = false) => ({
  videoRenderer: {
    videoId, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: owner }] },
    publishedTimeText: ago ? { simpleText: ago } : undefined, lengthText: { simpleText: length },
    ownerBadges: verified ? [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_VERIFIED_ARTIST" } }] : [],
  },
});
const song = (videoId, title, artists) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: artists.flatMap(([name, id], i) => [
        ...(i ? [{ text: " & " }] : []), { text: name, navigationEndpoint: { browseEndpoint: { browseId: id } } }]) } } },
    ],
  },
});

test("parseAgo and songTitle", () => {
  assert.equal(parseAgo("46 minutes ago", NOW), NOW - 46 * 6e4);
  assert.equal(parseAgo("3 weeks ago", NOW), NOW - 21 * 864e5);
  assert.equal(parseAgo("Streamed 10 minutes ago", NOW), null);
  assert.equal(songTitle("REZA PISHRO x TECH N9NE x YAS - SEPAR (Shield) سپر | Official Visualizer"), "SEPAR (Shield) سپر");
  assert.equal(songTitle("Reza Pishro X Saaren - Mirrors (Official Music Video) رضا پیشرو و سارن - آینه ها"), "Mirrors");
  assert.equal(norm("Yas"), norm("YAS"));
});

test("finds a new collaboration, drops fan uploads and noise, confirms on YouTube Music", async () => {
  const ytmCalls = [];
  const rel = new Releases({
    now: () => NOW,
    ytSearch: async () => ({ contents: [
      video("N7f16dVVLm8", "REZA PISHRO x TECH N9NE x YAS - SEPAR (Shield) سپر | Official Visualizer", "Strange Music Inc and 4 more", "46 minutes ago", "7:14"),
      video("6CdjCaupoEc", "آهنگ جدید یاس و پیشرو و تک ناین Persian Rap", "Abdolsalam", null, "40:23"), // a stream
      video("cjpQsS2VFrs", "لایو یاس و پیشرو و تکناین با ندا سرمست", "ZAR2RAP", "1 month ago", "8:06"), // live clip
      video("vR_3BzXixKA", "ریمیکس جدید یاس • تتلو", "Mix Faes", "4 weeks ago", "3:25"), // remix
      video("B8S0y0B81hw", "شادمهر عقیلی - گل یاس", "Persian Media Club", "3 weeks ago", "5:13"), // not by Yas: no YTM match
      video("old00000000", "YAS - Old Song", "Yas", "5 months ago"), // too old
    ] }),
    ytmSongs: async (q) => {
      ytmCalls.push(q);
      if (q === "یاس") return { contents: [song("9gnUhGhmNpE", "Sarkoob", [["یاس", YAS]]), song("t-BbfCBTV2A", "Empty Crown", [["YAS", YAS]])] };
      if (q.includes("SEPAR")) return { contents: [song("r6qM8uSNjjU", "SEPAR (Shield)", [["Reza Pishro", "UCqQ"], ["Tech N9ne", "UCtn"], ["Yas", YAS]])] };
      return { contents: [song("zzzzzzzzzzz", "Gole Yas", [["Shadmehr Aghili", "UCsh"]])] };
    },
  });
  const items = await rel.forArtists([{ id: YAS, name: "یاس" }]);
  assert.deepEqual(items, [{ videoId: "r6qM8uSNjjU", title: "SEPAR (Shield)", artist: "Reza Pishro, Tech N9ne, Yas", publishedAt: NOW - 46 * 6e4 }]);
  // Cached: asking again makes no new requests.
  const n = ytmCalls.length;
  await rel.forArtists([{ id: YAS, name: "یاس" }]);
  assert.equal(ytmCalls.length, n);
});

test("the artist's own verified upload counts even before YouTube Music has it", async () => {
  const rel = new Releases({
    now: () => NOW,
    ytSearch: async () => ({ contents: [video("abcdefghijk", "Reza Pishro - Payan (Official Video)", "Reza Pishro", "2 days ago", "3:30", true)] }),
    ytmSongs: async () => ({ contents: [] }),
  });
  assert.deepEqual(await rel.forArtists([{ name: "Reza Pishro" }]), [
    { videoId: "abcdefghijk", title: "Payan", artist: "Reza Pishro", publishedAt: NOW - 2 * 864e5 },
  ]);
});

test("songs from several artists merge newest first without duplicates", async () => {
  const rel = new Releases({
    now: () => NOW,
    ytSearch: async (q) => ({ contents: q === "A1"
      ? [video("aaaaaaaaaaa", "A1 - First (Official)", "A1", "3 days ago", "3:00", true), video("ccccccccccc", "A1 x A2 - Collab", "A1", "1 day ago", "3:00", true)]
      : [video("ccccccccccc", "A1 x A2 - Collab", "A1", "1 day ago", "3:00", true), video("bbbbbbbbbbb", "A2 - Second", "A2", "2 days ago", "3:00", true)] }),
    ytmSongs: async () => ({ contents: [] }),
  });
  const items = await rel.forArtists([{ name: "A1" }, { name: "A2" }]);
  assert.deepEqual(items.map((x) => x.videoId), ["ccccccccccc", "bbbbbbbbbbb", "aaaaaaaaaaa"]);
});

test("a song titled with the artist's name, or by a namesake, is not theirs", async () => {
  const rel = new Releases({
    now: () => NOW,
    ytSearch: async () => ({ contents: [
      video("lLcR1N1GV8w", "Mohammad Motamedi - Sogand (Official Video)", "Mohammad Motamedi", "7 days ago", "4:00", true),
      video("bxRGIe8Bdy8", "Yas&Zyzz - Kül [Official Music Video]", "Yas Resmi", "3 weeks ago", "2:30"),
    ] }),
    ytmSongs: async (q) => ({ contents: q === "یاس" ? [song("9gnUhGhmNpE", "Sarkoob", [["Yas", YAS]])] : [song("kul00000000", "Kül", [["Yas", "UCturkishyas"], ["Zyzz", "UCzyzz"]])] }),
  });
  assert.deepEqual(await rel.forArtists([{ name: "Sogand" }]), []);
  assert.deepEqual(await rel.forArtists([{ id: YAS, name: "یاس" }]), []);
});

test("a video not on YouTube Music needs a verified channel", async () => {
  const rel = new Releases({
    now: () => NOW,
    ytSearch: async () => ({ contents: [
      video("aaaaaaaaaaa", "Reza Pishro X Saaren - Mirrors (Official Music Video)", "Mori Hemo and MKA Media Production", "8 hours ago", "4:38", true),
      video("bbbbbbbbbbb", "Reza Pishro - Fake (Official Video)", "Some Fan", "2 days ago", "3:00", false),
    ] }),
    ytmSongs: async () => ({ contents: [] }),
  });
  assert.deepEqual((await rel.forArtists([{ name: "Reza Pishro" }])).map((x) => x.videoId), ["aaaaaaaaaaa"]);
});
