// Song/artist graph collected from YouTube Music (InnerTube WEB_REMIX) for every
// archived song. Parsers are defensive: odd input yields empty structures.

const isObj = (v) => v && typeof v === "object";
const runsOf = (x) => (Array.isArray(x?.runs) ? x.runs : []);
const textOf = (x) => runsOf(x).map((r) => r?.text ?? "").join("");
const bid = (run) => run?.navigationEndpoint?.browseEndpoint?.browseId ?? null;
const isArtistId = (id) => typeof id === "string" && id.startsWith("UC");
const isAlbumId = (id) => typeof id === "string" && id.startsWith("MPREb_");
const isSep = (r) => (r?.text ?? "").trim() === "•";

// Artists (UC ids) and album (MPREb_ id) found in a list of runs.
function entities(runs) {
  const artists = [];
  let album = null;
  for (const r of runs) {
    const id = bid(r);
    if (isArtistId(id)) artists.push({ name: r.text, id });
    else if (isAlbumId(id) && !album) album = { name: r.text, id };
  }
  return { artists, album };
}

function parseDuration(s) {
  if (typeof s !== "string" || !/^\d+(:\d+){1,2}$/.test(s.trim())) return null;
  return s.trim().split(":").reduce((a, p) => a * 60 + Number(p), 0);
}

function parseCount(s) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(s ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] ?? 1));
}

function panelItem(node) {
  if (!isObj(node)) return null;
  if (node.playlistPanelVideoRenderer) return node.playlistPanelVideoRenderer;
  const w = node.playlistPanelVideoWrapperRenderer;
  return w?.primaryRenderer?.playlistPanelVideoRenderer ?? null;
}

export function parseNext(json) {
  const out = { upNext: [], relatedBrowseId: null };
  try {
    const tabs = json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) return out;
    for (const t of tabs) {
      const tr = t?.tabRenderer;
      const id = tr?.endpoint?.browseEndpoint?.browseId;
      if (!out.relatedBrowseId && typeof id === "string" && id.startsWith("MPTR")) out.relatedBrowseId = id;
      const list = tr?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents;
      if (!Array.isArray(list) || out.upNext.length) continue;
      const items = list.map(panelItem).filter((r) => r?.videoId);
      // First item is the seed song itself.
      for (const r of items.slice(1)) {
        const runs = runsOf(r.longBylineText ?? r.shortBylineText);
        const { artists, album } = entities(runs);
        const segs = [[]];
        for (const run of runs) isSep(run) ? segs.push([]) : segs[segs.length - 1].push(run);
        if (!artists.length) {
          const name = segs[0].map((x) => x.text).join("").trim();
          if (name) artists.push({ name, id: null });
        }
        const yr = runs.map((x) => /^\s*((?:19|20)\d\d)\s*$/.exec(x?.text ?? "")).find(Boolean);
        out.upNext.push({
          videoId: r.videoId, title: textOf(r.title), artists, album: album ?? null,
          year: yr ? Number(yr[1]) : null,
          durationS: parseDuration(textOf(r.lengthText)), rank: out.upNext.length,
        });
      }
    }
  } catch { /* fall through */ }
  return out;
}

export function parseRelated(json) {
  const out = { songs: [], artists: [], albums: [], description: null };
  try {
    const sections = json?.contents?.sectionListRenderer?.contents;
    if (!Array.isArray(sections)) return out;
    for (const sec of sections) {
      const desc = sec?.musicDescriptionShelfRenderer;
      if (desc && !out.description) {
        const d = textOf(desc.description).trim();
        if (d) out.description = d.slice(0, 1000);
      }
      const items = sec?.musicCarouselShelfRenderer?.contents;
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const li = it?.musicResponsiveListItemRenderer;
        const vid = li?.playlistItemData?.videoId;
        if (vid) {
          const cols = (li.flexColumns ?? []).map((c) => c?.musicResponsiveListItemFlexColumnRenderer?.text);
          const { artists, album } = entities(cols.slice(1).flatMap(runsOf));
          out.songs.push({
            videoId: vid, title: textOf(cols[0]), artists, album, rank: out.songs.length,
          });
          continue;
        }
        const tr = it?.musicTwoRowItemRenderer;
        if (!tr) continue;
        const id = tr.navigationEndpoint?.browseEndpoint?.browseId ?? bid(runsOf(tr.title)[0]);
        const sub = textOf(tr.subtitle);
        if (isArtistId(id)) {
          out.artists.push({ id, name: textOf(tr.title), subscribers: /subscriber/i.test(sub) ? parseCount(sub) : null, rank: out.artists.length });
        } else if (isAlbumId(id)) {
          const parts = sub.split("•").map((s) => s.trim());
          const y = parts.find((p) => /^(19|20)\d\d$/.test(p));
          out.albums.push({ id, title: textOf(tr.title), kind: parts[0] && parts[0] !== y ? parts[0] : null, year: y ? Number(y) : null });
        }
      }
    }
  } catch { /* fall through */ }
  return out;
}

export class SongGraph {
  constructor({ catalog, transport, log = console }) {
    this.catalog = catalog;
    this.transport = transport;
    this.log = log;
  }

  async crawl(videoId) {
    try {
      const next = parseNext(await this.transport("next", { videoId, playlistId: "RDAMVM" + videoId, isAudioOnly: true }));
      const rel = next.relatedBrowseId
        ? parseRelated(await this.transport("browse", { browseId: next.relatedBrowseId }))
        : { songs: [], artists: [], albums: [], description: null };
      this.catalog.saveGraph(videoId, {
        upNext: next.upNext, related: rel.songs, similarArtists: rel.artists,
        albums: rel.albums, description: rel.description,
      });
      return { upNext: next.upNext.length, related: rel.songs.length, artists: rel.artists.length };
    } catch (e) {
      this.catalog.markCrawl(videoId, false, e?.message ?? String(e));
      throw e;
    }
  }

  async tick() {
    const id = this.catalog.needsCrawl(1)[0];
    if (!id) return null;
    try { return await this.crawl(id); } catch (e) {
      this.log.error?.(`song graph crawl ${id} failed: ${e?.message ?? e}`);
      return null;
    }
  }
}
