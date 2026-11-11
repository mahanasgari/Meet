import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountStore } from "../src/accounts.js";
import { ChangeFeed, decodeRows, encodeRows, syncPosition } from "../src/catalog_sync.js";
import { InviteStore } from "../src/invites.js";
import { SharedDocs, docsBackend } from "../src/shared_docs.js";

const server = (d, origin) => {
  const docs = new SharedDocs(join(d, origin, "shared.db"));
  docs.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const feed = new ChangeFeed({ db: docs.db, outFile: join(d, origin, "out.db"), origin, keepMs: Infinity });
  return { docs, feed };
};
const ship = (a, b) => {
  a.feed.flush();
  b.feed.apply(a.feed.origin, decodeRows(encodeRows(a.feed.read(syncPosition(b.docs.db, a.feed.origin)))));
  b.docs.changed();
};

test("saveAll writes only what changed and removes what's gone", () => {
  const { docs } = server(mkdtempSync(join(tmpdir(), "sd-")), "home");
  assert.equal(docs.saveAll("c", { a: { x: 1 }, b: { x: 2 } }), 2);
  assert.equal(docs.saveAll("c", { a: { x: 1 }, b: { x: 3 } }), 1);
  assert.equal(docs.saveAll("c", { a: { x: 1 } }), 1);
  assert.deepEqual(docs.all("c"), { a: { x: 1 } });
  assert.deepEqual(docs.all("other"), {});
});

test("accounts made at home show up on a mirror, which reloads them", () => {
  const d = mkdtempSync(join(tmpdir(), "sd-"));
  const home = server(d, "home");
  const de = server(d, "germany");
  // Home's old accounts.json is moved in once.
  mkdirSync(join(d, "acc"), { recursive: true });
  writeFileSync(join(d, "acc", "accounts.json"), JSON.stringify({ users: { sara: { uid: "aaaaaaaaaaaa", hash: "h", salt: "s" } } }));
  const legacy = () => ({ sara: { uid: "aaaaaaaaaaaa", hash: "h", salt: "s" } });
  const homeAcc = new AccountStore({ dir: join(d, "acc"), backend: docsBackend(home.docs, "accounts", { legacyLoad: legacy }) });
  assert.equal(homeAcc.usernameOf("aaaaaaaaaaaa"), "sara");
  const deAcc = new AccountStore({ dir: join(d, "acc-de"), backend: docsBackend(de.docs, "accounts") });
  assert.equal(deAcc.usernameOf("aaaaaaaaaaaa"), null);
  ship(home, de);
  assert.equal(deAcc.usernameOf("aaaaaaaaaaaa"), "sara", "reloaded after the sync");
});

test("invites: a block at home reaches the mirror", () => {
  const d = mkdtempSync(join(tmpdir(), "sd-"));
  const home = server(d, "home");
  const de = server(d, "germany");
  const hi = new InviteStore(join(d, "inv"), { backend: docsBackend(home.docs, "invites") });
  const e = hi.create("friend");
  const di = new InviteStore(join(d, "inv-de"), { backend: docsBackend(de.docs, "invites") });
  ship(home, de);
  assert.equal(di.list().length, 1);
  hi.setDisabled(e.code, true);
  ship(home, de);
  assert.deepEqual(di.disabledUids(), hi.disabledUids());
  assert.equal(di.disabledUids().length, 1);
});

test("an account's library copy is synced too (home's files moved in once)", () => {
  const d = mkdtempSync(join(tmpdir(), "sd-"));
  const home = server(d, "home");
  const de = server(d, "germany");
  mkdirSync(join(d, "acc", "data"), { recursive: true });
  writeFileSync(join(d, "acc", "data", "aaaaaaaaaaaa.json"), JSON.stringify({ data: { likes: [1] }, updatedAt: 5 }));
  const users = () => ({ sara: { uid: "aaaaaaaaaaaa", hash: "h", salt: "s" } });
  const ha = new AccountStore({ dir: join(d, "acc"), backend: docsBackend(home.docs, "accounts", { legacyLoad: users }), dataDocs: home.docs, importData: true });
  assert.deepEqual(ha.getData("aaaaaaaaaaaa"), { data: { likes: [1] }, updatedAt: 5 });
  const da = new AccountStore({ dir: join(d, "acc-de"), backend: docsBackend(de.docs, "accounts"), dataDocs: de.docs });
  assert.equal(da.getData("aaaaaaaaaaaa").data, null);
  ship(home, de);
  assert.deepEqual(da.getData("aaaaaaaaaaaa"), { data: { likes: [1] }, updatedAt: 5 });
  // Saved on the mirror (home down) → back home.
  da.putData("aaaaaaaaaaaa", { likes: [1, 2] }, 9);
  ship(de, home);
  assert.deepEqual(ha.getData("aaaaaaaaaaaa"), { data: { likes: [1, 2] }, updatedAt: 9 });
});
