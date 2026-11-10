// pnpm vertical: the crop planner, the key and the arguments. Pure functions; no FFmpeg.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerticalArgs, planCrop, RECIPE, verticalFilter, verticalKey, VerticalRefusal } from "../src/share/vertical.ts";

const out = { width: 1080, height: 1920, crf: 18 };

test("planCrop: 1920x1080 → the centred 608x1080 column at x=656", () => {
  assert.deepEqual(planCrop(1920, 1080), { width: 608, height: 1080, x: 656, y: 0 });
  assert.equal(verticalFilter(planCrop(1920, 1080), out), "crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1");
});

test("planCrop: 2560x1440 → 810x1440 centred", () => {
  assert.deepEqual(planCrop(2560, 1440), { width: 810, height: 1440, x: 876, y: 0 });
});

test("planCrop: an odd-sized source gets an even crop, inside the frame", () => {
  const c = planCrop(1279, 719);
  assert.deepEqual([c.width % 2, c.height % 2, c.x % 2, c.y % 2], [0, 0, 0, 0]);
  assert.equal(c.height, 718);
  assert.equal(c.width, 404); // 718 * 9 / 16 = 403.9
  assert.ok(c.x + c.width <= 1279 && c.y + c.height <= 719);
  assert.ok(Math.abs(c.x + c.width / 2 - 1279 / 2) <= 2, "centred");
});

test("planCrop: --shift moves the column by a percent of the frame width, clamped at both edges", () => {
  assert.equal(planCrop(1920, 1080, 10).x, 656 + 192);
  assert.equal(planCrop(1920, 1080, -10).x, 656 - 192);
  assert.equal(planCrop(1920, 1080, 50).x, 1920 - 608);
  assert.equal(planCrop(1920, 1080, 1000).x, 1312);
  assert.equal(planCrop(1920, 1080, -50).x, 0);
  assert.equal(planCrop(1920, 1080, -1000).x, 0);
});

test("planCrop: a source already narrower than 9:16 is refused, exactly 9:16 is not", () => {
  assert.throws(() => planCrop(500, 1080), (e: Error) => e instanceof VerticalRefusal && /already narrower than 9:16/.test(e.message));
  // The true aspect decides, not the rounded one: 405x720 is exactly 9:16 (its column rounds to 406),
  // 720x1281 is narrower (its height rounds down to 1280).
  assert.deepEqual(planCrop(405, 720), { width: 404, height: 720, x: 0, y: 0 });
  assert.throws(() => planCrop(720, 1281), VerticalRefusal);
  assert.throws(() => planCrop(1080, 1920 * 2), VerticalRefusal);
  assert.deepEqual(planCrop(1080, 1920), { width: 1080, height: 1920, x: 0, y: 0 });
});

test("verticalKey: changes with the shift, the output settings and the recipe, not otherwise", () => {
  const base = { id: "69fa242239946515", bytes: 17920219, mtimeMs: 1760537580000, crop: planCrop(1920, 1080), settings: out };
  const k = verticalKey(base);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(verticalKey({ ...base }), k);
  assert.equal(verticalKey({ ...base, recipe: RECIPE }), k);
  assert.notEqual(verticalKey({ ...base, crop: planCrop(1920, 1080, 20) }), k, "shift");
  assert.equal(verticalKey({ ...base, crop: planCrop(1920, 1080, 60) }), verticalKey({ ...base, crop: planCrop(1920, 1080, 90) }), "shifts clamped to the same column share a key");
  assert.notEqual(verticalKey({ ...base, recipe: RECIPE + 1 }), k, "recipe");
  assert.notEqual(verticalKey({ ...base, settings: { ...out, crf: 20 } }), k, "crf");
  assert.notEqual(verticalKey({ ...base, mtimeMs: base.mtimeMs + 1000 }), k, "source re-rendered");
});

test("parseVerticalArgs", () => {
  assert.deepEqual(parseVerticalArgs(["12"]), { no: 12, shift: 0, json: false });
  assert.deepEqual(parseVerticalArgs(["12", "--shift", "-15.5", "--json"]), { no: 12, shift: -15.5, json: true });
  assert.throws(() => parseVerticalArgs([]), /usage/);
  assert.throws(() => parseVerticalArgs(["12", "--shift"]), /--shift/);
  assert.throws(() => parseVerticalArgs(["12", "--shift", "left"]), /--shift/);
  assert.throws(() => parseVerticalArgs(["0"]), /unexpected/);
  assert.throws(() => parseVerticalArgs(["12", "13"]), /unexpected/);
});
