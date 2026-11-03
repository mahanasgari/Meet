// GET /song/related: everything the app's player shows under the cover for one song.
// Every lookup is indexed and limited (home has little RAM and a slow disk); answers are cached 20 min.
import { labelName } from "./mood_model.js";
import { seededShuffle } from "./mood_songs.js";

const TTL_MS = 20 * 60_000;
const MAX_CACHE = 500;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const cache = new Map();

const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; };
const toCard = (c) => ({ videoId: c.videoId, title: c.title, artists: c.artists, album: c.album, durationS: c.durationS, archived: c.archived });

export const emptyRelated = () => ({
  similar: [], mood: { label: null, songs: [] }, artist: null, moreFromArtist: [], fansAlsoLike: [], discover: [],
});

function compute(catalog, recommender, id, uid) {
  const out = emptyRelated();
  const exclude = new Set([id]);

  // Artist and their songs (stored first, then plays/listeners).
  const artistId = catalog.firstArtistId(id);
  const artistSongIds = new Set();
  if (artistId) {
    out.artist = catalog.artistBrief(artistId);
    out.fansAlsoLike = catalog.similarArtists(artistId, 12);
    const ids = catalog.songIdsOfArtist(artistId, 100).map((r) => r.videoId);
    for (const x of ids) artistSongIds.add(x);
    const cards = catalog.songCards(ids.filter((x) => x !== id));
    out.moreFromArtist = [...cards.values()].filter((c) => c.title)
      .sort((a, b) => (b.archived - a.archived) || (b.plays - a.plays) || (b.listeners - a.listeners) || (a.videoId < b.videoId ? -1 : 1))
      .slice(0, 15).map(toCard);
  }

  // Similar songs (one recommender call, more than shown: "discover" digs in the rest).
  let simRaw = [];
  try { simRaw = recommender?.similarTo(id, { limit: 40 }) ?? []; } catch { simRaw = []; }
  const simCards = catalog.songCards(simRaw.map((x) => x.videoId));
  const similarAll = simRaw.map((x) => simCards.get(x.videoId)).filter((c) => c?.title && !exclude.has(c.videoId));
  out.similar = similarAll.slice(0, 15).map(toCard);

  // Same felt mood: the model's candidate lists, other artists first.
  let moodPool = [];
  try {
    const f = catalog.mood?.feltFor(id, { uid });
    if (f && f.label && f.label !== "mixed") {
      out.mood.label = labelName(f.label);
      const top = catalog.mood.candidates(f.label).slice(0, 150).map((c) => c.id).filter((x) => !exclude.has(x));
      const pick = seededShuffle(top.filter((x) => !artistSongIds.has(x)), hash(id)).slice(0, 30);
      if (pick.length < 15) pick.push(...top.filter((x) => artistSongIds.has(x)).slice(0, 15 - pick.length));
      const cards = catalog.songCards(pick);
      moodPool = pick.map((x) => cards.get(x)).filter((c) => c?.title);
      out.mood.songs = moodPool.slice(0, 15).map(toCard);
    }
  } catch { /* no analysis: no mood row */ }

  // Discover: songs the listener hasn't played, not by the artists they play most.
  const hist = uid ? recommender?.historyOf?.(uid) : null;
  const avoidArtists = new Set();
  if (hist) for (const sid of hist.top) { const a = catalog.firstArtistId(sid); if (a) avoidArtists.add(a); }
  const seen = new Set();
  let pool = [...similarAll, ...moodPool].filter((c) => !seen.has(c.videoId) && seen.add(c.videoId));
  if (hist) pool = pool.filter((c) => !hist.played.has(c.videoId));
  if (avoidArtists.size) pool = pool.filter((c) => !c.artists.some((a) => a.id && avoidArtists.has(a.id)));
  if (!hist) pool.sort((a, b) => (a.plays - b.plays) || (a.videoId < b.videoId ? -1 : 1));
  out.discover = pool.slice(0, 10).map(toCard);
  return out;
}

/** Cached per (videoId, uid); a bad id or unknown song gives empty lists, never a throw. */
export function songRelated(catalog, recommender, rawId, uid = null, now = Date.now()) {
  const id = String(rawId ?? "").replace(/^yt_/, "");
  if (!YT_ID.test(id)) return emptyRelated();
  const key = `${id}|${uid ?? ""}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value;
  try { value = compute(catalog, recommender, id, uid); } catch (e) { console.error("[song/related]", e.message); return emptyRelated(); }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, { at: now, value });
  return value;
}

export const _clearRelatedCache = () => cache.clear();
