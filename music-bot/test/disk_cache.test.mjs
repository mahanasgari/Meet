import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiskCache, parseRange, serveFile } from "../src/disk_cache.js";

const ID = "dQw4w9WgXcQ";
const ID2 = "aaaaaaaaaaa";
const HOUR = 3600e3;

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSong(cache, id, bytes, mtimeMs = Date.now()) {
  const p = cache.path(id);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  const t = new Date(mtimeMs);
  utimesSync(p, t, t);
  return p;
}

test("validId accepts 11-char YouTube ids only", () => {
  assert.equal(DiskCache.validId(ID), true);
  assert.equal(DiskCache.validId("abc_-DEF123"), true);
  assert.equal(DiskCache.validId("short"), false);
  assert.equal(DiskCache.validId("toolongtoolong1"), false);
  assert.equal(DiskCache.validId("bad/chars!!"), false);
  assert.equal(DiskCache.validId(undefined), false);
});

test("path rejects invalid ids and constructor creates the dir", () => {
  const dir = join(tmpDir("dc-"), "nested", "cache");
  const cache = new DiskCache(dir);
  assert.ok(statSync(dir).isDirectory());
  assert.equal(cache.path(ID), join(dir, `${ID}.m4a`));
  assert.throws(() => cache.path("../etc/passwd"));
});

test("commit moves tmp into place; has and touch work", () => {
  const cache = new DiskCache(tmpDir("dc-"));
  assert.equal(cache.has(ID), false);

  const tmp = cache.tmpPath(ID);
  assert.match(tmp, /\.part$/);
  writeFileSync(tmp, Buffer.from("hello audio"));
  const final = cache.commit(tmp, ID);

  assert.equal(final, cache.path(ID));
  assert.equal(existsSync(tmp), false);
  assert.equal(cache.has(ID), true);
  assert.equal(readFileSync(final, "utf8"), "hello audio");

  const old = new Date(Date.now() - 10 * HOUR);
  utimesSync(final, old, old);
  cache.touch(ID);
  assert.ok(statSync(final).mtimeMs > old.getTime() + HOUR);
  cache.touch("not-a-valid-id!"); // must not throw
});

test("has is false for zero-byte files", () => {
  const cache = new DiskCache(tmpDir("dc-"));
  writeFileSync(cache.path(ID), "");
  assert.equal(cache.has(ID), false);
});

test("discard removes a tmp file and ignores missing ones", () => {
  const cache = new DiskCache(tmpDir("dc-"));
  const tmp = cache.tmpPath(ID);
  writeFileSync(tmp, "x");
  cache.discard(tmp);
  assert.equal(existsSync(tmp), false);
  cache.discard(tmp);
});

test("evict removes oldest-mtime files down to 90% of maxBytes", () => {
  const now = Date.now();
  const cache = new DiskCache(tmpDir("dc-"), { maxBytes: 1000 });
  // 5 files x 300 bytes = 1500 > 1000. Target = 900 -> must drop until <= 900.
  writeSong(cache, "AAAAAAAAAA1", 300, now - 5 * HOUR); // oldest
  writeSong(cache, "AAAAAAAAAA2", 300, now - 4 * HOUR);
  writeSong(cache, "AAAAAAAAAA3", 300, now - 3 * HOUR);
  writeSong(cache, "AAAAAAAAAA4", 300, now - 2 * HOUR);
  writeSong(cache, "AAAAAAAAAA5", 300, now - 1 * HOUR); // newest

  const result = cache.evict();
  assert.deepEqual(result, { removed: 2, bytes: 600 });
  assert.equal(existsSync(cache.path("AAAAAAAAAA1")), false);
  assert.equal(existsSync(cache.path("AAAAAAAAAA2")), false);
  assert.equal(existsSync(cache.path("AAAAAAAAAA3")), true);
  assert.equal(existsSync(cache.path("AAAAAAAAAA4")), true);
  assert.equal(existsSync(cache.path("AAAAAAAAAA5")), true);
  assert.deepEqual(cache.stats(), { files: 3, bytes: 900, maxBytes: 1000 });
});

test("evict does nothing when under the cap", () => {
  const cache = new DiskCache(tmpDir("dc-"), { maxBytes: 1000 });
  writeSong(cache, ID, 1000);
  assert.deepEqual(cache.evict(), { removed: 0, bytes: 0 });
  assert.equal(cache.has(ID), true);
});

test("commit triggers eviction", () => {
  const cache = new DiskCache(tmpDir("dc-"), { maxBytes: 100 });
  writeSong(cache, ID2, 90, Date.now() - HOUR);
  const tmp = cache.tmpPath(ID);
  writeFileSync(tmp, Buffer.alloc(50));
  cache.commit(tmp, ID);
  assert.equal(cache.has(ID2), false);
  assert.equal(cache.has(ID), true);
});

test("evict removes stale .part files older than 6 hours only", () => {
  const cache = new DiskCache(tmpDir("dc-"));
  const stale = join(cache.dir, `.${ID}.123.abcd.part`);
  const fresh = join(cache.dir, `.${ID2}.123.abcd.part`);
  writeFileSync(stale, "partial");
  writeFileSync(fresh, "partial");
  const seven = new Date(Date.now() - 7 * HOUR);
  utimesSync(stale, seven, seven);

  const result = cache.evict();
  assert.equal(result.removed, 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("parseRange handles every supported form", () => {
  const size = 100;
  assert.equal(parseRange(undefined, size), null);
  assert.equal(parseRange("", size), null);
  assert.equal(parseRange("items=0-1", size), null);
  assert.equal(parseRange("bytes=abc", size), null);
  assert.deepEqual(parseRange("bytes=10-19", size), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=10-", size), { start: 10, end: 99 });
  assert.deepEqual(parseRange("bytes=-20", size), { start: 80, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", size), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=5-500", size), { start: 5, end: 99 });
  assert.equal(parseRange("bytes=100-", size), "unsatisfiable");
  assert.equal(parseRange("bytes=200-300", size), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", size), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-6", size), null);
});

test("serveFile: full, partial, suffix, 416 and HEAD over HTTP", async () => {
  const dir = tmpDir("dc-");
  const file = join(dir, "song.m4a");
  const body = Buffer.from("0123456789".repeat(10)); // 100 bytes
  writeFileSync(file, body);

  const server = createServer((req, res) => serveFile(req, res, file));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  try {
    const full = await fetch(base);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/mp4");
    assert.equal(full.headers.get("content-length"), "100");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);

    const part = await fetch(base, { headers: { Range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 10-19/100");
    assert.equal(part.headers.get("content-length"), "10");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), body.subarray(10, 20));

    const suffix = await fetch(base, { headers: { Range: "bytes=-5" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 95-99/100");
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), body.subarray(95));

    const open = await fetch(base, { headers: { Range: "bytes=90-" } });
    assert.equal(open.status, 206);
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), body.subarray(90));

    const bad = await fetch(base, { headers: { Range: "bytes=500-600" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */100");
    await bad.arrayBuffer();

    const head = await fetch(base, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "100");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
