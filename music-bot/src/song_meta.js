// Clean song names for matching (lyrics, music videos): strip upload
// packaging, unify Persian/Arabic letter variants, split "Artist - Title"
// uploads, and score how alike two names are.

const NOISE =
  /\b(official|music|lyric|lyrics|video|audio|visuali[sz]er|clip|hd|hq|4k|8k|remaster(ed)?|full|version|mv|m\/v|new|exclusive)\b/gi;

/** Lowercase, unified letters, no brackets/punctuation/noise words. */
export function normalize(s) {
  const base = String(s || "")
    .toLowerCase()
    .replace(/[ي]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ة]/g, "ه")
    .replace(/[أإآ]/g, "ا")
    .replace(/[ً-ٰٟـ]/g, "") // diacritics, tatweel
    .replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ")
    .replace(/\b(feat|ft|featuring|prod|produced by)\b\.?.*$/i, " ");
  const clean = (x) => x.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  // Drop packaging words ("official video", "4k"...) unless the name is only
  // those words (a song really called "New Music" stays matchable).
  return clean(base.replace(NOISE, " ")) || clean(base);
}

/** 0..1: how alike two names are (word overlap, robust to order; containment counts). */
export function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = new Set(x.split(" "));
  const B = new Set(y.split(" "));
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  const jaccard = common / (A.size + B.size - common);
  const contain = common / Math.min(A.size, B.size); // all words of the shorter one present
  return Math.max(jaccard, contain * 0.9);
}

/**
 * Title and artist from a YouTube upload title, e.g.
 * 'Sogand - "Bilite Yektarafe" OFFICIAL VIDEO | سوگند - بلیط یک طرفه' →
 * { title: 'Bilite Yektarafe', artist: 'Sogand' }. Falls back to the
 * channel name as the artist.
 */
export function splitUploadTitle(raw, channel = "") {
  let s = String(raw || "")
    .replace(/\s+\|\s+.*$/, "") // bilingual suffix "| ..."
    .replace(/\s+I\s+(official|lyrics?|music|video|audio|visuali[sz]er)\b.*$/i, "") // "Title I Lyrics Video"
    .replace(/[“”«»"']/g, " ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(official\s+(music\s+)?(video|audio|visuali[sz]er)|music video|lyrics? video|visuali[sz]er)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleanChannel = String(channel || "").replace(/\s+-\s+Topic$/i, "").replace(/\b(vevo|official|music|records?|tv)\b/gi, "").trim();
  const m = /^(.+?)\s+[-–—|:]\s+(.+)$/.exec(s);
  if (m) {
    // "Artist - Title" (most uploads); if the right side is the channel, it was "Title - Artist".
    const [left, right] = [m[1].trim(), m[2].trim()];
    if (cleanChannel && similarity(right, cleanChannel) > similarity(left, cleanChannel)) {
      return { title: left.replace(/\s+(feat|ft)\.?\s.*$/i, "").trim(), artist: right };
    }
    return { title: right.replace(/\s+(feat|ft)\.?\s.*$/i, "").trim(), artist: left };
  }
  return { title: s, artist: cleanChannel || null };
}

/** The clean title/artist to search lyrics and videos with, from a catalog song. */
export function songMeta(song) {
  if (!song) return null;
  const durationS = song.durationS ?? null;
  if (song.sourceKind === "ytm_track" || song.sourceKind === "ytm_video") {
    return {
      title: song.title || null,
      artist: song.artist || null,
      artists: song.artists?.length ? song.artists : song.artist ? [song.artist] : [],
      album: song.album || null,
      durationS,
    };
  }
  const raw = song.meta?.videoTitle || song.title || "";
  const { title, artist } = splitUploadTitle(raw, song.ytChannel);
  return { title: title || song.title || null, artist: artist || song.artist || null, artists: artist ? [artist] : [], album: song.album || null, durationS };
}
