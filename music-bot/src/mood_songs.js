// Mood shelves: ranking lives in Catalog.moodSongs; here the daily deterministic shuffle and a 30 min cache.
import { MOOD_FELT } from "./mood_model.js";

const TTL_MS = 30 * 60_000;
const cache = new Map();

export const isMood = (m) => Object.hasOwn(MOOD_FELT, m);

/** Day number since the epoch: the default seed, so the shelf changes daily. */
export const dayNumber = (now = Date.now()) => Math.floor(now / 86_400_000);

const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Deterministic Fisher-Yates: the same seed always gives the same order. */
export function seededShuffle(items, seed) {
  const a = items.slice();
  const rnd = mulberry32(Number.isFinite(seed) ? Math.trunc(seed) : 0);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function moodShelf(catalog, mood, limit = 40, seed, now = Date.now()) {
  limit = Math.min(100, Math.max(1, Math.trunc(limit) || 40));
  const sd = Number.isFinite(seed) ? Math.trunc(seed) : dayNumber(now);
  const key = `${mood}|${sd}|${limit}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const top = catalog.moodSongs(mood, limit * 4);
  const songs = seededShuffle(top, sd).slice(0, limit).map((c) => ({
    videoId: c.videoId, title: c.title, artists: c.artists, album: c.album, durationS: c.durationS, archived: c.archived,
  }));
  const value = { mood, songs };
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: now, value });
  return value;
}

export const _clearMoodCache = () => cache.clear();
