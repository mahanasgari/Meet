import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SongLinks, renderSongPage, LINK_TTL_MS } from "../src/song_links.js";

const ID = "r6qM8uSNjjU";
const tmp = () => mkdtempSync(join(tmpdir(), "links-"));

test("a link plays one song, is case-insensitive, and reuses the same code for the same sharer", () => {
  const dir = tmp();
  let now = 1_000_000;
  const links = new SongLinks({ file: join(dir, "l.json"), now: () => now });
  const code = links.create({ id: ID, title: " SEPAR (Shield) ", artist: "Reza Pishro, Tech N9ne & Yas", by: "u1" });
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.deepEqual(links.get(code.toLowerCase()), { id: ID, title: "SEPAR (Shield)", artist: "Reza Pishro, Tech N9ne & Yas", by: "u1", at: now });
  assert.equal(links.create({ id: ID, title: "x", by: "u1" }), code, "same sharer, same song: same link");
  assert.notEqual(links.create({ id: ID, title: "x", by: "u2" }), code);
  assert.equal(links.create({ id: "../etc/pass", title: "x" }), null);
  assert.equal(links.get("short"), null);
  assert.equal(links.get("ZZZZZZZZ"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("links expire after 90 days; sharing again renews", () => {
  const dir = tmp();
  let now = 1_000_000;
  const links = new SongLinks({ file: join(dir, "l.json"), now: () => now });
  const code = links.create({ id: ID, title: "T", by: "u1" });
  now += LINK_TTL_MS - 1000;
  assert.ok(links.get(code));
  assert.equal(links.create({ id: ID, title: "T", by: "u1" }), code);
  now += LINK_TTL_MS - 1000;
  assert.ok(links.get(code), "renewed");
  now += 2000;
  assert.equal(links.get(code), null);
  rmSync(dir, { recursive: true, force: true });
});

test("links survive a restart", async () => {
  const dir = tmp();
  const file = join(dir, "l.json");
  const a = new SongLinks({ file });
  const code = a.create({ id: ID, title: "T", artist: "A" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(JSON.parse(readFileSync(file, "utf8"))[code]);
  assert.equal(new SongLinks({ file }).get(code).id, ID);
  rmSync(dir, { recursive: true, force: true });
});

test("the page escapes titles and points at the link's own audio and cover", () => {
  const html = renderSongPage({ id: ID, title: '<script>alert(1)</script>"', artist: "یاس" }, { base: "https://m.example", code: "ABCD2345" });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;"));
  assert.ok(html.includes('src="https://m.example/s/ABCD2345/audio"'));
  assert.ok(html.includes('content="https://m.example/s/ABCD2345/cover"'));
  assert.ok(html.includes("یاس"));
  assert.ok(!/title: "[^"]*<\/script>/.test(html), "no </script> inside the inline script");
});

test("the page offers the app and hands a set-up web app the song", () => {
  const html = renderSongPage({ id: ID, title: "T", artist: "A" }, { base: "https://m.example", code: "ABCD2345" });
  assert.ok(html.includes("location.replace('/?s=ABCD2345')"), "web app users open it in their account");
  assert.ok(html.includes("package=com.miniplayer.mini_player"), "Android: the app");
  assert.ok(html.includes("'miniplayer://s/' + code"), "PC: the app's own link");
});

test("App Links file names the app and its certificate", async () => {
  const { assetLinks, fingerprint } = await import("../src/song_links.js");
  const fp = fingerprint("bdfecdbc85796c068a5481f86f167923948023bc4f6f5041846d7571e23573cc");
  assert.match(fp, /^BD:FE:CD:BC:(?:[0-9A-F]{2}:){27}CC$/);
  assert.equal(fingerprint("nope"), null);
  const [e] = assetLinks([fp]);
  assert.equal(e.target.package_name, "com.miniplayer.mini_player");
  assert.deepEqual(e.target.sha256_cert_fingerprints, [fp]);
});
