import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Monitor, nextAlerts, parseServices, slug } from "../src/monitor.js";

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
