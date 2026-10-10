import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dailyReport, weeklyReport } from "../src/reports.js";

const listening = (o = {}) => ({
  totals: { plays: 1234, skips: 5, listeners: 4, minutes: 205, likes: 3, songs: 50, artists: 20 },
  prevTotals: { plays: 1000, skips: 0, listeners: 5, minutes: 100, likes: 0, songs: 40, artists: 10 },
  topSongs: [
    { id: "a", title: "<b>x</b>", artist: "Dua & Co", plays: 5, listeners: 2, skips: 0 },
    { id: "b", title: "Two", artist: "B", plays: 1, listeners: 1, skips: 0 },
  ],
  topArtists: [{ artist: "Dua", plays: 9, listeners: 2, songs: 3 }],
  ...o,
});
const fresh = { at: new Date().toISOString(), ok: true, bytes: 12 * 1048576 };
const base = () => ({
  date: "2026-10-09",
  listening: listening(),
  active: [{ name: "Ali", requests: 120 }, { name: "Sara", requests: 3 }],
  invitesTotal: 6,
  traffic: { n: 1200, err: 12, audio: 300, audioErr: 2, audioMs: 2100 },
  servers: [{ label: "Germany", up: true, uptime24h: 1, yt: { ok: true }, role: "worker" }],
  alerts: [],
  feedbackCount: 1,
  backup: fresh,
});

test("dailyReport has key numbers, names and deltas", () => {
  const h = dailyReport(base());
  assert.match(h, /Fri Oct 9/);
  assert.match(h, /1,234/);
  assert.match(h, /▲ 23%/);
  assert.match(h, /3\.4 h/);
  assert.match(h, /Ali, Sara/);
  assert.match(h, /All 1 services up/);
  assert.match(h, /1\.0% errors/);
  assert.match(h, /start in 2\.1 s/);
  assert.match(h, /1 new feedback/);
  assert.match(h, /Backup OK \(12 MB\)/);
  assert.ok(h.length < 1500);
});

test("dailyReport escapes HTML in titles", () => {
  const h = dailyReport(base());
  assert.ok(h.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(h.includes("Dua &amp; Co"));
});

test("dailyReport shows ▼ and minutes under an hour", () => {
  const h = dailyReport({ ...base(), listening: listening({ totals: { plays: 50, listeners: 1, minutes: 45 }, prevTotals: { plays: 100 } }) });
  assert.match(h, /▼ 50%/);
  assert.match(h, /45 min/);
});

test("dailyReport lists problems and alert count", () => {
  const h = dailyReport({
    ...base(),
    servers: [
      { label: "Turkey", up: false },
      { label: "US", up: true, yt: { ok: false } },
    ],
    alerts: [{ level: "down", text: "x" }, { level: "up", text: "y" }],
  });
  assert.match(h, /🔴 Turkey down/);
  assert.match(h, /🟠 YouTube failing on US/);
  assert.match(h, /2 alerts/);
});

test("dailyReport handles empty data", () => {
  const h = dailyReport({
    date: "2026-10-09",
    listening: { totals: { plays: 0 }, prevTotals: {} },
    active: [],
    traffic: null,
    servers: [],
    alerts: [],
    feedbackCount: 0,
    backup: null,
  });
  assert.match(h, /No listening yesterday/);
  assert.match(h, /⚠️ Last backup/);
  assert.doesNotMatch(h, /Top songs|feedback|services up/);
});

test("dailyReport flags failed and stale backups, omits % when prev is 0", () => {
  assert.match(dailyReport({ ...base(), backup: { ...fresh, ok: false } }), /backup failed/);
  assert.match(dailyReport({ ...base(), backup: { ...fresh, at: new Date(Date.now() - 30 * 3600_000).toISOString() } }), /⚠️/);
  assert.doesNotMatch(dailyReport({ ...base(), listening: listening({ prevTotals: { plays: 0 } }) }), /▲|▼/);
});

test("dailyReport trims long listener lists", () => {
  const active = Array.from({ length: 9 }, (_, i) => ({ name: `U${i}`, requests: 1 }));
  assert.match(dailyReport({ ...base(), active }), /U5 \+3/);
});

const week = () => ({
  from: "2026-10-03",
  to: "2026-10-09",
  listening: listening({
    topSongs: Array.from({ length: 7 }, (_, i) => ({ title: `S${i}`, artist: "A", plays: 10 - i })),
    topArtists: [{ artist: "Dua", plays: 99, listeners: 2, songs: 3 }],
  }),
  activeUsers: [{ name: "Ali", requests: 500, days: 5 }],
  invitesTotal: 6,
  newInvites: 1,
  traffic: { n: 9000, err: 9, audio: 1, audioErr: 0, audioMs: null },
  uptime: [{ label: "Germany", uptime7d: 0.997 }, { label: "US", uptime7d: 1 }, { label: "TR", uptime7d: null }],
  alertsCount: { down: 2, warn: 1 },
  heatPeak: { weekday: "Friday", hour: 22 },
});

test("weeklyReport has KPIs, tops, uptime and peak", () => {
  const h = weeklyReport(week());
  assert.match(h, /Oct 3 – Oct 9/);
  assert.match(h, /1,234<\/b> plays ▲ 23%/);
  assert.match(h, /3\.4<\/b> hours ▲ 105%/);
  assert.match(h, /5\. S4/);
  assert.doesNotMatch(h, /6\. S5/);
  assert.match(h, /Dua · 99 plays/);
  assert.match(h, /Most active: Ali \(5 days\)/);
  assert.match(h, /Busiest: Fridays around 22:00/);
  assert.match(h, /Germany 99\.7% · US 100%/);
  assert.doesNotMatch(h, /TR /);
  assert.match(h, /2 outages/);
  assert.match(h, /9,000 requests/);
});

test("weeklyReport skips empty sections", () => {
  const h = weeklyReport({ from: "2026-10-03", to: "2026-10-09", listening: { totals: { plays: 0 } }, activeUsers: [], uptime: [], alertsCount: {}, heatPeak: null });
  assert.match(h, /No listening this week/);
  assert.doesNotMatch(h, /Uptime|Busiest|Most active|Top/);
});
