// State paths (src/state-paths.ts): stored relative to the root with forward slashes, resolved on
// read, and an old absolute path re-rooted under this checkout by its tail when the file is here.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromStored, tailUnder, toStored } from "../src/state-paths.ts";

const root = mkdtempSync(path.join(tmpdir(), "croclip-paths-"));
const old = `${root}-old`; // where the repo used to be, beside the root, not under it; no files there unless a test puts them
const here = (...p: string[]) => path.join(root, ...p);
const put = (f: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, "x"); return f; };

test("toStored: under the root relative with forward slashes; elsewhere, or the root itself, unchanged", () => {
  assert.equal(toStored(here("demos", "store", "ab.dem"), root), "demos/store/ab.dem");
  assert.equal(toStored(here("state", "render", "id", "1", "hlae", "video.mp4"), root), "state/render/id/1/hlae/video.mp4");
  assert.equal(toStored(path.join(old, "demos", "x.dem"), root), path.join(old, "demos", "x.dem"));
  assert.equal(toStored(root, root), root);
});

test("fromStored: relative resolves under the root; an absolute path that exists is itself; one that is gone is re-rooted by its tail", () => {
  assert.equal(fromStored("state/render/ab/1/hlae/video.mp4", "state/render", root), here("state", "render", "ab", "1", "hlae", "video.mp4"));
  // The recorded file exists: it is used, even when a file of the same name exists here.
  const ours = put(here("state", "render", "cd", "1", "hlae", "video.mp4"));
  const theirs = put(path.join(old, "state", "render", "cd", "1", "hlae", "video.mp4"));
  assert.equal(fromStored(theirs, "state/render", root), theirs);
  // Gone: re-rooted here, whether or not ours exists (a message then names the place it should be).
  assert.equal(fromStored(path.join(old, "state", "render", "cd", "1", "hlae", "audio.wav"), "state/render", root), here("state", "render", "cd", "1", "hlae", "audio.wav"));
  assert.ok(ours);
  // No such subtree in the path: as it is. Either separator works.
  assert.equal(fromStored("C:\\elsewhere\\video.mp4", "state/render", root), "C:\\elsewhere\\video.mp4");
  assert.equal(fromStored("C:/old/state/render/launch-a-1/hlae/take0001/audio.wav", "state/render", root), here("state", "render", "launch-a-1", "hlae", "take0001", "audio.wav"));
});

test("tailUnder: the components after the last occurrence, case-insensitive on the subtree", () => {
  assert.deepEqual(tailUnder("C:\\a\\state\\render\\x\\State\\Render\\y\\z.mp4", "state/render"), ["y", "z.mp4"]);
  assert.deepEqual(tailUnder("state/render/y/z.mp4", "state/render"), ["y", "z.mp4"]);
  assert.equal(tailUnder("C:\\a\\state\\x.json", "state/render"), undefined);
  assert.equal(tailUnder("C:\\a\\state\\render", "state/render"), undefined);
});
