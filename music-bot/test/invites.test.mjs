import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InviteStore, RateLimiter, Usage, makeUserToken, newCode, normalizeCode, verifyUserToken,
} from "../src/invites.js";

const SECRET = "server-secret";

test("tokens verify, and any change breaks them", () => {
  const t = makeUserToken(SECRET, "a1b2c3d4e5f6");
  assert.equal(verifyUserToken(SECRET, t), "a1b2c3d4e5f6");
  assert.equal(verifyUserToken("other-secret", t), null, "other server secret");
  assert.equal(verifyUserToken(SECRET, t.replace("a1b2", "a1b3")), null, "edited uid");
  assert.equal(verifyUserToken(SECRET, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")), null);
  assert.equal(verifyUserToken(SECRET, "garbage"), null);
  assert.equal(verifyUserToken("", t), null);
});

test("codes are readable and normalised", () => {
  const c = newCode();
  assert.match(c, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(normalizeCode(" k7p2 qx9m "), "K7P2-QX9M");
  assert.equal(normalizeCode("K7P2QX9M"), "K7P2-QX9M");
});

test("create, redeem, block, persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const s = new InviteStore(dir);
  const inv = s.create("Ali");
  assert.equal(s.redeem(inv.code.toLowerCase()).uid, inv.uid);
  assert.equal(s.redeem("ZZZZ-ZZZZ"), null);
  s.setDisabled(inv.uid, true);
  assert.deepEqual(new InviteStore(dir).disabledUids(), [inv.uid], "saved to disk");
  assert.equal(new InviteStore(dir).redeem(inv.code).disabled, true);
  s.setDisabled(inv.code, false);
  assert.deepEqual(s.disabledUids(), []);
});

test("rate limiter allows up to the limit per window", () => {
  const r = new RateLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4].map(() => r.hit("u", 0)), [true, true, true, false]);
  assert.equal(r.hit("u", 1000), true, "new window");
  assert.equal(r.hit("other", 0), true, "per key");
});

test("usage counts per day", () => {
  const u = new Usage(mkdtempSync(join(tmpdir(), "use-")));
  u.touch("x"); u.touch("x");
  assert.equal(u.summary("x").today, 2);
  assert.equal(u.summary("nobody").today, 0);
});
