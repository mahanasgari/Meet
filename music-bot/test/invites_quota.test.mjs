import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InviteStore } from "../src/invites.js";

const store = () => new InviteStore(mkdtempSync(join(tmpdir(), "inv-")));

test("user invites are single-use and count against quota", () => {
  const s = store();
  const uid = "aaaaaaaaaaaa";
  assert.equal(s.remainingQuota(uid), 3);
  const a = s.createForUser(uid, "Ali");
  assert.equal(a.maxRedeems, 1);
  assert.equal(s.remainingQuota(uid), 2);
  const first = s.redeem(a.code);
  assert.equal(first.uid, a.uid);
  assert.equal(s.redeem(a.code), null, "second redeem refused");
});

test("admin invites stay unlimited when created without createdBy", () => {
  const s = store();
  const e = s.create("Friend");
  assert.equal(e.maxRedeems, null);
  assert.ok(s.redeem(e.code));
  assert.ok(s.redeem(e.code), "legacy multi-redeem");
});

test("revoke unused frees quota; used cannot revoke", () => {
  const s = store();
  const uid = "bbbbbbbbbbbb";
  const a = s.createForUser(uid, "X");
  assert.ok(s.revokeByCreator(a.code, uid));
  assert.equal(s.remainingQuota(uid), 3);
  const b = s.createForUser(uid, "Y");
  s.redeem(b.code);
  assert.throws(() => s.revokeByCreator(b.code, uid), /already_used/);
});

test("registration modes", () => {
  const s = store();
  assert.equal(s.registrationMode(), "invite_only");
  s.setRegistrationMode("open");
  assert.equal(s.registrationMode(), "open");
  s.setRegistrationMode("disabled");
  assert.equal(s.redeem(s.create("Z").code), null);
  assert.throws(() => s.setRegistrationMode("nope"), /bad_mode/);
});

test("quota exhausted", () => {
  const s = store();
  const uid = "cccccccccccc";
  s.setDefaultQuota(1);
  s.createForUser(uid, "One");
  assert.throws(() => s.createForUser(uid, "Two"), /quota_exhausted/);
});
