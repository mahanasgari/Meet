import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PART_MAX_AGE_MS = 6 * 3600e3;

export class DiskCache {
  constructor(dir, { maxBytes = 3 * 1024 ** 3 } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    mkdirSync(dir, { recursive: true });
  }

  static validId(id) {
    return typeof id === "string" && ID_RE.test(id);
  }

  #checkId(id) {
    if (!DiskCache.validId(id)) throw new Error(`invalid video id: ${id}`);
  }

  path(id) {
    this.#checkId(id);
    return join(this.dir, `${id}.m4a`);
  }

  has(id) {
    if (!DiskCache.validId(id)) return false;
    const p = this.path(id);
    return existsSync(p) && statSync(p).size > 0;
  }

  tmpPath(id) {
    this.#checkId(id);
    return join(this.dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  }

  commit(tmp, id) {
    const final = this.path(id);
    renameSync(tmp, final);
    this.evict();
    return final;
  }

  discard(tmp) {
    rmSync(tmp, { force: true });
  }

  touch(id) {
    try {
      const now = new Date();
      utimesSync(this.path(id), now, now);
    } catch {
      // ignore: file may be gone or id invalid
    }
  }

  #entries(suffix) {
    let names;
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const p = join(this.dir, name);
      try {
        const st = statSync(p);
        if (st.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
    return out;
  }

  evict() {
    let removed = 0;
    let bytes = 0;
    const now = Date.now();

    for (const part of this.#entries(".part")) {
      if (now - part.mtimeMs > PART_MAX_AGE_MS) {
        try {
          rmSync(part.path, { force: true });
          removed++;
          bytes += part.size;
        } catch {
          // ignore
        }
      }
    }

    const files = this.#entries(".m4a");
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > this.maxBytes) {
      const target = this.maxBytes * 0.9;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files) {
        if (total <= target) break;
        try {
          rmSync(f.path, { force: true });
          total -= f.size;
          removed++;
          bytes += f.size;
        } catch {
          // ignore
        }
      }
    }
    return { removed, bytes };
  }

  stats() {
    const files = this.#entries(".m4a");
    return {
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      maxBytes: this.maxBytes,
    };
  }
}

// Returns {start, end} (inclusive), null when the header is absent/invalid/multi-range,
// or "unsatisfiable".
export function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;

  if (a === "") {
    // suffix range: last n bytes
    const n = Number(b);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  if (b === "") return { start, end: size - 1 };

  const end = Number(b);
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function serveFile(req, res, filePath, { mime = "audio/mp4", extraHeaders = {} } = {}) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    res.writeHead(404, { "Cache-Control": "no-store", ...extraHeaders });
    res.end();
    return;
  }

  const base = {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    ...extraHeaders,
  };
  const range = parseRange(req.headers.range, size);

  if (range === "unsatisfiable") {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
    res.end();
    return;
  }

  let status = 200;
  let start = 0;
  let end = size - 1;
  const headers = { ...base };
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);

  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
