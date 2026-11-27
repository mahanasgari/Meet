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
// YouTube Music pushes back (HTTP 429/403). It goes in rounds: artists known
// when the round started (meta key artist_crawl_cutoff). With [rounds] on,
// a finished round starts the next one with the artists the last found on
// its pages (similar artists, featured artists), so the catalog and the
// archive queue keep growing; when no new artist is left, it re-fetches
// pages older than [refreshMs] for new releases.

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
   * @param {(path: string, body: object) => Promise<object>} o.transport  YouTube Music InnerTube (this server)
   * @param {{ id: string, transport: Function }[]} [o.peers]  other servers' InnerTube relays: one more
   *   artist at a time each. A page from a peer with no songs is fetched again here (some addresses get
   *   cut-down pages); a peer that keeps sending those rests for [peerRestMs].
   * @param {number} [o.cutoff]  crawl artists first seen up to here
   */
  constructor({ catalog, transport, peers = [], peerRestMs = 6 * 3600_000, cutoff = Date.now(), rounds = false, onRound = null, refreshMs = 30 * 86400_000, log = console, now = () => Date.now() }) {
    this.catalog = catalog;
    this.transport = transport;
    this.lanes = [
      { id: "local", transport, trusted: true, busy: false, pauseUntil: 0, strikes: 0 },
    ];
    this.addPeers(peers);
    this.peerRestMs = peerRestMs;
    this.cutoff = cutoff;
    this.rounds = rounds;
    this.onRound = onRound;
    this.refreshMs = refreshMs;
    this.round = 0;
    this.log = log;
    this.now = now;
    this.inFlight = new Set();
    /** Artists a peer answered with an empty page: the trusted lane fetches them. */
    this.recheck = [];
    this.done = 0;
  }

  /** More servers to fetch through (see the constructor's peers). */
  addPeers(peers) {
    for (const p of peers) {
      if (this.lanes.some((l) => l.id === p.id)) continue;
      this.lanes.push({ id: p.id, transport: p.transport, trusted: false, busy: false, pauseUntil: 0, strikes: 0 });
    }
  }

  /** Kept for callers that read it: the local lane's pause. */
  get pauseUntil() {
    return this.lanes[0].pauseUntil;
  }

  #pick(ids) {
    return ids.find((x) => !this.inFlight.has(x)) ?? null;
  }

  /** The next artist to fetch: this round's, the next round's, or a stale page. */
  #next() {
    const want = this.lanes.length + 2;
    let id = this.#pick(this.catalog.nextArtistPages(want, this.cutoff));
    if (id || !this.rounds) return id;
    if (this.inFlight.size) {
      // Someone is still on this round: start the next one only once it's free.
      if (this.catalog.nextArtistPages(1, this.cutoff).length) return null;
    }
    const now = this.now();
    // Artists first seen since this round started: the next round.
    id = this.#pick(this.catalog.nextArtistPages(want, now));
    if (id) {
      const st = this.catalog.artistPageStats(now);
      this.cutoff = now;
      this.round++;
      this.onRound?.(now);
      this.log.log(`[artists] new round: ${st.pending} artists found since the last one`);
      return id;
    }
    return this.#pick(this.catalog.staleArtistPages(want, now - this.refreshMs));
  }

  /**
   * Hands an artist to every free lane (this server and each peer) and
   * waits for them. False when there's nothing left to fetch.
   */
  async tick() {
    const now = this.now();
    const jobs = [];
    let any = false;
    for (const lane of this.lanes) {
      if (lane.busy || now < lane.pauseUntil) {
        any ||= lane.busy;
        continue;
      }
      const id = lane.trusted && this.recheck.length ? this.recheck.shift() : this.#next();
      if (!id) break;
      any = true;
      jobs.push(this.#fetch(lane, id));
    }
    // Nothing to give out and nobody working: done (for now).
    if (!jobs.length) return any || this.lanes.some((l) => now < l.pauseUntil && l.trusted);
    await Promise.all(jobs);
    return true;
  }

  async #fetch(lane, id) {
    lane.busy = true;
    this.inFlight.add(id);
    try {
      const page = parseArtistPage(await lane.transport("browse", { browseId: id }));
      let songs = page.songs;
      if (page.songsPlaylist) {
        const all = parseSongList(await lane.transport("browse", { browseId: page.songsPlaylist }));
        const have = new Set(songs.map((s) => s.videoId));
        songs = [...songs, ...all.filter((s) => !have.has(s.videoId))];
      }
      if (!lane.trusted && !songs.length) {
        // Maybe a cut-down page for that server's address: ask here instead.
        this.recheck.push(id);
        if (++lane.strikes >= 5) {
          lane.strikes = 0;
          lane.pauseUntil = this.now() + this.peerRestMs;
          this.log.error(`[artists] ${lane.id} keeps getting empty artist pages; resting it`);
        }
        return;
      }
      lane.strikes = 0;
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
        this.log.log(`[artists] ${st.fetched} pages fetched, ${st.pending} to go, ${st.songs} songs known (${this.lanes.filter((l) => this.now() >= l.pauseUntil).length} servers crawling)`);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (/HTTP (429|403)/.test(msg)) {
        // Pushed back: leave this artist for later, pause this lane.
        lane.pauseUntil = this.now() + 30 * 60_000;
        this.log.error(`[artists] YouTube Music pushed back on ${lane.id} (${msg}); pausing it 30 min`);
      } else if (!lane.trusted) {
        // A peer that can't be reached: rest it a while, the artist stays to do.
        lane.pauseUntil = this.now() + 10 * 60_000;
        this.log.error(`[artists] ${lane.id}: ${msg.slice(0, 120)}; resting 10 min`);
      } else {
        this.catalog.markArtistPageFailed(id, this.now());
        this.log.error(`[artists] ${id}: ${msg.slice(0, 120)}`);
      }
    } finally {
      lane.busy = false;
      this.inFlight.delete(id);
    }
  }
}
