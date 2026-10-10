import { strict as assert } from "node:assert";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appStats, dayRange, listeningStats, trafficStats, userStats } from "../src/analytics.js";

const DAY = 864e5;
const H = 3600e3;
// Fixed instant: 2026-10-10T12:00:00Z (a Saturday).
const NOW = Date.UTC(2026, 9, 10, 12, 0);
const tmp = () => mkdtempSync(join(tmpdir(), "an-"));

function writeUser(dir, id, events) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // Stats skip files older than the window; make them look fresh.
  utimesSync(path, NOW / 1000, NOW / 1000);
}

test("listeningStats: totals for this and the previous period", () => {
  const dir = tmp();
  writeUser(dir, "abc", [
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - H },
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - 2 * DAY },
    { t: "play", id: "s2", ti: "Song2", a: "ArtistY", s: 120, ts: NOW - 2 * DAY + H },
    { t: "skip", id: "s2", ti: "Song2", a: "ArtistY", s: 30, ts: NOW - 2 * DAY + 2 * H },
    { t: "like", id: "s1", ts: NOW - 2 * DAY + 3 * H },
    { t: "play", id: "s9", ti: "Old", a: "Old", s: 100, ts: NOW - 20 * DAY }, // older than both periods
    { t: "play", id: "s9", ti: "Future", a: "Old", s: 100, ts: NOW + H }, // after now
  ]);
  writeUser(dir, "def", [
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - H },
    { t: "fav", id: "s1", ts: NOW - H },
    { t: "play", id: "s3", ti: "Song3", a: "ArtistZ", s: 600, ts: NOW - 8 * DAY }, // previous period
  ]);
  writeFileSync(join(dir, "notes.txt"), "ignored");

  const r = listeningStats(dir, 7, NOW);
  assert.deepEqual(r.totals, {
    plays: 4,
    skips: 1,
    listeners: 2,
    minutes: 12, // 690 s = 11.5 min, rounded
    likes: 2, // like + fav
    songs: 2,
    artists: 2,
  });
  assert.deepEqual(r.prevTotals, {
    plays: 1,
    skips: 0,
    listeners: 1,
    minutes: 10,
    likes: 0,
    songs: 1,
    artists: 1,
  });
});

test("listeningStats: per-day rows, top songs and artists", () => {
  const dir = tmp();
  writeUser(dir, "abc", [
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - H },
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - 2 * DAY },
    { t: "play", id: "s2", ti: "Song2", a: "ArtistY", s: 120, ts: NOW - 2 * DAY + H },
    { t: "skip", id: "s2", ti: "Song2", a: "ArtistY", s: 30, ts: NOW - 2 * DAY + 2 * H },
  ]);
  writeUser(dir, "def", [
    { t: "play", id: "s1", ti: "Song1", a: "ArtistX", s: 180, ts: NOW - H },
    { t: "play", id: "s3", ti: "Song3", a: "ArtistZ", s: 600, ts: NOW - 8 * DAY },
  ]);

  const r = listeningStats(dir, 7, NOW);
  assert.equal(r.days.length, 7);
  const byDay = Object.fromEntries(r.days.map((d) => [d.day, d]));
  const today = byDay["2026-10-10"];
  assert.equal(today.plays, 2);
  assert.equal(today.skips, 0);
  assert.equal(today.listeners, 2);
  assert.equal(today.minutes, 6);
  const oct8 = byDay["2026-10-08"];
  assert.equal(oct8.plays, 2);
  assert.equal(oct8.skips, 1);
  assert.equal(oct8.listeners, 1);
  assert.equal(oct8.minutes, 6); // 330 s = 5.5 min, rounded
  const total = r.days.reduce((n, d) => n + d.plays, 0);
  assert.equal(total, r.totals.plays);

  assert.deepEqual(
    r.topSongs.map((s) => [s.id, s.title, s.artist, s.plays, s.skips, s.listeners]),
    [
      ["s1", "Song1", "ArtistX", 3, 0, 2],
      ["s2", "Song2", "ArtistY", 1, 1, 1],
    ],
  );
  assert.deepEqual(r.topArtists, [
    { artist: "ArtistX", plays: 3, listeners: 2, songs: 1 },
    { artist: "ArtistY", plays: 1, listeners: 1, songs: 1 },
  ]);
});

test("listeningStats: heatmap is 7x24 in Tehran time, Saturday = index 0", () => {
  const dir = tmp();
  // 2026-10-10T11:00Z is 14:30 in Tehran on a Saturday -> heat[0][14].
  writeUser(dir, "abc", [{ t: "play", id: "s1", ti: "A", a: "B", s: 60, ts: Date.UTC(2026, 9, 10, 11, 0) }]);
  // 2026-10-08T12:00Z is 15:30 Tehran on a Thursday -> heat[5][15].
  writeUser(dir, "def", [{ t: "play", id: "s2", ti: "C", a: "D", s: 60, ts: Date.UTC(2026, 9, 8, 12, 0) }]);

  const { heat } = listeningStats(dir, 7, NOW);
  assert.equal(heat.length, 7);
  for (const row of heat) assert.equal(row.length, 24);
  assert.equal(heat[0][14], 1);
  assert.equal(heat[5][15], 1);
  assert.equal(heat.flat().reduce((a, b) => a + b, 0), 2);
});

test("listeningStats: missing dir gives zeros and does not throw", () => {
  const r = listeningStats(join(tmp(), "nope"), 7, NOW);
  assert.equal(r.totals.plays, 0);
  assert.equal(r.totals.listeners, 0);
  assert.equal(r.prevTotals.plays, 0);
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.topSongs, []);
  assert.deepEqual(r.topArtists, []);
});

test("dayRange ends today (UTC) and is oldest first", () => {
  assert.deepEqual(dayRange(3, NOW), ["2026-10-08", "2026-10-09", "2026-10-10"]);
});

test("trafficStats: health/admin excluded, byDay, byRoute, byServer, hourly", () => {
  const snaps = {
    de: {
      hours: {
        "2026-10-10T11": { audio: [4, 1, 400, 1], health: [10, 0, 50, 0], search: [2, 0, 100, 0] },
        "2026-10-09T23": { audio: [2, 0, 200, 0], admin: [1, 0, 5, 0] },
        "2026-10-07T23": { audio: [5, 0, 500, 0] }, // before the 3-day window
      },
      errors: [
        { at: "2026-10-10T11:05:00.000Z", route: "audio", status: 500, detail: "de-new" },
        { at: "2026-10-09T10:00:00.000Z", route: "audio", status: 500, detail: "de-old" },
      ],
    },
    us: {
      hours: {
        "2026-10-10T11": { audio: [1, 0, 100, 0], jam: [3, 1, 60, 0] },
      },
      errors: [{ at: "2026-10-10T11:20:00.000Z", route: "jam", status: 500, detail: "us-new" }],
    },
    fr: null,
  };
  const { traffic, errors } = trafficStats(snaps, 3, NOW);

  assert.deepEqual(traffic.byDay, [
    { day: "2026-10-08", n: 0, err: 0, audio: 0, audioErr: 0, audioMs: null },
    { day: "2026-10-09", n: 2, err: 0, audio: 2, audioErr: 0, audioMs: 100 },
    { day: "2026-10-10", n: 10, err: 2, audio: 5, audioErr: 1, audioMs: 100 },
  ]);

  assert.deepEqual(
    traffic.byRoute.map((r) => [r.route, r.n, r.err, r.slow, r.avgMs]),
    [
      ["audio", 7, 1, 1, 100],
      ["jam", 3, 1, 0, 20],
      ["search", 2, 0, 0, 50],
    ],
  );

  assert.deepEqual(
    traffic.byServer.map((s) => [s.server, s.n, s.err, s.audio, s.audioMs]),
    [
      ["de", 8, 1, 6, 100],
      ["us", 4, 1, 1, 100],
    ],
  );

  assert.equal(traffic.hourly.length, 48);
  assert.equal(traffic.hourly[47].hour, "2026-10-10T12", "last bucket is the current hour");
  const h11 = traffic.hourly.find((h) => h.hour === "2026-10-10T11");
  assert.deepEqual({ n: h11.n, err: h11.err }, { n: 10, err: 2 });
  assert.deepEqual(traffic.hourly.find((h) => h.hour === "2026-10-09T23"), { hour: "2026-10-09T23", n: 2, err: 0 });

  assert.equal(errors.length, 3);
  assert.deepEqual(
    errors.map((e) => [e.server, e.detail]),
    [
      ["us", "us-new"],
      ["de", "de-new"],
      ["de", "de-old"],
    ],
  );
});

test("userStats: today, last7, lastN, servers merged and lastSeen latest", () => {
  const invites = [
    { code: "A1", name: "Ali", uid: "u1" },
    { code: "B2", name: "Bob", uid: "u2" },
    { code: "C3", name: "Cy", uid: "u3" },
  ];
  const usages = {
    home: {
      u1: { days: { "2026-10-10": 3, "2026-10-08": 2 }, lastSeen: 1000 },
      u2: { days: { "2026-09-01": 5, "2026-10-10": 1 }, lastSeen: 500 },
    },
    de: {
      u1: { days: { "2026-10-10": 4, "2026-10-05": 1 }, lastSeen: 2000 },
      u2: { days: { "2026-10-09": 2 }, lastSeen: 1500 },
    },
  };
  const { users, usageByDay } = userStats(invites, usages, 7, NOW);

  assert.deepEqual(users.map((u) => u.code), ["A1", "B2", "C3"]);
  assert.equal(users[0].name, "Ali");

  const [a, b, c] = users;
  assert.equal(a.lastSeen, 2000);
  assert.equal(a.today, 7);
  assert.equal(a.last7, 10);
  assert.equal(a.lastN, 10);
  assert.deepEqual(a.days, { "2026-10-10": 7, "2026-10-08": 2, "2026-10-05": 1 });
  assert.deepEqual(a.servers, { home: 5, de: 5 });

  // 2026-09-01 is outside the 7-day window, so it counts nowhere.
  assert.equal(b.lastSeen, 1500);
  assert.equal(b.today, 1);
  assert.equal(b.last7, 3);
  assert.equal(b.lastN, 3);
  assert.deepEqual(b.days, { "2026-10-10": 1, "2026-10-09": 2 });
  assert.deepEqual(b.servers, { home: 1, de: 2 });

  assert.equal(c.lastSeen, null);
  assert.equal(c.today, 0);
  assert.deepEqual(c.days, {});

  assert.equal(usageByDay.length, 7);
  const day = Object.fromEntries(usageByDay.map((d) => [d.day, d]));
  assert.deepEqual(day["2026-10-10"], { day: "2026-10-10", active: 2, requests: 8 });
  assert.deepEqual(day["2026-10-09"], { day: "2026-10-09", active: 1, requests: 2 });
  assert.deepEqual(day["2026-10-08"], { day: "2026-10-08", active: 1, requests: 2 });
  assert.deepEqual(day["2026-10-04"], { day: "2026-10-04", active: 0, requests: 0 });
});

test("appStats: downloads summed across servers, out-of-range days dropped", () => {
  const snaps = {
    de: {
      downloads: { "2026-10-10": { "app.apk": 3, "x.zip": 1 }, "2026-09-01": { "app.apk": 9 } },
      checks: { "2026-10-10": 4, "2026-10-09": 2 },
    },
    us: {
      downloads: { "2026-10-10": { "app.apk": 2 } },
      checks: { "2026-10-10": 1, "2026-10-01": 7 },
    },
  };
  const { downloads, checks } = appStats(snaps, 3, NOW);

  const apk = downloads.find((d) => d.day === "2026-10-10" && d.file === "app.apk");
  assert.equal(apk.n, 5);
  const zip = downloads.find((d) => d.file === "x.zip");
  assert.equal(zip.n, 1);
  assert.equal(downloads.length, 2, "Sept 1 and Oct 1 are out of range");
  assert.equal(downloads.some((d) => d.day === "2026-09-01"), false);

  assert.deepEqual(checks, [
    { day: "2026-10-08", n: 0 },
    { day: "2026-10-09", n: 2 },
    { day: "2026-10-10", n: 5 },
  ]);
});
