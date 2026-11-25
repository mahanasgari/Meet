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
  /** [backend] (shared_docs): accounts kept in the synced store, shared by every server. */
  /** [dataDocs] (a SharedDocs): each account's library copy, synced too. */
  constructor({ dir, backend = null, dataDocs = null, importData = false }) {
    this.dir = dir;
    this.file = join(dir, "accounts.json");
    this.data = { users: {} };
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
      this.data.users ||= {};
    } catch {
      // first run
    }
    this.backend = backend;
    if (backend) {
      this.data.users = backend.load();
      backend.onChange(() => (this.data.users = backend.load()));
    }
    this.dataDocs = dataDocs;
    // Home moves its existing library files in once.
    if (dataDocs && importData && dataDocs.count("account_data") === 0) {
      for (const u of Object.values(this.data.users)) {
        const f = this.#fileData(u.uid);
        if (f.data != null) dataDocs.put("account_data", u.uid, f, f.updatedAt || Date.now());
      }
    }
  }

  #fileData(uid) {
    try {
      const r = JSON.parse(readFileSync(join(this.dir, "data", `${uid}.json`), "utf8"));
      return { data: r.data ?? null, updatedAt: r.updatedAt || 0 };
    } catch {
      return { data: null, updatedAt: 0 };
    }
  }

  #save() {
    this.backend?.save(this.data.users);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  usernameOf(uid) {
    return Object.keys(this.data.users).find((n) => this.data.users[n].uid === uid) || null;
  }

  /** Public profile fields (no hashes). */
  profile(username) {
    const u = this.data.users[cleanName(username)];
    if (!u) return null;
    return {
      uid: u.uid,
      googleSub: u.googleSub || null,
      googleEmail: u.googleEmail || null,
      createdAt: u.createdAt || null,
      lastLoginAt: u.lastLoginAt || null,
    };
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

  /** Open registration: brand-new uid + username/password (no invite). */
  registerOpen({ username, password }) {
    const uid = randomBytes(6).toString("hex");
    const { recoveryCode } = this.signup({ username, password, uid });
    return { uid, recoveryCode };
  }

  /** Logged-in password change (must know the current password). */
  changePassword({ uid, currentPassword, newPassword }) {
    const name = this.usernameOf(uid);
    if (!name) throw new Error("no_account");
    const u = this.data.users[name];
    const ok = matches(String(currentPassword ?? "").slice(0, 200), u.salt, u.hash);
    if (!ok) throw new Error("wrong_password");
    const pw = String(newPassword ?? "");
    if (pw.length < 8 || pw.length > 200) throw new Error("bad_password");
    const salt = randomBytes(16).toString("hex");
    u.salt = salt;
    u.hash = hashSecret(pw, Buffer.from(salt, "hex"));
    this.#save();
    return true;
  }

  /** Issue a new recovery code; old one stops working. Shown once. */
  rotateRecovery({ uid, password }) {
    const name = this.usernameOf(uid);
    if (!name) throw new Error("no_account");
    const u = this.data.users[name];
    const ok = matches(String(password ?? "").slice(0, 200), u.salt, u.hash);
    if (!ok) throw new Error("wrong_password");
    const recoveryCode = newRecoveryCode();
    const recoverySalt = randomBytes(16).toString("hex");
    u.recoverySalt = recoverySalt;
    u.recoveryHash = hashSecret(recoveryCode, Buffer.from(recoverySalt, "hex"));
    this.#save();
    return { recoveryCode };
  }

  findByGoogleSub(sub) {
    if (!sub) return null;
    for (const [username, u] of Object.entries(this.data.users)) {
      if (u.googleSub === sub) return { username, ...u };
    }
    return null;
  }

  /** Attach Google identity to an existing account uid. */
  linkGoogle({ uid, googleSub, googleEmail }) {
    const name = this.usernameOf(uid);
    if (!name) throw new Error("no_account");
    const other = this.findByGoogleSub(googleSub);
    if (other && other.uid !== uid) throw new Error("google_taken");
    const u = this.data.users[name];
    u.googleSub = googleSub;
    u.googleEmail = googleEmail || null;
    this.#save();
    return { username: name, uid };
  }

  /**
   * Login with a verified Google subject. If unknown and [uid] is provided
   * (fresh invite), create a passwordless-linked account shell — caller should
   * have already minted the invite uid. Username is derived from email local-part.
   */
  loginOrRegisterGoogle({ googleSub, googleEmail, uid = null }) {
    const existing = this.findByGoogleSub(googleSub);
    if (existing) {
      existing.lastLoginAt = new Date().toISOString();
      this.#save();
      return { uid: existing.uid, username: this.usernameOf(existing.uid), created: false };
    }
    if (!uid) return null; // need invite/open registration first
    if (this.usernameOf(uid)) {
      // Invite device already has username/password — just link.
      this.linkGoogle({ uid, googleSub, googleEmail });
      return { uid, username: this.usernameOf(uid), created: false };
    }
    // Create a Google-backed account: random unusable password hash + email username.
    let base = cleanName((googleEmail || "").split("@")[0]).replace(/[^a-z0-9_.]/g, "") || "user";
    if (base.length < 3) base = `g_${base}`;
    let name = base.slice(0, 20);
    let n = 0;
    while (this.data.users[name] && n < 50) {
      n++;
      name = `${base.slice(0, 18)}${n}`;
    }
    if (this.data.users[name]) throw new Error("taken");
    const salt = randomBytes(16).toString("hex");
    const recoveryCode = newRecoveryCode();
    const recoverySalt = randomBytes(16).toString("hex");
    // Password login disabled until they set one via recover/change — store random hash.
    const randomPw = randomBytes(24).toString("hex");
    this.data.users[name] = {
      uid,
      salt,
      hash: hashSecret(randomPw, Buffer.from(salt, "hex")),
      recoverySalt,
      recoveryHash: hashSecret(recoveryCode, Buffer.from(recoverySalt, "hex")),
      googleSub,
      googleEmail: googleEmail || null,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    this.#save();
    return { uid, username: name, created: true, recoveryCode };
  }

  getData(uid) {
    if (this.dataDocs) {
      const r = this.dataDocs.get("account_data", uid);
      if (r) return { data: r.data ?? null, updatedAt: r.updatedAt || 0 };
    }
    return this.#fileData(uid);
  }

  putData(uid, data, now = Date.now()) {
    const text = JSON.stringify({ data, updatedAt: now });
    if (text.length > MAX_DATA) throw new Error("too_big");
    this.dataDocs?.put("account_data", uid, { data, updatedAt: now }, now);
    const d = join(this.dir, "data");
    mkdirSync(d, { recursive: true });
    const file = join(d, `${uid}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return now;
  }
}
