// Telegram HTML digests (daily + weekly). Pure functions: data in, HTML out.
import { escHtml } from "./telegram_bot.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const num = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const dt = (s) => new Date(`${s}T12:00:00Z`);
const md = (s) => `${MO[dt(s).getUTCMonth()]} ${dt(s).getUTCDate()}`;

export function fmtDuration(min) {
  const m = Number(min) || 0;
  return m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
}

/** " ▲ 12%" / " ▼ 5%" / "" (no previous value or no change). */
function delta(cur, prev) {
  if (!prev) return "";
  const p = Math.round(((cur - prev) / prev) * 100);
  return p === 0 ? "" : ` ${p > 0 ? "▲" : "▼"} ${Math.abs(p)}%`;
}

const pct = (x, d = 1) => `${(x * 100).toFixed(d).replace(/\.0+$/, "")}%`;

function names(list, max = 6) {
  const shown = list.slice(0, max).map((u) => escHtml(u.name));
  return shown.join(", ") + (list.length > max ? ` +${list.length - max}` : "");
}

function trafficLine(t) {
  if (!t || !t.n) return null;
  let s = `📡 ${num(t.n)} requests · ${((t.err / t.n) * 100).toFixed(1)}% errors`;
  if (t.audioMs) s += ` · songs start in ${(t.audioMs / 1000).toFixed(1)} s`;
  return s;
}

function topSongs(list, n) {
  return list.slice(0, n).map((s, i) => `${i + 1}. ${escHtml(s.title)} — ${escHtml(s.artist)} · ${num(s.plays)} ${s.plays === 1 ? "play" : "plays"}`);
}

export function dailyReport(ctx) {
  const d = ctx.date;
  const t = ctx.listening?.totals || {};
  const prev = ctx.listening?.prevTotals || {};
  const L = [`☀️ <b>Good morning — ${WD[dt(d).getUTCDay()]} ${md(d)}</b>`, ""];
  if (!t.plays) {
    L.push("🎧 No listening yesterday");
  } else {
    L.push(`🎧 <b>${num(t.listeners)}</b> ${t.listeners === 1 ? "listener" : "listeners"} · <b>${num(t.plays)}</b> plays${delta(t.plays, prev.plays)}`);
    L.push(`⏱ ${fmtDuration(t.minutes)} of music`);
    const ts = ctx.listening.topSongs || [];
    if (ts.length) L.push("", "🏆 <b>Top songs</b>", ...topSongs(ts, 3));
    if (ctx.active?.length) L.push("", `👥 ${names(ctx.active)}`);
  }
  L.push("");
  const servers = ctx.servers || [];
  const probs = [];
  for (const s of servers) {
    if (!s.up) probs.push(`🔴 ${escHtml(s.label)} down`);
    else if (s.yt && s.yt.ok === false) probs.push(`🟠 YouTube failing on ${escHtml(s.label)}`);
  }
  const na = ctx.alerts?.length || 0;
  const alertTxt = na ? ` · ${na} ${na === 1 ? "alert" : "alerts"} in 24 h` : "";
  if (probs.length) L.push(...probs.map((p, i) => (i === probs.length - 1 ? p + alertTxt : p)));
  else if (servers.length) L.push(`✅ All ${servers.length} services up${alertTxt}`);
  else if (na) L.push(`🔔 ${na} ${na === 1 ? "alert" : "alerts"} in 24 h`);
  const tl = trafficLine(ctx.traffic);
  if (tl) L.push(tl);
  if (ctx.feedbackCount > 0) L.push(`💬 ${num(ctx.feedbackCount)} new feedback`);
  const b = ctx.backup;
  const stale = b && Date.now() - new Date(b.at).getTime() > 26 * 3600_000;
  if (b && b.ok && !stale) L.push(`💾 Backup OK (${Math.max(1, Math.round((b.bytes || 0) / 1048576))} MB)`);
  else L.push(b && !b.ok ? "⚠️ Last backup failed" : "⚠️ Last backup missing or old");
  return L.join("\n").slice(0, 1500);
}

export function weeklyReport(ctx) {
  const t = ctx.listening?.totals || {};
  const prev = ctx.listening?.prevTotals || {};
  const L = [`📊 <b>Your week in music</b> · ${md(ctx.from)} – ${md(ctx.to)}`, ""];
  if (!t.plays) {
    L.push("🎧 No listening this week");
  } else {
    L.push(`▶️ <b>${num(t.plays)}</b> plays${delta(t.plays, prev.plays)}`);
    L.push(`👥 <b>${num(t.listeners)}</b> listeners${delta(t.listeners, prev.listeners)}`);
    L.push(`⏱ <b>${((t.minutes || 0) / 60).toFixed(1)}</b> hours${delta(t.minutes, prev.minutes)}`);
    L.push(`🎵 <b>${num(t.songs)}</b> unique songs${delta(t.songs, prev.songs)}`);
    const ts = ctx.listening.topSongs || [];
    if (ts.length) L.push("", "🏆 <b>Top songs</b>", ...topSongs(ts, 5));
    const ta = ctx.listening.topArtists || [];
    if (ta.length) L.push("", "🎤 <b>Top artists</b>", ...ta.slice(0, 5).map((a, i) => `${i + 1}. ${escHtml(a.artist)} · ${num(a.plays)} plays`));
  }
  const au = ctx.activeUsers || [];
  if (au.length) {
    const u = au[0];
    L.push("", `👑 Most active: ${escHtml(u.name)}${u.days ? ` (${u.days} ${u.days === 1 ? "day" : "days"})` : ""}`);
  }
  if (ctx.heatPeak) L.push(`🔥 Busiest: ${escHtml(ctx.heatPeak.weekday)}s around ${String(ctx.heatPeak.hour).padStart(2, "0")}:00`);
  if (ctx.invitesTotal != null || ctx.newInvites) {
    L.push(`🎟 ${num(ctx.invitesTotal)} friends${ctx.newInvites ? ` · ${num(ctx.newInvites)} new` : ""}`);
  }
  const up = (ctx.uptime || []).filter((u) => u.uptime7d != null);
  const ac = ctx.alertsCount || {};
  if (up.length || ac.down || ac.warn) {
    const parts = [];
    if (up.length) parts.push(up.map((u) => `${escHtml(u.label)} ${pct(u.uptime7d)}`).join(" · "));
    L.push("", `🛠 Uptime: ${parts.join("") || "n/a"}`);
    const x = [];
    if (ac.down) x.push(`🔴 ${num(ac.down)} ${ac.down === 1 ? "outage" : "outages"}`);
    if (ac.warn) x.push(`🟠 ${num(ac.warn)} ${ac.warn === 1 ? "blocking warning" : "blocking warnings"}`);
    if (x.length) L.push(x.join(" · "));
  }
  const tl = trafficLine(ctx.traffic);
  if (tl) L.push(tl);
  return L.join("\n").slice(0, 3000);
}
