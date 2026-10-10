// MiniPlayer admin bot on Telegram: sends monitor alerts to the admin's
// chats and answers a few commands (/status, /today, /users, ...). Private:
// a chat is only served after it was linked with a one-time code from the
// dashboard (Alerts → Connect Telegram). Runs on the home server only.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const escHtml = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** "2h" / "30m" / "1d" → milliseconds, or null. */
export function parseDuration(s) {
  const m = /^(\d{1,4})\s*(m|min|h|d)?$/i.exec(String(s || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  return n * (unit === "d" ? 864e5 : unit === "h" ? 3600_000 : 60_000);
}

/** "/invite@miniplayer_robot Ali" → { cmd: "invite", arg: "Ali" }. */
export function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim() } : null;
}

const TEHRAN_MS = 3.5 * 3600_000;

/** Which scheduled reports are due at `nowMs` (Tehran = UTC+3:30, no DST). */
export function dueReports(nowMs, state = {}) {
  const t = new Date(nowMs + TEHRAN_MS);
  const tehranDate = t.toISOString().slice(0, 10);
  const h = t.getUTCHours();
  const fresh = state.lastDaily !== tehranDate;
  return {
    daily: fresh && h >= 9 && h < 12,
    weekly: state.lastWeekly !== tehranDate && t.getUTCDay() === 5 && h >= 20,
    tehranDate,
    // true when a daily is past its window and should just be marked done
    skipDaily: fresh && h >= 12,
  };
}

export class TelegramBot {
  /**
   * @param {object} o
   * @param {string} o.token
   * @param {string} o.dir  where telegram.json (linked chats, mute) lives
   * @param {string} o.dashboardUrl
   * @param {Record<string, (arg: string) => string | Promise<string>>} o.commands  reply HTML per command
   * @param {string[]} [o.chatIds]  chats linked from the environment
   */
  constructor({ token, dir, dashboardUrl, commands, chatIds = [] }) {
    this.api = `https://api.telegram.org/bot${token}`;
    this.dir = dir;
    this.file = join(dir, "telegram.json");
    this.dashboardUrl = dashboardUrl;
    this.commands = commands;
    this.codes = new Map(); // one-time link codes → expiry
    this.state = { chats: [], muteUntil: 0, offset: 0 };
    try {
      Object.assign(this.state, JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // first run
    }
    for (const id of chatIds) if (id && !this.state.chats.includes(String(id))) this.state.chats.push(String(id));
    this.username = null;
    this.reportFns = null;
  }

  /** Schedule daily/weekly digests; each is an async () => html. */
  startReports({ daily, weekly }) {
    this.reportFns = { daily, weekly };
    const tick = async () => {
      try {
        const due = dueReports(Date.now(), this.state);
        if (due.skipDaily) {
          this.state.lastDaily = due.tehranDate;
          this.save();
        }
        const enabled = this.state.reports !== false && this.linked;
        if (due.daily) {
          this.state.lastDaily = due.tehranDate;
          this.save();
          if (enabled) await this.broadcast(daily);
        }
        if (due.weekly) {
          this.state.lastWeekly = due.tehranDate;
          this.save();
          if (enabled) await this.broadcast(weekly);
        }
      } catch (e) {
        console.error("[telegram] report tick failed:", e.message);
      }
    };
    const timer = setInterval(tick, 60_000);
    timer.unref?.();
    return tick;
  }

  /** Build a report and send it to every linked chat (never throws). */
  async broadcast(fn) {
    let html;
    try {
      html = await fn();
    } catch (e) {
      console.error("[telegram] report failed:", e.message);
      return false;
    }
    const res = await Promise.allSettled(this.state.chats.map((c) => this.send(c, html)));
    return res.some((r) => r.status === "fulfilled");
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  async call(method, body, timeoutMs = 20_000) {
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
    return j.result;
  }

  get linked() {
    return this.state.chats.length > 0;
  }

  /** A t.me link that connects whoever opens it (valid 10 minutes, once). */
  linkUrl() {
    const code = randomBytes(9).toString("base64url");
    this.codes.set(code, Date.now() + 10 * 60_000);
    return `https://t.me/${this.username || "miniplayer_robot"}?start=${code}`;
  }

  send(chatId, html, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: html.slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  /** Monitor alerts: to every linked chat unless muted. */
  async notify(text, { force = false } = {}) {
    if (!this.linked || (!force && Date.now() < this.state.muteUntil)) return false;
    const results = await Promise.allSettled(this.state.chats.map((c) => this.send(c, escHtml(text), this.dashButton())));
    return results.some((r) => r.status === "fulfilled");
  }

  dashButton() {
    return { reply_markup: { inline_keyboard: [[{ text: "Open dashboard", url: this.dashboardUrl }]] } };
  }

  start() {
    this.call("getMe")
      .then((me) => (this.username = me.username))
      .catch(() => undefined);
    this.poll();
  }

  async poll() {
    for (;;) {
      try {
        const updates = await this.call(
          "getUpdates",
          { offset: this.state.offset, timeout: 50, allowed_updates: ["message"] },
          65_000,
        );
        for (const u of updates) {
          this.state.offset = u.update_id + 1;
          await this.handle(u.message).catch((e) => console.error("[telegram] reply failed:", e.message));
        }
        if (updates.length) this.save();
      } catch (e) {
        // Network trouble or another poller: wait and retry.
        await new Promise((r) => setTimeout(r, String(e?.message).includes("Conflict") ? 30_000 : 10_000));
      }
    }
  }

  async handle(msg) {
    if (!msg?.text || msg.chat?.type !== "private") return;
    const chat = String(msg.chat.id);
    const c = parseCommand(msg.text);
    if (c?.cmd === "start" && c.arg) {
      const exp = this.codes.get(c.arg);
      if (exp && exp > Date.now()) {
        this.codes.delete(c.arg);
        if (!this.state.chats.includes(chat)) this.state.chats.push(chat);
        this.save();
        await this.send(chat, "✅ <b>Connected.</b> You'll get MiniPlayer alerts here.\n\nTry /status or /today.", this.dashButton());
        return;
      }
    }
    if (!this.state.chats.includes(chat)) {
      await this.send(chat, "This bot is private. To connect, open the MiniPlayer dashboard → Alerts → <b>Connect Telegram</b>.");
      return;
    }
    if (!c || c.cmd === "start" || c.cmd === "help") {
      await this.send(
        chat,
        [
          "<b>MiniPlayer admin</b>",
          "/status — servers and YouTube",
          "/today — listeners, plays, requests",
          "/users — friends and last activity",
          "/alerts — latest alerts",
          "/feedback — latest feedback",
          "/invite Name — new invite code",
          "/report — yesterday's digest now",
          "/week — weekly digest now",
          "/reports off · /reports on — daily and weekly digests",
          "/mute 2h · /mute off — pause alerts",
          "/dashboard — open the dashboard",
          "/unlink — stop alerts in this chat",
        ].join("\n"),
      );
      return;
    }
    if (c.cmd === "dashboard") {
      await this.send(chat, "MiniPlayer dashboard", this.dashButton());
      return;
    }
    if (c.cmd === "mute") {
      if (/^(off|0|no)$/i.test(c.arg)) {
        this.state.muteUntil = 0;
        this.save();
        await this.send(chat, "🔔 Alerts are on.");
        return;
      }
      const ms = parseDuration(c.arg || "2h");
      if (!ms) {
        await this.send(chat, "Use /mute 30m, /mute 2h, /mute 1d or /mute off.");
        return;
      }
      this.state.muteUntil = Date.now() + ms;
      this.save();
      const until = new Date(this.state.muteUntil + 3.5 * 3600_000).toISOString().slice(11, 16);
      await this.send(chat, `🔕 Alerts paused until ${until} (Tehran). /mute off to resume.`);
      return;
    }
    if (c.cmd === "report" || c.cmd === "week") {
      const fn = this.reportFns?.[c.cmd === "report" ? "daily" : "weekly"];
      if (!fn) {
        await this.send(chat, "Reports aren't set up.");
        return;
      }
      try {
        await this.send(chat, await fn());
      } catch (e) {
        console.error("[telegram] report failed:", e.message);
        await this.send(chat, "Couldn't build the report.");
      }
      return;
    }
    if (c.cmd === "reports") {
      const on = /^on$/i.test(c.arg);
      if (!on && !/^off$/i.test(c.arg)) {
        await this.send(chat, `Reports are ${this.state.reports === false ? "off" : "on"}. Use /reports on or /reports off.`);
        return;
      }
      this.state.reports = on;
      this.save();
      await this.send(chat, on ? "📰 Daily and weekly reports are on." : "🔕 Daily and weekly reports are off.");
      return;
    }
    if (c.cmd === "unlink") {
      this.state.chats = this.state.chats.filter((x) => x !== chat);
      this.save();
      await this.send(chat, "Disconnected. No more alerts here.");
      return;
    }
    const fn = this.commands[c.cmd];
    if (!fn) {
      await this.send(chat, "Unknown command. /help");
      return;
    }
    await this.send(chat, await fn(c.arg));
  }
}
