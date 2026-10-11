import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { PROBE_DEFAULTS, probeSummary, runProbes } from "../src/probes.js";

const rep = (s, n) => Array(n).fill(`"${s}"`).join(",");
function server(mode) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const u = req.url;
      if (mode === "hang") return; // never answer
      if (u.startsWith("/search")) {
        const n = mode === "good" ? 9 : 2;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ id: i })) }));
      }
      if (u.startsWith("/ytm/browse")) {
        return res.end(mode === "good" ? `[${rep("musicResponsiveListItemRenderer", 10)}]` : "This user doesn't have any public YouTube Music content");
      }
      if (u.startsWith("/ytm/next")) return res.end(`[${rep("playlistPanelVideoRenderer", mode === "good" ? 30 : 5)}]`);
      if (u.startsWith("/audio")) {
        if (mode !== "good") {
          res.statusCode = 502;
          return res.end("bad");
        }
        res.statusCode = 206;
        res.setHeader("x-mp-source", "test");
        return res.end(Buffer.alloc(65536));
      }
      res.statusCode = 404;
      res.end();
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("good server passes every probe", async () => {
  const { srv, url } = await server("good");
  try {
    const r = await runProbes(url, { token: "t" });
    assert.deepEqual(probeSummary(r), { ok: true, failing: [] });
    assert.equal(r.search.detail, "9 results");
    assert.equal(r.artist.detail, "10 items");
    assert.equal(r.next.detail, "30 up-next");
    assert.equal(r.audio.detail, "64 KB via test");
  } finally {
    srv.close();
  }
});

test("bad server fails every probe with details", async () => {
  const { srv, url } = await server("bad");
  try {
    const r = await runProbes(url, { token: "t" });
    assert.deepEqual(probeSummary(r).failing, ["search", "artist", "next", "audio"]);
    assert.equal(r.search.detail, "2 results");
    assert.equal(r.artist.detail, "empty artist page");
    assert.equal(r.next.detail, "5 up-next");
    assert.equal(r.audio.detail, "HTTP 502");
  } finally {
    srv.close();
  }
});

test("hanging server times out without throwing", async () => {
  const { srv, url } = await server("hang");
  try {
    const r = await runProbes(url, { token: "t", timeoutMs: 150 });
    for (const k of ["search", "artist", "next", "audio"]) {
      assert.equal(r[k].ok, false);
      assert.equal(r[k].detail, "timeout");
    }
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("unreachable server never throws; defaults exported", async () => {
  const r = await runProbes("http://127.0.0.1:1", { token: "t", timeoutMs: 500 });
  assert.equal(probeSummary(r).ok, false);
  assert.equal(PROBE_DEFAULTS.query, "Sogand");
});

test("probeSummary", () => {
  assert.deepEqual(probeSummary({ search: { ok: true }, artist: { ok: false }, next: { ok: true }, audio: { ok: true } }), {
    ok: false,
    failing: ["artist"],
  });
});
