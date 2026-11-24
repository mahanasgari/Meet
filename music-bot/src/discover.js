// Catalog-first New & Trending: recently available songs and short-window
// growth from the plays table. Honest date kinds — never call stored_at a
// "release". Optional lang filter is script/heuristic only.

const DAY = 864e5;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Rough language from title/artist script (same idea as the app). */
export function guessLang(title, artist) {
  const s = `${title || ""} ${artist || ""}`;
  if (/[؀-ۿ]/.test(s)) {
    const persian = (s.match(/[پچژگیک]/g) || []).length;
    const arabic = (s.match(/[يكةىإأ]/g) || []).length;
    return arabic > persian ? "ar" : "fa";
  }
  if (/[ğşıİçöüĞŞÇÖÜ]/.test(s)) return "tr";
  if (/[a-zA-Z]/.test(s)) return "en";
  return null;
}

function rowOut(r, { dateKind, at, extra = {} } = {}) {
  return {
    id: `yt_${r.video_id}`,
    title: r.title,
    artist: r.artist || "",
    dateKind: dateKind || null,
    at: at ?? null,
    archived: true,
    ...extra,
  };
}

/**
 * Newly available music in the catalog.
 * Prefers Spotify release_date when present; otherwise stored_at as "stored"
 * (catalog arrival), never labeled as a release.
 */
export function discoverNew(catalog, { limit = 40, lang = null, maxAgeMs = 90 * DAY, now = Date.now() } = {}) {
  if (!catalog?.db) return [];
  const since = now - maxAgeMs;
  const rows = catalog.db
    .prepare(
      `SELECT s.video_id, s.title, s.artist, s.stored_at,
              sp.release_date AS sp_release
       FROM songs s
       LEFT JOIN spotify_tracks sp ON sp.video_id = s.video_id AND sp.spotify_id IS NOT NULL
       WHERE s.status = 'stored'
         AND s.title IS NOT NULL AND TRIM(s.title) != ''
         AND NOT (LOWER(TRIM(s.title)) IN ('unknown','untitled','n/a','na'))
         AND (
           (sp.release_date IS NOT NULL AND length(sp.release_date) >= 4)
           OR (s.stored_at IS NOT NULL AND s.stored_at >= ?)
         )
       ORDER BY
         CASE WHEN sp.release_date IS NOT NULL THEN 0 ELSE 1 END,
         COALESCE(sp.release_date, '') DESC,
         s.stored_at DESC
       LIMIT ?`,
    )
    .all(since, Math.min(Math.max(limit * 3, limit), 200));

  const out = [];
  const seenArtists = new Map();
  for (const r of rows) {
    if (!YT_ID.test(r.video_id)) continue;
    if (lang) {
      const g = guessLang(r.title, r.artist);
      if (g && g !== lang) continue;
      if (!g && lang !== "en") continue; // unknown script: only keep for en-ish pool
    }
    const key = (r.artist || "").split(",")[0].trim().toLowerCase() || "_";
    const n = seenArtists.get(key) ?? 0;
    if (n >= 2) continue;
    seenArtists.set(key, n + 1);

    let dateKind = "stored";
    let at = r.stored_at || null;
    if (r.sp_release && String(r.sp_release).length >= 4) {
      dateKind = "release";
      const t = Date.parse(String(r.sp_release).length === 4 ? `${r.sp_release}-01-01` : r.sp_release);
      at = Number.isFinite(t) ? t : at;
    }
    out.push(rowOut(r, { dateKind, at }));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Trending = plays in the recent window that grew vs the previous window.
 * Avoids lifetime-plays domination. Falls back to raw recent plays if growth
 * is too sparse (caller should label source).
 */
export function discoverTrending(catalog, {
  limit = 40,
  lang = null,
  windowMs = 7 * DAY,
  now = Date.now(),
} = {}) {
  if (!catalog?.db) return { items: [], mode: "empty" };
  const curFrom = now - windowMs;
  const prevFrom = now - 2 * windowMs;

  const recent = catalog.db
    .prepare(
      `SELECT p.video_id, COUNT(*) plays, COUNT(DISTINCT p.uid) listeners
       FROM plays p
       WHERE p.at >= ? AND p.at <= ?
         AND (p.source IS NULL OR p.source != 'peer')
       GROUP BY p.video_id
       HAVING plays >= 2`,
    )
    .all(curFrom, now);

  const prev = new Map(
    catalog.db
      .prepare(
        `SELECT p.video_id, COUNT(*) plays
         FROM plays p
         WHERE p.at >= ? AND p.at < ?
           AND (p.source IS NULL OR p.source != 'peer')
         GROUP BY p.video_id`,
      )
      .all(prevFrom, curFrom)
      .map((r) => [r.video_id, r.plays]),
  );

  const meta = catalog.db.prepare(
    `SELECT video_id, title, artist, status FROM songs WHERE video_id = ?`,
  );

  const scored = [];
  for (const r of recent) {
    if (!YT_ID.test(r.video_id)) continue;
    const m = meta.get(r.video_id);
    if (!m || m.status !== "stored" || !m.title) continue;
    if (/^(unknown|untitled|n\/?a)$/i.test(String(m.title).trim())) continue;
    if (lang) {
      const g = guessLang(m.title, m.artist);
      if (g && g !== lang) continue;
      if (!g && lang !== "en") continue;
    }
    const before = prev.get(r.video_id) || 0;
    // Growth-heavy score; brand-new songs (before=0) still count via recent plays.
    const growth = r.plays / (before + 1);
    const score = r.listeners * 2 + r.plays + growth * 3;
    scored.push({
      video_id: r.video_id,
      title: m.title,
      artist: m.artist,
      plays: r.plays,
      listeners: r.listeners,
      before,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.plays - a.plays || (a.video_id < b.video_id ? -1 : 1));

  const perArtist = new Map();
  const items = [];
  for (const r of scored) {
    const key = (r.artist || "").split(",")[0].trim().toLowerCase() || "_";
    const n = perArtist.get(key) ?? 0;
    if (n >= 2) continue;
    perArtist.set(key, n + 1);
    items.push(
      rowOut(r, {
        dateKind: null,
        at: null,
        extra: {
          plays: r.plays,
          listeners: r.listeners,
          growth: r.before === 0 ? "new" : "up",
        },
      }),
    );
    if (items.length >= limit) break;
  }

  // Sparse catalog plays: still return recent-play ranking, tagged as such.
  const mode = items.length >= 8 ? "growth" : items.length > 0 ? "recent_plays" : "empty";
  return { items, mode, windowMs };
}
