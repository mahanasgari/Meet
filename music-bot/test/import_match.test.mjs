import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  detectSource,
  parseCsv,
  parseSpotifyPlaylistId,
  parseApplePlaylist,
  matchTracks,
} from "../src/import_match.js";

test("detectSource", () => {
  assert.equal(detectSource("https://open.spotify.com/playlist/abc123"), "spotify");
  assert.equal(detectSource("https://music.youtube.com/playlist?list=PLx"), "youtube");
  assert.equal(detectSource("https://soundcloud.com/user/sets/foo"), "soundcloud");
  assert.equal(detectSource("https://music.apple.com/us/playlist/pl.abc"), "apple");
  assert.equal(detectSource("https://example.com/x"), null);
});

test("parseSpotifyPlaylistId", () => {
  assert.equal(parseSpotifyPlaylistId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), "37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(parseSpotifyPlaylistId("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), "37i9dQZF1DXcBWIGoYBM5M");
});

test("parseApplePlaylist", () => {
  assert.deepEqual(
    parseApplePlaylist("https://music.apple.com/us/playlist/today/pl.abc-123"),
    { storefront: "us", id: "pl.abc-123" },
  );
});

test("parseCsv title and artist", () => {
  const { tracks } = parseCsv("Title,Artist,ISRC\nHello,Adele,GBAAA123\n");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, "Hello");
  assert.equal(tracks[0].artist, "Adele");
  assert.equal(tracks[0].isrc, "GBAAA123");
});

test("matchTracks uses videoId and catalog", async () => {
  const catalog = {
    videoIdBySpotifyId: (id) => (id === "sp1" ? "aaaaaaaaaaa" : null),
    videoIdByIsrc: () => null,
    findSongByName: () => null,
  };
  const { matches } = await matchTracks({
    tracks: [
      { title: "A", artist: "B", videoId: "bbbbbbbbbbb" },
      { title: "C", artist: "D", externalId: "sp1" },
    ],
    catalog,
    searchYtm: async () => [],
  });
  assert.equal(matches[0].status, "matched");
  assert.equal(matches[0].videoId, "bbbbbbbbbbb");
  assert.equal(matches[1].videoId, "aaaaaaaaaaa");
  assert.equal(matches[1].status, "matched");
});

test("matchTracks scores YTM search", async () => {
  const { matches } = await matchTracks({
    tracks: [{ title: "Hello", artist: "Adele", durationS: 295 }],
    catalog: null,
    searchYtm: async () => [
      { id: "ccccccccccc", title: "Hello", channel: "Adele", duration: 295 },
      { id: "ddddddddddd", title: "Hello (live)", channel: "Someone", duration: 400 },
    ],
  });
  assert.equal(matches[0].videoId, "ccccccccccc");
  assert.equal(matches[0].status, "matched");
});
