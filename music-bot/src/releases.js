// New songs from given artists, newest first, including collaborations an
// artist isn't the main name on (YouTube Music's artist pages miss those, and
// its search ranks by popularity, so a song out today doesn't show).
//
// Per artist: YouTube search sorted by upload date (this month) finds what's
// new; obvious noise is dropped (live clips, covers, remixes, reactions, fan
// mixes); each remaining video is confirmed on YouTube Music, which gives the
// clean song with its real title and artists. Cached per artist (on disk
// too): fresh for 6 hours, then shown while a refresh runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MIN = 6e4;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CACHE_MS = 6 * HOUR; // refreshed in the background after this
const STALE_MS = 3 * DAY; // still shown (while refreshing) up to this
const MAX_AGE_MS = 60 * DAY;
const VERIFY_PER_ARTIST = 6;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
// Sorted by upload date, uploaded this month, videos only.
export const YT_NEWEST_PARAMS = "CAISBAgEEAE=";
const NOISE = /\b(live|cover|remix|reaction|react|karaoke|slowed|reverb|sped ?up|nightcore|instrumental|8d|mashup|teaser|trailer|snippet|interview|podcast|concert|full album)\b|کاور|ریمیکس|لایو|ری ?اکشن|کنسرت|تیزر|ریاکشن|میکس/i;

const text = (node) => (node?.runs || []).map((r) => r.text).join("") || node?.simpleText || "";

/** Lowercase, no punctuation or spaces, Persian letter variants unified. */
export function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ٟ‌‍]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** "46 minutes ago", "3 weeks ago" → a time in ms; null for live/streamed or unknown. */
export function parseAgo(s, now) {
  const m = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(String(s || "").trim());
  if (!m) return null;
  const unit = { second: 1000, minute: MIN, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }[m[2].toLowerCase()];
  return now - Number(m[1]) * unit;
}

/** "7:14" / "1:02:03" → seconds. */
const seconds = (s) => String(s || "").split(":").reduce((t, x) => t * 60 + (Number(x) || 0), 0);

/** Video results of a YouTube (www) search response. */
export function parseYtVideos(data, now) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      if (YT_ID.test(v.videoId || "")) {
        out.push({
          videoId: v.videoId,
          title: text(v.title),
          owner: text(v.ownerText),
          verified: (v.ownerBadges || []).some((b) => /VERIFIED/.test(b?.metadataBadgeRenderer?.style || "")),
          publishedAt: parseAgo(v.publishedTimeText?.simpleText, now),
          duration: seconds(v.lengthText?.simpleText),
        });
      }
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(data);
  return out;
}

/** Song rows of a YouTube Music search response: id, title, artists [{id, name}]. */
export function parseYtmSongs(data) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.musicResponsiveListItemRenderer) {
      const r = o.musicResponsiveListItemRenderer;
      const id = r.playlistItemData?.videoId;
      const cols = r.flexColumns || [];
      const runs = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const artists = runs
        .map((x) => ({ id: x.navigationEndpoint?.browseEndpoint?.browseId || "", name: x.text }))
        .filter((a) => a.id.startsWith("UC"));
      if (YT_ID.test(id || "")) out.push({ videoId: id, title: text(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text), artists });
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(data);
  return out;
}

/**
 * A video title split into who and what: "A x B - Song (Official Video) | …"
 * → { artists: "A x B", song: "Song" }. Without a dash, artists is "".
 */
export function splitTitle(title) {
  let t = String(title || "").split(/\s[|｜]\s/)[0];
  // "(Official Video)" and anything after it (often the title again in Persian).
  t = t.replace(/\s*[([][^)\]]*(official|video|audio|visuali[sz]er|lyric|clip|موزیک|ویدیو)[^)\]]*[)\]].*$/i, "");
  t = t.replace(/\[[^\]]*\]/g, "");
  const parts = t.split(/\s[-–—]\s/).map((x) => x.replace(/\s+/g, " ").trim());
  // "Artists - Song - the same in Persian": the first song name is enough.
  return parts.length > 1 ? { artists: parts[0], song: parts[1] } : { artists: "", song: parts[0] };
}

/** The song part of a video title. */
export const songTitle = (title) => splitTitle(title).song;

export class Releases {
  /**
   * @param {object} o
   * @param {(query: string) => Promise<object>} o.ytSearch    YouTube search, newest first (raw response)
   * @param {(query: string) => Promise<object>} o.ytmSongs    YouTube Music song search (raw response)
   * @param {() => number} [o.now]
   * @param {string} [o.file]   where the cache is kept across restarts
   */
  constructor({ ytSearch, ytmSongs, now = () => Date.now(), file = null }) {
    this.ytSearch = ytSearch;
    this.ytmSongs = ytmSongs;
    this.now = now;
    this.file = file;
    this.cache = new Map(); // artist key -> { at, items }
    this.pending = new Map(); // artist key -> refresh in flight
    if (file) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) this.cache.set(k, v);
      } catch {
        // first run
      }
    }
  }

  /** New songs of [artists] ([{ id?, name }]), newest first. */
  async forArtists(artists, { limit = 20 } = {}) {
    const list = artists.filter((a) => a?.name).slice(0, 12);
    const results = [];
    // Four artists at a time: each is a few YouTube requests.
    for (let i = 0; i < list.length; i += 4) {
      results.push(...(await Promise.all(list.slice(i, i + 4).map((a) => this.#artist(a).catch(() => [])))));
    }
    const now = this.now();
    const seen = new Set();
    const out = [];
    // A cached list may hold songs that have since passed 60 days.
    for (const it of results.flat().filter((x) => now - x.publishedAt <= MAX_AGE_MS).sort((a, b) => b.publishedAt - a.publishedAt)) {
      const key = norm(it.title);
      if (seen.has(it.videoId) || seen.has(key)) continue;
      seen.add(it.videoId);
      seen.add(key);
      out.push(it);
    }
    return out.slice(0, limit);
  }

  #artist(a) {
    const key = a.id || norm(a.name);
    const hit = this.cache.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (age < CACHE_MS) return Promise.resolve(hit.items);
    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = this.#find(a)
        .then((items) => {
          this.cache.set(key, { at: this.now(), items });
          if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
          this.#saveSoon();
          return items;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    // A list a few hours old is shown at once while the refresh runs.
    if (age < STALE_MS) {
      refresh.catch(() => {});
      return Promise.resolve(hit.items);
    }
    return refresh;
  }

  #saveSoon() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.cache)));
      } catch (e) {
        console.error("[releases] save failed", e?.message);
      }
    }, 2000);
    this.timer.unref?.();
  }

  async #find(a) {
    const now = this.now();
    // Names this artist goes by (یاس / Yas / YAS): their own name plus what
    // YouTube Music calls them on their songs.
    const names = new Set([norm(a.name)]);
    if (a.id) {
      for (const s of parseYtmSongs(await this.ytmSongs(a.name)).slice(0, 20)) {
        for (const x of s.artists) if (x.id === a.id) names.add(norm(x.name));
      }
    }
    const mentions = (s) => [...names].some((n) => n.length >= 2 && norm(s).includes(n));
    const isArtist = (artists) => artists.some((x) => (a.id ? x.id === a.id : names.has(norm(x.name))));

    const videos = parseYtVideos(await this.ytSearch(a.name), now).filter(
      (v) =>
        v.publishedAt != null && now - v.publishedAt <= MAX_AGE_MS &&
        v.duration >= 90 && v.duration <= 600 &&
        !NOISE.test(v.title) &&
        // Named as the artist (before the dash when there is one), not just a
        // song title that happens to be their name.
        (mentions(splitTitle(v.title).artists || v.title) || (v.verified && mentions(v.owner))),
    );
    const checked = await Promise.all(videos.slice(0, VERIFY_PER_ARTIST).map(async (v) => {
      const { artists, song: name } = splitTitle(v.title);
      const want = norm(name);
      if (!want) return null;
      // "Artists - Song" finds a collaboration best; a bare title needs the
      // name. "x"/"feat." and a Persian word in a Latin title throw the
      // search, so simpler queries follow.
      const who = artists.replace(/\s(x|X|&|ft\.?|feat\.?|×|و)\s/g, " ");
      const latin = (q) => q.replace(/[\u0600-\u06FF]+/g, " ").replace(/\s+/g, " ").trim();
      const queries = artists ? [`${who} ${name}`, latin(`${who} ${name}`), latin(name)] : [`${name} ${a.name}`, latin(name)];
      // The song's credits on YouTube Music may name only the lead artist:
      // anyone named in the video title will do.
      const credited = (list) => isArtist(list) || list.some((x) => norm(x.name).length >= 2 && norm(artists).includes(norm(x.name)));
      // Someone else with the same name (another "Yas"): not our artist's song.
      const namesake = (list) => Boolean(a.id) && list.some((x) => names.has(norm(x.name)) && x.id !== a.id);
      let song = null;
      let other = false;
      for (const q of new Set(queries.filter((x) => /[\p{L}]{2}/u.test(x)))) {
        const songs = parseYtmSongs(await this.ytmSongs(q)).slice(0, 5);
        const same = songs.filter((s) => norm(s.title).length >= 2 && (norm(s.title).includes(want) || want.includes(norm(s.title))));
        if (same.some((s) => namesake(s.artists) && !isArtist(s.artists))) {
          other = true;
          break;
        }
        song = same.find((s) => credited(s.artists));
        if (song) break;
      }
      if (song) {
        return {
          videoId: song.videoId,
          title: song.title,
          // Full credits from the video title when YouTube Music lists only the lead.
          artist: isArtist(song.artists) || !artists ? song.artists.map((x) => x.name).join(", ") : artists,
          publishedAt: v.publishedAt,
        };
      }
      if (!other && v.verified && (mentions(v.owner) || mentions(artists))) {
        // Not (yet) on YouTube Music: an upload by a verified channel, the
        // artist's own or one naming them before the dash. ("Official" in a
        // title alone proves nothing: anyone can write it.)
        return { videoId: v.videoId, title: name, artist: mentions(artists) ? artists : v.owner, publishedAt: v.publishedAt };
      }
      return null;
    }));
    return checked.filter(Boolean);
  }
}
