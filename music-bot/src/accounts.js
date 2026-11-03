// Username + password accounts (home server only). An account ties a
// username to a uid, so a new device can log in and get that uid's token;
// the app's synced data is stored per uid.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// No 0/O/1/I/L: recovery codes get written down and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_DATA = 2_000_000;

const hashSecret = (secret, salt) => scryptSync(secret, salt, 64).toString("hex");

function matches(secret, saltHex, hashHex) {
  const want = Buffer.from(hashHex || "", "hex");
  const got = scryptSync(secret, Buffer.from(saltHex || "", "hex"), 64);
  return want.length === got.length && timingSafeEqual(want, got);
}

const newRecoveryCode = () => {
  let s = "";
  for (const b of randomBytes(16)) s += ALPHABET[b % ALPHABET.length];
  return s.match(/.{4}/g).join("-");
};

const normalizeRecovery = (c) => {
  const s = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 16 ? s.match(/.{4}/g).join("-") : s;
};

const cleanName = (u) => String(u || "").trim().toLowerCase();

export class AccountStore {
  constructor({ dir }) {
    this.dir = dir;
    this.file = join(dir, "accounts.json");
    this.data = { users: {} };
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      this.data.users ||= {};
    } catch {
      // first run
    }
  }

  #save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  usernameOf(uid) {
    return Object.keys(this.data.users).find((n) => this.data.users[n].uid === uid) || null;
  }

  signup({ username, password, uid }) {
    const name = cleanName(username);
    if (!/^[a-z0-9_.]{3,24}$/.test(name)) throw new Error("bad_username");
    const pw = String(password ?? "");
    if (pw.length < 8 || pw.length > 200) throw new Error("bad_password");
    if (this.usernameOf(uid)) throw new Error("has_account");
    if (this.data.users[name]) throw new Error("taken");
    const recoveryCode = newRecoveryCode();
    const salt = randomBytes(16).toString("hex");
    const recoverySalt = randomBytes(16).toString("hex");
    this.data.users[name] = {
      uid,
      salt,
      hash: hashSecret(pw, Buffer.from(salt, "hex")),
      recoverySalt,
      recoveryHash: hashSecret(recoveryCode, Buffer.from(recoverySalt, "hex")),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.#save();
    return { recoveryCode };
  }

  login({ username, password }) {
    const u = this.data.users[cleanName(username)];
    // Same work for unknown names so timing doesn't reveal them.
    const ok = matches(String(password ?? "").slice(0, 200), u?.salt, u?.hash || "00");
    if (!u || !ok) return null;
    u.lastLoginAt = new Date().toISOString();
    this.#save();
    return u.uid;
  }

  recover({ username, recoveryCode, newPassword }) {
    const u = this.data.users[cleanName(username)];
    const pw = String(newPassword ?? "");
    if (pw.length < 8 || pw.length > 200) return null;
    const ok = matches(normalizeRecovery(recoveryCode), u?.recoverySalt, u?.recoveryHash || "00");
    if (!u || !ok) return null;
    const salt = randomBytes(16).toString("hex");
    u.salt = salt;
    u.hash = hashSecret(pw, Buffer.from(salt, "hex"));
    this.#save();
    return u.uid;
  }

  getData(uid) {
    try {
      const r = JSON.parse(readFileSync(join(this.dir, "data", `${uid}.json`), "utf8"));
      return { data: r.data ?? null, updatedAt: r.updatedAt || 0 };
    } catch {
      return { data: null, updatedAt: 0 };
    }
  }

  putData(uid, data, now = Date.now()) {
    const text = JSON.stringify({ data, updatedAt: now });
    if (text.length > MAX_DATA) throw new Error("too_big");
    const d = join(this.dir, "data");
    mkdirSync(d, { recursive: true });
    const file = join(d, `${uid}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return now;
  }
}
