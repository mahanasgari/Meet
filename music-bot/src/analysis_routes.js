// /analysis/*: analyzer containers lease songs from home, fetch the stored
// audio and post results. Same credential as the archive workers.

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Handles one /analysis/ request; always answers [res].
 * [isMaster] says whether the caller used MUSIC_API_TOKEN.
 */
export async function handleAnalysis({ req, res, url, catalog, archive, isMaster, readBody, sendJson, now = Date.now }) {
  if (!isMaster) return sendJson(res, 401, { error: "unauthorized" });
  if (!catalog) return sendJson(res, 404, { error: "no_archive" });
  const path = url.pathname;
  if (req.method === "GET" && path === "/analysis/audio") {
    const id = String(url.searchParams.get("id") || "").replace(/^yt_/, "");
    if (!ID.test(id)) return sendJson(res, 400, { error: "invalid_id" });
    if (!archive || !(await archive.serveForAnalysis(req, res, id))) sendJson(res, 404, { error: "not_stored" });
    return;
  }
  if (req.method === "POST" && (path === "/analysis/lease" || path === "/analysis/result")) {
    const body = await readBody(req, 100_000).catch(() => ({}));
    const server = String(req.headers["x-mp-server"] || body.server || "analyzer").slice(0, 40);
    if (path === "/analysis/lease") return sendJson(res, 200, { jobs: catalog.leaseAnalysis(server, body.n, now()) });
    const id = String(body.videoId || "");
    if (!ID.test(id)) return sendJson(res, 400, { error: "invalid_id" });
    try {
      if (body.error) catalog.saveAnalysisError(id, body.error, now());
      else catalog.saveAnalysis(id, body, server, now());
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message).startsWith("invalid_") ? e.message : "invalid_result" });
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: "not_found" });
}
