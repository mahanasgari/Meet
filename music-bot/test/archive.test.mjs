import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Archive, HomeLink, handleHomeRoute, songInfoFromYtdlp, videoIdFromUrl } from "../src/archive.js";

const ID = "dQw4w9WgXcQ";
const PAGE = `https://www.youtube.com/watch?v=${ID}`;
const silentLog = { error() {}, log() {} };

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "arch-"));
}

/** Fake cache backed by real files in [dir]. */
function fakeCache(dir, hasIds = []) {
  const calls = [];
  return {
    calls,
    has: (id) => hasIds.includes(id),
    touch: (id) => calls.push(["touch", id]),
    path: (id) => join(dir, `cache-${id}.m4a`),
    tmpPath: (id) => join(dir, `tmp-${id}.part`),
    commit: (tmp, id) => {
      calls.push(["commit", id]);
      renameSync(tmp, join(dir, `cache-${id}.m4a`));
    },
    discard: (tmp) => {
      calls.push(["discard", tmp]);
      rmSync(tmp, { force: true });
    },
    stats: () => ({}),
  };
}

/** Fake home link that records every call. */
function fakeHome(overrides = {}) {
  const calls = [];
  const rec = (name, val) => async (...args) => {
    calls.push([name, ...args]);
    return typeof val === "function" ? val(...args) : val;
  };
  return {
    calls,
    claim: rec("claim", { action: "youtube" }),
    lookup: rec("lookup", null),
    plays: rec("plays", undefined),
    failed: rec("failed", undefined),
    peers: rec("peers", []),
    stored: rec("stored", undefined),
    nextJobs: rec("nextJobs", []),
    ...overrides,
  };
}

function makeArchive({ dir = tmpDir(), cache, tg, home, ...rest } = {}) {
  return new Archive({
    serverId: "s1",
    token: "t",
    dir,
    cache: cache || fakeCache(dir),
    tg: tg || { ready: true, connect: async () => {}, open: async () => null },
    home: home || fakeHome(),
    ytdlpBin: "nonexistent",
    ytdlpArgs: () => [],
    log: silentLog,
    ...rest,
  });
}

/** The play is recorded just after the response ends, so poll briefly. */
async function waitFor(check, ms = 1000) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

/** Starts an HTTP server on a random port; returns {url, close}. */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------- videoIdFromUrl ----------

test("videoIdFromUrl reads watch URLs on every YouTube host variant", () => {
  for (const host of ["https://youtube.com", "https://www.youtube.com", "https://m.youtube.com", "https://music.youtube.com"]) {
    assert.equal(videoIdFromUrl(`${host}/watch?v=${ID}`), ID, host);
  }
});

test("videoIdFromUrl reads youtu.be, shorts, embed and live paths", () => {
  assert.equal(videoIdFromUrl(`https://youtu.be/${ID}`), ID);
  assert.equal(videoIdFromUrl(`https://youtu.be/${ID}?si=x`), ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/shorts/${ID}?feature=share`), ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/live/${ID}`), ID);
});

test("videoIdFromUrl ignores extra query params", () => {
  assert.equal(videoIdFromUrl(`https://www.youtube.com/watch?list=PL123&v=${ID}&t=42`), ID);
  assert.equal(videoIdFromUrl(`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`), ID);
});

test("videoIdFromUrl rejects ids that are not 11 safe characters", () => {
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=abcdefghij"), null, "10 chars");
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=abcdefghijkl"), null, "12 chars");
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=abcdefghi!k"), null, "bad char");
  assert.equal(videoIdFromUrl("https://youtu.be/abc.defghij"), null, "dot in id");
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch"), null, "no v param");
});

test("videoIdFromUrl returns null for non-YouTube hosts and garbage", () => {
  assert.equal(videoIdFromUrl("https://vimeo.com/123456789"), null);
  assert.equal(videoIdFromUrl(`https://notyoutube.com/watch?v=${ID}`), null);
  assert.equal(videoIdFromUrl("not a url"), null);
  assert.equal(videoIdFromUrl(""), null);
});

// ---------- songInfoFromYtdlp ----------

test("songInfoFromYtdlp maps a music track", () => {
  const info = songInfoFromYtdlp({
    track: "Song",
    artists: ["Artist A", "Artist B"],
    album: "Album",
    release_year: 2020,
    duration: 200,
    channel: "Artist A - Topic",
    tags: Array.from({ length: 50 }, (_, i) => `t${i}`),
    acodec: "mp4a.40.2",
    abr: 128,
    upload_date: "20100101",
    title: "Song (Official Audio)",
  });
  assert.equal(info.title, "Song");
  assert.equal(info.artist, "Artist A");
  assert.deepEqual(info.artists, ["Artist A", "Artist B"]);
  assert.equal(info.album, "Album");
  assert.equal(info.ytChannel, "Artist A");
  assert.equal(info.year, 2020, "release_year wins over upload_date");
  assert.equal(info.durationS, 200);
  assert.equal(info.codec, "mp4a.40.2");
  assert.equal(info.bitrateKbps, 128);
  assert.equal(info.tags.length, 40, "tags capped at 40");
  assert.equal(info.meta.videoTitle, "Song (Official Audio)");
});

test("songInfoFromYtdlp maps a plain video from channel and upload date", () => {
  const info = songInfoFromYtdlp({
    title: "Video Title",
    channel: "Chan",
    upload_date: "20091023",
    description: "x".repeat(1000),
  });
  assert.equal(info.title, "Video Title");
  assert.equal(info.artist, "Chan");
  assert.deepEqual(info.artists, ["Chan"]);
  assert.equal(info.year, 2009);
  assert.equal(info.ytChannel, "Chan");
  assert.equal(info.meta.uploadDate, "20091023");
  assert.equal(info.meta.description.length, 600);
});

test("songInfoFromYtdlp splits a comma-separated artist string", () => {
  const info = songInfoFromYtdlp({ title: "T", artist: "A, B" });
  assert.equal(info.artist, "A");
  assert.deepEqual(info.artists, ["A", "B"]);
});

test("songInfoFromYtdlp returns {} for null or undefined", () => {
  assert.deepEqual(songInfoFromYtdlp(null), {});
  assert.deepEqual(songInfoFromYtdlp(undefined), {});
});

// ---------- handleHomeRoute ----------

function fakeCatalog() {
  const calls = [];
  return {
    calls,
    lookup: (id) => {
      calls.push(["lookup", id]);
      return { id, status: "stored" };
    },
    claim: (id, server) => {
      calls.push(["claim", id, server]);
      return { action: "download" };
    },
    stored: (id, info) => {
      calls.push(["stored", id, info]);
      return { id, msgId: 5 };
    },
    failed: (...args) => {
      calls.push(["failed", ...args]);
    },
    nextJobs: (server, limit) => {
      calls.push(["nextJobs", server, limit]);
      return ["job1"];
    },
    recordPlays: (events) => {
      calls.push(["recordPlays", events]);
    },
  };
}

test("handleHomeRoute /archive/lookup wraps the song", async () => {
  const catalog = fakeCatalog();
  const r = await handleHomeRoute("/archive/lookup", { id: ID }, { catalog, peers: () => [] });
  assert.deepEqual(r, { song: { id: ID, status: "stored" } });
  assert.deepEqual(catalog.calls, [["lookup", ID]]);
});

test("handleHomeRoute /archive/claim passes id and server through", async () => {
  const catalog = fakeCatalog();
  const r = await handleHomeRoute("/archive/claim", { id: ID, server: "s2" }, { catalog, peers: () => [] });
  assert.deepEqual(r, { action: "download" });
  assert.deepEqual(catalog.calls, [["claim", ID, "s2"]]);
});

test("handleHomeRoute /archive/stored returns {ok, song}", async () => {
  const catalog = fakeCatalog();
  const info = { title: "T", msgId: 9 };
  const r = await handleHomeRoute("/archive/stored", { id: ID, info }, { catalog, peers: () => [] });
  assert.deepEqual(r, { ok: true, song: { id: ID, msgId: 5 } });
  assert.deepEqual(catalog.calls, [["stored", ID, info]]);
  await handleHomeRoute("/archive/stored", { id: ID }, { catalog, peers: () => [] });
  assert.deepEqual(catalog.calls[1], ["stored", ID, {}], "missing info becomes {}");
});

test("handleHomeRoute /archive/failed passes flags and returns {ok}", async () => {
  const catalog = fakeCatalog();
  const r = await handleHomeRoute(
    "/archive/failed",
    { id: ID, server: "s3", error: "boom", flags: { blocked: true } },
    { catalog, peers: () => [] },
  );
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(catalog.calls, [["failed", ID, "s3", "boom", { blocked: true }]]);
});

test("handleHomeRoute /archive/jobs clamps limit to 5 and defaults to 1", async () => {
  const catalog = fakeCatalog();
  const big = await handleHomeRoute("/archive/jobs", { server: "s1", limit: 99 }, { catalog, peers: () => [] });
  assert.deepEqual(big, { ids: ["job1"] });
  await handleHomeRoute("/archive/jobs", { server: "s1" }, { catalog, peers: () => [] });
  assert.deepEqual(catalog.calls, [
    ["nextJobs", "s1", 5],
    ["nextJobs", "s1", 1],
  ]);
});

test("handleHomeRoute /archive/plays slices to 1000 events and tolerates non-arrays", async () => {
  const catalog = fakeCatalog();
  const events = Array.from({ length: 1500 }, (_, i) => ({ i }));
  const r = await handleHomeRoute("/archive/plays", { events }, { catalog, peers: () => [] });
  assert.deepEqual(r, { ok: true });
  assert.equal(catalog.calls[0][1].length, 1000);
  assert.equal(catalog.calls[0][1][999].i, 999);

  await handleHomeRoute("/archive/plays", { events: "nope" }, { catalog, peers: () => [] });
  assert.deepEqual(catalog.calls[1], ["recordPlays", []]);
});

test("handleHomeRoute /archive/peers returns {peers}", async () => {
  const peers = [{ id: "s2", url: "https://s2" }];
  const r = await handleHomeRoute("/archive/peers", {}, { catalog: fakeCatalog(), peers: () => peers });
  assert.deepEqual(r, { peers });
});

test("handleHomeRoute returns null for unknown paths", async () => {
  assert.equal(await handleHomeRoute("/archive/nope", {}, { catalog: fakeCatalog(), peers: () => [] }), null);
});

// ---------- HomeLink (catalog mode) ----------

test("HomeLink in catalog mode delegates to the catalog and peers function", async () => {
  const catalog = fakeCatalog();
  const link = new HomeLink({ catalog, peers: () => ["p1"] });
  assert.deepEqual(await link.claim(ID, "s1"), { action: "download" });
  assert.deepEqual(await link.stored(ID, { title: "T" }), { id: ID, msgId: 5 });
  await link.failed(ID, "s1", "err", { unavailable: true });
  assert.deepEqual(await link.nextJobs("s1", 2), ["job1"]);
  await link.plays([{ videoId: ID }]);
  assert.deepEqual(await link.lookup(ID), { id: ID, status: "stored" });
  assert.deepEqual(await link.peers(), ["p1"]);
  assert.deepEqual(catalog.calls, [
    ["claim", ID, "s1"],
    ["stored", ID, { title: "T" }],
    ["failed", ID, "s1", "err", { unavailable: true }],
    ["nextJobs", "s1", 2],
    ["recordPlays", [{ videoId: ID }]],
    ["lookup", ID],
  ]);
});

// ---------- Archive.handleAudio fast paths ----------

test("handleAudio returns false for non-YouTube URLs without calling anything", async () => {
  const home = fakeHome();
  const cache = fakeCache(tmpDir(), [ID]);
  const archive = makeArchive({ home, cache });
  const ok = await archive.handleAudio({ headers: {} }, {}, "https://vimeo.com/123456789", "");
  assert.equal(ok, false);
  assert.deepEqual(home.calls, []);
  assert.deepEqual(cache.calls, []);
  assert.deepEqual(archive.events, []);
});

test("handleAudio serves a cache hit from disk with exact bytes", async () => {
  const dir = tmpDir();
  const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const cache = fakeCache(dir, [ID]);
  writeFileSync(cache.path(ID), bytes);
  const home = fakeHome();
  const archive = makeArchive({ dir, cache, home });
  const srv = await listen(async (req, res) => {
    const ok = await archive.handleAudio(req, res, PAGE, "");
    if (!ok && !res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });
  try {
    const r = await fetch(srv.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/mp4");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  } finally {
    await srv.close();
  }
  assert.equal(archive.counters.disk, 1);
  assert.equal(archive.events.at(-1).source, "disk");
  assert.deepEqual(home.calls, [], "cache hit never asks home");
});

test("handleAudio returns false and records a youtube play when claim says wait", async () => {
  const home = fakeHome({ claim: async () => ({ action: "wait" }) });
  const archive = makeArchive({ home });
  const ok = await archive.handleAudio({ headers: {} }, {}, PAGE, "");
  assert.equal(ok, false);
  assert.equal(archive.events.length, 1);
  assert.equal(archive.events[0].source, "youtube");
  assert.equal(archive.events[0].videoId, ID);
  assert.equal(archive.counters.youtube, 1);
});

test("handleAudio streams a stored song from Telegram with 200, then 206 for a Range", async () => {
  const dir = tmpDir();
  const buffer = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  const opened = [];
  const tg = {
    ready: true,
    connect: async () => {},
    open: async (msgId) => {
      opened.push(msgId);
      return {
        size: buffer.length,
        mime: "audio/mp4",
        read: async function* (o, l) {
          yield buffer.subarray(o, o + l);
        },
      };
    },
  };
  const home = fakeHome({ claim: async () => ({ action: "stored", song: { msgId: 5 } }) });
  const cache = fakeCache(dir);
  const archive = makeArchive({ dir, cache, tg, home });
  const srv = await listen(async (req, res) => {
    const ok = await archive.handleAudio(req, res, PAGE, "");
    if (!ok && !res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });
  try {
    const full = await fetch(srv.url);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), buffer);
    await waitFor(() => archive.counters.telegram === 1);
    assert.equal(archive.counters.telegram, 1);

    const part = await fetch(srv.url, { headers: { Range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 10-19/${buffer.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), buffer.subarray(10, 20));
    await waitFor(() => archive.counters.telegram === 2);
    assert.equal(archive.counters.telegram, 2);
  } finally {
    await srv.close();
  }
  assert.deepEqual(opened, [5, 5]);
  // The full read also filled the disk cache with the exact bytes.
  assert.deepEqual(readFileSync(cache.path(ID)), buffer);
  assert.equal(archive.events.at(-1).source, "telegram");
});

test("handleAudio returns false when claim throws", async () => {
  const home = fakeHome({
    claim: async () => {
      throw new Error("home down");
    },
  });
  const archive = makeArchive({ home });
  const ok = await archive.handleAudio({ headers: {} }, {}, PAGE, "");
  assert.equal(ok, false);
  assert.equal(archive.events.at(-1).source, "youtube");
});

// ---------- flushPlays ----------

test("flushPlays sends events to home and clears them", async () => {
  const home = fakeHome();
  const archive = makeArchive({ home });
  archive.events.push({ videoId: "a", source: "disk" }, { videoId: "b", source: "telegram" });
  await archive.flushPlays();
  assert.deepEqual(home.calls, [
    ["plays", [
      { videoId: "a", source: "disk" },
      { videoId: "b", source: "telegram" },
    ]],
  ]);
  assert.deepEqual(archive.events, []);
});

test("flushPlays keeps events when home.plays rejects", async () => {
  const home = fakeHome({
    plays: async () => {
      throw new Error("offline");
    },
  });
  const archive = makeArchive({ home });
  const events = [
    { videoId: "a", source: "disk" },
    { videoId: "b", source: "youtube" },
  ];
  archive.events.push(...events);
  await archive.flushPlays();
  assert.deepEqual(archive.events, events);
});
