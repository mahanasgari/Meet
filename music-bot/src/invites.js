// Invite codes for MiniPlayer: each friend redeems a code and gets a
// personal token. Tokens are signed with the shared MUSIC_API_TOKEN, so any
// server (home or worker) can check them without a database; blocked users
// are listed in a small file the workers fetch from the home server.
//
// User-created invites are single-use (maxRedeems: 1) with a per-uid quota.
// Admin/Telegram invites stay unlimited (maxRedeems: null) for legacy devices.
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
const MODES = new Set(["invite_only", "open", "disabled"]);

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
  /** [backend] (shared_docs): invites kept in the synced store, shared by every server. */
  constructor(dir, { backend = null } = {}) {
    this.dir = dir;
    this.file = join(dir, "invites.json");
    this.data = { invites: {}, settings: {}, quotas: {}, removed: [] };
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      this.data.invites ||= {};
      this.data.settings ||= {};
      this.data.quotas ||= {};
      this.data.removed ||= [];
    } catch {
      // first run
    }
    this.useBackend(backend);
  }

  /** Switches to the synced store (its records win over the old file's). */
  useBackend(backend) {
    this.backend = backend;
    if (!backend) return;
    this.data.invites = backend.load();
    backend.onChange(() => (this.data.invites = backend.load()));
  }

  save() {
    this.backend?.save(this.data.invites);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  registrationMode() {
    const m = this.data.settings?.registrationMode;
    return MODES.has(m) ? m : "invite_only";
  }

  setRegistrationMode(mode) {
    if (!MODES.has(mode)) throw new Error("bad_mode");
    (this.data.settings ||= {}).registrationMode = mode;
    this.save();
    return mode;
  }

  defaultQuota() {
    const n = Number(this.data.settings?.defaultInviteQuota);
    return Number.isFinite(n) && n >= 0 ? Math.min(50, Math.floor(n)) : 3;
  }

  setDefaultQuota(n) {
    const v = Math.min(50, Math.max(0, Math.floor(Number(n))));
    if (!Number.isFinite(v)) throw new Error("bad_quota");
    (this.data.settings ||= {}).defaultInviteQuota = v;
    this.save();
    return v;
  }

  quotaOf(uid) {
    const o = this.data.quotas?.[uid];
    return o != null ? o : this.defaultQuota();
  }

  setQuota(uid, n) {
    const v = Math.min(50, Math.max(0, Math.floor(Number(n))));
    if (!uid || !Number.isFinite(v)) throw new Error("bad_quota");
    (this.data.quotas ||= {})[uid] = v;
    this.save();
    return v;
  }

  /** Invites this uid has created (pending or used), not revoked. */
  listByCreator(uid) {
    return Object.entries(this.data.invites)
      .filter(([, e]) => e.createdBy === uid)
      .map(([code, e]) => ({ code, ...e }));
  }

  remainingQuota(uid) {
    return Math.max(0, this.quotaOf(uid) - this.listByCreator(uid).length);
  }

  status() {
    return {
      mode: this.registrationMode(),
      defaultInviteQuota: this.defaultQuota(),
      google: Boolean(process.env.GOOGLE_CLIENT_ID),
    };
  }

  /**
   * Create an invite. Admin/Telegram: omit createdBy → unlimited redeems.
   * User invites: pass createdBy → single-use, counts against quota.
   */
  create(name, { createdBy = null, maxRedeems = undefined } = {}) {
    let code;
    do code = newCode();
    while (this.data.invites[code]);
    const unlimited = createdBy == null && maxRedeems === undefined;
    const entry = {
      name: String(name || "Friend").slice(0, 60),
      uid: randomBytes(6).toString("hex"),
      created: new Date().toISOString(),
      redeemed: 0,
      disabled: false,
      maxRedeems: unlimited ? null : maxRedeems === undefined ? 1 : maxRedeems,
      createdBy: createdBy || null,
    };
    this.data.invites[code] = entry;
    this.save();
    return { code, ...entry };
  }

  /** User creates a single-use invite if quota allows. */
  createForUser(uid, name) {
    if (this.registrationMode() === "disabled") throw new Error("registration_disabled");
    if (!uid) throw new Error("no_user");
    if (this.remainingQuota(uid) <= 0) throw new Error("quota_exhausted");
    return this.create(name || "Friend", { createdBy: uid, maxRedeems: 1 });
  }

  /**
   * Redeem [code]. Returns the entry, or null if missing / exhausted.
   * Disabled invites: returns the entry without counting (callers check .disabled).
   * Single-use: refused once redeemed >= maxRedeems (atomic in-process).
   */
  redeem(code) {
    if (this.registrationMode() === "disabled") return null;
    const key = normalizeCode(code);
    const entry = this.data.invites[key];
    if (!entry) return null;
    if (entry.disabled) return entry;
    const max = entry.maxRedeems;
    if (max != null && (entry.redeemed || 0) >= max) return null;
    entry.redeemed = (entry.redeemed || 0) + 1;
    entry.lastRedeemed = new Date().toISOString();
    this.save();
    return entry;
  }

  /** Revoke an unused invite (creator only). Frees quota. */
  revokeByCreator(code, uid) {
    const key = normalizeCode(code);
    const entry = this.data.invites[key];
    if (!entry || entry.createdBy !== uid) return null;
    if ((entry.redeemed || 0) > 0) throw new Error("already_used");
    delete this.data.invites[key];
    this.save();
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
    let last7 = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      last7 += u.days[d] || 0;
    }
    return { today: u.days[today] || 0, last7, lastSeen: u.lastSeen };
  }
}
