// What listeners do right now says what they'll play next. The app's YouTube
// Music calls pass through this server (up next, artist pages, albums,
// playlists, search); the songs in those answers are queued for the archive
// so the next tap plays from Telegram instead of YouTube.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const isObj = (v) => v && typeof v === "object";

/** Calls [visit] on every object in [json], depth-first in document order. */
function collect(json, visit) {
  const stack = [json];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (isObj(node)) {
      visit(node);
      const vals = Object.values(node);
      for (let i = vals.length - 1; i >= 0; i--) if (isObj(vals[i])) stack.push(vals[i]);
    }
  }
}

function uniq(ids, skip = null) {
  const out = [];
  const seen = new Set(skip ? [skip] : []);
  for (const id of ids) {
    if (VIDEO_ID.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The up-next queue of a `next` answer, in order, without the song itself. */
export function upNextIds(json, current = null) {
  const ids = [];
  collect(json, (n) => {
    const r = n.playlistPanelVideoRenderer;
    if (isObj(r) && typeof r.videoId === "string") ids.push(r.videoId);
  });
  return uniq(ids, current);
}

/** Songs listed in a browse/search answer (artist top songs, album and playlist tracks, song results). */
export function listedSongIds(json) {
  const ids = [];
  collect(json, (n) => {
    const r = n.musicResponsiveListItemRenderer;
    if (!isObj(r)) return;
    const id =
      r.playlistItemData?.videoId ??
      r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint
        ?.watchEndpoint?.videoId;
    if (typeof id === "string") ids.push(id);
  });
  return uniq(ids);
}

/** Playlist browse ids (VL…) in a search answer. */
export function playlistIds(json) {
  const ids = new Set();
  collect(json, (n) => {
    const id = n.browseEndpoint?.browseId;
    if (typeof id === "string" && /^VL[A-Za-z0-9_-]{10,60}$/.test(id)) ids.add(id);
  });
  return [...ids];
}

/** The "Songs → See all" playlist of an artist page, if any. */
export function artistSongsPlaylist(json) {
  let found = null;
  collect(json, (n) => {
    if (found || !isObj(n.musicShelfRenderer)) return;
    const id = n.musicShelfRenderer.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
    if (typeof id === "string" && id.startsWith("VL")) found = id;
  });
  return found;
}

/**
 * Songs to queue for one relayed YouTube Music call: [{ids, reason}].
 * `next` → the first songs of the up-next queue are "next" (about to play),
 * the rest "interest"; artist/album/playlist pages → "interest"; search →
 * only the top few song results (the listener hasn't picked yet).
 */
export function interestFor(endpoint, body, json) {
  if (endpoint === "next") {
    const ids = upNextIds(json, typeof body?.videoId === "string" ? body.videoId : null);
    return [
      { ids: ids.slice(0, 6), reason: "next" },
      { ids: ids.slice(6, 20), reason: "interest" },
    ];
  }
  if (endpoint === "browse") {
    const id = String(body?.browseId || "");
    // Artist (UC), album (MPRE), playlist (VL), or a page's continuation.
    if (!(/^(UC|MPRE|VL|OLAK)/.test(id) || (!id && body?.continuation))) return [];
    return [{ ids: listedSongIds(json).slice(0, 60), reason: "interest" }];
  }
  if (endpoint === "search") {
    return [{ ids: listedSongIds(json).slice(0, 5), reason: "interest" }];
  }
  return [];
}
