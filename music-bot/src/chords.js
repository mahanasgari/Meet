// Chords, key and tempo worked out from a song's audio, for the app's chord
// sheet. Plain signal processing, no model: per frame a pitch-class profile
// (how much of each of the 12 notes sounds), matched against major and minor
// triads, then smoothed so a chord only changes when the music clearly does.
// Good on pop/rap/ballad progressions; jazz chords come out as their triad.
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SR = 11025; // plenty for chords (notes up to ~1.8 kHz matter)
const N = 4096; // ~0.37 s window: fine enough for bass notes
const HOP = 1024; // ~93 ms between frames
const FRAME_S = HOP / SR;
const LO_HZ = 55;
const HI_HZ = 1760;
// Tuned on real songs (All of Me, Someone Like You, Perfect, Viva La Vida).
export const DEFAULTS = {
  smooth: 9, // frames in the chroma median filter (~0.8 s)
  changeCost: 1.2, // how much better a new chord must fit to switch
  minSegS: 0.6, // shorter chords are folded into the one before
  noChord: 0.55, // fit "no chord" needs to beat (silence always does)
  bass: 0.15, // weight of "the bass plays this chord's root"
  seventh: 0.9, // a 7th this strong next to the triad's notes is named (strict: a wrong 7th reads worse than a missing one)
};
const BASS_HI_HZ = 200;
export const VERSION = 3;
// Longer is a mix or a podcast, not a song: no chord sheet.
export const MAX_SECONDS = 12 * 60;

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
// Keys written with flats (major roots / minor roots), as musicians expect.
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]); // F Bb Eb Ab Db (F#, not Gb)
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

/** Note names for [key]: flats in flat keys, sharps otherwise. */
export function spelling(key) {
  if (!key) return NAMES;
  return (key.mode === "minor" ? FLAT_MINOR : FLAT_MAJOR).has(key.root) ? FLATS : SHARPS;
}
// Krumhansl–Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** 24 triads: index r = r major, 12 + r = r minor. */
const CHORDS = [];
for (let r = 0; r < 12; r++) CHORDS.push({ name: NAMES[r], notes: [r, (r + 4) % 12, (r + 7) % 12] });
for (let r = 0; r < 12; r++) CHORDS.push({ name: `${NAMES[r]}m`, notes: [r, (r + 3) % 12, (r + 7) % 12] });
const TEMPLATES = CHORDS.map(({ notes }) => {
  const t = new Float64Array(12);
  t[notes[0]] = 1; // root
  t[notes[1]] = 0.8;
  t[notes[2]] = 0.9;
  return normalize(t);
});

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}

/** In-place radix-2 FFT of (re, im). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Per frame: 12 note strengths (unnormalized) and loudness. */
function chroma(samples) {
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  // Each FFT bin's note and how close it is to that note's centre.
  const bins = [];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f < LO_HZ || f > HI_HZ) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const near = Math.round(midi);
    const w = Math.cos((Math.PI / 2) * Math.min(1, Math.abs(midi - near) * 2));
    bins.push([k, ((near % 12) + 12) % 12, w * w, f <= BASS_HI_HZ]);
  }
  const frames = [];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let start = 0; start + N <= samples.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const x = samples[start + i];
      energy += x * x;
      re[i] = x * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const c = new Float64Array(12);
    const b = new Float64Array(12);
    for (const [k, pc, w, low] of bins) {
      const m = w * Math.sqrt(Math.hypot(re[k], im[k]));
      c[pc] += m;
      if (low) b[pc] += m;
    }
    frames.push({ c, b, rms: Math.sqrt(energy / N) });
  }
  return frames;
}

/** Median of each note over a sliding window: steadies the profile. */
function smooth(frames, size, field = "c") {
  const half = size >> 1;
  const out = [];
  const buf = [];
  for (let i = 0; i < frames.length; i++) {
    const c = new Float64Array(12);
    for (let pc = 0; pc < 12; pc++) {
      buf.length = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) buf.push(frames[j][field][pc]);
      buf.sort((a, b) => a - b);
      c[pc] = buf[buf.length >> 1];
    }
    out.push(c);
  }
  return out;
}

/** Best chord path: fits each frame, changing only when clearly better. */
function viterbi(scores, changeCost) {
  const S = 25; // 24 chords + "no chord"
  const n = scores.length;
  if (!n) return [];
  let prev = scores[0].slice();
  const back = [new Int16Array(S)];
  for (let t = 1; t < n; t++) {
    let best = 0;
    for (let s = 1; s < S; s++) if (prev[s] > prev[best]) best = s;
    const cur = new Float64Array(S);
    const bk = new Int16Array(S);
    for (let s = 0; s < S; s++) {
      const stay = prev[s];
      const jump = prev[best] - changeCost;
      if (stay >= jump) {
        cur[s] = stay + scores[t][s];
        bk[s] = s;
      } else {
        cur[s] = jump + scores[t][s];
        bk[s] = best;
      }
    }
    back.push(bk);
    prev = cur;
  }
  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
  const path = new Array(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = s;
    s = back[t][s];
  }
  return path;
}

/**
 * "7", "maj7" or "" for the chord [root] over frames [g.s, g.e): a 7th is
 * named only when it sounds about as strong as the triad's own notes.
 */
function seventhOf(sm, g, root, minor, ratio) {
  const c = new Float64Array(12);
  for (let t = g.s; t < g.e; t++) {
    const v = normalize(sm[t]);
    for (let i = 0; i < 12; i++) c[i] += v[i];
  }
  const third = (root + (minor ? 3 : 4)) % 12;
  const triad = (c[root] + c[third] + c[(root + 7) % 12]) / 3;
  const b7 = c[(root + 10) % 12];
  const maj7 = c[(root + 11) % 12];
  if (b7 >= ratio * triad && b7 > maj7) return "7";
  if (!minor && maj7 >= ratio * triad && maj7 > b7) return "maj7";
  return "";
}

/**
 * The key from the chords played: the one whose own chords fill most of the
 * song, its home chord counting extra, with the note profile breaking ties.
 */
function keyFromChords(segs, total) {
  const dur = new Float64Array(24);
  let all = 0;
  for (const g of segs) {
    if (g.k < 0) continue;
    dur[g.k] += g.e - g.s;
    all += g.e - g.s;
  }
  const profile = keyOf(total);
  if (!all) return profile;
  const maj = (r) => ((r % 12) + 12) % 12;
  const min = (r) => 12 + (((r % 12) + 12) % 12);
  let best = null;
  for (let r = 0; r < 12; r++) {
    for (const mode of ["major", "minor"]) {
      const own = mode === "major"
        ? [maj(r), min(r + 2), min(r + 4), maj(r + 5), maj(r + 7), min(r + 9)]
        : [min(r), maj(r + 3), min(r + 5), min(r + 7), maj(r + 7), maj(r + 8), maj(r + 10)];
      const fit = own.reduce((a, k) => a + dur[k], 0) / all;
      const home = dur[own[0]] / all;
      const score = fit + 0.5 * home + (profile && profile.root === r && profile.mode === mode ? 0.1 : 0);
      if (!best || score > best.score) best = { score, root: r, mode };
    }
  }
  return { name: `${NAMES[best.root]}${best.mode === "minor" ? "m" : ""}`, root: best.root, mode: best.mode };
}

/** The key whose profile best matches the whole song's notes. */
function keyOf(total) {
  let best = { score: -Infinity, name: null };
  const corr = (profile, r) => {
    const mx = total.reduce((a, b) => a + b, 0) / 12;
    const mp = profile.reduce((a, b) => a + b, 0) / 12;
    let num = 0;
    let dx = 0;
    let dp = 0;
    for (let i = 0; i < 12; i++) {
      const x = total[(i + r) % 12] - mx;
      const p = profile[i] - mp;
      num += x * p;
      dx += x * x;
      dp += p * p;
    }
    return num / (Math.sqrt(dx * dp) || 1);
  };
  for (let r = 0; r < 12; r++) {
    for (const [profile, suffix, mode] of [[MAJOR_PROFILE, "", "major"], [MINOR_PROFILE, "m", "minor"]]) {
      const score = corr(profile, r);
      if (score > best.score) best = { score, name: `${NAMES[r]}${suffix}`, root: r, mode };
    }
  }
  return best.name ? { name: best.name, root: best.root, mode: best.mode } : null;
}

/** Tempo from how loudness rises (onsets), 70–160 BPM, or null. */
export function tempoOf(samples, sr = SR) {
  const hop = 128; // ~12 ms: fine enough to tell 118 from 120 BPM
  const env = [];
  let last = 0;
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let e = 0;
    for (let j = 0; j < hop; j++) e += samples[i + j] * samples[i + j];
    e = Math.log1p(1000 * Math.sqrt(e / hop));
    env.push(Math.max(0, e - last));
    last = e;
  }
  if (env.length < 64) return null;
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const o = env.map((x) => x - mean);
  const fps = sr / hop;
  // Autocorrelation at a lag (fractional), per overlapping sample.
  const ac = (lag) => {
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let v = 0;
    for (let i = 0; i + l0 + 1 < o.length; i++) v += o[i] * (o[i + l0] * (1 - fr) + o[i + l0 + 1] * fr);
    return v / (o.length - l0);
  };
  // A real beat repeats every 1, 2, 3 and 4 beats; a wrong one doesn't.
  let best = { bpm: 0, v: -Infinity };
  for (let bpm = 60; bpm <= 160; bpm += 0.5) {
    const lag = (60 * fps) / bpm;
    const v = ac(lag) + ac(2 * lag) + 0.5 * ac(3 * lag) + 0.5 * ac(4 * lag);
    if (v > best.v) best = { bpm, v };
  }
  return best.bpm ? Math.round(best.bpm) : null;
}

/**
 * Chords of [samples] (mono, [SR] Hz): { key, bpm, chords: [{ s, e, c }] }
 * with times in ms and c a chord name ("Am", "F#") or "N" (no chord).
 */
export function analyze(samples, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const frames = chroma(samples);
  if (!frames.length) return { key: null, bpm: null, chords: [] };
  const loud = frames.map((f) => f.rms).sort((a, b) => a - b);
  const quiet = Math.max(1e-4, loud[Math.floor(loud.length * 0.5)] * 0.08);
  const total = new Float64Array(12);
  for (const f of frames) if (f.rms > quiet) for (let i = 0; i < 12; i++) total[i] += f.c[i];
  const sm = smooth(frames, o.smooth);
  const bass = smooth(frames, o.smooth, "b");
  const scores = sm.map((c, t) => {
    const out = new Float64Array(25);
    const silent = frames[t].rms <= quiet;
    const v = normalize(c);
    const bmax = Math.max(...bass[t]) || 1;
    for (let k = 0; k < 24; k++) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += v[i] * TEMPLATES[k][i];
      out[k + 1] = silent ? 0 : dot + o.bass * (bass[t][k % 12] / bmax);
    }
    out[0] = silent ? 1 : o.noChord; // "no chord" wins only on silence or mush
    return out;
  });
  const path = viterbi(scores, o.changeCost);
  // Runs of the same chord (k: 0–11 major, 12–23 minor, -1 none), too-short
  // ones folded into the one before.
  let segs = [];
  for (let t = 0; t < path.length; t++) {
    const k = path[t] - 1;
    const last = segs.at(-1);
    if (last && last.k === k) last.e = t + 1;
    else segs.push({ s: t, e: t + 1, k });
  }
  const minFrames = Math.round(o.minSegS / FRAME_S);
  const merged = [];
  for (const g of segs) {
    const last = merged.at(-1);
    if (last && (g.e - g.s < minFrames || last.k === g.k)) last.e = g.e;
    else merged.push({ ...g });
  }
  segs = merged;
  const key = keyFromChords(segs, total);
  const names = spelling(key);
  for (const g of segs) {
    if (g.k < 0) {
      g.c = "N";
      continue;
    }
    const root = g.k % 12;
    const minor = g.k >= 12;
    g.c = `${names[root]}${minor ? "m" : ""}${seventhOf(sm, g, root, minor, o.seventh)}`;
  }
  // Frames are centred half a window after their start.
  const ms = (f) => Math.max(0, Math.round((f * HOP + N / 2) * (1000 / SR)));
  return {
    key: key && { ...key, name: `${names[key.root]}${key.mode === "minor" ? "m" : ""}` },
    bpm: tempoOf(samples),
    chords: segs.map((g, i) => ({ s: i === 0 ? 0 : ms(g.s), e: ms(g.e), c: g.c })),
  };
}

/** Decodes [file] to mono [SR] Hz float samples with ffmpeg. */
export function decode(file, ffmpegBin = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin, ["-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parts = [];
    let err = "";
    p.stdout.on("data", (d) => parts.push(d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-500)));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim()}`));
      const buf = Buffer.concat(parts);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** Chord sheets per song, worked out once and kept on disk. One at a time. */
export class ChordStore {
  /** @param {{ dir: string, localFile: (id: string) => Promise<string|null>, ffmpegBin?: string }} o */
  constructor({ dir, localFile, ffmpegBin = "ffmpeg" }) {
    this.dir = dir;
    this.localFile = localFile;
    this.ffmpegBin = ffmpegBin;
    this.pending = new Map();
    this.chain = Promise.resolve();
    mkdirSync(dir, { recursive: true });
  }

  /** Stops the worker thread (tests; the server keeps it for its lifetime). */
  close() {
    const w = this.worker;
    this.worker = null;
    return w ? w.terminate() : Promise.resolve();
  }

  /** analyze() on a worker thread, so the server keeps answering. */
  #inWorker(samples) {
    if (!this.worker) {
      this.worker = new Worker(new URL("./chords_worker.js", import.meta.url));
      this.worker.unref();
      this.jobs = new Map();
      this.seq = 0;
      const failAll = (e) => {
        for (const { reject } of this.jobs.values()) reject(e);
        this.jobs.clear();
        this.worker = null;
      };
      this.worker.on("message", ({ id, result, error }) => {
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        if (!job) return;
        if (error) job.reject(new Error(error));
        else job.resolve(result);
      });
      this.worker.on("error", failAll);
      this.worker.on("exit", () => failAll(new Error("chord worker stopped")));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      const copy = samples.slice(); // own buffer, handed over without copying again
      this.worker.postMessage({ id, buffer: copy.buffer }, [copy.buffer]);
    });
  }

  #file(id) {
    return join(this.dir, `${id}.json`);
  }

  /** Worked out already (by this version)? */
  has(id) {
    try {
      return JSON.parse(readFileSync(this.#file(id), "utf8")).v === VERSION;
    } catch {
      return false;
    }
  }

  /** Nothing being worked out right now. */
  get idle() {
    return this.pending.size === 0;
  }

  /** The chords of song [id], or null when its audio can't be had. */
  get(id) {
    const f = this.#file(id);
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, "utf8"));
        if (j.v === VERSION) return Promise.resolve(j);
      } catch {
        // redo it
      }
    }
    let p = this.pending.get(id);
    if (!p) {
      const run = async () => {
        const path = await this.localFile(id);
        if (!path) return null;
        const t0 = Date.now();
        const samples = await decode(path, this.ffmpegBin);
        if (samples.length > MAX_SECONDS * SR) {
          console.log(`[chords] ${id}: ${Math.round(samples.length / SR / 60)} min, too long for a chord sheet`);
          return null;
        }
        const r = { v: VERSION, ...(await this.#inWorker(samples)) };
        writeFileSync(f, JSON.stringify(r));
        console.log(`[chords] ${id}: ${r.key?.name ?? "?"} ${r.bpm ?? "?"} bpm, ${r.chords.length} changes (${Date.now() - t0} ms)`);
        return r;
      };
      p = this.chain.then(run, run);
      this.chain = p.catch(() => null);
      this.pending.set(id, p);
      void p.finally(() => this.pending.delete(id)).catch(() => null);
    }
    return p;
  }
}
