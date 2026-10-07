import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clipParams } from "../src/clip.js";

const q = (o) => new URLSearchParams(o);

test("valid clip request", () => {
  const p = clipParams(q({ url: "https://music.youtube.com/watch?v=jIZFZQgURX8&list=x", start: "42.7", dur: "30", title: 'A "B"', artist: "C" }));
  assert.equal(p.url, "https://www.youtube.com/watch?v=jIZFZQgURX8");
  assert.equal(p.start, 42);
  assert.equal(p.dur, 30);
  assert.equal(p.title, "A B");
});

test("rejects bad urls, lengths and starts", () => {
  assert.equal(clipParams(q({ url: "https://evil.com/watch?v=jIZFZQgURX8", start: 0, dur: 30 })), null);
  assert.equal(clipParams(q({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8", start: 0, dur: 61 })), null);
  assert.equal(clipParams(q({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8", start: 0, dur: 2 })), null);
  assert.equal(clipParams(q({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8", start: -5, dur: 30 })), null);
  assert.equal(clipParams(q({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8", start: "x", dur: 30 })), null);
});

test("full=1 asks for the whole song, ignoring start/dur", () => {
  const p = clipParams(new URLSearchParams({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8", full: "1", title: "T" }));
  assert.equal(p.full, true);
  assert.equal(p.start, 0);
  assert.equal(clipParams(new URLSearchParams({ url: "https://www.youtube.com/watch?v=jIZFZQgURX8" })), null, "no full, no range");
});
