import { strict as assert } from "node:assert";
import { test } from "node:test";
import { artistSongsPlaylist, interestFor, listedSongIds, playlistIds, upNextIds } from "../src/interest.js";

const panel = (videoId) => ({ playlistPanelVideoRenderer: { videoId } });
const row = (videoId) => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId } } });
const id = (n) => `song${String(n).padStart(7, "0")}`; // 11 chars

test("up next: in order, without the current song, deduped", () => {
  const json = { contents: { tabs: [{ queue: [panel(id(0)), panel(id(1)), { playlistPanelVideoWrapperRenderer: { primaryRenderer: panel(id(2)) } }, panel(id(1))] }] } };
  assert.deepEqual(upNextIds(json, id(0)), [id(1), id(2)]);
});

test("next: first six are 'next', the rest 'interest'", () => {
  const json = { q: Array.from({ length: 12 }, (_, i) => panel(id(i + 1))) };
  const [next, more] = interestFor("next", { videoId: id(0) }, json);
  assert.equal(next.reason, "next");
  assert.deepEqual(next.ids, [1, 2, 3, 4, 5, 6].map(id));
  assert.deepEqual(more.ids, [7, 8, 9, 10, 11, 12].map(id));
});

test("browse: artist/album/playlist pages count, the home feed doesn't", () => {
  const json = { shelf: [row(id(1)), row(id(2)), row("bad")] };
  assert.deepEqual(interestFor("browse", { browseId: "UCabc" }, json), [{ ids: [id(1), id(2)], reason: "interest" }]);
  assert.deepEqual(interestFor("browse", { browseId: "FEmusic_home" }, json), []);
  assert.equal(interestFor("browse", { continuation: "x" }, json)[0].ids.length, 2);
});

test("search: only the top five song results", () => {
  const json = { r: Array.from({ length: 9 }, (_, i) => row(id(i))) };
  assert.deepEqual(interestFor("search", {}, json)[0].ids, [0, 1, 2, 3, 4].map(id));
});

test("song rows without playlistItemData use the play button", () => {
  const r = { musicResponsiveListItemRenderer: { overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId: id(5) } } } } } } } };
  assert.deepEqual(listedSongIds([r]), [id(5)]);
});

test("playlist ids and the artist's 'Songs' playlist", () => {
  const nav = (browseId) => ({ navigationEndpoint: { browseEndpoint: { browseId } } });
  assert.deepEqual(playlistIds({ a: [{ browseEndpoint: { browseId: "VLPL1234567890ab" } }, { browseEndpoint: { browseId: "UCx" } }] }), ["VLPL1234567890ab"]);
  const page = { s: [{ musicShelfRenderer: { title: { runs: [{ text: "Songs", ...nav("VLOLAK5uy_songs") }] } } }] };
  assert.equal(artistSongsPlaylist(page), "VLOLAK5uy_songs");
  assert.equal(artistSongsPlaylist({}), null);
});
