import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaleStore, BALE_MAX_DOWNLOAD_BYTES } from "../src/bale_store.js";

function makeFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url).replace(/^.*\/bot[^/]+\//, "").replace(/\?.*$/, "");
    const h = handlers[path] || handlers["*"];
    if (!h) throw new Error(`unexpected fetch ${path}`);
    return h(url, init, calls);
  };
  return { fetchFn, calls };
}

function jsonOk(result) {
  return {
    ok: true,
    async text() {
      return JSON.stringify({ ok: true, result });
    },
  };
}

function store(handlers, extra = {}) {
  const { fetchFn, calls } = makeFetch(handlers);
  const s = new BaleStore({
    botToken: "T",
    channelId: "5656853058",
    minUploadIntervalMs: 20,
    fetch: fetchFn,
    log: { warn() {}, log() {}, error() {} },
    ...extra,
  });
  return { s, calls };
}

test("backupChannel key is stable", () => {
  const { s } = store({});
  assert.equal(s.backupChannel, "bale:5656853058");
});

test("connect calls getMe + getChat", async () => {
  const { s, calls } = store({
    getMe: () => jsonOk({ id: 1, username: "bot" }),
    getChat: () => jsonOk({ id: 5656853058, title: "mini player" }),
  });
  assert.equal(s.ready, false);
  await Promise.all([s.connect(), s.connect()]);
  assert.equal(s.ready, true);
  assert.equal(calls.filter((c) => c.url.includes("/getMe")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/getChat")).length, 1);
});

test("uploadAudio posts multipart sendAudio and returns fileId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bale-"));
  const path = join(dir, "a.m4a");
  writeFileSync(path, Buffer.alloc(1200, 1));
  const { s } = store({
    getMe: () => jsonOk({ id: 1 }),
    getChat: () => jsonOk({ id: 9 }),
    sendAudio: () =>
      jsonOk({
        message_id: 7,
        audio: { file_id: "fid-1", file_size: 1200, mime_type: "audio/mp4" },
      }),
  });
  const r = await s.uploadAudio(path, { title: "T", artist: "A", durationS: 3.2, caption: "c" });
  assert.deepEqual(r, { msgId: 7, fileId: "fid-1", size: 1200, mime: "audio/mp4" });
});

test("uploadAudio rejects files over download cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bale-"));
  const path = join(dir, "big.m4a");
  writeFileSync(path, Buffer.alloc(100));
  const { s } = store(
    {
      getMe: () => jsonOk({ id: 1 }),
      getChat: () => jsonOk({ id: 9 }),
    },
    { maxDownloadBytes: 50 },
  );
  // stat size is 100 > 50
  await assert.rejects(s.uploadAudio(path, {}), /download cap/);
});

test("open + read returns bytes (full getFile download)", async () => {
  const body = Buffer.from("hello-bale-audio-bytes!!");
  const { fetchFn, calls } = makeFetch({
    getMe: () => jsonOk({ id: 1 }),
    getChat: () => jsonOk({ id: 9 }),
    getFile: () => jsonOk({ file_id: "fid", file_path: "p/f", file_size: body.length }),
  });
  const realFetch = async (url, init) => {
    if (String(url).includes("/file/bot")) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() {
          return body;
        },
        async text() {
          return "";
        },
      };
    }
    return fetchFn(url, init);
  };
  const s2 = new BaleStore({
    botToken: "T",
    channelId: "1",
    fetch: realFetch,
    log: { warn() {}, log() {}, error() {} },
  });
  const h = await s2.open("fid");
  assert.equal(h.size, body.length);
  const chunks = [];
  for await (const c of h.read(0)) chunks.push(c);
  assert.ok(Buffer.concat(chunks).equals(body));
  const mid = [];
  for await (const c of h.read(6, 4)) mid.push(c);
  assert.ok(Buffer.concat(mid).equals(body.subarray(6, 10)));
  assert.ok(calls.some((c) => String(c.url).includes("/file/bot")));
});

test("BALE_MAX_DOWNLOAD_BYTES is 20 MiB", () => {
  assert.equal(BALE_MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024);
});
