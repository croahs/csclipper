// Stars and the page's feat / weapon filters: the stars file and the derivation from a clip's
// moment. Pure functions and a temp directory; no library, no browser.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { featsOf, weaponsOf } from "../src/library/facets.ts";
import { changeStars, parseStars, readStars, writeStars } from "../src/library/stars.ts";

const withDir = (fn: (file: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-stars-"));
  try { fn(path.join(dir, "stars.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("readStars: a missing file is no stars", () => withDir((f) => assert.deepEqual(readStars(f), [])));

test("readStars: a garbled or foreign file is no stars, never a throw", () => withDir((f) => {
  for (const text of ["", "{", "null", "[]", '{"version":2,"stars":[1]}', '{"version":1}', '{"version":1,"stars":"3"}']) {
    writeFileSync(f, text);
    assert.deepEqual(readStars(f), [], text);
  }
}));

test("parseStars: keeps positive integers only, sorted, each once", () => {
  assert.deepEqual(parseStars('{"version":1,"stars":[12,3,12,"4",-1,0,2.5,null,3]}'), [3, 12]);
});

test("writeStars: writes the versioned shape, deduplicated, and no temp file is left", () => withDir((f) => {
  writeStars([5, 2, 5], f);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { version: 1, stars: [2, 5] });
  assert.deepEqual(readStars(f), [2, 5]);
  assert.deepEqual(readdirSync(path.dirname(f)), ["stars.json"]);
}));

test("changeStars: stars and unstars; starring twice is one star", () => withDir((f) => {
  const known = new Set([1, 2, 3, 7]);
  assert.deepEqual(changeStars("star", [3, 1, 3], known, f), { stars: [1, 3], unknown: [] });
  assert.deepEqual(changeStars("star", [3], known, f).stars, [1, 3]);
  assert.deepEqual(changeStars("unstar", [1, 2], known, f).stars, [3]);
}));

test("changeStars: a number the index does not hold refuses the whole change", () => withDir((f) => {
  const known = new Set([1, 2]);
  changeStars("star", [1], known, f);
  const r = changeStars("star", [2, 99], known, f);
  assert.deepEqual(r, { stars: [1], unknown: [99] });
  assert.deepEqual(readStars(f), [1]);
}));

test("changeStars: the star of a deleted clip is dropped at the next write", () => withDir((f) => {
  writeStars([4, 9], f);
  assert.deepEqual(changeStars("star", [1], new Set([1, 9]), f).stars, [1, 9]);
}));

// Modelled on real index entries (moment: kills, killTicks, weapons, flags, clutch, breakdown).
const moment = (kills: number, weapons: string[], clutch?: { vs: number; won: boolean }) =>
  ({ rank: 1, score: 100, breakdown: { kills: 50 }, kills, killTicks: [], weapons, flags: ["all HS"], ...(clutch ? { clutch } : {}) });

test("featsOf: ace, 4k, 3k by kill count; clutch only when won", () => {
  assert.deepEqual(featsOf(moment(5, ["AK-47"])), ["ace"]);
  assert.deepEqual(featsOf(moment(4, ["Glock"], { vs: 3, won: true })), ["4k", "clutch"]);
  assert.deepEqual(featsOf(moment(3, ["AWP"], { vs: 2, won: false })), ["3k"]);
  assert.deepEqual(featsOf(moment(2, ["M4A1-S"], { vs: 1, won: true })), ["clutch"]);
  assert.deepEqual(featsOf(moment(2, ["M4A1-S"])), []);
});

test("featsOf / weaponsOf: reels and entries without a moment have none", () => {
  assert.deepEqual(featsOf(undefined), []);
  assert.deepEqual(featsOf({}), []);
  assert.deepEqual(weaponsOf(undefined), []);
  assert.deepEqual(weaponsOf({ kills: 3 }), []);
});

test("weaponsOf: each weapon once, the game's names for non-guns labelled", () => {
  assert.deepEqual(weaponsOf(moment(3, ["AK-47", "hegrenade", "AK-47"])), ["AK-47", "HE grenade"]);
  assert.deepEqual(weaponsOf(moment(2, ["inferno", "molotov"])), ["Fire"]);
  assert.deepEqual(weaponsOf({ weapons: ["Deagle", 3, "", null] }), ["Deagle"]);
});

test("the library page's inlined data escapes every <, so no title can end the script element", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/library/page.ts", import.meta.url), "utf8");
  // In the source the replacement is written with two backslashes: at run time that is the six
  // characters of the JSON escape, never a literal "<".
  const bs = String.fromCharCode(92);
  assert.ok(src.includes('.replaceAll("<", "' + bs + bs + 'u003c")'), "page.ts must replace < with the JSON escape");
});
