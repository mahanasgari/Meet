import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PublicPlaylists, MAX_PER_OWNER, isPublicId } from "../src/public_playlists.js";

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 8, 12);
const clean = (t) => (t && t.id && t.u ? { id: t.id, t: t.t || "?", a: t.a || "", u: t.u, art: t.art } : null);
const open = () => new PublicPlaylists({ file: join(mkdtempSync(join(tmpdir(), "pp-")), "x", "p.db"), cleanTrack: clean });
const tr = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, t: `Song ${i}`, u: `https://music.youtube.com/watch?v=s${i}`, art: `https://i/${i}.jpg` }));

test("publish, browse, open, update and remove", () => {
  const p = open();
  const id = p.publish({ owner: "u1", ownerName: "sara", name: " Road trip ", description: "for the car", tag: "happy", tracks: [...tr(6), { id: "s1", u: "x" }, null] }, NOW);
  assert.ok(isPublicId(id));
  const [item] = p.list({}, NOW);
  assert.equal(item.name, "Road trip");
  assert.equal(item.owner, "sara");
  assert.equal(item.count, 6, "duplicates and bad tracks dropped");
  assert.deepEqual(item.cover, ["https://i/0.jpg", "https://i/1.jpg", "https://i/2.jpg", "https://i/3.jpg"]);
  assert.equal(item.tracks, undefined, "lists don't carry the songs");
  const full = p.get(id, { viewer: "u2" });
  assert.equal(full.tracks.length, 6);
  assert.equal(full.mine, false);
  assert.equal(p.get(id, { viewer: "u1" }).mine, true);

  assert.throws(() => p.publish({ owner: "u2", ownerName: "x", id, name: "mine now", tag: "sad", tracks: tr(1) }), /not_owner/);
  p.publish({ owner: "u1", ownerName: "sara", id, name: "Road trip 2", tag: "party", tracks: tr(2) }, NOW + 1);
  assert.equal(p.get(id).count, 2);
  assert.equal(p.get(id).tag, "party");
  assert.throws(() => p.remove(id, "u2"), /not_owner/);
  assert.equal(p.remove(id, "u1"), true);
  assert.equal(p.get(id), null);
});

test("bad input is refused", () => {
  const p = open();
  assert.throws(() => p.publish({ owner: "u", ownerName: "a", name: "", tag: "happy", tracks: tr(1) }), /bad_name/);
  assert.throws(() => p.publish({ owner: "u", ownerName: "a", name: "x", tag: "nope", tracks: tr(1) }), /bad_tag/);
  assert.throws(() => p.publish({ owner: "u", ownerName: "a", name: "x", tag: "happy", tracks: [] }), /no_tracks/);
  assert.equal(p.publish({ owner: "u", ownerName: "a", name: "big", tag: "happy", tracks: tr(400) }) && p.list()[0].count, 300);
  for (let i = 1; i < MAX_PER_OWNER; i++) p.publish({ owner: "u", ownerName: "a", name: `p${i}`, tag: "sad", tracks: tr(1) });
  assert.throws(() => p.publish({ owner: "u", ownerName: "a", name: "one more", tag: "sad", tracks: tr(1) }), /too_many/);
});

test("popular: plays and saves of the last week, once per listener per day, own plays don't count", () => {
  const p = open();
  const a = p.publish({ owner: "o1", ownerName: "a", name: "A", tag: "chill", tracks: tr(3) }, NOW - 3 * DAY);
  const b = p.publish({ owner: "o2", ownerName: "b", name: "B", tag: "chill", tracks: tr(3) }, NOW - 2 * DAY);
  assert.equal(p.note(a, "x", "play", NOW), true);
  assert.equal(p.note(a, "x", "play", NOW + 1000), false, "same listener, same day");
  assert.equal(p.note(a, "y", "play", NOW), true);
  assert.equal(p.note(b, "x", "save", NOW), true); // a save counts 3
  assert.equal(p.note(b, "o2", "play", NOW), false, "the owner");
  assert.deepEqual(p.list({ sort: "popular" }, NOW).map((x) => x.id), [b, a]);
  assert.deepEqual(p.list({ sort: "new" }, NOW).map((x) => x.id), [b, a]);
  // A week later the old activity no longer counts for "popular this week",
  // all-time totals still order them.
  p.note(a, "z", "play", NOW + 8 * DAY);
  assert.deepEqual(p.list({ sort: "popular" }, NOW + 8 * DAY).map((x) => x.id), [a, b]);
  assert.equal(p.get(a).plays, 3);
  assert.equal(p.get(b).saves, 1);
});

test("tag and text filters; hidden playlists only for owner and admin", () => {
  const p = open();
  const a = p.publish({ owner: "o1", ownerName: "sara", name: "Gym mix", tag: "workout", tracks: tr(2) }, NOW);
  p.publish({ owner: "o2", ownerName: "ali", name: "Rainy", description: "slow piano", tag: "sad", tracks: tr(2) }, NOW);
  assert.deepEqual(p.list({ tag: "workout" }).map((x) => x.name), ["Gym mix"]);
  assert.deepEqual(p.list({ q: "PIANO" }).map((x) => x.name), ["Rainy"]);
  assert.deepEqual(p.list({ q: "sara" }).map((x) => x.name), ["Gym mix"]);
  assert.equal(p.report(a, "u9", "spam"), true);
  assert.equal(p.adminList()[0].reports, 1);
  p.setHidden(a, true);
  assert.equal(p.list({ tag: "workout" }).length, 0);
  assert.equal(p.get(a, { viewer: "u9" }), null);
  assert.equal(p.get(a, { viewer: "o1" }).hidden, true);
  assert.ok(p.get(a, { admin: true }));
  assert.equal(p.note(a, "u9", "play"), false, "hidden: not counted");
  assert.equal(p.mine("o1").length, 1);
});
