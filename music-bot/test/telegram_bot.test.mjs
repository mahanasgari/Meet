import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TelegramBot, escHtml, parseCommand, parseDuration } from "../src/telegram_bot.js";

const HOUR = 3600_000;

// A bot that never touches the network: every Telegram API call is recorded.
function makeBot(opts = {}) {
  const dir = opts.dir || mkdtempSync(join(tmpdir(), "tgbot-"));
  const bot = new TelegramBot({
    token: "test-token",
    dir,
    dashboardUrl: "https://example.test/dash",
    commands: {
      status: async (arg) => `STATUS ${arg}`.trim(),
      ...(opts.commands || {}),
    },
    chatIds: opts.chatIds,
  });
  const sent = [];
  bot.call = async (method, body) => {
    sent.push({ method, body });
    return {};
  };
  return { bot, sent, dir };
}

const priv = (id, text) => ({ text, chat: { id, type: "private" } });

// Links `id` through a fresh code from linkUrl(), exactly as the t.me deep link does.
async function link(bot, id) {
  const code = new URL(bot.linkUrl()).searchParams.get("start");
  await bot.handle(priv(id, `/start ${code}`));
  return code;
}

test("escHtml escapes & < > only", () => {
  assert.equal(escHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escHtml("&amp;"), "&amp;amp;");
  assert.equal(escHtml(null), "");
  assert.equal(escHtml(undefined), "");
  assert.equal(escHtml(42), "42");
});

test("parseDuration converts m/h/d and defaults to hours", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("2h"), 2 * HOUR);
  assert.equal(parseDuration("1d"), 24 * HOUR);
  assert.equal(parseDuration("5"), 5 * HOUR);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(undefined), null);
});

test("parseCommand splits command and argument", () => {
  assert.deepEqual(parseCommand("/invite Ali Reza"), { cmd: "invite", arg: "Ali Reza" });
  assert.deepEqual(parseCommand("/status@miniplayer_robot"), { cmd: "status", arg: "" });
  assert.deepEqual(parseCommand("/MUTE 2h"), { cmd: "mute", arg: "2h" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
});

test("handle: unlinked private chat gets the private reply and is not linked", async () => {
  const { bot, sent } = makeBot();
  await bot.handle(priv(1, "hi"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "sendMessage");
  assert.equal(sent[0].body.chat_id, "1");
  assert.match(sent[0].body.text, /This bot is private/);
  assert.equal(bot.linked, false);
  assert.deepEqual(bot.state.chats, []);
});

test("handle: group chats are ignored", async () => {
  const { bot, sent } = makeBot({ chatIds: ["5"] });
  await bot.handle({ text: "/status", chat: { id: -100, type: "group" } });
  await bot.handle({ text: "/start abc", chat: { id: -100, type: "group" } });
  assert.equal(sent.length, 0);
  assert.deepEqual(bot.state.chats, ["5"]);
});

test("handle: messages without text are ignored", async () => {
  const { bot, sent } = makeBot();
  await bot.handle({ chat: { id: 1, type: "private" } });
  await bot.handle(undefined);
  assert.equal(sent.length, 0);
});

test("linkUrl returns a t.me URL carrying a code", () => {
  const { bot } = makeBot();
  const url = new URL(bot.linkUrl());
  assert.equal(url.origin, "https://t.me");
  assert.equal(url.pathname, "/miniplayer_robot");
  assert.ok((url.searchParams.get("start") || "").length >= 12);
  bot.username = "other_bot";
  assert.match(bot.linkUrl(), /^https:\/\/t\.me\/other_bot\?start=/);
});

test("/start <code> links a new chat and writes telegram.json", async () => {
  const { bot, sent, dir } = makeBot();
  await link(bot, 42);
  assert.deepEqual(bot.state.chats, ["42"]);
  assert.equal(bot.linked, true);
  const saved = JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8"));
  assert.deepEqual(saved.chats, ["42"]);
  const last = sent[sent.length - 1];
  assert.match(last.body.text, /Connected/);
});

test("a link code cannot be reused by another chat", async () => {
  const { bot, sent } = makeBot();
  const code = new URL(bot.linkUrl()).searchParams.get("start");
  await bot.handle(priv(42, `/start ${code}`));
  await bot.handle(priv(43, `/start ${code}`));
  assert.deepEqual(bot.state.chats, ["42"]);
  const last = sent[sent.length - 1];
  assert.equal(last.body.chat_id, "43");
  assert.match(last.body.text, /This bot is private/);
});

test("an expired link code does not link", async () => {
  const { bot } = makeBot();
  const code = new URL(bot.linkUrl()).searchParams.get("start");
  bot.codes.set(code, Date.now() - 1);
  await bot.handle(priv(42, `/start ${code}`));
  assert.deepEqual(bot.state.chats, []);
  assert.equal(bot.linked, false);
});

test("linked chat: /status calls the command handler and sends its text", async () => {
  const seen = [];
  const { bot, sent } = makeBot({
    commands: {
      status: async (arg) => {
        seen.push(arg);
        return "<b>all good</b>";
      },
    },
  });
  await link(bot, 42);
  sent.length = 0;
  await bot.handle(priv(42, "/status"));
  assert.deepEqual(seen, [""]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, "42");
  assert.equal(sent[0].body.text, "<b>all good</b>");
  assert.equal(sent[0].body.parse_mode, "HTML");
});

test("linked chat: unknown command replies 'Unknown command'", async () => {
  const { bot, sent } = makeBot();
  await link(bot, 42);
  sent.length = 0;
  await bot.handle(priv(42, "/foo"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /^Unknown command/);
});

test("linked chat: /mute 2h pauses notify() until muteUntil, force overrides", async () => {
  const { bot, sent } = makeBot();
  await link(bot, 42);
  sent.length = 0;
  const before = Date.now();
  await bot.handle(priv(42, "/mute 2h"));
  const after = Date.now();
  assert.ok(bot.state.muteUntil >= before + 2 * HOUR && bot.state.muteUntil <= after + 2 * HOUR);
  sent.length = 0;

  assert.equal(await bot.notify("alert"), false);
  assert.equal(sent.length, 0, "muted notify sends nothing");

  assert.equal(await bot.notify("alert", { force: true }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text, "alert");
});

test("linked chat: /mute off clears the mute", async () => {
  const { bot, sent } = makeBot();
  await link(bot, 42);
  await bot.handle(priv(42, "/mute 1d"));
  assert.ok(bot.state.muteUntil > Date.now());
  await bot.handle(priv(42, "/mute off"));
  assert.equal(bot.state.muteUntil, 0);
  sent.length = 0;
  assert.equal(await bot.notify("back"), true);
  assert.equal(sent.length, 1);
});

test("linked chat: /mute with a bad duration does not mute", async () => {
  const { bot } = makeBot();
  await link(bot, 42);
  await bot.handle(priv(42, "/mute soon"));
  assert.equal(bot.state.muteUntil, 0);
});

test("linked chat: /unlink removes the chat", async () => {
  const { bot, sent } = makeBot();
  await link(bot, 42);
  await link(bot, 43);
  sent.length = 0;
  await bot.handle(priv(42, "/unlink"));
  assert.deepEqual(bot.state.chats, ["43"]);
  assert.match(sent[0].body.text, /Disconnected/);
});

test("notify escapes HTML and attaches the dashboard button", async () => {
  const { bot, sent } = makeBot({ chatIds: ["7"] });
  assert.equal(await bot.notify("a < b & c > d"), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, "7");
  assert.equal(sent[0].body.text, "a &lt; b &amp; c &gt; d");
  assert.deepEqual(sent[0].body.reply_markup, {
    inline_keyboard: [[{ text: "Open dashboard", url: "https://example.test/dash" }]],
  });
});

test("notify returns false when there are no linked chats", async () => {
  const { bot, sent } = makeBot();
  assert.equal(await bot.notify("hello"), false);
  assert.equal(await bot.notify("hello", { force: true }), false);
  assert.equal(sent.length, 0);
});

test("chatIds from the constructor are linked (deduplicated, as strings)", () => {
  const { bot } = makeBot({ chatIds: [7, "8", "7", "", null] });
  assert.deepEqual(bot.state.chats, ["7", "8"]);
  assert.equal(bot.linked, true);
});

test("state reloads from telegram.json in a new instance", async () => {
  const { bot, dir } = makeBot();
  await link(bot, 42);
  await bot.handle(priv(42, "/mute 1h"));
  const muteUntil = bot.state.muteUntil;

  const { bot: reloaded } = makeBot({ dir });
  assert.deepEqual(reloaded.state.chats, ["42"]);
  assert.equal(reloaded.state.muteUntil, muteUntil);
  assert.equal(reloaded.linked, true);
});

import { dueReports } from "../src/telegram_bot.js";

const utc = (s) => Date.parse(s);

test("dueReports: daily from 09:00 Tehran, once per date, skipped after 12:00", () => {
  assert.equal(dueReports(utc("2026-10-09T05:29:00Z"), {}).daily, false); // 08:59 Tehran
  const d = dueReports(utc("2026-10-09T05:31:00Z"), {});
  assert.equal(d.daily, true);
  assert.equal(d.tehranDate, "2026-10-09");
  assert.equal(dueReports(utc("2026-10-09T05:31:00Z"), { lastDaily: "2026-10-09" }).daily, false);
  assert.equal(dueReports(utc("2026-10-09T09:00:00Z"), {}).daily, false); // 12:30 Tehran
  assert.equal(dueReports(utc("2026-10-09T21:00:00Z"), {}).tehranDate, "2026-10-10"); // past Tehran midnight
});

test("dueReports: weekly on Friday from 20:00 Tehran", () => {
  assert.equal(dueReports(utc("2026-10-09T16:31:00Z"), {}).weekly, true); // Fri 20:01
  assert.equal(dueReports(utc("2026-10-09T16:31:00Z"), { lastWeekly: "2026-10-09" }).weekly, false);
  assert.equal(dueReports(utc("2026-10-09T16:29:00Z"), {}).weekly, false); // 19:59
  assert.equal(dueReports(utc("2026-10-10T16:31:00Z"), {}).weekly, false); // Saturday
});

test("report commands: /report, /week, /reports on|off", async () => {
  const { bot, sent } = makeBot();
  await link(bot, 7);
  sent.length = 0;
  await bot.handle(priv(7, "/report"));
  assert.match(sent[0].body.text, /Reports aren't set up/);
  bot.reportFns = { daily: async () => "DAILY", weekly: async () => "WEEKLY" };
  await bot.handle(priv(7, "/report"));
  await bot.handle(priv(7, "/week"));
  assert.equal(sent[1].body.text, "DAILY");
  assert.equal(sent[2].body.text, "WEEKLY");
  await bot.handle(priv(7, "/reports off"));
  assert.equal(bot.state.reports, false);
  await bot.handle(priv(7, "/reports on"));
  assert.equal(bot.state.reports, true);
  bot.reportFns.daily = async () => {
    throw new Error("boom");
  };
  const err = console.error;
  console.error = () => {};
  await bot.handle(priv(7, "/report"));
  console.error = err;
  await bot.handle(priv(7, "/help"));
  assert.match(sent.at(-1).body.text, /\/report /);
});

test("report commands ignore unlinked chats", async () => {
  const { bot, sent } = makeBot();
  bot.reportFns = { daily: async () => "DAILY", weekly: async () => "W" };
  await bot.handle(priv(9, "/report"));
  assert.match(sent[0].body.text, /private/);
});
