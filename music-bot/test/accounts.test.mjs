import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/accounts.js";

const store = () => new AccountStore({ dir: mkdtempSync(join(tmpdir(), "acc-")) });
const U = "aaaaaaaaaaaa";

test("signup, login, wrong password, persistence", () => {
  const s = store();
  const { recoveryCode } = s.signup({ username: " Bob_1 ", password: "password1", uid: U });
  assert.match(recoveryCode, /^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
  assert.equal(s.login({ username: "bob_1", password: "password1" }), U);
  assert.equal(s.login({ username: "bob_1", password: "nope" }), null);
  assert.equal(s.login({ username: "ghost", password: "password1" }), null);
  assert.equal(s.usernameOf(U), "bob_1");
  assert.equal(new AccountStore({ dir: s.dir }).login({ username: "BOB_1", password: "password1" }), U);
});

test("taken, has_account, bad input", () => {
  const s = store();
  s.signup({ username: "alice", password: "password1", uid: U });
  assert.throws(() => s.signup({ username: "alice", password: "password1", uid: "bbbbbbbbbbbb" }), /taken/);
  assert.throws(() => s.signup({ username: "alice2", password: "password1", uid: U }), /has_account/);
  for (const u of ["ab", "a b c", "x".repeat(25), "bad!"])
    assert.throws(() => s.signup({ username: u, password: "password1", uid: "cccccccccccc" }), /bad_username/);
  assert.throws(() => s.signup({ username: "okname", password: "short", uid: "cccccccccccc" }), /bad_password/);
  assert.throws(() => s.signup({ username: "okname", password: "x".repeat(201), uid: "cccccccccccc" }), /bad_password/);
});

test("recover sets a new password", () => {
  const s = store();
  const { recoveryCode } = s.signup({ username: "carol", password: "password1", uid: U });
  assert.equal(s.recover({ username: "carol", recoveryCode: "AAAA-AAAA-AAAA-AAAA", newPassword: "newpass99" }), null);
  assert.equal(s.recover({ username: "carol", recoveryCode: recoveryCode.toLowerCase(), newPassword: "short" }), null);
  assert.equal(s.recover({ username: "carol", recoveryCode: recoveryCode.toLowerCase(), newPassword: "newpass99" }), U);
  assert.equal(s.login({ username: "carol", password: "password1" }), null);
  assert.equal(s.login({ username: "carol", password: "newpass99" }), U);
});

test("data round trip and size limit", () => {
  const s = store();
  assert.deepEqual(s.getData(U), { data: null, updatedAt: 0 });
  assert.equal(s.putData(U, { a: [1, 2] }, 123), 123);
  assert.deepEqual(s.getData(U), { data: { a: [1, 2] }, updatedAt: 123 });
  assert.throws(() => s.putData(U, "x".repeat(2_000_001)), /too_big/);
  assert.deepEqual(s.getData(U).data, { a: [1, 2] });
});
