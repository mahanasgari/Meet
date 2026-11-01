import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/catalog.js";
import { ArtistCrawler, parseArtistPage, parseSongList } from "../src/artist_crawl.js";

const A = "UCqQhiAox0_6YMFl621JWazg";
const B = "UCaaaaaaaaaaaaaaaaaaaaaa";
const run = (text, browseId) => ({ text, ...(browseId ? { navigationEndpoint: { browseEndpoint: { browseId } } } : {}) });
const row = (videoId, title, artists, album, dur) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [run(title)] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [...artists.map(([n, id]) => run(n, id)), ...(album ? [run(" • "), run(album[0], album[1])] : [])] } } },
    ],
    fixedColumns: dur ? [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [run(dur)] } } }] : [],
  },
});
const two = (title, id, subtitle) => ({ musicTwoRowItemRenderer: { title: { runs: [run(title, id)] }, subtitle: { runs: [run(subtitle)] }, navigationEndpoint: { browseEndpoint: { browseId: id } } } });

const omv = (title, videoId, type = "MUSIC_VIDEO_TYPE_OMV") => ({ musicTwoRowItemRenderer: { title: { runs: [run(title)] }, subtitle: { runs: [run("Reza Pishro")] }, navigationEndpoint: { watchEndpoint: { videoId, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } } } } });

const page = {
  header: {
    musicImmersiveHeaderRenderer: {
      title: { runs: [run("Reza Pishro")] },
      description: { runs: [run("Persian rapper.")] },
      subscriptionButton: { subscribeButtonRenderer: { subscriberCountText: { runs: [run("352K")] } } },
    },
  },
  contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicShelfRenderer: {
      title: { runs: [run("Songs", "VLOLAK5uy_songs")] },
      contents: [row("r6qM8uSNjjU", "SEPAR (Shield)", [["Reza Pishro", A], ["Yas", B]], ["Shield", "MPREb_x1"], "3:40")],
    } },
    { musicCarouselShelfRenderer: { contents: [two("REFIGH", "MPREb_refigh", "2026"), two("Nirvana", "MPREb_nirvana", "Album • 2023")] } },
    { musicCarouselShelfRenderer: { contents: [omv("Bazam Kalan", "vvvvvvvvvv1"), omv("Live clip", "vvvvvvvvvv2", "MUSIC_VIDEO_TYPE_UGC")] } },
    { musicCarouselShelfRenderer: { contents: [two("Yas", B, "1.1M subscribers")] } },
  ] } } } }] } },
};

test("parses an artist page", () => {
  const p = parseArtistPage(page);
  assert.equal(p.name, "Reza Pishro");
  assert.equal(p.subscribers, 352000);
  assert.equal(p.description, "Persian rapper.");
  assert.equal(p.songsPlaylist, "VLOLAK5uy_songs");
  assert.deepEqual(p.songs.map((s) => [s.videoId, s.title, s.durationS, s.album?.id]), [["r6qM8uSNjjU", "SEPAR (Shield)", 220, "MPREb_x1"]]);
  assert.deepEqual(p.songs[0].artists.map((a) => a.id), [A, B]);
  assert.deepEqual(p.albums.map((a) => [a.id, a.kind, a.year]), [["MPREb_refigh", null, 2026], ["MPREb_nirvana", "Album", 2023]]);
  assert.deepEqual(p.videos, [{ videoId: "vvvvvvvvvv1", title: "Bazam Kalan" }]);
  assert.deepEqual(p.related.map((a) => [a.id, a.subscribers]), [[B, 1100000]]);
});

test("parses a song list once each, in order", () => {
  const list = { contents: [row("aaaaaaaaaaa", "One", [["Reza Pishro", A]]), row("bbbbbbbbbbb", "Two", []), row("aaaaaaaaaaa", "One", [])] };
  assert.deepEqual(parseSongList(list).map((s) => s.title), ["One", "Two"]);
});

test("crawler saves pages, skips artists found after it started, then finishes", async () => {
  const catalog = new Catalog(join(mkdtempSync(join(tmpdir(), "ac-")), "c.db"));
  // A known artist (via a song credit) before the crawl starts.
  catalog.saveGraph("zzzzzzzzzzz", { upNext: [{ videoId: "r6qM8uSNjjU", title: "SEPAR", artists: [{ id: A, name: "Reza Pishro" }] }] }, 1000);
  const asked = [];
  const crawler = new ArtistCrawler({
    catalog,
    cutoff: 2000,
    now: () => 5000,
    log: { log() {}, error() {} },
    transport: async (path, body) => {
      asked.push(body.browseId);
      return body.browseId === A ? page : { contents: [row("ccccccccccc", "Three", [["Reza Pishro", A]], null, "2:00"), row("livelivelive".slice(0, 11), "Live in Istanbul", [["Reza Pishro", A]], null, "1:32:10")] };
    },
  });
  assert.equal(await crawler.tick(), true);
  assert.deepEqual(asked, [A, "VLOLAK5uy_songs"]);
  const st = catalog.artistPageStats(2000);
  assert.equal(st.fetched, 1);
  assert.equal(st.pending, 0, "Yas, first seen on the page, is not crawled");
  const songs = catalog.db.prepare("SELECT video_id FROM song_artists WHERE artist_id=? ORDER BY video_id").all(A).map((r) => r.video_id);
  assert.deepEqual(songs, ["ccccccccccc", "liveliveliv", "r6qM8uSNjjU"], "the concert is still known");
  assert.equal(catalog.db.prepare("SELECT subscribers FROM artists WHERE id=?").get(A).subscribers, 352000);
  // Its songs wait in the archive queue, the page's top song first.
  const jobs = catalog.db.prepare("SELECT video_id, reason, weight FROM jobs ORDER BY weight DESC").all();
  assert.deepEqual(jobs.map((j) => [j.video_id, j.reason]), [["r6qM8uSNjjU", "crawl"], ["ccccccccccc", "crawl"]]);
  assert.ok(jobs[0].weight > jobs[1].weight);
  assert.equal(await crawler.tick(), false, "nothing left");
});

test("crawler pauses when YouTube Music pushes back, without marking the artist failed", async () => {
  const catalog = new Catalog(join(mkdtempSync(join(tmpdir(), "ac-")), "c.db"));
  catalog.saveGraph("zzzzzzzzzzz", { upNext: [{ videoId: "r6qM8uSNjjU", title: "SEPAR", artists: [{ id: A, name: "Reza Pishro" }] }] }, 1000);
  let t = 5000;
  const crawler = new ArtistCrawler({
    catalog, cutoff: 2000, now: () => t, log: { log() {}, error() {} },
    transport: async () => { throw new Error("ytmusic browse: HTTP 429"); },
  });
  await crawler.tick();
  assert.equal(catalog.artistPageStats(2000).pending, 1);
  assert.ok(crawler.pauseUntil > t);
});

test("official videos from an artist page become video matches, never overriding", () => {
  const catalog = new Catalog(join(mkdtempSync(join(tmpdir(), "ac-")), "c.db"));
  const song = (videoId, title) => ({ videoId, title, artists: [{ id: A, name: "Reza Pishro" }] });
  catalog.saveArtistPage(A, { name: "Reza Pishro", songs: [song("aaaaaaaaaa1", "Bazam Kalan"), song("aaaaaaaaaa2", "Khoda"), song("aaaaaaaaaa3", "Rejected Song"), song("aaaaaaaaaa4", "Kept Song"), song("aaaaaaaaaa5", "Paye Sabeti")] }, 1000);
  catalog.videoMapReject("aaaaaaaaaa3", 1000);
  catalog.videoMapReject("aaaaaaaaaa3", 1000); // idempotent
  catalog.db.prepare("UPDATE video_map SET rejected_json=? WHERE video_id=?").run('["vvvvvvvvvv3"]', "aaaaaaaaaa3");
  catalog.videoMapSet("aaaaaaaaaa4", "oldoldold01", "Old", 500);
  const n = catalog.matchArtistVideos(A, [
    { videoId: "vvvvvvvvvv1", title: "Reza Pishro - Bazam Kalan (Official Music Video)" },
    { videoId: "vvvvvvvvvv9", title: "Reza Pishro - Something Else (Official Video)" },
    { videoId: "vvvvvvvvvv3", title: "Reza Pishro - Rejected Song (Official Video)" },
    { videoId: "vvvvvvvvvv4", title: "Reza Pishro - Kept Song (Official Video)" },
    { videoId: "vvvvvvvvvv5", title: "Paye Sabeti Unplugged (Official Video)" },
  ], 9000);
  assert.equal(n, 1);
  assert.equal(catalog.videoMapGet("aaaaaaaaaa1").srcId, "vvvvvvvvvv1");
  assert.equal(catalog.videoMapGet("aaaaaaaaaa2"), null);
  assert.equal(catalog.videoMapGet("aaaaaaaaaa3").srcId, null);
  assert.equal(catalog.videoMapGet("aaaaaaaaaa4").srcId, "oldoldold01");
  assert.equal(catalog.videoMapGet("aaaaaaaaaa5"), null, "an unplugged video isn't the studio song's");
});

test("nextVideoMatches: stored YouTube Music songs without a match, most played first", () => {
  const catalog = new Catalog(join(mkdtempSync(join(tmpdir(), "ac-")), "c.db"));
  const ins = catalog.db.prepare("INSERT INTO songs(video_id, status, source_kind, stored_at) VALUES(?,?,?,?)");
  ins.run("aaaaaaaaaa1", "stored", "ytm_track", 100);
  ins.run("aaaaaaaaaa2", "stored", "ytm_track", 200);
  ins.run("aaaaaaaaaa3", "stored", "ytm_track", 50);
  ins.run("aaaaaaaaaa4", "stored", "ytm_track", 300); // already matched
  ins.run("aaaaaaaaaa5", "stored", "video", 400); // not a YTM track
  ins.run("aaaaaaaaaa6", "pending", "ytm_track", null);
  const play = catalog.db.prepare("INSERT INTO plays(video_id, at) VALUES(?,1)");
  play.run("aaaaaaaaaa3"); play.run("aaaaaaaaaa3"); play.run("aaaaaaaaaa1");
  catalog.videoMapSet("aaaaaaaaaa4", null, null, 1);
  assert.deepEqual(catalog.nextVideoMatches(10), ["aaaaaaaaaa3", "aaaaaaaaaa1", "aaaaaaaaaa2"]);
  assert.deepEqual(catalog.nextVideoMatches(1), ["aaaaaaaaaa3"]);
});
