// Catalog copies on every server, kept in step with each other.
//
// Each server records what changes in its own catalog (SQLite sessions:
// one small binary "changeset" per table every few seconds) in an outbox
// next to the catalog. The other servers pull each origin's outbox in
// order and apply it to their copy. Changes a server applies from others
// are not recorded again, so nothing echoes. Where two servers changed
// the same row, the change applied last wins.
//
// Positions are kept in the catalog's meta table (never synced):
//   sync_from:<origin>  = the last outbox seq of <origin> applied here
//                         (for this server's own origin: its own last seq)
// so a copy of the catalog file (backup, snapshot) carries where to go on
// from for every origin.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";

/** Tables never synced: server-local state (job queue, crawl cursors, meta) and the search index (rebuilt locally). */
const LOCAL_TABLES = new Set(["meta", "jobs", "crawl", "sqlite_sequence"]);
const isLocal = (name) => LOCAL_TABLES.has(name) || name.startsWith("search_fts") || name.startsWith("sqlite_");

/** The catalog tables that are synced. */
export function syncTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%PRIMARY KEY%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !isLocal(n));
}

const posKey = (origin) => `sync_from:${origin}`;

/** Position of [origin] in [db] (0 = nothing applied yet). */
export function syncPosition(db, origin) {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(posKey(origin));
  return r ? Number(r.value) || 0 : 0;
}

function setPosition(db, origin, seq) {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(posKey(origin), String(seq));
}

/** All origins [db] has a position for: { origin: seq }. */
export function syncPositions(db) {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'sync_from:%'").all()) {
    out[r.key.slice("sync_from:".length)] = Number(r.value) || 0;
  }
  return out;
}

/**
 * Records this server's catalog changes ([origin]) and applies other
 * servers'. [outFile]: the outbox database (kept [keepMs]).
 */
export class ChangeFeed {
  constructor({ db, outFile, origin, keepMs = 7 * 864e5 }) {
    if (!/^[a-z0-9-]{1,40}$/.test(origin || "")) throw new Error("bad origin");
    this.db = db;
    this.origin = origin;
    this.keepMs = keepMs;
    mkdirSync(dirname(outFile), { recursive: true });
    this.out = new DatabaseSync(outFile);
    this.out.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS out (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tbl TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS out_at ON out(at);`);
    this.tables = syncTables(db);
    this.sessions = [];
    this.#open();
  }

  #open() {
    this.sessions = this.tables.map((t) => [t, this.db.createSession({ table: t })]);
  }

  #close() {
    for (const [, s] of this.sessions) s.close();
    this.sessions = [];
  }

  /** This server's last outbox seq. */
  lastSeq() {
    return this.out.prepare("SELECT COALESCE(MAX(seq), 0) s FROM out").get().s;
  }

  /**
   * Moves the changes made since the last flush into the outbox. Returns
   * how many changesets were written.
   */
  flush(now = Date.now()) {
    // Never in the middle of a transaction (it could still be rolled back).
    if (this.db.isTransaction) return 0;
    const ready = [];
    for (const [t, s] of this.sessions) {
      const data = s.changeset();
      if (data.length) ready.push([t, data]);
    }
    if (!ready.length) return 0;
    // Start counting afresh (a session keeps everything since it opened).
    this.#close();
    this.#open();
    const ins = this.out.prepare("INSERT INTO out(at, tbl, data) VALUES(?, ?, ?)");
    this.out.exec("BEGIN");
    try {
      for (const [t, data] of ready) ins.run(now, t, data);
      this.out.exec("COMMIT");
    } catch (e) {
      this.out.exec("ROLLBACK");
      throw e;
    }
    // A copy of the catalog file then says how far its own changes go.
    setPosition(this.db, this.origin, this.lastSeq());
    return ready.length;
  }

  /** Outbox rows after [since], oldest first, up to about [maxBytes]. */
  read(since, { maxBytes = 4 * 1024 * 1024, maxRows = 2000 } = {}) {
    const rows = [];
    let size = 0;
    for (const r of this.out.prepare("SELECT seq, at, tbl, data FROM out WHERE seq > ? ORDER BY seq LIMIT ?").iterate(Number(since) || 0, maxRows)) {
      if (rows.length && size + r.data.length > maxBytes) break;
      rows.push(r);
      size += r.data.length;
    }
    return rows;
  }

  /** The oldest seq still kept (a peer further behind must start from a fresh copy). */
  firstSeq() {
    return this.out.prepare("SELECT COALESCE(MIN(seq), 0) s FROM out").get().s;
  }

  prune(now = Date.now()) {
    return Number(this.out.prepare("DELETE FROM out WHERE at < ?").run(now - this.keepMs).changes);
  }

  /**
   * Applies [rows] (from [origin]'s outbox, in order) to this catalog.
   * Rows at or before the position already applied are skipped. Returns
   * the new position.
   */
  apply(origin, rows) {
    if (origin === this.origin) throw new Error("own changes");
    let pos = syncPosition(this.db, origin);
    const todo = rows.filter((r) => Number(r.seq) > pos).sort((a, b) => a.seq - b.seq);
    if (!todo.length) return pos;
    // Local changes so far go out first; while applying, nothing is
    // recorded (so others' changes never echo back out from here).
    this.flush();
    this.#close();
    try {
      for (const r of todo) {
        if (this.tables.includes(r.tbl)) {
          this.db.applyChangeset(toBytes(r.data), {
            filter: (table) => this.tables.includes(table),
            // Same row changed here too, or already there: theirs wins.
            // A row that's gone here (update/delete of a missing row) or a
            // broken constraint: skip that change.
            onConflict: (type) =>
              type === constants.SQLITE_CHANGESET_DATA || type === constants.SQLITE_CHANGESET_CONFLICT
                ? constants.SQLITE_CHANGESET_REPLACE
                : constants.SQLITE_CHANGESET_OMIT,
          });
        }
        pos = Number(r.seq);
        setPosition(this.db, origin, pos);
      }
    } finally {
      this.#open();
    }
    return pos;
  }

  close() {
    this.#close();
    this.out.close();
  }
}

const toBytes = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

// --- Wire format of /sync/catalog/changes: one frame per outbox row:
// seq (8 bytes) | at (8) | table name length (2) | table name | data length (4) | data
export function encodeRows(rows) {
  const parts = [];
  for (const r of rows) {
    const name = Buffer.from(r.tbl, "utf8");
    const head = Buffer.alloc(8 + 8 + 2);
    head.writeBigUInt64BE(BigInt(r.seq), 0);
    head.writeBigUInt64BE(BigInt(r.at), 8);
    head.writeUInt16BE(name.length, 16);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(r.data.length, 0);
    parts.push(head, name, len, Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length));
  }
  return Buffer.concat(parts);
}

export function decodeRows(buf) {
  const rows = [];
  let o = 0;
  while (o < buf.length) {
    if (o + 18 > buf.length) throw new Error("truncated frame");
    const seq = Number(buf.readBigUInt64BE(o));
    const at = Number(buf.readBigUInt64BE(o + 8));
    const n = buf.readUInt16BE(o + 16);
    o += 18;
    const tbl = buf.toString("utf8", o, o + n);
    o += n;
    if (o + 4 > buf.length) throw new Error("truncated frame");
    const len = buf.readUInt32BE(o);
    o += 4;
    if (o + len > buf.length) throw new Error("truncated frame");
    rows.push({ seq, at, tbl, data: new Uint8Array(buf.subarray(o, o + len)) });
    o += len;
  }
  return rows;
}

/**
 * Keeps this catalog in step with [peers] ({origin, url}): asks each for
 * its changes after the position held here and applies them. One round per
 * call; quiet about peers that don't answer (they're caught up later).
 */
export async function pullOnce(feed, peers, { fetchImpl = fetch, token, timeoutMs = 20_000, maxRounds = 20 } = {}) {
  const result = {};
  for (const p of peers) {
    if (p.origin === feed.origin) continue;
    let applied = 0;
    try {
      for (let round = 0; round < maxRounds; round++) {
        const since = syncPosition(feed.db, p.origin);
        const r = await fetchImpl(`${p.url}/sync/catalog/changes?since=${since}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.status === 410) {
          result[p.origin] = { error: "too_far_behind" };
          break;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (r.headers.get("x-sync-origin") && r.headers.get("x-sync-origin") !== p.origin) throw new Error("origin mismatch");
        const rows = decodeRows(Buffer.from(await r.arrayBuffer()));
        if (!rows.length) break;
        feed.apply(p.origin, rows);
        applied += rows.length;
        if (r.headers.get("x-sync-more") !== "1") break;
      }
      result[p.origin] ??= { applied, at: syncPosition(feed.db, p.origin) };
    } catch (e) {
      result[p.origin] = { error: String(e?.message || e).slice(0, 120), applied };
    }
  }
  return result;
}
