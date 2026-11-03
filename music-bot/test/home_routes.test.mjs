import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { forwardHeaders, isHomeOnlyPath, proxyToHome } from "../src/home_routes.js";

test("home-only paths", () => {
  for (const p of ["/invite/redeem", "/app/latest.json", "/app/servers.json", "/app/files/x.apk", "/releases", "/chords",
    "/song/info", "/share/song", "/s/ABCD2345", "/s/ABCD2345/audio", "/recommend", "/recommend/similar", "/account/login", "/reports", "/artists/search", "/search/smart", "/song/links", "/mood/songs"])
    assert.ok(isHomeOnlyPath(p), p);
  for (const p of ["/health", "/app/revoked.json", "/share", "/stream", "/jam", "/recommendx", "/releases/x", "/account", "/sx", "/s/player/base.js"])
    assert.ok(!isHomeOnlyPath(p), p);
});

test("X-MP-User only forwarded for the master token", () => {
  const req = { headers: { authorization: "Bearer t", "x-mp-user": "aaaaaaaaaaaa", range: "bytes=0-1", cookie: "no" } };
  assert.equal(forwardHeaders(req, { isMaster: false, ip: "1.2.3.4" })["x-mp-user"], undefined);
  const h = forwardHeaders(req, { isMaster: true, ip: "1.2.3.4" });
  assert.equal(h["x-mp-user"], "aaaaaaaaaaaa");
  assert.equal(h["x-forwarded-for"], "1.2.3.4");
  assert.equal(h.cookie, undefined);
});

const fakeRes = () => {
  const r = { chunks: [], writeHead(s, h) { r.status = s; r.headers = h; r.headersSent = true; }, end(b) { if (b) r.chunks.push(Buffer.from(b)); r.done = true; r.emit?.("finish"); },
    write(b) { r.chunks.push(Buffer.from(b)); return true; }, on() { return r; }, once() { return r; }, emit() {}, destroy() { r.destroyed = true; } };
  return r;
};

test("proxy forwards body and copies the answer", async () => {
  const req = Readable.from([Buffer.from('{"a":1}')]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  let seen;
  const fetchImpl = async (u, init) => {
    seen = { u, init };
    return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json", "x-other": "z" } });
  };
  const res = fakeRes();
  await proxyToHome({ fetchImpl, homeUrl: "https://home", req, res, url: new URL("http://x/account/login?q=1"), isMaster: false, ip: "9.9.9.9" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.u, "https://home/account/login?q=1");
  assert.equal(seen.init.body.toString(), '{"a":1}');
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers, { "content-type": "application/json" });
});

test("proxy answers 502 when home is down", async () => {
  const req = Readable.from([]);
  req.method = "GET";
  req.headers = {};
  const res = fakeRes();
  await proxyToHome({ fetchImpl: async () => { throw new Error("down"); }, homeUrl: "https://home", req, res, url: new URL("http://x/releases") });
  assert.equal(res.status, 502);
  assert.equal(res.chunks.toString(), '{"error":"home_unreachable"}');
});
