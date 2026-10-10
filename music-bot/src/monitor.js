// Home-server monitor: checks every music server (and any extra service)
// every couple of minutes, keeps 30 days of up/down history, pulls each
// worker's /admin/stats for the dashboard and raises alerts (saved, and
// sent to Telegram when a bot is configured).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECK_MS = 2 * 60_000;
const KEEP_DAYS = 30;
const DOWN_AFTER = 2; // failed checks in a row before "down"
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/** "Germany" → "germany", "United States" → "united-states". */
export const slug = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";

/** "Meet=https://x/api/health,Other=https://y" → targets. */
export function parseServices(spec) {
  return String(spec || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      const label = i > 0 ? p.slice(0, i).trim() : p;
      const url = i > 0 ? p.slice(i + 1).trim() : p;
      return { id: slug(label), label, url, role: "service" };
    })
    .filter((t) => /^https?:\/\//.test(t.url));
}

/** Plain-language alert decisions for one check (pure, for tests). */
export function nextAlerts(prev, cur, label) {
  const out = [];
  if (prev.down !== cur.down) {
    if (cur.down) out.push({ level: "down", text: `${label} is down (${cur.error || "no answer"})` });
    else if (prev.downSince) {
      const mins = Math.max(1, Math.round((Date.parse(cur.checkedAt) - Date.parse(prev.downSince)) / 60_000));
      out.push({ level: "up", text: `${label} is back after ${mins} min` });
    }
  }
  if (prev.ytBlocked !== cur.ytBlocked && cur.ytBlocked !== undefined && prev.ytBlocked !== undefined) {
    out.push(
      cur.ytBlocked
        ? { level: "warn", text: `YouTube is failing on ${label}: ${cur.ytDetail || "test failed"}` }
        : { level: "up", text: `YouTube works again on ${label}` },
    );
  }
  return out;
}

export class Monitor {
  /**
   * @param {object} o
   * @param {string} o.dir           where history/alerts live
   * @param {string} o.token         master token (for workers' /admin/stats)
   * @param {() => object[]} o.targets  [{id,label,url,role}] (role home|worker|service)
   * @param {() => object} o.localStats  this server's stats (for role "home")
   * @param {(text: string) => Promise<boolean>} [o.notify]
   */
  constructor({ dir, token, targets, localStats, notify }) {
    this.dir = dir;
    this.token = token;
    this.targets = targets;
    this.localStats = localStats;
    this.notify = notify || (async () => false);
    this.state = new Map();
    this.alertsFile = join(dir, "alerts.json");
    try {
      this.alerts = JSON.parse(readFileSync(this.alertsFile, "utf8"));
    } catch {
      this.alerts = [];
    }
  }

  start() {
    mkdirSync(this.dir, { recursive: true });
    setTimeout(() => this.checkAll(), 20_000).unref();
    setInterval(() => this.checkAll(), CHECK_MS).unref();
  }

  async checkAll() {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.targets().map((t) => this.checkOne(t).catch(() => undefined)));
      this.prune();
    } finally {
      this.running = false;
    }
  }

  async checkOne(t) {
    const now = Date.now();
    const prev = this.state.get(t.id) || { fails: 0, down: false, downSince: null };
    const cur = { ...t, checkedAt: new Date(now).toISOString(), stats: prev.stats ?? null, raw: prev.raw ?? null };
    const healthUrl = t.role === "service" ? t.url : `${t.url}/health`;
    const t0 = Date.now();
    try {
      const r = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      cur.ms = Date.now() - t0;
      cur.ok = r.ok;
      cur.error = r.ok ? null : `HTTP ${r.status}`;
      await r.arrayBuffer().catch(() => undefined);
    } catch (e) {
      cur.ms = null;
      cur.ok = false;
      cur.error = e?.name === "TimeoutError" ? "timeout" : String(e?.cause?.code || e?.message || e).slice(0, 80);
    }
    if (t.role === "home") {
      cur.raw = this.localStats();
    } else if (t.role === "worker" && cur.ok) {
      try {
        const r = await fetch(`${t.url}/admin/stats`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (r.ok) cur.raw = await r.json();
      } catch {
        // keep the last stats
      }
    }
    cur.fails = cur.ok ? 0 : prev.fails + 1;
    cur.down = cur.ok ? false : prev.down || cur.fails >= DOWN_AFTER;
    cur.downSince = cur.down ? prev.downSince || cur.checkedAt : null;
    const yt = cur.raw?.metrics?.yt || [];
    // Two failed self-tests in a row = blocked; one success = fine again.
    if (yt.length) {
      cur.ytBlocked = yt[0].ok ? false : yt.length > 1 && !yt[1].ok ? true : prev.ytBlocked ?? false;
      cur.ytDetail = yt[0].detail;
    }
    this.state.set(t.id, cur);
    appendFileSync(join(this.dir, `${dayKey(now)}.jsonl`), `${JSON.stringify([now, t.id, cur.ok ? 1 : 0, cur.ms])}\n`);
    for (const a of nextAlerts(prev, cur, t.label)) await this.alert(a.level, t.id, a.text);
  }

  async alert(level, server, text) {
    const entry = { at: new Date().toISOString(), level, server, text };
    this.alerts.unshift(entry);
    this.alerts.length = Math.min(this.alerts.length, 300);
    try {
      const tmp = `${this.alertsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.alerts));
      renameSync(tmp, this.alertsFile);
    } catch {
      // keep in memory
    }
    const icon = { down: "🔴", up: "🟢", warn: "🟠", info: "ℹ️" }[level] || "";
    return this.notify(`${icon} MiniPlayer: ${text}`).catch(() => false);
  }

  prune() {
    const cut = dayKey(Date.now() - KEEP_DAYS * 864e5);
    try {
      for (const f of readdirSync(this.dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cut) rmSync(join(this.dir, f));
      }
    } catch {
      // ignore
    }
  }

  /** {id: [[ts, up, ms]]} in 15-minute buckets (up = every check passed). */
  history(days = 7, now = Date.now()) {
    const from = now - days * 864e5;
    const buckets = new Map();
    for (let i = days; i >= 0; i--) {
      let text = "";
      try {
        text = readFileSync(join(this.dir, `${dayKey(now - i * 864e5)}.jsonl`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let p;
        try {
          p = JSON.parse(line);
        } catch {
          continue;
        }
        const [ts, id, up, ms] = p;
        if (ts < from) continue;
        const b = Math.floor(ts / 900_000) * 900_000;
        const key = `${id}|${b}`;
        const v = buckets.get(key) || { id, b, up: 1, msSum: 0, msN: 0 };
        v.up = Math.min(v.up, up);
        if (ms != null) {
          v.msSum += ms;
          v.msN++;
        }
        buckets.set(key, v);
      }
    }
    const out = {};
    for (const v of buckets.values()) {
      (out[v.id] ||= []).push([v.b, v.up, v.msN ? Math.round(v.msSum / v.msN) : null]);
    }
    for (const a of Object.values(out)) a.sort((x, y) => x[0] - y[0]);
    return out;
  }

  /** Fraction of passed checks per server over [hours]. */
  uptime(hours, now = Date.now()) {
    const from = now - hours * 3600_000;
    const acc = {};
    for (let i = Math.ceil(hours / 24); i >= 0; i--) {
      let text = "";
      try {
        text = readFileSync(join(this.dir, `${dayKey(now - i * 864e5)}.jsonl`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const [ts, id, up] = JSON.parse(line);
          if (ts < from) continue;
          const a = (acc[id] ||= [0, 0]);
          a[0] += up;
          a[1]++;
        } catch {
          // skip
        }
      }
    }
    return Object.fromEntries(Object.entries(acc).map(([id, [u, n]]) => [id, n ? u / n : null]));
  }
}
