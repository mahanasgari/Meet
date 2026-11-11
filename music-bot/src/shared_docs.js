// Small shared records (accounts, invites, shared playlist codes, song
// links...) in one SQLite file per server, synced between servers with the
// same change feed as the catalog. Each collection is a map id -> JSON.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SharedDocs {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (coll, id));`);
    this.listeners = new Map();
  }

  /** Every record of [coll]: { id: value }. */
  all(coll) {
    const out = {};
    for (const r of this.db.prepare("SELECT id, body FROM docs WHERE coll=?").iterate(coll)) {
      try {
        out[r.id] = JSON.parse(r.body);
      } catch {
        /* skip a broken record */
      }
    }
    return out;
  }

  count(coll) {
    return this.db.prepare("SELECT COUNT(*) n FROM docs WHERE coll=?").get(coll).n;
  }

  /**
   * Makes [coll] hold exactly [map] ({ id: value }), writing only what
   * changed (so only that is synced). Returns how many rows changed.
   */
  saveAll(coll, map, now = Date.now()) {
    const cur = new Map(this.db.prepare("SELECT id, body FROM docs WHERE coll=?").all(coll).map((r) => [r.id, r.body]));
    const put = this.db.prepare(`INSERT INTO docs(coll, id, body, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(coll, id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`);
    const del = this.db.prepare("DELETE FROM docs WHERE coll=? AND id=?");
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const [id, v] of Object.entries(map)) {
        const body = JSON.stringify(v);
        if (cur.get(id) !== body) {
          put.run(coll, id, body, now);
          n++;
        }
        cur.delete(id);
      }
      for (const id of cur.keys()) {
        del.run(coll, id);
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  /** [fn]() runs when other servers' changes to [coll] arrive. */
  onChange(coll, fn) {
    if (!this.listeners.has(coll)) this.listeners.set(coll, new Set());
    this.listeners.get(coll).add(fn);
  }

  /** After applying synced changes: tell every collection's listeners. */
  changed() {
    for (const fns of this.listeners.values()) for (const fn of fns) {
      try {
        fn();
      } catch (e) {
        console.error("[shared] reload:", e.message);
      }
    }
  }
}

/**
 * Moves a JSON-file store onto [docs]: the first time, the file's records
 * are copied in; from then on [load] gets them from [docs] and [save]
 * writes there. Returns { load(), save(map) } for collection [coll].
 */
export function docsBackend(docs, coll, { legacyLoad } = {}) {
  if (docs.count(coll) === 0 && legacyLoad) {
    const legacy = legacyLoad();
    if (legacy && Object.keys(legacy).length) docs.saveAll(coll, legacy);
  }
  return {
    load: () => docs.all(coll),
    save: (map) => docs.saveAll(coll, map),
    onChange: (fn) => docs.onChange(coll, fn),
  };
}
