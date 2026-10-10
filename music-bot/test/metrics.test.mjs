import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Metrics, routeKey, visitorId } from "../src/metrics.js";

const DAY = 864e5;
// Fixed instant: 2026-10-10T11:30:00Z (hour bucket "2026-10-10T11").
const NOW = Date.UTC(2026, 9, 10, 11, 30);

test("routeKey maps paths to dashboard groups", () => {
  const cases = {
    "/audio": "audio",
    "/lyrics/lrclib/get": "lyrics",
    "/app/files/x.apk": "app-download",
    "/app/latest.json": "update-check",
    "/app/": "app",
    "/jam/abc": "jam",
    "/nope": "other",
    "/admin/invites": "admin",
  };
  for (const [path, key] of Object.entries(cases)) {
    assert.equal(routeKey(path), key, path);
  }
});

test("record counts requests, errors (5xx only), ms and slow requests", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.record("audio", 200, 120.4, NOW);
  m.record("audio", 200, 80, NOW);
  m.record("audio", 500, 10, NOW);
  m.record("audio", 503, 10, NOW);
  m.record("audio", 499, 10, NOW);
  m.record("audio", 200, 5000, NOW); // not slow: needs > 5000
  m.record("audio", 200, 5001, NOW); // slow
  const h = m.snapshot().hours["2026-10-10T11"];
  // count, errors, ms sum (rounded per request), slow
  assert.deepEqual(h.audio, [7, 2, 120 + 80 + 10 + 10 + 10 + 5000 + 5001, 1]);
});

test("record keys buckets by UTC hour", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.record("audio", 200, 1, NOW);
  m.record("audio", 200, 1, NOW + 30 * 60e3); // 12:00 UTC, next bucket
  m.record("jam", 200, 1, NOW); // same hour, other route
  const hours = m.snapshot().hours;
  assert.deepEqual(Object.keys(hours).sort(), ["2026-10-10T11", "2026-10-10T12"]);
  assert.equal(hours["2026-10-10T11"].audio[0], 1);
  assert.equal(hours["2026-10-10T11"].jam[0], 1);
  assert.equal(hours["2026-10-10T12"].audio[0], 1);
  assert.equal(hours["2026-10-10T12"].jam, undefined);
});

test("error keeps newest first and caps at 100", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  for (let i = 0; i < 150; i++) m.error("audio", 500, `e${i}`, NOW + i);
  const errors = m.snapshot().errors;
  assert.equal(errors.length, 50, "snapshot shows the newest 50");
  assert.equal(m.data.errors.length, 100, "stored list is capped at 100");
  assert.equal(m.data.errors[0].detail, "e149", "newest first");
  assert.equal(m.data.errors[99].detail, "e50");
  assert.equal(errors[0].status, 500);
  assert.equal(errors[0].route, "audio");
});

test("error truncates long detail text", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.error("audio", 500, "x".repeat(1000), NOW);
  assert.equal(m.data.errors[0].detail.length, 300);
});

test("download counts once per visitor per file per day", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.download("app.apk", "203.0.113.7", NOW);
  m.download("app.apk", "203.0.113.7", NOW + 1000);
  m.download("app.apk", "198.51.100.9", NOW + 2000);
  m.download("other.apk", "203.0.113.7", NOW + 3000);
  const day = "2026-10-10";
  assert.deepEqual(m.snapshot().downloads, { [day]: { "app.apk": 2, "other.apk": 1 } });
});

test("snapshot reports counts, not ids or raw IPs", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.download("app.apk", "203.0.113.7", NOW);
  m.updateCheck("203.0.113.7", NOW);
  const json = JSON.stringify(m.snapshot());
  assert.ok(!json.includes("203.0.113.7"), "no raw IP in snapshot");
  assert.ok(!json.includes(visitorId("203.0.113.7")), "no visitor id in snapshot");
  assert.deepEqual(m.snapshot().checks, { "2026-10-10": 1 });
  assert.deepEqual(m.snapshot().downloads["2026-10-10"], { "app.apk": 1 });
});

test("updateCheck is unique per visitor per day", () => {
  const m = new Metrics(mkdtempSync(join(tmpdir(), "met-")));
  m.updateCheck("10.0.0.1", NOW);
  m.updateCheck("10.0.0.1", NOW + 60e3);
  m.updateCheck("10.0.0.2", NOW);
  m.updateCheck("10.0.0.1", NOW + DAY); // next day counts again
  assert.deepEqual(m.snapshot().checks, { "2026-10-10": 2, "2026-10-11": 1 });
});

test("save then reload restores the data", () => {
  const dir = mkdtempSync(join(tmpdir(), "met-"));
  const now = Date.now();
  const m = new Metrics(dir);
  m.record("audio", 502, 40, now);
  m.error("audio", 502, "boom", now);
  m.ytTest(true, 300, "ok", now);
  m.download("app.apk", "10.0.0.1", now);
  m.updateCheck("10.0.0.1", now);
  m.save();

  const r = new Metrics(dir);
  assert.deepEqual(r.snapshot(), m.snapshot());
  assert.equal(r.snapshot().yt.length, 1);
  assert.equal(r.snapshot().errors[0].detail, "boom");
});

test("save does nothing when nothing changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "met-"));
  const m = new Metrics(dir);
  m.save();
  assert.throws(() => readFileSync(join(dir, "metrics.json")), "no file written");
});

test("save prunes data older than 30 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "met-"));
  const now = Date.now();
  const old = now - 40 * DAY;
  const recent = now - 29 * DAY;
  const m = new Metrics(dir);
  m.record("audio", 200, 1, old);
  m.record("audio", 200, 1, recent);
  m.record("audio", 200, 1, now);
  m.download("app.apk", "10.0.0.1", old);
  m.download("app.apk", "10.0.0.1", recent);
  m.updateCheck("10.0.0.1", old);
  m.updateCheck("10.0.0.1", recent);
  m.save();

  const r = new Metrics(dir);
  const s = r.snapshot();
  const oldHour = new Date(old).toISOString().slice(0, 13);
  const recentHour = new Date(recent).toISOString().slice(0, 13);
  const oldDay = new Date(old).toISOString().slice(0, 10);
  const recentDay = new Date(recent).toISOString().slice(0, 10);
  assert.equal(s.hours[oldHour], undefined, "old hour bucket dropped");
  assert.equal(s.hours[recentHour].audio[0], 1, "29-day-old bucket kept");
  assert.equal(s.hours[oldDay], undefined, "old download day dropped");
  assert.equal(s.downloads[recentDay]["app.apk"], 1);
  assert.equal(s.checks[oldDay], undefined, "old update-check day dropped");
  assert.equal(s.checks[recentDay], 1);
});

test("visitorId is stable and 12 hex characters", () => {
  const id = visitorId("203.0.113.7");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(visitorId("203.0.113.7"), id);
  assert.notEqual(visitorId("203.0.113.8"), id);
});

test("saved file holds no raw IPs", () => {
  const dir = mkdtempSync(join(tmpdir(), "met-"));
  const m = new Metrics(dir);
  m.download("app.apk", "203.0.113.7", Date.now());
  m.updateCheck("203.0.113.7", Date.now());
  m.save();
  assert.ok(!readFileSync(join(dir, "metrics.json"), "utf8").includes("203.0.113.7"));
});
