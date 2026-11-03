// Smart search over the catalog: song text (FTS5, typo-ish and any script),
// artists by name or alias, and tag / mood words. Every part is indexed and
// limited; see the catalog methods for the queries.

import { normSearch, persianFold, MOOD_WORDS } from "./search_text.js";

const FTS_LIMIT = 200; // unranked: reading few index pages matters more than bm25 (cold disk)
const ARTIST_SONGS = 300;
const TAG_LIMIT = 50;
const ALIAS_SONGS = 30;

const pop = (c) => (c.archived ? 20 : 0) + Math.log10((c.plays ?? 0) + 1) * 6 + Math.log10((c.listeners ?? 0) + 1) * 3;

/** Tags the query refers to: mood words mapped, plus words / word pairs that exist as a tag. */
function matchTags(catalog, raw, words) {
  const cands = [];
  const low = persianFold(raw).toLowerCase().replace(/\s+/g, " ").trim();
  const toks = low.split(" ").filter(Boolean).slice(0, 6);
  if (toks.length > 1) cands.push(low);
  for (let i = 0; i + 1 < toks.length; i++) cands.push(`${toks[i]} ${toks[i + 1]}`);
  for (const t of toks) cands.push(t);
  for (const w of words) if (MOOD_WORDS[w]) cands.push(MOOD_WORDS[w]);
  const out = [], used = new Set();
  for (const c of cands) {
    const tag = MOOD_WORDS[c] ?? c;
    if (tag.length < 2 || out.includes(tag) || used.has(c)) continue;
    used.add(c);
    // A word inside an already matched pair is not a second tag.
    if (out.some((o) => o.includes(" ") && o.split(" ").includes(tag))) continue;
    if (catalog.tagExists(tag)) out.push(tag);
    if (out.length >= 3) break;
  }
  return out;
}

function tagSongs(catalog, tags) {
  if (!tags.length) return [];
  if (tags.length === 1) return catalog.tagTop(tags[0], TAG_LIMIT).map((r) => ({ ...r, tag: tags[0] }));
  const [a, b] = tags.slice(0, 2);
  const [small, big] = catalog.tagCount(a) <= catalog.tagCount(b) ? [a, b] : [b, a];
  const out = [];
  for (const r of catalog.tagTop(small, 2000)) {
    if (catalog.hasTag(big, r.videoId)) out.push({ ...r, tag: `${a}+${b}` });
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

export function smartSearch(catalog, query, limit = 30) {
  const t0 = performance.now();
  const raw = String(query ?? "").slice(0, 100).trim();
  const lim = Math.min(Math.max(Math.floor(Number(limit)) || 30, 1), 100);
  const empty = { songs: [], artists: [], tags: [] };
  const norm = normSearch(raw);
  if (!norm) return empty;
  const tri = catalog.ftsMode === "trigram";
  const minLen = tri ? 3 : 2;
  const words = norm.split(" ").filter((w) => w.length >= minLen).slice(0, 6);

  // a. artists
  const artists = [], seenA = new Set();
  for (const a of [...catalog.artistsByAlias(raw), ...catalog.artistsByNamePrefix(raw, 20)]) {
    if (seenA.has(a.id)) continue;
    seenA.add(a.id);
    artists.push(a);
    if (artists.length >= 20) break;
  }

  const cand = new Map(); // videoId -> { score, why }
  const add = (id, score, why) => {
    const c = cand.get(id);
    if (!c || score > c.score) cand.set(id, { score, why });
  };

  // b. song text: unranked FTS reads (cheap), ranked here with whole-word matches far ahead of substrings
  const q = (w) => (tri ? `"${w}"` : `"${w}"*`);
  const hits = new Map();
  const take = (rows) => { for (const r of rows) if (!hits.has(r.videoId)) hits.set(r.videoId, r); };
  if (norm.length >= minLen) take(catalog.ftsSearch(tri ? `"${norm}"` : `"${norm}" *`, FTS_LIMIT, false));
  if (words.length > 1) take(catalog.ftsSearch(words.map(q).join(" AND "), FTS_LIMIT, false));
  const scoreHit = (h) => {
    const T = ` ${h.title} `, A = ` ${h.artists} `, both = T + A, sp = ` ${norm} `;
    const sub = words.filter((w) => both.includes(w)).length;
    const whole = words.filter((w) => both.includes(` ${w} `)).length;
    const inTitle = T.includes(sp) ? 30 : h.title.includes(norm) ? 15 : 0;
    let s, full = true;
    if (both.includes(sp)) s = 120 + inTitle;
    else if (words.length > 1 && whole === words.length) s = 90 + inTitle * 0.7;
    else if (both.includes(norm)) s = 55 + inTitle * 0.5;
    else if (words.length && sub === words.length) s = 45;
    else { s = words.length ? 20 * (sub / words.length) : 0; full = false; }
    return { s, full, why: h.title.includes(norm) || words.some((w) => h.title.includes(w)) ? "title" : "artist" };
  };
  const score = (rows) => {
    let best = 0;
    for (const h of rows) { const r = scoreHit(h); h.r = r; if (r.full) best = Math.max(best, r.s); }
    return best;
  };
  let rows = [...hits.values()];
  score(rows);
  // Several words: all of them must match, unless nothing does; then a loose OR whose weak results are dropped.
  if (!rows.some((h) => h.r.full) && words.length > 1 && performance.now() - t0 < 80) {
    const or = catalog.ftsSearch(words.map(q).join(" OR "), FTS_LIMIT, false);
    rows = or; score(rows);
    const top = Math.max(0, ...rows.map((h) => h.r.s));
    rows = rows.filter((h) => h.r.s >= top * 0.5);
  } else if (words.length > 1) rows = rows.filter((h) => h.r.full);
  for (const h of rows) add(h.videoId, h.r.s, h.r.why);

  // c. tags and moods
  const tags = performance.now() - t0 < 100 ? matchTags(catalog, raw, words) : [];
  const tagHits = tagSongs(catalog, tags);

  // artists matching the query by name or alias: their songs, ahead of text matches
  const strong = [], weak = [];
  for (const a of artists) {
    if (normSearch(a.alias ?? a.name) === norm || normSearch(a.name) === norm) strong.push(a);
    else if (a.alias) weak.push(a);
  }
  const artistIds = [];
  for (const a of strong.slice(0, 3)) for (const r of catalog.songIdsOfArtist(a.id, ARTIST_SONGS)) artistIds.push([r.videoId, r.position === 0 ? 200 : 150, a.alias ? "alias" : "artist"]);
  for (const a of weak.slice(0, 2)) for (const r of catalog.songIdsOfArtist(a.id, ALIAS_SONGS)) artistIds.push([r.videoId, 70, "alias"]);

  const cards = catalog.songCards([...cand.keys(), ...tagHits.map((r) => r.videoId), ...artistIds.map((x) => x[0])]);
  for (const r of tagHits) if (cards.has(r.videoId)) add(r.videoId, 40 + (r.weight ?? 0) * 20, `tag:${r.tag}`);
  for (const [id, sc, why] of artistIds) add(id, sc, why);

  const songs = [];
  for (const [id, c] of cand) {
    const card = cards.get(id);
    if (!card || !card.title) continue;
    songs.push({
      videoId: id, title: card.title, artists: card.artists, album: card.album, durationS: card.durationS,
      archived: card.archived, score: Math.round((c.score + pop(card)) * 10) / 10, why: c.why,
    });
  }
  songs.sort((a, b) => b.score - a.score);
  return { songs: songs.slice(0, lim), artists, tags };
}
