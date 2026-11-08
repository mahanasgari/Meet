// Mirrors have no catalog or accounts: requests only the home server can
// answer are forwarded there, so phones that can't reach home's domain
// still work through any mirror.
import { Readable } from "node:stream";

const HOME_ONLY = [
  /^\/invite\/redeem$/,
  /^\/app\/(latest|servers)\.json$/,
  /^\/app\/files\//,
  /^\/releases$/,
  /^\/chords$/,
  /^\/song\/info$/,
  /^\/song\/related$/,
  /^\/artists\/search$/,
  /^\/search\/smart$/,
  /^\/song\/links$/,
  /^\/mood\/(songs|vote)$/,
  /^\/share\/song$/,
  /^\/s\/[A-Za-z2-9]{8}(\/(audio|cover))?$/, // song links only
  /^\/recommend(\/|$)/,
  /^\/account\//,
  /^\/reports$/,
  // Kept on home so every server sees the same ones: shared playlist codes,
  // feedback, the weekly chart (built from home's listeners), cloud sync.
  /^\/share$/,
  /^\/share\/[A-Za-z0-9]{6}$/,
  /^\/feedback$/,
  /^\/charts\/weekly$/,
  /^\/sync\/(events|user)$/,
  /^\/explore(\/|$)/, // public playlists
];

export const isHomeOnlyPath = (pathname) => HOME_ONLY.some((re) => re.test(String(pathname || "")));

const COPY_REQ = ["authorization", "content-type", "content-encoding", "range", "x-mp-context"];
const COPY_RES = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "content-disposition",
];

/** Headers to send home; X-MP-User only counts when the master token was used. */
export function forwardHeaders(req, { isMaster, ip }) {
  const h = {};
  for (const k of COPY_REQ) if (req.headers[k]) h[k] = String(req.headers[k]);
  if (isMaster && req.headers["x-mp-user"]) h["x-mp-user"] = String(req.headers["x-mp-user"]);
  if (ip) h["x-forwarded-for"] = ip;
  return h;
}

/**
 * Proxy [req] to homeUrl + path + query. Always answers [res]; resolves true.
 * 502 {error:"home_unreachable"} when home doesn't answer or the body is too big.
 */
export async function proxyToHome({ fetchImpl = fetch, homeUrl, req, res, url, isMaster, ip, bodyLimit = 3_000_000, timeoutMs = 30_000 }) {
  const fail = () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "home_unreachable" }));
  };
  try {
    const init = {
      method: req.method,
      headers: forwardHeaders(req, { isMaster, ip }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > bodyLimit) return fail(), true;
        chunks.push(c);
      }
      init.body = Buffer.concat(chunks);
    }
    const r = await fetchImpl(homeUrl + url.pathname + url.search, init);
    const out = {};
    for (const k of COPY_RES) {
      const v = r.headers.get(k);
      if (v) out[k] = v;
    }
    res.writeHead(r.status, out);
    if (!r.body || req.method === "HEAD") {
      res.end();
      return true;
    }
    // Stream so big files start at once; a mid-stream failure cuts the socket.
    Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
  } catch {
    fail();
  }
  return true;
}
