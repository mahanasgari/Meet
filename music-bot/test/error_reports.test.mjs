import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportStore } from "../src/error_reports.js";

const mk = (max) => new ReportStore({ file: join(mkdtempSync(join(tmpdir(), "rep-")), "r.jsonl"), max });
const ok = { kind: "play_failed", message: "x", platform: "android", appVersion: "1.0.0", network: "wifi" };

test("sanitizes fields and drops unknown ones", () => {
  const s = mk();
  assert.ok(s.add({ ...ok, message: "m".repeat(900), trackId: "yt_abcdefghijk", evil: 1, token: "t", extra: { a: 1 } }, { uid: "u", ip: "1.2.3.4", now: 1000 }));
  const [r] = s.latest();
  assert.equal(r.message.length, 500);
  assert.equal(r.trackId, "yt_abcdefghijk");
  assert.equal(r.evil, undefined);
  assert.equal(r.ip, undefined);
  assert.deepEqual(r.extra, { a: 1 });
  assert.equal(r.at, 1000);
});

test("rejects bad kind/platform, bad trackId and big extra become null/absent", () => {
  const s = mk();
  assert.equal(s.add({ ...ok, kind: "nope" }), false);
  assert.equal(s.add({ ...ok, platform: "beos" }), false);
  s.add({ ...ok, trackId: "bad", network: "5g", extra: { big: "x".repeat(3000) } });
  const [r] = s.latest();
  assert.equal(r.trackId, null);
  assert.equal(r.network, null);
  assert.equal(r.extra, undefined);
});

test("rate limit is 60 per hour per uid", () => {
  const s = mk();
  for (let i = 0; i < 60; i++) assert.ok(s.add(ok, { uid: "a", now: 1000 + i }));
  assert.equal(s.add(ok, { uid: "a", now: 2000 }), false);
  assert.ok(s.add(ok, { uid: "b", now: 2000 }));
  assert.ok(s.add(ok, { uid: "a", now: 1000 + 3_600_001 }));
});

test("latest, ring size, file and summary", () => {
  const s = mk(3);
  for (let i = 0; i < 5; i++) s.add({ ...ok, kind: i % 2 ? "stall" : "crash", message: String(i), appVersion: i < 4 ? "1" : "2" }, { uid: "u", now: 100 + i });
  assert.deepEqual(s.latest().map((r) => r.message), ["4", "3", "2"]);
  assert.deepEqual(s.latest({ kind: "stall" }).map((r) => r.message), ["3"]);
  assert.deepEqual(s.summary(0).byKind, { crash: 2, stall: 1 });
  assert.deepEqual(s.summary(103).byAppVersion, { 1: 1, 2: 1 });
  assert.equal(readFileSync(s.file, "utf8").trim().split("\n").length, 5);
});
