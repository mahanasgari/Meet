// "Felt" mood of a song. Raw Essentia numbers are skewed for our catalog (Persian pop is almost
// always "danceable", often with sad words over it), so every number is turned into a percentile
// among OUR analyzed songs, then mixed with what the title, tags, lyrics and listeners' votes say.
import { normSearch } from "./search_text.js";
import { cleanTitle } from "./lastfm.js";

export const FELT_MOODS = ["sad", "happy", "chill", "energetic", "dance"];
/** Names accepted by /mood/songs (old analysis names too) mapped to a felt mood. */
export const MOOD_FELT = {
  sad: "sad", happy: "happy", chill: "chill", relaxed: "chill", energetic: "energetic", aggressive: "energetic",
  energy: "energetic", dance: "dance", party: "dance",
};
/** Felt mood to the song_tags tag smart search knows. */
export const FELT_TAG = { sad: "sad", happy: "happy", chill: "relaxed", energetic: "aggressive", dance: "party" };

const CAL_COLS = ["sad", "happy", "relaxed", "aggressive", "party", "danceability", "energy", "valence", "arousal"];
export const CAL_TTL_MS = 30 * 60_000;
const MAX_CAL_ROWS = 5_000;

// ---------------------------------------------------------------- calibration

export class Calibration {
  constructor(rows) {
    this.n = rows.length;
    this.cols = {};
    for (const c of CAL_COLS) {
      const v = [];
      for (const r of rows) { const x = r[c]; if (x != null && Number.isFinite(x)) v.push(x); }
      this.cols[c] = Float64Array.from(v).sort();
    }
  }
  /** Share of catalog values below [v] (ties count half); 0.5 when the column is empty/unknown. */
  pct(col, v) {
    const a = this.cols[col];
    if (v == null || !Number.isFinite(v) || !a || a.length === 0) return 0.5;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
    const below = lo;
    hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
    return (below + lo) / 2 / a.length;
  }
}

// ---------------------------------------------------------------- lexicons

const cue = (mood, list, strength = 0.35) => list.map((w) => ({ mood, w: normSearch(w), strength }));
const TITLE_CUES = [
  ...cue("sad", ["غم", "غمگین", "غمناک", "دلتنگ", "دلتنگی", "دلم گرفته", "گرفته", "گریه", "اشک", "تنها", "تنهایی", "جدایی",
    "خداحافظ", "درد", "دل شکسته", "بی تو", "رفتی", "نرو", "حسرت", "سوگ", "مرگ", "عزا", "دلشکسته", "دلگیر",
    "gham", "ghamgin", "ghamnak", "deltang", "deltangi", "delam gerefte", "gerefte", "gerye", "ashk", "tanha", "tanhaei",
    "tanhaii", "jodaei", "jodai", "khodahafez", "khodafez", "dard", "bi to", "bito", "rafti", "naro", "hasrat",
    "del shekaste", "delshekaste", "delgir", "sad", "cry", "crying", "tears", "lonely", "alone", "goodbye", "miss you",
    "broken", "pain", "heartbreak", "sorrow"]),
  ...cue("happy", ["شاد", "شادی", "خوشحال", "shad", "shadi", "khoshhal", "happy", "joy", "sunshine"]),
  ...cue("dance", ["عروسی", "تولد", "رقص", "رقصی", "بندری", "جشن", "پارتی", "مشاالله", "ماشالله", "aroosi", "arosi", "tavalod",
    "raghs", "raqs", "bandari", "mashallah", "jashn", "party", "dance", "club", "dj"], 0.3),
  ...cue("chill", ["lofi", "lo fi", "chill", "aram", "آرام", "آرامش", "relax", "piano", "acoustic", "sleep", "خواب", "پیانو"]),
  ...cue("energetic", ["workout", "gym", "hardstyle", "rap battle", "battle", "تمرین"]),
];
const OPPOSITE = { sad: ["happy", "dance"], happy: ["sad"], dance: ["sad"], chill: ["energetic"], energetic: ["chill"] };

const SAD_LYRIC = ["غم", "غمگین", "گریه", "اشک", "تنها", "تنهایی", "جدایی", "خداحافظ", "درد", "شکسته", "حسرت", "رفتی", "نرو", "دلتنگ", "دلتنگی",
  "گرفته", "بی تو", "مرگ", "قبر", "داغ", "ماتم", "gham", "gerye", "ashk", "tanha", "jodaei", "dard", "tears", "cry", "lonely", "alone", "pain", "broken", "goodbye"];
const HAPPY_LYRIC = ["شاد", "شادی", "خنده", "بخند", "عشق", "برقص", "برقصیم", "رقص", "جشن", "خوشحال", "بزن", "شادمانی", "عروسی",
  "shad", "khande", "raghs", "jashn", "dance", "happy", "smile", "party", "love", "fun"];

const TAG_MOOD = {
  sad: "sad", melancholic: "sad", melancholy: "sad", depressing: "sad", depressive: "sad", sadness: "sad", heartbreak: "sad", "غمگین": "sad",
  happy: "happy", "feel good": "happy", uplifting: "happy", joyful: "happy", cheerful: "happy", "شاد": "happy",
  party: "dance", dance: "dance", danceable: "dance", club: "dance",
  chill: "chill", chillout: "chill", relaxing: "chill", relax: "chill", calm: "chill", mellow: "chill", "lo fi": "chill", lofi: "chill", ambient: "chill",
  energetic: "energetic", workout: "energetic", aggressive: "energetic", intense: "energetic",
};

const re = (w) => new RegExp(`(?:^| )${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${/[؀-ۿ]/.test(w) ? "[؀-ۿ]{0,2}" : ""}(?: |$)`);
const compile = (list) => list.map((c) => (typeof c === "string" ? { ...{ w: normSearch(c) } } : c)).map((c) => ({ ...c, re: re(c.w) }));
const TITLE_RE = compile(TITLE_CUES);
const SAD_L = compile(SAD_LYRIC), HAPPY_L = compile(HAPPY_LYRIC);

/** Mood nudges from a title (plus its cleaned form): { sad: +.35, happy: -.2, ... }. */
export function textPriors(title) {
  const out = {};
  if (!title) return out;
  const text = normSearch(`${title} ${cleanTitle(title)}`);
  if (!text) return out;
  const hit = new Set();
  for (const c of TITLE_RE) {
    const key = `${c.mood}|${c.w}`;
    if (hit.has(key) || !c.re.test(text)) continue;
    hit.add(key);
  }
  const moods = new Map();
  for (const c of TITLE_RE) if (hit.has(`${c.mood}|${c.w}`)) moods.set(c.mood, Math.max(moods.get(c.mood) ?? 0, c.strength));
  for (const [m, s] of moods) {
    out[m] = (out[m] ?? 0) + s;
    for (const o of OPPOSITE[m] ?? []) out[o] = (out[o] ?? 0) - (o === "dance" ? 0.1 : 0.2);
  }
  return out;
}

export function tagPriors(tags) {
  const out = {};
  const seen = new Set();
  for (const t of tags ?? []) {
    if (t.src === "mood" || t.src === "analysis") continue; // our own output: no feedback loop
    const m = TAG_MOOD[normSearch(t.tag)];
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out[m] = (out[m] ?? 0) + 0.25 * Math.max(0.5, Math.min(1, t.weight ?? 1));
  }
  return out;
}

export function lyricPriors(text) {
  const t = normSearch(text ?? "");
  if (t.length < 20) return {};
  const count = (list) => list.reduce((n, c) => n + (t.match(new RegExp(c.re.source, "g"))?.length ?? 0), 0);
  const d = count(SAD_L) - count(HAPPY_L);
  if (d === 0) return {};
  const amt = Math.min(0.3, 0.05 * Math.abs(d));
  return d > 0 ? { sad: amt, happy: -amt / 2 } : { happy: amt, sad: -amt / 2 };
}

// ---------------------------------------------------------------- the model

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const add = (base, ...ps) => { for (const p of ps) for (const [k, v] of Object.entries(p ?? {})) base[k] = (base[k] ?? 0) + v; return base; };

/**
 * row: raw analysis ({sad, happy, relaxed, aggressive, party, danceability, energy, valence, arousal, scale}).
 * ctx: { cal: Calibration, title?, tags?, lyrics?: string, votes?: {counts:{mood:n}, mine?: mood} }.
 */
export function feltMood(row, ctx = {}) {
  const cal = ctx.cal ?? new Calibration([]);
  const P = (c) => cal.pct(c, row[c]);
  const minor = row.scale === "minor" ? 1 : row.scale === "major" ? 0 : 0.5;
  const major = row.scale === "major" ? 1 : row.scale === "minor" ? 0 : 0.5;
  const pSad = P("sad"), pHappy = P("happy"), pVal = P("valence"), pAr = P("arousal"), pRel = P("relaxed"), pEn = P("energy"), pAgg = P("aggressive");

  let sad = 0.3 * pSad + 0.25 * (1 - pVal) + 0.12 * minor + 0.1 * pRel + 0.1 * (1 - pAr) + 0.13 * (1 - pHappy);
  let happy = 0.3 * pHappy + 0.3 * pVal + 0.15 * major + 0.25 * (1 - pSad);
  let chill = 0.35 * pRel + 0.25 * (1 - pAr) + 0.2 * (1 - pEn) + 0.2 * (1 - pAgg);
  let energetic = 0.4 * pEn + 0.35 * pAr + 0.25 * pAgg;
  const s = { sad, happy, chill, energetic, dance: 0 };
  add(s, textPriors(ctx.title), tagPriors(ctx.tags), lyricPriors(ctx.lyrics));
  for (const m of ["sad", "happy", "chill", "energetic"]) s[m] = clamp01(s[m]);
  s.dance = clamp01(P("danceability") * (1 - s.sad) * (0.5 * P("party") + 0.5 * s.happy) * 1.6 + (s.dance ?? 0));

  // Listeners' votes dominate: 2+ votes, or the asker's own.
  const v = ctx.votes;
  if (v) {
    const total = FELT_MOODS.reduce((n, m) => n + (v.counts?.[m] ?? 0), 0);
    if (total >= 2 || v.mine) {
      const share = (m) => (total ? (v.counts?.[m] ?? 0) / total : 0);
      for (const m of FELT_MOODS) {
        const own = v.mine ? (m === v.mine ? 1 : 0) : share(m);
        s[m] = 0.3 * s[m] + 0.7 * (v.mine && total <= 1 ? own : 0.5 * own + 0.5 * share(m));
      }
    }
  }
  const out = {};
  for (const m of FELT_MOODS) out[m] = Math.round(clamp01(s[m]) * 1000) / 1000;
  const ranked = FELT_MOODS.slice().sort((a, b) => out[b] - out[a]);
  const top = out[ranked[0]];
  return { label: top >= 0.5 ? ranked[0] : "mixed", confidence: Math.round((top - out[ranked[1]]) * 1000) / 1000, ...out };
}

/** Label as shown ("Sad", "Happy", "Chill", "Energetic", "Dance", "Mixed"). */
export const labelName = (l) => l[0].toUpperCase() + l.slice(1);

export class MoodModel {
  #catalog; #cal = null; #calAt = 0; #lists = null; #cache = new Map();
  constructor({ catalog }) { this.#catalog = catalog; }

  /** Recompute percentile tables and per-mood candidate lists at most every 30 min. */
  ensureCalibrated(now = Date.now(), force = false) {
    if (!force && this.#cal && now - this.#calAt < CAL_TTL_MS) return this.#cal;
    const rows = this.#catalog.analysisMoodRows(MAX_CAL_ROWS);
    const all = rows;
    const cal = new Calibration(rows);
    const lists = Object.fromEntries(FELT_MOODS.map((m) => [m, []]));
    for (const r of all) {
      const f = feltMood(r, { cal });
      for (const m of FELT_MOODS) if (f[m] >= 0.4) lists[m].push({ id: r.id, p: f[m] });
    }
    for (const m of FELT_MOODS) lists[m].sort((a, b) => b.p - a.p);
    this.#cal = cal; this.#lists = lists; this.#calAt = now; this.#cache.clear();
    return cal;
  }

  /** Base candidates (numbers only), best first: [{id, p}]. */
  candidates(mood, now = Date.now()) {
    this.ensureCalibrated(now);
    return this.#lists[mood] ?? [];
  }

  invalidate(videoId) { this.#cache.delete(videoId); }

  /** Full felt for a song (title, tags, lyrics, votes); null when it has no analysis. [uid] = who asks. */
  feltFor(videoId, { uid = null, now = Date.now() } = {}) {
    const cal = this.ensureCalibrated(now);
    let base = this.#cache.get(videoId);
    if (base === undefined) {
      const inp = this.#catalog.moodInputs(videoId);
      base = inp ? { row: inp.row, title: inp.title, tags: inp.tags, lyrics: inp.lyrics } : null;
      if (this.#cache.size > 5000) this.#cache.clear();
      this.#cache.set(videoId, base);
    }
    if (!base) return null;
    return feltMood(base.row, { cal, ...base, votes: this.#catalog.moodVotes(videoId, uid) });
  }
}
