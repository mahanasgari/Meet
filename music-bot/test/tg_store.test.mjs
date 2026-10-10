import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TgStore } from "../src/tg_store.js";

const bigInt = (n) => ({ toJSNumber: () => Number(n), valueOf: () => Number(n) });
class AudioAttr { constructor(o) { Object.assign(this, o); } }
const Api = { DocumentAttributeAudio: AudioAttr };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFake(opts = {}) {
  const file = opts.file || randomBytes(300_000);
  const f = {
    file, calls: { start: 0, getEntity: 0, sendFile: [], getMessages: 0, iter: [], del: [] },
    session: { save: () => "SESSION-ABC" },
    failRefAt: opts.failRefAt ?? null, failedRef: false,
    sendFailures: opts.sendFailures || [],
    async start() {
      f.calls.start++; await sleep(10);
      if (opts.startFail && f.calls.start <= opts.startFail) throw new Error("boom");
    },
    async getEntity(id) { f.calls.getEntity++; return { id, title: "chan" }; },
    async sendFile(peer, o) {
      f.calls.sendFile.push({ t: Date.now(), o }); await sleep(5);
      if (f.sendFailures.length) throw f.sendFailures.shift();
      return { id: 42, media: { document: { size: file.length, mimeType: "audio/mp4" } } };
    },
    async getMessages() { f.calls.getMessages++; return [{ id: 7, media: { document: { size: file.length, mimeType: "audio/mp4" }, v: f.calls.getMessages } }]; },
    async *iterDownload({ offset, requestSize, limit }) {
      const off = Number(offset.toJSNumber ? offset.toJSNumber() : offset.valueOf());
      assert.equal(off % 4096, 0); assert.equal(requestSize % 4096, 0); assert.equal((1024 * 1024) % requestSize, 0);
      f.calls.iter.push({ off, requestSize, limit });
      let n = 0;
      for (let p = off; p < file.length && (limit === undefined || n < limit); p += requestSize, n++) {
        if (f.failRefAt !== null && !f.failedRef && p >= f.failRefAt) {
          f.failedRef = true;
          throw Object.assign(new Error("x"), { errorMessage: "FILE_REFERENCE_EXPIRED" });
        }
        yield file.subarray(p, Math.min(p + requestSize, file.length));
      }
    },
    async deleteMessages(peer, ids, o) { f.calls.del.push({ ids, o }); },
    async disconnect() { f.disconnected = true; },
  };
  return f;
}

function store(fake, extra = {}) {
  const dir = extra.dir || mkdtempSync(join(tmpdir(), "tgs-"));
  const seen = [];
  const s = new TgStore({
    apiId: 1, apiHash: "h", botToken: "TOKEN", channelId: -1001, sessionFile: join(dir, "sess"),
    minUploadIntervalMs: 50, floodPadMs: 0, log: { warn() {}, log() {}, error() {} }, bigInt, Api,
    clientFactory: (sess) => { seen.push(sess); return fake; }, ...extra,
  });
  return { s, dir, seen };
}
const collect = async (gen) => Buffer.concat(await Array.fromAsync(gen));

test("connect is single-flight and saves session; second instance reuses it", async () => {
  const fake = makeFake();
  const { s, dir, seen } = store(fake);
  assert.equal(s.ready, false);
  await Promise.all([s.connect(), s.connect(), s.connect()]);
  assert.equal(fake.calls.start, 1);
  assert.equal(s.ready, true);
  assert.equal(readFileSync(join(dir, "sess"), "utf8"), "SESSION-ABC");
  assert.equal(statSync(join(dir, "sess")).mode & 0o777, 0o600);
  assert.deepEqual(seen, [""]);
  const { seen: seen2 } = store(makeFake(), { dir });
  const s2 = new TgStore({ sessionFile: join(dir, "sess"), clientFactory: (x) => { seen2.push(x); return makeFake(); }, bigInt, Api });
  await s2.connect();
  assert.deepEqual(seen2, ["SESSION-ABC"]);
});

test("uploadAudio serializes, respects min interval, returns size/mime", async () => {
  const fake = makeFake();
  const { s } = store(fake);
  const rs = await Promise.all([1, 2, 3].map(() => s.uploadAudio("/x.m4a", { title: "T", artist: "A", durationS: 3.4, caption: "c" })));
  assert.deepEqual(rs[0], { msgId: 42, size: 300_000, mime: "audio/mp4" });
  const t = fake.calls.sendFile.map((c) => c.t);
  assert.equal(t.length, 3);
  assert.ok(t[1] - t[0] >= 45 && t[2] - t[1] >= 45, `gaps ${t[1] - t[0]} ${t[2] - t[1]}`);
  const o = fake.calls.sendFile[0].o;
  assert.equal(o.attributes[0].title, "T"); assert.equal(o.attributes[0].performer, "A"); assert.equal(o.attributes[0].duration, 3);
});

test("uploadAudio retries on FloodWait", async () => {
  const fake = makeFake({ sendFailures: [{ seconds: 0, errorMessage: "FLOOD_WAIT_0" }] });
  const { s } = store(fake);
  const r = await s.uploadAudio("/x.m4a", { title: "T" });
  assert.equal(r.msgId, 42);
  assert.equal(fake.calls.sendFile.length, 2);
});

test("uploadAudio gives up after 3 flood retries and non-flood errors throw", async () => {
  const fl = () => ({ seconds: 0, errorMessage: "FLOOD_WAIT_0" });
  const f1 = makeFake({ sendFailures: [fl(), fl(), fl(), fl()] });
  await assert.rejects(store(f1).s.uploadAudio("/x", {}), /upload failed/);
  assert.equal(f1.calls.sendFile.length, 4);
  const f2 = makeFake({ sendFailures: [new Error("nope")] });
  await assert.rejects(store(f2).s.uploadAudio("/x", {}), /nope/);
  assert.equal(f2.calls.sendFile.length, 1);
});

test("read: whole file, exact slice, clamped, and size/mime", async () => {
  const fake = makeFake();
  const { s } = store(fake);
  const h = await s.open(7);
  assert.equal(h.size, 300_000); assert.equal(h.mime, "audio/mp4");
  assert.ok((await collect(h.read(0))).equals(fake.file));
  assert.ok((await collect(h.read(70_001, 50_000))).equals(fake.file.subarray(70_001, 120_001)));
  assert.ok((await collect(h.read(299_000, 99_999))).equals(fake.file.subarray(299_000)));
  assert.equal((await collect(h.read(400_000))).length, 0);
  assert.ok((await collect(h.read(262_141, 7))).equals(fake.file.subarray(262_141, 262_148)));
});

test("read crossing chunk boundary with 512KiB chunks on larger file", async () => {
  const file = randomBytes(1_500_000);
  const fake = makeFake({ file });
  const { s } = store(fake);
  const h = await s.open(7);
  assert.ok((await collect(h.read(524_000, 2_000))).equals(file.subarray(524_000, 526_000)));
  assert.ok((await collect(h.read(0))).equals(file));
});

test("FILE_REFERENCE_EXPIRED mid-stream refetches and resumes", async () => {
  const file = randomBytes(1_500_000);
  const fake = makeFake({ file, failRefAt: 524_288 });
  const { s } = store(fake);
  const h = await s.open(7);
  const out = await collect(h.read(10, Infinity));
  assert.ok(out.equals(file.subarray(10)));
  assert.equal(fake.calls.getMessages, 2);
  assert.equal(fake.failedRef, true);
});

test("message lookups are cached", async () => {
  const fake = makeFake();
  const { s } = store(fake);
  await s.open(7); await s.open(7);
  assert.equal(fake.calls.getMessages, 1);
});

test("cache expires after 30 minutes", async () => {
  const fake = makeFake();
  let t = 1_000_000;
  const { s } = store(fake, { now: () => t });
  await s.open(7); t += 31 * 60_000; await s.open(7);
  assert.equal(fake.calls.getMessages, 2);
});

test("delete revokes message", async () => {
  const fake = makeFake();
  const { s } = store(fake);
  await s.delete(7);
  assert.deepEqual(fake.calls.del[0], { ids: [7], o: { revoke: true } });
  await s.close();
  assert.equal(fake.disconnected, true);
});

test("connect failure: retry gated by 30s gap, token never in error", async () => {
  const fake = makeFake({ startFail: 1 });
  let t = 5_000;
  const { s } = store(fake, { now: () => t });
  await assert.rejects(s.connect(), /connect failed/);
  assert.equal(s.ready, false);
  t += 10_000;
  await assert.rejects(s.connect(), (e) => /unavailable/.test(e.message) && !e.message.includes("TOKEN"));
  assert.equal(fake.calls.start, 1);
  t += 21_000;
  await s.connect();
  assert.equal(fake.calls.start, 2);
  assert.equal(s.ready, true);
});
