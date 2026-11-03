// Anonymous error reports from the apps (home only): sanitized, rate-limited
// per user, appended to a JSON-lines file and kept in a ring in memory.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const KINDS = ["play_failed", "stopped_after_failures", "stall", "crash", "error"];
const NETWORKS = ["wifi", "mobile", "none", "other"];
const PLATFORMS = ["android", "linux", "windows", "web", "ios", "macos"];
const HOUR = 3_600_000;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** The allowed fields of [r], cleaned; null when it is not a usable report. */
export function sanitizeReport(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (!KINDS.includes(r.kind)) return null;
  const out = {
    kind: r.kind,
    message: str(r.message, 500),
    trackId: typeof r.trackId === "string" && /^yt_[\w-]{11}$/.test(r.trackId) ? r.trackId : null,
    server: str(r.server, 120),
    network: NETWORKS.includes(r.network) ? r.network : null,
    appVersion: str(r.appVersion, 20),
    platform: PLATFORMS.includes(r.platform) ? r.platform : null,
  };
  if (!out.platform) return null;
  if (r.extra && typeof r.extra === "object" && !Array.isArray(r.extra)) {
    try {
      if (JSON.stringify(r.extra).length <= 2048) out.extra = r.extra;
    } catch {}
  }
  return out;
}

export class ReportStore {
  constructor({ file, max = 5000 } = {}) {
    this.file = file;
    this.max = max;
    this.ring = [];
    this.hits = new Map(); // uid -> timestamps within the last hour
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        if (existsSync(file)) {
          const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
          for (const l of lines.slice(-max)) {
            try {
              this.ring.push(JSON.parse(l));
            } catch {}
          }
        }
      } catch {}
    }
  }

  /** Store [report]; false when invalid or [uid] sent over 60 in an hour. */
  add(report, { uid = null, ip = null, now = Date.now() } = {}) {
    void ip; // never stored
    const clean = sanitizeReport(report);
    if (!clean) return false;
    const key = uid || "anon";
    const recent = (this.hits.get(key) || []).filter((t) => now - t < HOUR);
    if (recent.length >= 60) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    const entry = { at: now, uid: uid || null, ...clean };
    this.ring.push(entry);
    if (this.ring.length > this.max) this.ring.splice(0, this.ring.length - this.max);
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(entry) + "\n");
      } catch {}
    }
    return true;
  }

  latest({ limit = 200, kind } = {}) {
    const list = kind ? this.ring.filter((r) => r.kind === kind) : this.ring;
    return list.slice(-Math.max(1, limit)).reverse();
  }

  summary(sinceMs = 0) {
    const byKind = {};
    const byAppVersion = {};
    let total = 0;
    for (const r of this.ring) {
      if (r.at < sinceMs) continue;
      total++;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const v = r.appVersion || "?";
      byAppVersion[v] = (byAppVersion[v] || 0) + 1;
    }
    return { total, byKind, byAppVersion };
  }
}
