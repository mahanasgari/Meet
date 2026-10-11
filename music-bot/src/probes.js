// App-like probes: what the app actually does (search, artist page,
// up-next, audio), not just "/health answers".
export const PROBE_DEFAULTS = { query: "Sogand", artistId: "UCf0ZrFvu4ku8P55cnuXHUDw", videoId: "s4KAWd1NXZc" };

const CONTEXT = { client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en" } };
const count = (s, needle) => s.split(needle).length - 1;

async function timed(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ok: !!r.ok, ms: Date.now() - t0, detail: String(r.detail).slice(0, 120) };
  } catch (e) {
    const d = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : String(e?.cause?.code || e?.message || e);
    return { ok: false, ms: Date.now() - t0, detail: d.slice(0, 120) };
  }
}

export async function runProbes(baseUrl, { token, fetchImpl = fetch, opts = PROBE_DEFAULTS, timeoutMs = 25000 } = {}) {
  const o = { ...PROBE_DEFAULTS, ...opts };
  const auth = { Authorization: `Bearer ${token}` };
  const post = (path, body) =>
    fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const search = timed(async () => {
    const r = await fetchImpl(`${baseUrl}/search?q=${encodeURIComponent(o.query)}&limit=10`, {
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status !== 200) {
      await r.arrayBuffer().catch(() => undefined);
      return { ok: false, detail: `HTTP ${r.status}` };
    }
    const j = JSON.parse(await r.text());
    const list = j.results || j.tracks || j.items || [];
    const n = Array.isArray(list) ? list.length : 0;
    return { ok: n >= 5, detail: `${n} results` };
  });

  const artist = timed(async () => {
    const r = await post("/ytm/browse", { context: CONTEXT, browseId: o.artistId });
    const text = await r.text();
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
    if (text.includes("have any public YouTube Music content")) return { ok: false, detail: "empty artist page" };
    const n = count(text, "musicResponsiveListItemRenderer") + count(text, "musicTwoRowItemRenderer");
    return { ok: n >= 5, detail: n >= 5 ? `${n} items` : `${n} items (${Math.round(text.length / 1024)} KB)` };
  });

  const next = timed(async () => {
    const r = await post("/ytm/next", {
      context: CONTEXT,
      videoId: o.videoId,
      playlistId: `RDAMVM${o.videoId}`,
      isAudioOnly: true,
    });
    const text = await r.text();
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
    const n = count(text, "playlistPanelVideoRenderer");
    return { ok: n >= 20, detail: `${n} up-next` };
  });

  const audio = timed(async () => {
    const r = await fetchImpl(
      `${baseUrl}/audio?url=${encodeURIComponent(`https://music.youtube.com/watch?v=${o.videoId}`)}`,
      { headers: { ...auth, Range: "bytes=0-65535" }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (r.status !== 200 && r.status !== 206) {
      await r.body?.cancel().catch(() => undefined);
      return { ok: false, detail: `HTTP ${r.status}` };
    }
    const src = r.headers.get("x-mp-source") || "?";
    let got = 0;
    const reader = r.body.getReader();
    while (got < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
    }
    await reader.cancel().catch(() => undefined);
    return { ok: got >= 32768, detail: `${Math.round(got / 1024)} KB via ${src}` };
  });

  const [s, a, n, au] = await Promise.all([search, artist, next, audio]);
  return { at: new Date().toISOString(), search: s, artist: a, next: n, audio: au };
}

export function probeSummary(p) {
  const failing = ["search", "artist", "next", "audio"].filter((k) => !p?.[k]?.ok);
  return { ok: failing.length === 0, failing };
}
