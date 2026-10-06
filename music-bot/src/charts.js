// "Popular on MiniPlayer": a weekly chart built from the opt-in listening
// sync. Privacy: a song only appears when at least `minListeners` different
// people played it, and the result carries no ids of people — only songs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function buildWeeklyChart(usersDir, { now = Date.now(), minListeners = 2, limit = 30 } = {}) {
  const songs = new Map();
  let files = [];
  try {
    files = readdirSync(usersDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const f of files) {
    const path = join(usersDir, f);
    try {
      if (now - statSync(path).mtimeMs > WEEK_MS) continue; // idle all week
    } catch {
      continue;
    }
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // One person counts once per song, however often they replay it.
    const seen = new Map();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e.id || (e.t !== "play" && e.t !== "skip") || now - e.ts > WEEK_MS) continue;
      const s = seen.get(e.id) || { plays: 0, skips: 0, ti: e.ti, a: e.a };
      if (e.t === "play") s.plays++;
      else s.skips++;
      seen.set(e.id, s);
    }
    for (const [id, s] of seen) {
      if (s.plays === 0) continue; // only skipped: not a fan
      const t = songs.get(id) || { id, title: s.ti, artist: s.a, listeners: 0, plays: 0, skips: 0 };
      t.listeners++;
      t.plays += Math.min(s.plays, 5); // a loop can't carry the chart alone
      t.skips += s.skips;
      songs.set(id, t);
    }
  }
  return [...songs.values()]
    .filter((t) => t.listeners >= minListeners && t.title)
    .map((t) => ({ ...t, score: t.listeners * 3 + t.plays - t.skips * 0.5 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id, title, artist, listeners, plays }) => ({ id, title, artist, listeners, plays }));
}
