// Artist crawler (home only): fetches the YouTube Music page of every artist
// in the catalog — name, subscribers, about, albums/singles, similar artists —
// and their songs ("Songs → See all", the first page of up to ~100), into the
// catalog.
//
// Every song found is queued for the archive with the lowest priority
// ("crawl": after plays, up next, opened and suggested songs), most popular
// first: artists with more subscribers, and each artist's top songs (the
// page lists them by popularity).
//
// One artist at a time, a few seconds apart; backs off for half an hour when
// YouTube Music pushes back (HTTP 429/403). Only artists known when the
// crawl started (meta key artist_crawl_cutoff): artists first seen on the
// pages it fetches are stored but not crawled in turn, so it finishes.

const isObj = (v) => v && typeof v === "object";
const runsOf = (x) => (Array.isArray(x?.runs) ? x.runs : []);
const textOf = (x) => runsOf(x).map((r) => r?.text ?? "").join("") || x?.simpleText || "";
const bid = (run) => run?.navigationEndpoint?.browseEndpoint?.browseId ?? null;
const isArtistId = (id) => typeof id === "string" && /^UC[\w-]{22}$/.test(id);
const isAlbumId = (id) => typeof id === "string" && id.startsWith("MPREb_");

function walk(o, fn) {
  if (!isObj(o)) return;
  if (fn(o) === false) return;
  for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, fn);
}

function parseCount(s) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(s ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] ?? 1));
}

function parseDuration(s) {
  if (typeof s !== "string" || !/^\d+(:\d+){1,2}$/.test(s.trim())) return null;
  return s.trim().split(":").reduce((a, p) => a * 60 + Number(p), 0);
}

/** A song row (musicResponsiveListItemRenderer) → { videoId, title, artists, album, durationS }. */
export function songRow(r) {
  const videoId =
    r?.playlistItemData?.videoId ??
    r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) return null;
  const cols = (r.flexColumns ?? []).map((c) => c?.musicResponsiveListItemFlexColumnRenderer?.text);
  const artists = [];
  let album = null;
  for (const run of cols.slice(1).flatMap(runsOf)) {
    const id = bid(run);
    if (isArtistId(id)) artists.push({ id, name: run.text });
    else if (isAlbumId(id) && !album) album = { id, name: run.text };
  }
  const fixed = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text;
  return { videoId, title: textOf(cols[0]) || null, artists, album, durationS: parseDuration(textOf(fixed)) };
}

/** Every song row in a browse answer (a playlist page), in order, once each. */
export function parseSongList(json) {
  const out = [];
  const seen = new Set();
  walk(json, (n) => {
    if (!n.musicResponsiveListItemRenderer) return true;
    const s = songRow(n.musicResponsiveListItemRenderer);
    if (s && !seen.has(s.videoId)) {
      seen.add(s.videoId);
      out.push(s);
    }
    return false;
  });
  return out;
}

/**
 * An artist page → { name, subscribers, description, songs (top songs on the
 * page), songsPlaylist ("See all", VL…), albums, related }.
 */
export function parseArtistPage(json) {
  const out = { name: null, subscribers: null, description: null, songs: [], songsPlaylist: null, albums: [], related: [], videos: [] };
  const h = json?.header?.musicImmersiveHeaderRenderer ?? json?.header?.musicVisualHeaderRenderer ?? json?.header?.musicHeaderRenderer;
  if (h) {
    out.name = textOf(h.title) || null;
    const sub = h.subscriptionButton?.subscribeButtonRenderer;
    out.subscribers = parseCount(textOf(sub?.subscriberCountText) || textOf(sub?.longSubscriberCountText));
    const d = textOf(h.description).trim();
    if (d) out.description = d.slice(0, 1000);
  }
  const seenSong = new Set();
  const seenRel = new Set();
  walk(json?.contents, (n) => {
    if (n.musicShelfRenderer) {
      const shelf = n.musicShelfRenderer;
      const vl = bid(runsOf(shelf.title)[0]) ?? shelf.bottomEndpoint?.browseEndpoint?.browseId;
      if (!out.songsPlaylist && typeof vl === "string" && vl.startsWith("VL")) out.songsPlaylist = vl;
      for (const it of shelf.contents ?? []) {
        const s = songRow(it?.musicResponsiveListItemRenderer);
        if (s && !seenSong.has(s.videoId)) {
          seenSong.add(s.videoId);
          out.songs.push(s);
        }
      }
      return false;
    }
    if (n.musicDescriptionShelfRenderer && !out.description) {
      const d = textOf(n.musicDescriptionShelfRenderer.description).trim();
      if (d) out.description = d.slice(0, 1000);
      return false;
    }
    if (n.musicTwoRowItemRenderer) {
      const tr = n.musicTwoRowItemRenderer;
      const id = tr.navigationEndpoint?.browseEndpoint?.browseId ?? bid(runsOf(tr.title)[0]);
      const sub = textOf(tr.subtitle);
      // YouTube's own "official music video" label.
      const we = tr.navigationEndpoint?.watchEndpoint;
      if (/^[\w-]{11}$/.test(we?.videoId ?? "") && we.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType === "MUSIC_VIDEO_TYPE_OMV") {
        out.videos.push({ videoId: we.videoId, title: textOf(tr.title) });
      }
      if (isArtistId(id) && !seenRel.has(id)) {
        seenRel.add(id);
        out.related.push({ id, name: textOf(tr.title) || null, subscribers: /subscriber/i.test(sub) ? parseCount(sub) : null, rank: out.related.length });
      } else if (isAlbumId(id)) {
        const parts = sub.split("•").map((x) => x.trim());
        const y = parts.find((p) => /^(19|20)\d\d$/.test(p));
        out.albums.push({ id, title: textOf(tr.title) || null, kind: parts[0] && parts[0] !== y ? parts[0] : null, year: y ? Number(y) : null });
      }
      return false;
    }
    return true;
  });
  return out;
}

const MAX_SONG_S = 15 * 60;

/** Archive order of an artist's [rank]-th song: popular artists' top songs first. */
export function crawlWeight(subscribers, rank) {
  return Math.round(100 * Math.log10((subscribers || 0) + 10) - 15 * rank);
}

export class ArtistCrawler {
  /**
   * @param {object} o
   * @param {import("./catalog.js").Catalog} o.catalog
   * @param {(path: string, body: object) => Promise<object>} o.transport  YouTube Music InnerTube
   * @param {number} [o.cutoff]  crawl artists first seen up to here
   */
  constructor({ catalog, transport, cutoff = Date.now(), log = console, now = () => Date.now() }) {
    this.catalog = catalog;
    this.transport = transport;
    this.cutoff = cutoff;
    this.log = log;
    this.now = now;
    this.busy = false;
    this.pauseUntil = 0;
    this.done = 0;
  }

  /** Fetches the next artist's page and songs. False when there's nothing left. */
  async tick() {
    if (this.busy || this.now() < this.pauseUntil) return true;
    const [id] = this.catalog.nextArtistPages(1, this.cutoff);
    if (!id) return false;
    this.busy = true;
    try {
      const page = parseArtistPage(await this.transport("browse", { browseId: id }));
      let songs = page.songs;
      if (page.songsPlaylist) {
        const all = parseSongList(await this.transport("browse", { browseId: page.songsPlaylist }));
        const have = new Set(songs.map((s) => s.videoId));
        songs = [...songs, ...all.filter((s) => !have.has(s.videoId))];
      }
      this.catalog.saveArtistPage(id, { ...page, songs }, this.now());
      // Official videos on the page → their songs' video matches, no search needed.
      this.catalog.matchArtistVideos(id, page.videos || [], this.now());
      this.catalog.enqueue(
        // Not concerts, mixes or full albums (over 15 minutes).
        songs.filter((s) => !(s.durationS > MAX_SONG_S)).map((s) => s.videoId),
        "crawl",
        this.now(),
        new Map(songs.map((s, i) => [s.videoId, crawlWeight(page.subscribers, i)])),
      );
      if (++this.done % 100 === 0) {
        const st = this.catalog.artistPageStats(this.cutoff);
        this.log.log(`[artists] ${st.fetched} pages fetched, ${st.pending} to go, ${st.songs} songs known`);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (/HTTP (429|403)/.test(msg)) {
        // Pushed back: leave this artist for later, pause the crawl.
        this.pauseUntil = this.now() + 30 * 60_000;
        this.log.error(`[artists] YouTube Music pushed back (${msg}); pausing 30 min`);
      } else {
        this.catalog.markArtistPageFailed(id, this.now());
        this.log.error(`[artists] ${id}: ${msg.slice(0, 120)}`);
      }
    } finally {
      this.busy = false;
    }
    return true;
  }
}
