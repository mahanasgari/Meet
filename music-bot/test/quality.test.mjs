import { strict as assert } from "node:assert";
import { test } from "node:test";
import { audioFormat } from "../src/quality.js";

test("low picks the small stream, everything else the best", () => {
  assert.match(audioFormat("low"), /abr<=70/);
  assert.equal(audioFormat(undefined), "bestaudio/best");
  assert.equal(audioFormat("high"), "bestaudio/best");
  assert.equal(audioFormat("; rm -rf /"), "bestaudio/best");
});
