// Numbers for the admin dashboard, built from what the servers already keep:
// listening sync files, per-server metrics and per-user request counts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DAY = 864e5;
export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/** The last [days] day keys, oldest first, ending today (UTC). */
export function dayRange(days, now = Date.now()) {
  return Array.from({ length: days }, (_, i) => dayKey(now - (days - 1 - i) * DAY));
}

// Tehran is UTC+3:30 all year (no daylight saving since 2022).
const TEHRAN_MS = 3.5 * 3600_000;
/** [weekday 0=Saturday..6=Friday, hour 0..23] in Tehran time. */
function tehranSlot(ts) {
  const d = new Date(ts + TEHRAN_MS);
  return [(d.getUTCDay() + 1) % 7, d.getUTCHours()];
}

function emptyTotals() {
  return { plays: 0, skips: 0, listeners: 0, minutes: 0, likes: 0, songs: 0, artists: 0 };
}

/**
 * Listening analytics from the opt-in sync (users/*.jsonl, anonymous ids):
 * totals for this period and the one before, per day, top songs/artists
 * and a weekday × hour heatmap.
 */
export function listeningStats(usersDir, days, now = Date.now()) {
  const from = now - days * DAY;
  const prevFrom = from - days * DAY;
  const keys = dayRange(days, now);
  const perDay = new Map(keys.map((d) => [d, { day: d, plays: 0, skips: 0, listeners: new Set(), minutes: 0 }]));
  const songs = new Map();
  const artists = new Map();
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const cur = { ...emptyTotals(), listeners: new Set(), songs: new Set(), artists: new Set() };
  const prev = { ...emptyTotals(), listeners: new Set(), songs: new Set(), artists: new Set() };

  let files = [];
  try {
    files = readdirSync(usersDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // no sync yet
  }
  for (const f of files) {
    const path = join(usersDir, f);
    try {
      if (statSync(path).mtimeMs < prevFrom) continue;
    } catch {
      continue;
    }
    const who = f.slice(0, -6);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Number(e.ts);
      if (!(ts >= prevFrom && ts <= now)) continue;
      const t = ts >= from ? cur : prev;
      const isPlay = e.t === "play";
      if (isPlay || e.t === "skip") {
        if (isPlay) t.plays++;
        else t.skips++;
        t.listeners.add(who);
        if (e.id) t.songs.add(e.id);
        if (e.a) t.artists.add(e.a);
        const mins = Number(e.s) > 0 ? e.s / 60 : 0;
        t.minutes += mins;
        if (t !== cur) continue;
        const d = perDay.get(dayKey(ts));
        if (d) {
          if (isPlay) d.plays++;
          else d.skips++;
          d.listeners.add(who);
          d.minutes += mins;
        }
        if (isPlay) {
          const [wd, h] = tehranSlot(ts);
          heat[wd][h]++;
        }
        if (e.id) {
          const s = songs.get(e.id) || { id: e.id, title: e.ti, artist: e.a, plays: 0, skips: 0, listeners: new Set() };
          if (isPlay) s.plays++;
          else s.skips++;
          s.listeners.add(who);
          s.title ||= e.ti;
          s.artist ||= e.a;
          songs.set(e.id, s);
        }
        if (e.a && isPlay) {
          const a = artists.get(e.a) || { artist: e.a, plays: 0, listeners: new Set(), songs: new Set() };
          a.plays++;
          a.listeners.add(who);
          if (e.id) a.songs.add(e.id);
          artists.set(e.a, a);
        }
      } else if (e.t === "like" || e.t === "fav") {
        t.likes++;
      }
    }
  }
  const fin = (t) => ({
    plays: t.plays,
    skips: t.skips,
    listeners: t.listeners.size,
    minutes: Math.round(t.minutes),
    likes: t.likes,
    songs: t.songs.size,
    artists: t.artists.size,
  });
  return {
    totals: fin(cur),
    prevTotals: fin(prev),
    days: [...perDay.values()].map((d) => ({ ...d, listeners: d.listeners.size, minutes: Math.round(d.minutes) })),
    topSongs: [...songs.values()]
      .filter((s) => s.plays > 0 && s.title)
      .sort((a, b) => b.plays - a.plays || b.listeners.size - a.listeners.size)
      .slice(0, 50)
      .map((s) => ({ ...s, listeners: s.listeners.size })),
    topArtists: [...artists.values()]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 30)
      .map((a) => ({ artist: a.artist, plays: a.plays, listeners: a.listeners.size, songs: a.songs.size })),
    heat,
  };
}

/**
 * Traffic across servers. [snaps] maps server id → Metrics.snapshot().
 * Health checks and admin calls are left out (that's the monitor itself).
 */
export function trafficStats(snaps, days, now = Date.now()) {
  const keys = dayRange(days, now);
  const first = `${keys[0]}T00`;
  const byDay = new Map(keys.map((d) => [d, { day: d, n: 0, err: 0, audio: 0, audioErr: 0, audioMsSum: 0 }]));
  const hourKeys = Array.from({ length: 48 }, (_, i) => new Date(now - (47 - i) * 3600_000).toISOString().slice(0, 13));
  const hourly = new Map(hourKeys.map((h) => [h, { hour: h, n: 0, err: 0 }]));
  const routes = new Map();
  const servers = [];
  const errors = [];
  for (const [server, snap] of Object.entries(snaps)) {
    if (!snap) continue;
    const s = { server, n: 0, err: 0, audio: 0, audioMsSum: 0 };
    for (const [hour, rs] of Object.entries(snap.hours || {})) {
      const inRange = hour >= first;
      for (const [route, [n, err, ms, slow]] of Object.entries(rs)) {
        if (route === "health" || route === "admin") continue;
        const h = hourly.get(hour);
        if (h) {
          h.n += n;
          h.err += err;
        }
        if (!inRange) continue;
        const d = byDay.get(hour.slice(0, 10));
        if (d) {
          d.n += n;
          d.err += err;
          if (route === "audio") {
            d.audio += n;
            d.audioErr += err;
            d.audioMsSum += ms;
          }
        }
        const r = routes.get(route) || { route, n: 0, err: 0, msSum: 0, slow: 0 };
        r.n += n;
        r.err += err;
        r.msSum += ms;
        r.slow += slow || 0;
        routes.set(route, r);
        s.n += n;
        s.err += err;
        if (route === "audio") {
          s.audio += n;
          s.audioMsSum += ms;
        }
      }
    }
    servers.push(s);
    for (const e of snap.errors || []) errors.push({ ...e, server });
  }
  const avg = (sum, n) => (n ? Math.round(sum / n) : null);
  return {
    traffic: {
      byDay: [...byDay.values()].map(({ audioMsSum, ...d }) => ({ ...d, audioMs: avg(audioMsSum, d.audio) })),
      hourly: [...hourly.values()],
      byRoute: [...routes.values()]
        .sort((a, b) => b.n - a.n)
        .map(({ msSum, ...r }) => ({ ...r, avgMs: avg(msSum, r.n) })),
      byServer: servers
        .sort((a, b) => b.n - a.n)
        .map(({ audioMsSum, ...s }) => ({ ...s, audioMs: avg(audioMsSum, s.audio) })),
    },
    errors: errors.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 150),
  };
}

/**
 * Invites joined with request counts from every server. [usages] maps
 * server id → Usage.data ({uid: {days: {day: n}, lastSeen}}).
 */
export function userStats(invites, usages, days, now = Date.now()) {
  const keys = dayRange(days, now);
  const today = keys[keys.length - 1];
  const week = new Set(dayRange(7, now));
  const daily = new Map(keys.map((d) => [d, { day: d, active: new Set(), requests: 0 }]));
  const users = invites.map((inv) => {
    const u = { ...inv, lastSeen: null, today: 0, last7: 0, lastN: 0, days: {}, servers: {} };
    for (const [server, data] of Object.entries(usages)) {
      const rec = data?.[inv.uid];
      if (!rec) continue;
      if (rec.lastSeen && (!u.lastSeen || rec.lastSeen > u.lastSeen)) u.lastSeen = rec.lastSeen;
      for (const [d, n] of Object.entries(rec.days || {})) {
        if (d === today) u.today += n;
        if (week.has(d)) u.last7 += n;
        const dd = daily.get(d);
        if (!dd) continue;
        u.lastN += n;
        u.days[d] = (u.days[d] || 0) + n;
        u.servers[server] = (u.servers[server] || 0) + n;
        dd.active.add(inv.uid);
        dd.requests += n;
      }
    }
    return u;
  });
  return {
    users,
    usageByDay: [...daily.values()].map((d) => ({ day: d.day, active: d.active.size, requests: d.requests })),
  };
}

/** App release downloads and update checks, summed over servers. */
export function appStats(snaps, days, now = Date.now()) {
  const keys = new Set(dayRange(days, now));
  const dl = new Map();
  const checks = new Map([...keys].map((d) => [d, 0]));
  for (const snap of Object.values(snaps)) {
    if (!snap) continue;
    for (const [day, files] of Object.entries(snap.downloads || {})) {
      if (!keys.has(day)) continue;
      for (const [file, n] of Object.entries(files)) {
        const k = `${day}|${file}`;
        dl.set(k, (dl.get(k) || 0) + n);
      }
    }
    for (const [day, n] of Object.entries(snap.checks || {})) {
      if (keys.has(day)) checks.set(day, checks.get(day) + n);
    }
  }
  return {
    downloads: [...dl].map(([k, n]) => {
      const [day, file] = k.split("|");
      return { day, file, n };
    }).sort((a, b) => (a.day < b.day ? -1 : 1)),
    checks: [...checks].map(([day, n]) => ({ day, n })).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
