import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Monitor, nextAlerts, parseServices, probeAlerts, resourceAlerts, slug } from "../src/monitor.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mon-"));
const DAY = 864e5;
// Fixed instant: 2026-10-10T12:00:00Z. History files are named by UTC day.
const NOW = Date.UTC(2026, 9, 10, 12, 0);
const newMonitor = (dir) => new Monitor({ dir, token: "t", targets: () => [], localStats: () => ({}) });

test("slug makes url-safe ids", () => {
  assert.equal(slug("United States"), "united-states");
  assert.equal(slug("Germany"), "germany");
  assert.equal(slug("  --Meet!! "), "meet");
  assert.equal(slug(""), "server");
});

test("parseServices keeps only valid http(s) services", () => {
  assert.deepEqual(parseServices("Meet=https://a/api/health, bad, X=ftp://x"), [
    { id: "meet", label: "Meet", url: "https://a/api/health", role: "service" },
  ]);
  assert.deepEqual(parseServices(""), []);
  assert.deepEqual(parseServices(undefined), []);
});

test("nextAlerts: up to down raises a down alert with the error", () => {
  const out = nextAlerts({ down: false }, { down: true, error: "HTTP 502", checkedAt: "2026-10-10T10:00:00.000Z" }, "Germany");
  assert.deepEqual(out, [{ level: "down", text: "Germany is down (HTTP 502)" }]);
  const noAnswer = nextAlerts({ down: false }, { down: true, error: null }, "Germany");
  assert.equal(noAnswer[0].text, "Germany is down (no answer)");
});

test("nextAlerts: down to up says how long it was down", () => {
  const out = nextAlerts(
    { down: true, downSince: "2026-10-10T10:00:00.000Z" },
    { down: false, checkedAt: "2026-10-10T10:05:00.000Z" },
    "Germany",
  );
  assert.deepEqual(out, [{ level: "up", text: "Germany is back after 5 min" }]);
});

test("nextAlerts: YouTube blocked and recovered", () => {
  const blocked = nextAlerts({ down: false, ytBlocked: false }, { down: false, ytBlocked: true, ytDetail: "403" }, "DE");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].level, "warn");
  assert.ok(blocked[0].text.includes("YouTube is failing"));
  assert.ok(blocked[0].text.includes("403"));

  const back = nextAlerts({ down: false, ytBlocked: true }, { down: false, ytBlocked: false }, "DE");
  assert.deepEqual(back, [{ level: "up", text: "YouTube works again on DE" }]);
});

test("nextAlerts: first YouTube result (undefined to true) raises nothing", () => {
  assert.deepEqual(nextAlerts({ down: false }, { down: false, ytBlocked: true }, "DE"), []);
});

test("history buckets 15 minutes: up = min, ms = average of non-null", () => {
  const dir = tmp();
  const m = newMonitor(dir);
  const t0 = Date.UTC(2026, 9, 10, 12, 0); // a 15-minute bucket start
  const lines = [
    [t0, "de", 1, 100],
    [t0 + 60_000, "de", 0, null],
    [t0 + 120_000, "de", 1, 300],
    [t0 + 20 * 60_000, "de", 1, 200], // bucket 12:15
  ];
  writeFileSync(join(dir, "2026-10-10.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const h = m.history(7, NOW);
  assert.deepEqual(h.de, [
    [t0, 0, 200],
    [t0 + 15 * 60_000, 1, 200],
  ]);
});

test("uptime is the fraction of passed checks", () => {
  const dir = tmp();
  const m = newMonitor(dir);
  const t0 = Date.UTC(2026, 9, 10, 12, 0);
  const lines = [
    [t0, "de", 1, 100],
    [t0 + 60_000, "de", 0, null],
    [t0 + 120_000, "de", 1, 300],
    [t0 + 20 * 60_000, "de", 1, 200],
  ];
  writeFileSync(join(dir, "2026-10-10.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(m.uptime(24, NOW).de, 0.75);
  assert.equal(m.uptime(24, NOW).missing, undefined);
  assert.deepEqual(newMonitor(tmp()).uptime(24, NOW), {});
});

test("alert keeps newest first, writes alerts.json, and reloads", async () => {
  const dir = tmp();
  const m = newMonitor(dir);
  assert.equal(await m.alert("down", "de", "first"), false, "notify defaults to false");
  await m.alert("up", "de", "second");
  assert.equal(m.alerts[0].text, "second");
  assert.equal(m.alerts[1].text, "first");
  assert.equal(m.alerts[0].level, "up");
  assert.equal(m.alerts[0].server, "de");

  const saved = JSON.parse(readFileSync(join(dir, "alerts.json"), "utf8"));
  assert.deepEqual(saved.map((a) => a.text), ["second", "first"]);

  const reloaded = newMonitor(dir);
  assert.deepEqual(reloaded.alerts.map((a) => a.text), ["second", "first"]);
});

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const memSrv = (free, total = 8 * GB) => ({ mem: { free, total }, disk: null });
const diskSrv = (free, total = 100 * GB) => ({ mem: null, disk: { free, total } });

test("resourceAlerts: memory goes low below max(150 MB, 7%) and warns once", () => {
  // 8 GB total: low threshold = max(150 MB, 560 MB) = 560 MB
  let r = resourceAlerts({ memLow: false }, memSrv(600 * MB), "Germany");
  assert.equal(r.state.memLow, false);
  assert.deepEqual(r.alerts, []);

  r = resourceAlerts({ memLow: false }, memSrv(500 * MB), "Germany");
  assert.equal(r.state.memLow, true);
  assert.deepEqual(r.alerts, [{ level: "warn", text: "Memory low on Germany: 500 MB free of 8.0 GB" }]);

  // still low: no repeat alert
  r = resourceAlerts(r.state, memSrv(400 * MB), "Germany");
  assert.equal(r.state.memLow, true);
  assert.deepEqual(r.alerts, []);
});

test("resourceAlerts: memory hysteresis, recover only above max(250 MB, 12%)", () => {
  // 8 GB total: recover threshold = max(250 MB, 960 MB) = 960 MB
  let r = resourceAlerts({ memLow: true }, memSrv(800 * MB), "DE");
  assert.equal(r.state.memLow, true, "between thresholds stays low");
  assert.deepEqual(r.alerts, []);

  r = resourceAlerts(r.state, memSrv(900 * MB), "DE");
  assert.equal(r.state.memLow, true, "still below recover threshold");
  assert.deepEqual(r.alerts, []);

  r = resourceAlerts(r.state, memSrv(1000 * MB), "DE");
  assert.equal(r.state.memLow, false);
  assert.deepEqual(r.alerts, [{ level: "up", text: "Memory OK again on DE (1000 MB free)" }]);
});

test("resourceAlerts: memory between thresholds from OK does not trip", () => {
  const r = resourceAlerts({ memLow: false }, memSrv(700 * MB), "DE");
  assert.equal(r.state.memLow, false);
  assert.deepEqual(r.alerts, []);
});

test("resourceAlerts: disk low below max(1.5 GB, 5%), recovers above max(2.5 GB, 8%)", () => {
  // 100 GB total: low = max(1.5, 5) = 5 GB; recover = max(2.5, 8) = 8 GB
  let r = resourceAlerts({ diskLow: false }, diskSrv(6 * GB), "Worker");
  assert.equal(r.state.diskLow, false);
  assert.deepEqual(r.alerts, []);

  r = resourceAlerts({ diskLow: false }, diskSrv(4 * GB), "Worker");
  assert.equal(r.state.diskLow, true);
  assert.deepEqual(r.alerts, [{ level: "warn", text: "Disk almost full on Worker: 4.0 GB left" }]);

  r = resourceAlerts(r.state, diskSrv(7 * GB), "Worker");
  assert.equal(r.state.diskLow, true, "between thresholds stays low");
  assert.deepEqual(r.alerts, []);

  r = resourceAlerts(r.state, diskSrv(8.5 * GB), "Worker");
  assert.equal(r.state.diskLow, false);
  assert.deepEqual(r.alerts, [{ level: "up", text: "Disk space OK again on Worker (8.5 GB free)" }]);
});

test("resourceAlerts: small disks use the 1.5 GB / 2.5 GB floors", () => {
  // 10 GB total: 5% = 0.5 GB, so the 1.5 GB floor applies
  const r = resourceAlerts({ diskLow: false }, diskSrv(1 * GB, 10 * GB), "S");
  assert.equal(r.state.diskLow, true);
  assert.equal(r.alerts.length, 1);
});

test("resourceAlerts: first observation warns only when already low", () => {
  const low = resourceAlerts(undefined, { mem: { free: 100 * MB, total: 8 * GB }, disk: { free: 1 * GB, total: 100 * GB } }, "X");
  assert.deepEqual(low.state, { memLow: true, diskLow: true });
  assert.deepEqual(low.alerts.map((a) => a.level), ["warn", "warn"]);

  const healthy = resourceAlerts(undefined, { mem: { free: 4 * GB, total: 8 * GB }, disk: { free: 50 * GB, total: 100 * GB } }, "X");
  assert.deepEqual(healthy.state, { memLow: false, diskLow: false });
  assert.deepEqual(healthy.alerts, [], "a healthy first reading never says OK again");
});

test("resourceAlerts: missing mem/disk keeps previous state silently", () => {
  let r = resourceAlerts({ memLow: true, diskLow: true }, { mem: null, disk: null }, "X");
  assert.deepEqual(r, { state: { memLow: true, diskLow: true }, alerts: [] });

  r = resourceAlerts({ memLow: true, diskLow: false }, undefined, "X");
  assert.deepEqual(r, { state: { memLow: true, diskLow: false }, alerts: [] });

  r = resourceAlerts(undefined, {}, "X");
  assert.deepEqual(r, { state: { memLow: false, diskLow: false }, alerts: [] });

  // half-present data (no total) is treated as missing
  r = resourceAlerts({ memLow: false }, { mem: { free: 1 } }, "X");
  assert.deepEqual(r, { state: { memLow: false, diskLow: false }, alerts: [] });
});

const pr = (ok, detail = "x") => ({ ok, detail });
const res = (o) => ({ search: pr(true), artist: pr(true), next: pr(true), audio: pr(true), ...o });

test("probeAlerts: warns on 2nd consecutive failure once, then recovers", () => {
  let r = probeAlerts({}, res({ artist: pr(false, "empty artist page") }), "Germany");
  assert.deepEqual(r.alerts, []);
  assert.equal(r.fails.artist, 1);
  r = probeAlerts(r.fails, res({ artist: pr(false, "empty artist page") }), "Germany");
  assert.deepEqual(r.alerts, [{ level: "warn", text: "Artist pages broken on Germany: empty artist page" }]);
  r = probeAlerts(r.fails, res({ artist: pr(false, "empty artist page") }), "Germany");
  assert.deepEqual(r.alerts, []);
  r = probeAlerts(r.fails, res(), "Germany");
  assert.deepEqual(r.alerts, [{ level: "up", text: "Artist pages works again on Germany" }]);
  assert.equal(r.fails.artist, 0);
});

test("probeAlerts: a single blip is silent", () => {
  let r = probeAlerts({}, res({ next: pr(false) }), "X");
  r = probeAlerts(r.fails, res(), "X");
  assert.deepEqual(r.alerts, []);
});

test("Monitor runs probes at most every probeEveryMs and stores results", async () => {
  const server = createServer((_q, s) => s.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let clock = 1000;
  let calls = 0;
  const m = new Monitor({
    dir: tmp(),
    token: "t",
    targets: () => [],
    localStats: () => ({}),
    probeEveryMs: 600_000,
    now: () => clock,
    runProbesImpl: async () => {
      calls++;
      return { at: "x", ...res() };
    },
  });
  const t = { id: "w", label: "W", url, role: "worker" };
  await m.checkOne(t);
  await m.lastProbeRun;
  await m.checkOne(t);
  assert.equal(calls, 1);
  clock += 600_001;
  await m.checkOne(t);
  await m.lastProbeRun;
  assert.equal(calls, 2);
  const st = m.state.get("w");
  assert.equal(st.probeHistory.length, 2);
  assert.ok(st.probes.search.ok);
  await m.checkOne({ id: "s", label: "S", url, role: "service" });
  assert.equal(calls, 2);
  server.close();
});
