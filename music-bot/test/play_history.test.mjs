import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedDocs } from "../src/shared_docs.js";
import { PlayHistory, cleanPlay } from "../src/play_history.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const make = () => new PlayHistory(new SharedDocs(join(mkdtempSync(join(tmpdir(), "ph-")), "s.db")));

test("plays are kept per month, merged by song and start time", () => {
  const h = make();
  const a = { id: "yt_aaaaaaaaaaa", t: "A", a: "X", at: Date.UTC(2026, 9, 31, 23), s: 30, d: 200 };
  const b = { id: "yt_bbbbbbbbbbb", t: "B", a: "Y", at: Date.UTC(2026, 10, 1, 1), s: 200, d: 200, f: true };
  assert.equal(h.add("u1", [a, b], NOW), 2);
  assert.equal(h.add("u1", [a], NOW), 0, "the same play twice is one play");
  assert.equal(h.add("u1", [{ ...a, s: 120 }], NOW), 1, "a longer listen of the same play updates it");
  const all = h.since("u1", 0, NOW).months;
  assert.deepEqual(Object.keys(all).sort(), ["2026-10", "2026-11"]);
  assert.equal(all["2026-10"][0].s, 120);
  assert.equal(all["2026-11"][0].f, 1);
  assert.deepEqual(h.since("u2", 0, NOW).months, {}, "another account sees nothing");
});

test("since: only months changed after the given time", () => {
  const h = make();
  h.add("u1", [{ id: "yt_aaaaaaaaaaa", at: Date.UTC(2026, 9, 5), s: 10 }], NOW);
  h.add("u1", [{ id: "yt_bbbbbbbbbbb", at: Date.UTC(2026, 10, 5), s: 10 }], NOW + 1000);
  assert.deepEqual(Object.keys(h.since("u1", NOW, NOW + 2000).months), ["2026-11"]);
});

test("a removal sticks, whatever comes later for that play", () => {
  const h = make();
  const p = { id: "yt_aaaaaaaaaaa", t: "A", at: Date.UTC(2026, 10, 2), s: 50 };
  h.add("u1", [p], NOW);
  h.add("u1", [{ id: p.id, at: p.at, del: 1 }], NOW);
  h.add("u1", [{ ...p, s: 90 }], NOW);
  assert.deepEqual(h.since("u1", 0, NOW).months["2026-11"], [{ id: p.id, at: p.at, del: 1 }]);
});

test("bad plays are dropped", () => {
  assert.equal(cleanPlay({ id: "", at: NOW }, NOW), null);
  assert.equal(cleanPlay({ id: "x", at: "soon" }, NOW), null);
  assert.equal(cleanPlay({ id: "x", at: NOW + 3 * 864e5 }, NOW), null, "not in the future");
  assert.equal(cleanPlay({ id: "x", at: Date.UTC(2019, 0, 1) }, NOW), null);
  assert.equal(cleanPlay({ id: "x", at: NOW, s: 1e9 }, NOW).s, 86_400);
  assert.equal(cleanPlay({ id: "x", at: NOW, t: "a".repeat(500) }, NOW).t.length, 200);
});
