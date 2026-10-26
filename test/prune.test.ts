// Raw capture pruning (src/queue/prune.ts): a unit's take media goes after its publish, the sweep
// takes only held clips' media, a record's path is re-rooted under this checkout's state/render/,
// and nothing outside it or not named like capture media is ever deleted.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localRenderPath, pruneHeldCaptures, pruneTakes, sweepUnderClipLock } from "../src/queue/prune.ts";
import { RenderLock } from "../src/render/controller/guards.ts";

/** A render dir with one single-take clip and one chained launch two clips point into. */
function setup() {
  const renderDir = path.join(mkdtempSync(path.join(tmpdir(), "croclip-prune-")), "state", "render");
  const put = (rel: string, bytes = 16) => { const f = path.join(renderDir, ...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, Buffer.alloc(bytes, 1)); return f; };
  const single = { video: put("aaaa/1/hlae/video.mp4", 1000), audio: put("aaaa/1/hlae/take0000/audio.wav", 100) };
  writeFileSync(path.join(renderDir, "aaaa", "1", "capture.json"), JSON.stringify({ renderKey: "k", mapping: {}, ...single })); // the pre-reels shape
  const launch = "launch-dddd-2";
  const t = (i: number) => ({ video: put(`${launch}/hlae/video${i}.mp4`, 1000), audio: put(`${launch}/hlae/take000${i}/audio.wav`, 100) });
  const bbbb = [t(0), t(1)], cccc = [t(2)];
  for (const [id, takes] of [["bbbb", bbbb], ["cccc", cccc]] as const) {
    mkdirSync(path.join(renderDir, id, "2"), { recursive: true });
    writeFileSync(path.join(renderDir, id, "2", "capture.json"), JSON.stringify({ renderKey: "k", takes: takes.map((x) => ({ mapping: {}, ...x })) }));
  }
  const keep = [put(`${launch}/console.log`), put(`${launch}/render.json`), put("aaaa/1/console.log"), put("aaaa/1/usrlocal/cfg/croclip_look.cfg")];
  return { renderDir, single, bbbb, cccc, keep };
}

test("pruneTakes deletes a unit's take media and nothing else; a file already gone is not a problem", () => {
  const { renderDir, bbbb, cccc, keep } = setup();
  const r = pruneTakes(bbbb, renderDir);
  assert.deepEqual(r, { files: 4, bytes: 2200, problems: [] });
  for (const f of bbbb.flatMap((x) => [x.video, x.audio])) assert.ok(!existsSync(f), f);
  for (const f of [...cccc.flatMap((x) => [x.video, x.audio]), ...keep]) assert.ok(existsSync(f), f);
  assert.deepEqual(pruneTakes(bbbb, renderDir), { files: 0, bytes: 0, problems: [] });
});

test("a path outside the render dir, or not a capture file, is left alone and reported", () => {
  const { renderDir, keep } = setup();
  const outside = path.join(path.dirname(path.dirname(renderDir)), "elsewhere.mp4");
  writeFileSync(outside, "x");
  const r = pruneTakes([{ video: outside, audio: keep[0] }], renderDir);
  assert.equal(r.files, 0);
  assert.equal(r.problems.length, 2);
  assert.ok(existsSync(outside) && existsSync(keep[0]));
});

test("a recorded path is re-rooted under this checkout's state/render/", () => {
  const here = path.join("D:", "new", "state", "render");
  assert.equal(localRenderPath("C:\\Users\\x\\croclipper\\state\\render\\abcd\\1\\hlae\\video.mp4", here), path.join(here, "abcd", "1", "hlae", "video.mp4"));
  assert.equal(localRenderPath("/home/x/cs/state/render/launch-a-1/hlae/take0001/audio.wav", here), path.join(here, "launch-a-1", "hlae", "take0001", "audio.wav"));
  assert.equal(localRenderPath("C:\\elsewhere\\video.mp4", here), "C:\\elsewhere\\video.mp4");
});

test("the sweep prunes held clips only, through both capture shapes, and leaves the rest of the launch dir", () => {
  const { renderDir, single, bbbb, cccc, keep } = setup();
  const r = pruneHeldCaptures({ renderDir, held: new Set(["aaaa", "bbbb"]) });
  assert.deepEqual(r, { files: 6, bytes: 3300, problems: [], clips: 2 });
  for (const f of [single, ...bbbb].flatMap((x) => [x.video, x.audio])) assert.ok(!existsSync(f), f);
  for (const f of [...cccc.flatMap((x) => [x.video, x.audio]), ...keep]) assert.ok(existsSync(f), f);
  assert.ok(existsSync(path.join(renderDir, "aaaa", "1", "capture.json")));
  // A second sweep finds nothing; a render dir that does not exist is fine.
  assert.deepEqual(pruneHeldCaptures({ renderDir, held: new Set(["aaaa", "bbbb"]) }), { files: 0, bytes: 0, problems: [], clips: 0 });
  assert.deepEqual(pruneHeldCaptures({ renderDir: path.join(renderDir, "nope"), held: new Set(["aaaa"]) }), { files: 0, bytes: 0, problems: [], clips: 0 });
  assert.deepEqual(readdirSync(path.join(renderDir, "launch-dddd-2")).sort(), ["console.log", "hlae", "render.json"]);
});

test("a path that only looks like it is under the render dir (through a junction) is left alone", () => {
  const { renderDir } = setup();
  const outsideDir = path.join(path.dirname(path.dirname(renderDir)), "outside");
  mkdirSync(outsideDir);
  const target = path.join(outsideDir, "video.mp4");
  writeFileSync(target, "x");
  symlinkSync(outsideDir, path.join(renderDir, "jjjj"), "junction");
  const viaJunction = path.join(renderDir, "jjjj", "video.mp4");
  assert.ok(existsSync(viaJunction));
  const r = pruneTakes([{ video: viaJunction, audio: viaJunction }], renderDir);
  assert.equal(r.files, 0);
  assert.equal(r.problems.length, 2);
  assert.ok(existsSync(target));
});

test("the sweep runs under the clip lock and is skipped, not queued, while a clip run holds it", () => {
  const { renderDir, single } = setup();
  const lockFile = path.join(path.dirname(renderDir), ".clip.lock");
  const held = new RenderLock(lockFile);
  held.acquire();
  assert.equal(sweepUnderClipLock({ renderDir, held: new Set(["aaaa"]), lockFile }), undefined);
  assert.ok(existsSync(single.video));
  held.release();
  const r = sweepUnderClipLock({ renderDir, held: new Set(["aaaa"]), lockFile });
  assert.equal(r?.files, 2);
  assert.ok(!existsSync(single.video) && !existsSync(lockFile));
});

test("a capture.json that does not parse is a problem, not a throw", () => {
  const { renderDir } = setup();
  writeFileSync(path.join(renderDir, "aaaa", "1", "capture.json"), "{not json");
  const r = pruneHeldCaptures({ renderDir, held: new Set(["aaaa"]) });
  assert.equal(r.files, 0);
  assert.equal(r.problems.length, 1);
});
