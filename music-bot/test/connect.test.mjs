import { test } from "node:test";
import assert from "node:assert/strict";
import { Connect } from "../src/connect.js";

test("an account's devices see each other; other accounts don't", () => {
  let now = 1000;
  const c = new Connect({ now: () => now });
  c.hello("u1", { id: "phone", name: "Phone", platform: "android" });
  c.hello("u1", { id: "pc", name: "PC", platform: "linux", state: { playing: true, track: { id: "yt_x", title: "Separ" } } });
  c.hello("u2", { id: "other", name: "Not mine" });
  assert.deepEqual(c.devices("u1", "phone").map((d) => d.name), ["PC"]);
  assert.equal(c.devices("u1", "phone")[0].state.track.title, "Separ");
  now += 50_000;
  c.hello("u1", { id: "phone", name: "Phone" });
  assert.deepEqual(c.devices("u1", "phone"), [], "a device that stopped polling is gone");
});

test("a command reaches only its device, and stays until the next poll says it arrived", async () => {
  const c = new Connect();
  c.hello("u1", { id: "phone" });
  c.hello("u1", { id: "pc" });
  assert.equal(c.send("u1", "phone", "pc", "pause"), true);
  assert.equal(c.send("u1", "phone", "tv", "pause"), false, "not online");
  assert.equal(c.send("u1", "phone", "pc", "format-disk"), false, "unknown command");
  const r = await c.poll("u1", "pc", { waitMs: 0 });
  assert.deepEqual(r.commands.map((x) => x.cmd), ["pause"]);
  const again = await c.poll("u1", "pc", { waitMs: 0 });
  assert.equal(again.commands.length, 1, "not confirmed yet: sent again");
  const after = await c.poll("u1", "pc", { since: r.commands[0].seq, waitMs: 0 });
  assert.equal(after.commands.length, 0);
  assert.equal((await c.poll("u1", "phone", { waitMs: 0 })).commands.length, 0);
});

test("a waiting poll answers as soon as a command comes", async () => {
  const c = new Connect();
  c.hello("u1", { id: "phone" });
  c.hello("u1", { id: "pc" });
  const t = Date.now();
  const waiting = c.poll("u1", "pc", { waitMs: 5000 });
  setTimeout(() => c.send("u1", "phone", "pc", "transfer", { index: 2 }), 50);
  const r = await waiting;
  assert.equal(r.commands[0].cmd, "transfer");
  assert.equal(r.commands[0].args.index, 2);
  assert.ok(Date.now() - t < 1000);
});

test("a waiting poll also answers when another device's playing changes", async () => {
  const c = new Connect();
  c.hello("u1", { id: "phone" });
  c.hello("u1", { id: "pc", state: { playing: false } });
  const first = await c.poll("u1", "phone", { waitMs: 0 });
  const waiting = c.poll("u1", "phone", { waitMs: 5000, known: first.key });
  setTimeout(() => c.hello("u1", { id: "pc", state: { playing: true } }), 30);
  const r = await waiting;
  assert.equal(r.devices[0].state.playing, true);
});
