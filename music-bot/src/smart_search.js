// Smart search over the catalog: song text (FTS5, typo-ish and any script),
// artists by name or alias, and tag / mood words. Every part is indexed and
// limited; see the catalog methods for the queries.

import { normSearch, persianFold, MOOD_WORDS } from "./search_text.js";

const FTS_LIMIT = 100;
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
  const raw = String(query ?? "").slice(0, 100).trim();
  const lim = Math.min(Math.max(Math.floor(Number(limit)) || 30, 1), 100);
  const empty = { songs: [], artists: [], tags: [] };
  const norm = normSearch(raw);
  if (!norm) return empty;
  const tri = catalog.ftsMode === "trigram";
  const words = norm.split(" ").filter((w) => w.length >= (tri ? 3 : 2)).slice(0, 6);

  // a. artists
  const artists = [], seenA = new Set();
  for (const a of [...catalog.artistsByAlias(raw), ...catalog.artistsByNamePrefix(raw, 20)]) {
    if (seenA.has(a.id)) continue;
    seenA.add(a.id);
    artists.push(a);
    if (artists.length >= 20) break;
  }

  // b. song text
  const cand = new Map(); // videoId -> { score, why }
  const add = (id, score, why) => {
    const c = cand.get(id);
    if (!c || score > c.score) cand.set(id, { score, why });
  };
  const hits = new Map();
  const take = (rows) => { for (const r of rows) if (!hits.has(r.videoId)) hits.set(r.videoId, r); };
  const q = (w) => (tri ? `"${w}"` : `"${w}"*`);
  if (norm.length >= (tri ? 3 : 2)) take(catalog.ftsSearch(tri ? `"${norm}"` : `"${norm}" *`, FTS_LIMIT, true));
  if (hits.size < 30 && words.length > 1) take(catalog.ftsSearch(words.map(q).join(" AND "), FTS_LIMIT, false));
  if (hits.size < 30 && words.length > 1) take(catalog.ftsSearch(words.map(q).join(" OR "), FTS_LIMIT, false));
  if (hits.size < 30 && words.length === 1 && words[0] !== norm) take(catalog.ftsSearch(q(words[0]), FTS_LIMIT, false));
  for (const h of hits.values()) {
    const text = `${h.title} ${h.artists}`;
    const inTitle = words.filter((w) => h.title.includes(w)).length;
    const got = words.filter((w) => text.includes(w)).length;
    const phrase = text.includes(norm);
    let s = phrase ? 100 : got === words.length && words.length ? 60 : 30 * (words.length ? got / words.length : 0);
    if (h.title.includes(norm)) s += 30;
    else if (inTitle) s += 10 * (inTitle / Math.max(1, words.length));
    s += Math.min(10, Math.max(0, -h.rank));
    add(h.videoId, s, h.title.includes(norm) || inTitle >= got / 2 ? "title" : "artist");
  }

  // c. tags and moods
  const tags = matchTags(catalog, raw, words);
  const tagHits = tagSongs(catalog, tags);
  const pending = tagHits.map((r) => r.videoId);

  // alias artists: their songs
  const aliasArtists = artists.filter((a) => a.alias).slice(0, 2);
  const aliasIds = [];
  for (const a of aliasArtists) for (const id of catalog.songIdsOfArtist(a.id, ALIAS_SONGS)) aliasIds.push(id);

  const cards = catalog.songCards([...cand.keys(), ...pending, ...aliasIds]);
  for (const r of tagHits) {
    const c = cards.get(r.videoId);
    if (c) add(r.videoId, 40 + (r.weight ?? 0) * 20, `tag:${r.tag}`);
  }
  for (const id of aliasIds) add(id, 70, "alias");

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
