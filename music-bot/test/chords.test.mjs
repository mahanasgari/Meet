import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SR, analyze, tempoOf } from "../src/chords.js";

/** A chord as a few harmonic-rich tones (MIDI notes) for [seconds]. */
function tones(midis, seconds, sr = SR) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (const m of midis) {
    const f = 440 * 2 ** ((m - 69) / 12);
    for (let h = 1; h <= 4; h++) {
      const a = 0.15 / h;
      for (let i = 0; i < n; i++) out[i] += a * Math.sin((2 * Math.PI * f * h * i) / sr);
    }
  }
  return out;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// C4=60. With a bass note an octave below the root, like a band would.
const C = [48, 60, 64, 67];
const AmC = [45, 57, 60, 64];
const F = [41, 57, 60, 65];
const G = [43, 55, 59, 62];

test("finds a I–vi–IV–V progression and its key", () => {
  const song = concat(...[C, AmC, F, G, C, AmC, F, G].map((c) => tones(c, 2.5)));
  const r = analyze(song);
  const seq = r.chords.map((x) => x.c).filter((c) => c !== "N");
  assert.deepEqual(seq, ["C", "Am", "F", "G", "C", "Am", "F", "G"]);
  assert.equal(r.key.name, "C");
  // Changes land within half a second of the real ones.
  const starts = r.chords.filter((x) => x.c !== "N").map((x) => x.s);
  starts.slice(1).forEach((s, i) => assert.ok(Math.abs(s - (i + 1) * 2500) < 500, `change ${i + 1} at ${s} ms`));
});

test("minor key and sharps", () => {
  const Em = [40, 52, 55, 59];
  const B = [47, 59, 63, 66];
  const Am = [45, 57, 60, 64];
  const r = analyze(concat(...[Em, Am, Em, B, Em].map((c, i) => tones(c, i % 2 ? 2 : 3))));
  assert.deepEqual(r.chords.map((x) => x.c).filter((c) => c !== "N"), ["Em", "Am", "Em", "B", "Em"]);
  assert.equal(r.key.name, "Em");
});

test("silence is no chord", () => {
  const r = analyze(concat(new Float32Array(SR * 2), tones(C, 3)));
  assert.equal(r.chords[0].c, "N");
  assert.equal(r.chords.at(-1).c, "C");
});

test("tempo from a click track", () => {
  const n = SR * 12;
  const x = new Float32Array(n);
  const every = Math.round((SR * 60) / 120);
  for (let i = 0; i < n; i += every) for (let j = 0; j < 200 && i + j < n; j++) x[i + j] = Math.sin(j / 3) * (1 - j / 200);
  assert.equal(tempoOf(x), 120);
});

test("names a seventh only when it clearly sounds", () => {
  const Cmaj7 = [48, 60, 64, 67, 71, 83]; // the 7th in two octaves, as on a piano
  const G7 = [43, 55, 59, 62, 65];
  const r = analyze(concat(tones(Cmaj7, 3), tones(G7, 3), tones(C, 3)));
  assert.deepEqual(r.chords.map((x) => x.c).filter((c) => c !== "N"), ["Cmaj7", "G7", "C"]);
});
