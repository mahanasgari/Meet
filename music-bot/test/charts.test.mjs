import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWeeklyChart } from "../src/charts.js";

const now = Date.now();
const ev = (t, id, ti, ago = 1000) => JSON.stringify({ t, id, ti, a: "X", s: 100, ts: now - ago });
function dir(users) {
  const d = mkdtempSync(join(tmpdir(), "charts-"));
  for (const [uid, lines] of Object.entries(users)) writeFileSync(join(d, `${uid}.jsonl`), lines.join("\n") + "\n");
  return d;
}

test("songs need two different listeners; no ids of people leak", () => {
  const d = dir({
    a1: [ev("play", "s1", "Shared"), ev("play", "s2", "Only A")],
    b2: [ev("play", "s1", "Shared"), ev("play", "s3", "Only B")],
  });
  const c = buildWeeklyChart(d, { now });
  assert.deepEqual(c.map((s) => s.id), ["s1"]);
  assert.equal(c[0].listeners, 2);
  assert.ok(!JSON.stringify(c).includes("a1") && !JSON.stringify(c).includes("b2"));
});

test("one person looping a song is one listener", () => {
  const d = dir({ a1: Array.from({ length: 20 }, () => ev("play", "s1", "Loop")) });
  assert.equal(buildWeeklyChart(d, { now }).length, 0);
});

test("skips don't count as listeners, old plays drop out, ranking by fans", () => {
  const old = 9 * 24 * 3600 * 1000;
  const d = dir({
    a1: [ev("play", "hit", "Hit"), ev("skip", "meh", "Meh"), ev("play", "old", "Old", old)],
    b2: [ev("play", "hit", "Hit"), ev("skip", "meh", "Meh"), ev("play", "old", "Old", old)],
    c3: [ev("play", "hit", "Hit"), ev("play", "mid", "Mid")],
    d4: [ev("play", "mid", "Mid")],
  });
  const c = buildWeeklyChart(d, { now });
  assert.deepEqual(c.map((s) => s.id), ["hit", "mid"]);
});

test("empty or missing folder gives an empty chart", () => {
  assert.deepEqual(buildWeeklyChart("/nonexistent-dir", { now }), []);
});
