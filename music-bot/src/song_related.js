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
  newFromArtist: [], newLikeThis: [], popularNow: [], hiddenGems: [], newArtists: [], unknownArtists: [], famousArtists: [],
});

const DAY = 86_400_000;
/** "2025", "2025-03", "2025-03-09" -> ms; a bare year counts as July 1st, a month as its 15th. null when unparsable. */
export function releaseMs(d) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d ?? ""));
  if (!m) return null;
  const y = +m[1];
  if (y < 1900 || y > 2100) return null;
  const t = m[2] ? Date.UTC(y, +m[2] - 1, m[3] ? +m[3] : 15) : Date.UTC(y, 6, 1);
  return Number.isFinite(t) ? t : null;
}

function compute(catalog, recommender, id, uid, now) {
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
  extras(catalog, out, { id, artistId, artistSongIds, simRaw, moodPool, hist, now });
  return out;
}

const small = (s, l) => (s == null || s < 50_000) && (l == null || l < 5_000) && ((s != null && s < 50_000) || (l != null && l < 5_000));
const famous = (s, l) => (s ?? 0) >= 500_000 || (l ?? 0) >= 100_000;

/** New releases, popular, hidden gems and the artist rows: one candidate pool, batched lookups (<= ~600 rows). */
function extras(catalog, out, { id, artistId, artistSongIds, simRaw, moodPool, hist, now }) {
  // Candidate pool with a similarity score: similar songs, mood songs, a few songs of each top similar artist.
  const score = new Map();
  simRaw.forEach((x) => score.set(x.videoId, x.score ?? 0.5));
  for (const c of moodPool) if (!score.has(c.videoId)) score.set(c.videoId, 0.3);
  const base = artistId ? catalog.similarArtists(artistId, 30) : [];
  for (const a of base.slice(0, 6)) {
    for (const r of catalog.songIdsOfArtist(a.id, 8)) if (!score.has(r.videoId)) score.set(r.videoId, 0.2);
  }
  score.delete(id);
  const poolIds = [...score.keys()];
  const mineIds = [...artistSongIds].filter((x) => x !== id);
  const cards = catalog.songCards([...poolIds, ...mineIds]);
  const facts = catalog.songFacts([...poolIds, ...mineIds]);
  const ok = (vid) => (cards.get(vid)?.title ? cards.get(vid) : null);
  const age = (vid) => { const t = releaseMs(facts.get(vid)?.date); return t == null ? null : now - t; };
  const pop = (vid) => Math.max(cards.get(vid)?.listeners ?? 0, facts.get(vid)?.users ?? 0);
  const within = (days) => (vid) => { const a = age(vid); return a != null && a >= -30 * DAY && a <= days * DAY; };
  const played = (vid) => !!hist?.played.has(vid);
  const pick = (ids, n) => ids.map(ok).filter(Boolean).slice(0, n).map(toCard);
  const byScore = (a, b) => (score.get(b) - score.get(a)) || (a < b ? -1 : 1);

  out.newFromArtist = pick(mineIds.filter(within(548)).sort((a, b) => (age(a) - age(b)) || (a < b ? -1 : 1)), 15);
  out.newLikeThis = pick(poolIds.filter(within(365)).sort(byScore), 15);
  const recent = within(1095);
  const rank = (vid) => pop(vid) * (recent(vid) ? 2 : 1);
  out.popularNow = pick([...new Set([...poolIds, ...mineIds])].sort((a, b) =>
    (rank(b) - rank(a)) || ((cards.get(b)?.plays ?? 0) - (cards.get(a)?.plays ?? 0)) || (a < b ? -1 : 1)), 15);
  out.hiddenGems = pick(poolIds.filter((vid) => {
    const c = ok(vid);
    if (!c || played(vid) || (artistId && c.artists.some((a) => a.id === artistId))) return false;
    const p = pop(vid);
    return p > 0 ? p < 2000 : c.plays <= 1;
  }).sort(byScore), 10);

  // Artists: first hop (YouTube Music, Last.fm, ListenBrainz), then one bounded hop from the top 3.
  const cand = new Map(base.map((a) => [a.id, a]));
  const first = new Set(cand.keys());
  for (const a of base.slice(0, 3)) for (const b of catalog.similarArtists(a.id, 12)) if (b.id !== artistId && !cand.has(b.id)) cand.set(b.id, b);
  const af = catalog.artistFacts([...cand.keys()]);
  const playedArtists = hist ? catalog.artistIdsOfSongs(hist.played) : new Set();
  const info = (a) => ({ ...a, subscribers: af.get(a.id)?.subscribers ?? a.subscribers ?? null, listeners: af.get(a.id)?.listeners ?? null });
  const all = [...cand.values()].map(info);
  const used = new Set();
  const take = (list, n) => { const r = []; for (const a of list) { if (r.length >= n) break; if (!used.has(a.id)) { used.add(a.id); r.push(a); } } return r; };
  const fresh = all.filter((a) => !playedArtists.has(a.id));
  const isSmall = (a) => small(a.subscribers, a.listeners), isFamous = (a) => famous(a.subscribers, a.listeners);
  // New artists: unplayed first-hop artists; the middle ones lead so the unknown/famous rows keep theirs.
  const firstFresh = fresh.filter((a) => first.has(a.id));
  const mid = firstFresh.filter((a) => !isSmall(a) && !isFamous(a));
  const rest = firstFresh.filter((a) => isSmall(a) || isFamous(a));
  const newA = take([...mid, ...(mid.length < 4 ? rest.slice(0, Math.floor(rest.length / 3)) : [])], 12);
  const unknownA = take(all.filter(isSmall), 12);
  const famousA = take(fresh.filter(isFamous), 12);
  // Each artist's best known song (small LIMIT per artist, one batched card lookup).
  const chosen = [...newA, ...unknownA, ...famousA];
  const tops = new Map(chosen.map((a) => [a.id, catalog.songIdsOfArtist(a.id, 6).map((r) => r.videoId)]));
  const tc = catalog.songCards([...tops.values()].flat());
  const topOf = (a) => {
    const best = (tops.get(a.id) ?? []).map((v) => tc.get(v)).filter((c) => c?.title)
      .sort((x, y) => (y.listeners - x.listeners) || (y.plays - x.plays) || (x.videoId < y.videoId ? -1 : 1))[0];
    return best ? toCard(best) : null;
  };
  const art = (a) => ({ id: a.id, name: a.name, subscribers: a.subscribers, listeners: a.listeners, topSong: topOf(a) });
  out.newArtists = newA.map(art);
  out.unknownArtists = unknownA.map(art);
  out.famousArtists = famousA.map(art);
}

/** Cached per (videoId, uid); a bad id or unknown song gives empty lists, never a throw. */
export function songRelated(catalog, recommender, rawId, uid = null, now = Date.now()) {
  const id = String(rawId ?? "").replace(/^yt_/, "");
  if (!YT_ID.test(id)) return emptyRelated();
  const key = `${id}|${uid ?? ""}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value;
  try { value = compute(catalog, recommender, id, uid, now); } catch (e) { console.error("[song/related]", e.message); return emptyRelated(); }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, { at: now, value });
  return value;
}

export const _clearRelatedCache = () => cache.clear();
