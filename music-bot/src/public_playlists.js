// Public playlists (Explore): listeners publish a playlist, everyone can
// browse, play and save it. Home server only, in its own small database
// (not the big catalog), so Explore stays quick even when home's disk is slow.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const EXPLORE_TAGS = [
  "happy", "sad", "chill", "romantic", "party", "workout", "focus", "sleep",
  "persian-pop", "persian-classic", "rap", "rock", "electronic", "jazz", "classical", "other",
];
export const MAX_TRACKS = 300;
export const MAX_PER_OWNER = 20;
const DAY = 864e5;
const WEEK = 7 * DAY;
// No 0/O/1/I/L: codes get read out and typed.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const newId = () => {
  let s = "";
  for (const b of randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return s;
};
export const isPublicId = (id) => /^[A-Z2-9]{8}$/.test(String(id || ""));

export class PublicPlaylists {
  /** [cleanTrack]: validates one track ({id,t,a,u,art,d}), null to drop it. */
  constructor({ file, cleanTrack }) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.cleanTrack = cleanTrack;
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_name TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL,
        tracks_json TEXT NOT NULL, count INTEGER NOT NULL, cover_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, saves INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS playlists_owner ON playlists(owner);
      CREATE INDEX IF NOT EXISTS playlists_new ON playlists(hidden, created_at);
      CREATE TABLE IF NOT EXISTS events (
        playlist TEXT NOT NULL, uid TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (playlist, uid, kind, day));
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS reports (
        playlist TEXT NOT NULL, uid TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (playlist, uid));
    `);
  }

  #row(r, { tracks = false } = {}) {
    if (!r) return null;
    const out = {
      id: r.id, name: r.name, description: r.description, tag: r.tag, owner: r.owner_name,
      count: r.count, cover: JSON.parse(r.cover_json), plays: r.plays, saves: r.saves,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (r.hidden) out.hidden = true;
    if (r.score != null) out.score = r.score;
    if (tracks) out.tracks = JSON.parse(r.tracks_json);
    return out;
  }

  /**
   * Publish (or update, when [id] is one of [owner]'s) a playlist.
   * Throws Error(code): no_tracks, bad_name, bad_tag, too_many, not_found, not_owner.
   */
  publish({ owner, ownerName, id, name, description, tag, tracks }, now = Date.now()) {
    const title = str(name, 80);
    if (!title) throw new Error("bad_name");
    const t = EXPLORE_TAGS.includes(tag) ? tag : null;
    if (!t) throw new Error("bad_tag");
    const seen = new Set();
    const list = [];
    for (const raw of Array.isArray(tracks) ? tracks : []) {
      const c = this.cleanTrack(raw);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      list.push(c);
      if (list.length >= MAX_TRACKS) break;
    }
    if (!list.length) throw new Error("no_tracks");
    const cover = list.map((x) => x.art).filter(Boolean).slice(0, 4);
    const desc = str(description, 300);
    if (id) {
      const cur = this.db.prepare("SELECT owner FROM playlists WHERE id=?").get(id);
      if (!cur) throw new Error("not_found");
      if (cur.owner !== owner) throw new Error("not_owner");
      this.db.prepare(`UPDATE playlists SET owner_name=?, name=?, description=?, tag=?, tracks_json=?, count=?,
        cover_json=?, updated_at=? WHERE id=?`)
        .run(ownerName, title, desc, t, JSON.stringify(list), list.length, JSON.stringify(cover), now, id);
      return id;
    }
    const mine = this.db.prepare("SELECT COUNT(*) n FROM playlists WHERE owner=?").get(owner).n;
    if (mine >= MAX_PER_OWNER) throw new Error("too_many");
    let pid = newId();
    while (this.db.prepare("SELECT 1 FROM playlists WHERE id=?").get(pid)) pid = newId();
    this.db.prepare(`INSERT INTO playlists(id, owner, owner_name, name, description, tag, tracks_json, count,
      cover_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, owner, ownerName, title, desc, t, JSON.stringify(list), list.length, JSON.stringify(cover), now, now);
    return pid;
  }

  /** Owner (or [admin]) removes it for good. */
  remove(id, owner, { admin = false } = {}) {
    const cur = this.db.prepare("SELECT owner FROM playlists WHERE id=?").get(id);
    if (!cur) return false;
    if (!admin && cur.owner !== owner) throw new Error("not_owner");
    this.db.prepare("DELETE FROM playlists WHERE id=?").run(id);
    this.db.prepare("DELETE FROM events WHERE playlist=?").run(id);
    this.db.prepare("DELETE FROM reports WHERE playlist=?").run(id);
    return true;
  }

  /** A public playlist with its songs; hidden ones only for their owner or admin. */
  get(id, { viewer = null, admin = false } = {}) {
    const r = this.db.prepare("SELECT * FROM playlists WHERE id=?").get(id);
    if (!r || (r.hidden && !admin && r.owner !== viewer)) return null;
    const out = this.#row(r, { tracks: true });
    out.mine = Boolean(viewer && r.owner === viewer);
    return out;
  }

  /**
   * Browse: sort "popular" (plays + 3 × saves in the last 7 days, then all
   * time) or "new"; optional [tag] and text [q] (name, description, owner).
   */
  list({ sort = "popular", tag = null, q = "", limit = 30, offset = 0 } = {}, now = Date.now()) {
    limit = Math.max(1, Math.min(Number(limit) || 30, 60));
    offset = Math.max(0, Math.min(Number(offset) || 0, 2000));
    const where = ["p.hidden=0"];
    const args = [];
    if (tag && EXPLORE_TAGS.includes(tag)) {
      where.push("p.tag=?");
      args.push(tag);
    }
    const text = str(q, 60).toLowerCase();
    if (text) {
      where.push("(lower(p.name) LIKE ? OR lower(p.description) LIKE ? OR lower(p.owner_name) LIKE ?)");
      const like = `%${text.replace(/[%_]/g, "")}%`;
      args.push(like, like, like);
    }
    const sql = sort === "new"
      ? `SELECT p.* FROM playlists p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
      : `SELECT p.*, COALESCE(w.score, 0) score FROM playlists p
          LEFT JOIN (SELECT playlist, SUM(CASE kind WHEN 'save' THEN 3 ELSE 1 END) score
                     FROM events WHERE at > ? GROUP BY playlist) w ON w.playlist = p.id
          WHERE ${where.join(" AND ")}
          ORDER BY score DESC, (p.plays + 3 * p.saves) DESC, p.created_at DESC LIMIT ? OFFSET ?`;
    const params = sort === "new" ? [...args, limit, offset] : [now - WEEK, ...args, limit, offset];
    return this.db.prepare(sql).all(...params).map((r) => this.#row(r));
  }

  /** [owner]'s playlists, hidden ones too. */
  mine(owner) {
    return this.db.prepare("SELECT * FROM playlists WHERE owner=? ORDER BY updated_at DESC").all(owner).map((r) => this.#row(r));
  }

  /** Counts a play or save once per listener per day. True when it counted. */
  note(id, uid, kind, now = Date.now()) {
    if (!["play", "save"].includes(kind) || !uid) return false;
    const r = this.db.prepare("SELECT owner, hidden FROM playlists WHERE id=?").get(id);
    if (!r || r.hidden || r.owner === uid) return false; // own plays don't count
    const day = Math.floor(now / DAY);
    const ins = this.db.prepare("INSERT OR IGNORE INTO events(playlist, uid, kind, day, at) VALUES(?,?,?,?,?)")
      .run(id, uid, kind, day, now);
    if (!Number(ins.changes)) return false;
    this.db.prepare(`UPDATE playlists SET ${kind === "save" ? "saves=saves+1" : "plays=plays+1"} WHERE id=?`).run(id);
    // Events older than the popular window aren't needed any more.
    if (Math.random() < 0.01) this.db.prepare("DELETE FROM events WHERE at < ?").run(now - 2 * WEEK);
    return true;
  }

  report(id, uid, reason, now = Date.now()) {
    if (!this.db.prepare("SELECT 1 FROM playlists WHERE id=?").get(id)) return false;
    this.db.prepare("INSERT OR REPLACE INTO reports(playlist, uid, reason, at) VALUES(?,?,?,?)")
      .run(id, uid || "?", str(reason, 300) || "no reason", now);
    return true;
  }

  setHidden(id, hidden) {
    return Number(this.db.prepare("UPDATE playlists SET hidden=? WHERE id=?").run(hidden ? 1 : 0, id).changes) > 0;
  }

  /** For the admin dashboard: everything, reported first. */
  adminList(limit = 200) {
    return this.db.prepare(`SELECT p.*, COUNT(r.uid) reports, GROUP_CONCAT(r.reason, ' | ') reasons
        FROM playlists p LEFT JOIN reports r ON r.playlist = p.id
        GROUP BY p.id ORDER BY reports DESC, p.created_at DESC LIMIT ?`)
      .all(limit)
      .map((r) => ({ ...this.#row(r), hidden: Boolean(r.hidden), reports: r.reports, reasons: r.reasons || "" }));
  }
}
