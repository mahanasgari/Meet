// Invite codes for MiniPlayer: each friend redeems a code once and gets a
// personal token. Tokens are signed with the shared MUSIC_API_TOKEN, so any
// server (home or worker) can check them without a database; blocked users
// are listed in a small file the workers fetch from the home server.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sign = (secret, body) =>
  createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);

/** Personal token for [uid]: "u1.<uid>.<signature>". */
export function makeUserToken(secret, uid) {
  const body = `u1.${uid}`;
  return `${body}.${sign(secret, body)}`;
}

/** The uid inside a valid token, or null (wrong format or signature). */
export function verifyUserToken(secret, token) {
  const m = /^u1\.([a-f0-9]{12})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ""));
  if (!m || !secret) return null;
  const want = Buffer.from(sign(secret, `u1.${m[1]}`));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}

// No 0/O/1/I/L: codes get read out loud and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newCode() {
  let s = "";
  for (const b of randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "k7p2 qx9m" / "K7P2QX9M" → "K7P2-QX9M". */
export function normalizeCode(c) {
  const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export class InviteStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "invites.json");
    this.data = { invites: {} };
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      this.data.invites ||= {};
    } catch {
      // first run
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  create(name) {
    let code;
    do code = newCode();
    while (this.data.invites[code]);
    const entry = {
      name: String(name || "Friend").slice(0, 60),
      uid: randomBytes(6).toString("hex"),
      created: new Date().toISOString(),
      redeemed: 0,
      disabled: false,
    };
    this.data.invites[code] = entry;
    this.save();
    return { code, ...entry };
  }

  /** The invite for [code] (counting the redemption), or null. */
  redeem(code) {
    const entry = this.data.invites[normalizeCode(code)];
    if (!entry) return null;
    if (!entry.disabled) {
      entry.redeemed = (entry.redeemed || 0) + 1;
      entry.lastRedeemed = new Date().toISOString();
      this.save();
    }
    return entry;
  }

  /** Block or unblock by code or uid; returns the entry or null. */
  setDisabled(codeOrUid, disabled) {
    const key = normalizeCode(codeOrUid);
    const entry =
      this.data.invites[key] ||
      Object.values(this.data.invites).find((e) => e.uid === codeOrUid);
    if (!entry) return null;
    entry.disabled = Boolean(disabled);
    this.save();
    return entry;
  }

  /** Remove an invite for good (by code or uid); its token stops working. */
  remove(codeOrUid) {
    const key = normalizeCode(codeOrUid);
    const code = this.data.invites[key]
      ? key
      : Object.keys(this.data.invites).find((c) => this.data.invites[c].uid === codeOrUid);
    if (!code) return null;
    const entry = this.data.invites[code];
    delete this.data.invites[code];
    // Keep its uid blocked so a token already handed out can't come back.
    (this.data.removed ||= []).push(entry.uid);
    this.save();
    return entry;
  }

  list() {
    return Object.entries(this.data.invites).map(([code, e]) => ({ code, ...e }));
  }

  disabledUids() {
    return [
      ...Object.values(this.data.invites)
        .filter((e) => e.disabled)
        .map((e) => e.uid),
      ...(this.data.removed || []),
    ];
  }
}

/** Fixed-window counter: at most [limit] hits per [windowMs] per key. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  hit(key, now = Date.now()) {
    let w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.hits.set(key, w);
    }
    w.count++;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (now - v.start >= this.windowMs) this.hits.delete(k);
      }
    }
    return w.count <= this.limit;
  }
}

/** Requests per user per day (last 30 days), saved now and then. */
export class Usage {
  constructor(dir) {
    this.file = join(dir, "usage.json");
    this.dir = dir;
    this.data = {};
    this.dirty = false;
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // first run
    }
  }

  touch(uid, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const u = (this.data[uid] ||= { days: {}, lastSeen: null });
    u.days[day] = (u.days[day] || 0) + 1;
    u.lastSeen = now.toISOString();
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    for (const u of Object.values(this.data)) {
      for (const d of Object.keys(u.days)) if (d < cutoff) delete u.days[d];
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  summary(uid) {
    const u = this.data[uid];
    if (!u) return { today: 0, last7: 0, lastSeen: null };
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    let last7 = 0;
    for (const [d, n] of Object.entries(u.days)) if (d >= week) last7 += n;
    return { today: u.days[today] || 0, last7, lastSeen: u.lastSeen };
  }
}
