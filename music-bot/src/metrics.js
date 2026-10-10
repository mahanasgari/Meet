// Server metrics for the admin dashboard: requests per route per hour
// (count, errors, time to first byte), recent errors, YouTube self-tests,
// app downloads and update checks. Kept small (30 days of hourly buckets)
// and saved to SHARES_DIR/metrics.json now and then.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEEP_DAYS = 30;

/** Dashboard route group for a request path. */
export function routeKey(pathname) {
  const p = String(pathname || "/");
  if (p.startsWith("/lyrics/")) return "lyrics";
  if (p.startsWith("/jam")) return "jam";
  if (p.startsWith("/rooms/")) return "rooms";
  if (p.startsWith("/share")) return "share";
  if (p.startsWith("/sync/")) return "sync";
  if (p.startsWith("/ytm/")) return "ytm";
  if (p.startsWith("/admin")) return "admin";
  if (p.startsWith("/app/files/")) return "app-download";
  if (p === "/app/latest.json") return "update-check";
  if (p.startsWith("/app")) return "app";
  if (p.startsWith("/invite/")) return "invite";
  if (p.startsWith("/charts/")) return "charts";
  const m = /^\/(audio|search|meta|playlist|clip|img|thumb|feedback|health)$/.exec(p);
  return m ? m[1] : "other";
}

/** Short one-way id for an address (counts unique visitors, keeps no IPs). */
export const visitorId = (ip) =>
  createHash("sha256").update(`mp-visitor:${ip}`).digest("hex").slice(0, 12);

const hourKey = (t) => new Date(t).toISOString().slice(0, 13); // 2026-10-10T11
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

export class Metrics {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "metrics.json");
    this.data = { hours: {}, errors: [], yt: [], downloads: {}, checks: {} };
    try {
      Object.assign(this.data, JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // first run
    }
    this.dirty = false;
  }

  /** One finished request: [ms] is the time to the first byte. */
  record(route, status, ms, now = Date.now()) {
    const h = (this.data.hours[hourKey(now)] ||= {});
    const r = (h[route] ||= [0, 0, 0, 0]); // count, errors (5xx), ms sum, slow (>5 s)
    r[0]++;
    if (status >= 500) r[1]++;
    r[2] += Math.max(0, Math.round(ms));
    if (ms > 5000) r[3]++;
    this.dirty = true;
  }

  error(route, status, detail, now = Date.now()) {
    this.data.errors.unshift({
      at: new Date(now).toISOString(),
      route,
      status,
      detail: String(detail || "").slice(0, 300),
    });
    this.data.errors.length = Math.min(this.data.errors.length, 100);
    this.dirty = true;
  }

  /** Result of a YouTube self-test. */
  ytTest(ok, ms, detail = "", now = Date.now()) {
    this.data.yt.unshift({ at: new Date(now).toISOString(), ok, ms, detail: String(detail).slice(0, 200) });
    this.data.yt.length = Math.min(this.data.yt.length, 200);
    this.dirty = true;
  }

  /** A release file download (one count per visitor per file per day). */
  download(file, ip, now = Date.now()) {
    const d = (this.data.downloads[dayKey(now)] ||= {});
    const v = (d[file] ||= []);
    const id = visitorId(ip);
    if (!v.includes(id) && v.length < 5000) v.push(id);
    this.dirty = true;
  }

  /** An app asking for updates: unique visitors per day ≈ apps in use. */
  updateCheck(ip, now = Date.now()) {
    const v = (this.data.checks[dayKey(now)] ||= []);
    const id = visitorId(ip);
    if (!v.includes(id) && v.length < 5000) {
      v.push(id);
      this.dirty = true;
    }
  }

  prune(now = Date.now()) {
    const cutDay = dayKey(now - KEEP_DAYS * 864e5);
    const cutHour = `${cutDay}T00`;
    for (const k of Object.keys(this.data.hours)) if (k < cutHour) delete this.data.hours[k];
    for (const key of ["downloads", "checks"]) {
      for (const k of Object.keys(this.data[key])) if (k < cutDay) delete this.data[key][k];
    }
  }

  save() {
    if (!this.dirty) return;
    this.prune();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  /** What /admin/stats returns (visitor ids reduced to counts). */
  snapshot() {
    const count = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length]));
    return {
      hours: this.data.hours,
      errors: this.data.errors.slice(0, 50),
      yt: this.data.yt.slice(0, 100),
      downloads: Object.fromEntries(Object.entries(this.data.downloads).map(([d, f]) => [d, count(f)])),
      checks: count(this.data.checks),
    };
  }
}
