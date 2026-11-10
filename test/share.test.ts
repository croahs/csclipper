// pnpm share: the bitrate ladder, the caption and the arguments. Pure functions; no FFmpeg.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareCaption } from "../src/share/caption.ts";
import { MB, parseShareArgs, planShare, shareName } from "../src/share/index.ts";

const hd = { width: 1920, height: 1080, fps: 60, audio: true };

test("planShare: a short clip gets 1080p60 at the bitrate that fills ~94 % of the limit", () => {
  const p = planShare({ ...hd, seconds: 20 }, 20 * MB);
  assert.ok(p.ok);
  assert.deepEqual([p.width, p.height, p.fps, p.audioKbps], [1920, 1080, 60, 128]);
  // video + audio over the clip stays under the limit
  assert.ok(((p.videoKbps + p.audioKbps) * 1000 * 20) / 8 < 20 * MB * 0.95);
  assert.ok(p.videoKbps >= 5000);
});

test("planShare: steps down the ladder as the clip gets longer", () => {
  const rung = (seconds: number) => { const p = planShare({ ...hd, seconds }, 20 * MB); return p.ok ? `${p.height}p${p.fps}` : "refused"; };
  assert.equal(rung(31), "720p60"); // about 4.9 Mbps: under the 1080p60 floor
  assert.equal(rung(80), "720p30");
  assert.equal(rung(198), "480p30");
  assert.equal(rung(400), "refused");
});

test("planShare: refuses below the floor and names a limit that works", () => {
  const p = planShare({ ...hd, seconds: 198 }, 5 * MB);
  assert.equal(p.ok, false);
  if (p.ok) return;
  assert.match(p.reason, /too long for 5 MB/);
  assert.match(p.reason, new RegExp(`limit of ${p.neededMb} MB`));
  const again = planShare({ ...hd, seconds: 198 }, p.neededMb * MB);
  assert.ok(again.ok, "the named limit is enough");
  assert.equal(planShare({ ...hd, seconds: 198 }, (p.neededMb - 1) * MB).ok, false, "and one MB less is not");
});

test("planShare: never upscales a smaller or slower source", () => {
  const p = planShare({ width: 1280, height: 720, fps: 30, audio: true, seconds: 10 }, 20 * MB);
  assert.ok(p.ok);
  assert.deepEqual([p.width, p.height, p.fps], [1280, 720, 30]);
  // 4:3 at 1080 stepping down keeps its aspect, even width
  const q = planShare({ width: 1440, height: 1080, fps: 60, audio: false, seconds: 120 }, 20 * MB);
  assert.ok(q.ok);
  assert.equal(q.audioKbps, 0);
  assert.equal(q.width, Math.round((1440 * q.height) / 1080 / 2) * 2);
  assert.ok(q.height <= 1080 && q.fps <= 60);
});

test("shareCaption: highlight, hand-picked range and both reels", () => {
  assert.equal(shareCaption({ title: "de_cache · R12 · 3k Deagle clutch", map: "de_cache", round: 12 }), "3k Deagle clutch · Cache · round 12 #CS2");
  assert.equal(shareCaption({ title: "de_inferno · R20 · 3k Tec-9 · 1v5 clutch (lost)", map: "de_inferno", round: 20, kind: "highlight" }), "3k Tec-9 · 1v5 clutch (lost) · Inferno · round 20 #CS2");
  assert.equal(shareCaption({ title: "de_inferno · R1 · ticks 5669-6103", map: "de_inferno", round: 1 }), "Inferno · round 1 #CS2");
  assert.equal(shareCaption({ title: "de_dust2 · R18 · 2k Tec-9", round: 18 }), "2k Tec-9 · Dust2 · round 18 #CS2", "map taken from the title");
  const takes = (n: number) => ({ takes: Array.from({ length: n }, () => ({})) });
  assert.equal(shareCaption({ title: "de_cache · deaths", map: "de_cache", round: 1, kind: "deaths", reel: takes(9) }), "Cache · all 9 deaths from the killer's view #CS2");
  assert.equal(shareCaption({ title: "de_cache · kills", map: "de_cache", round: 1, kind: "kills", reel: takes(22) }), "Cache · all 22 kills from the victim's view #CS2");
  assert.equal(shareCaption({ title: "de_nuke · kills", map: "de_nuke", round: 1, kind: "kills", reel: takes(1) }), "Nuke · 1 kill from the victim's view #CS2");
});

test("shareName: clip number and a file-safe slug of the title", () => {
  assert.equal(shareName({ no: 12, title: "de_cache · R12 · 3k Deagle clutch" }), "12-de-cache-r12-3k-deagle-clutch.mp4");
  assert.equal(shareName({ no: 3, title: "<>:\"/\\|?*" }), "3-clip.mp4");
});

test("parseShareArgs", () => {
  assert.deepEqual(parseShareArgs(["12"]), { no: 12, maxMb: undefined, json: false });
  assert.deepEqual(parseShareArgs(["12", "--max-mb", "8.5"]), { no: 12, maxMb: 8.5, json: false });
  assert.deepEqual(parseShareArgs(["--max-mb", "50", "7", "--json"]), { no: 7, maxMb: 50, json: true });
  assert.throws(() => parseShareArgs([]), /usage/);
  assert.throws(() => parseShareArgs(["0"]), /unexpected/);
  assert.throws(() => parseShareArgs(["12", "13"]), /unexpected/);
  assert.throws(() => parseShareArgs(["12", "--max-mb"]), /--max-mb/);
  assert.throws(() => parseShareArgs(["12", "--max-mb", "-3"]), /--max-mb/);
  assert.throws(() => parseShareArgs(["../x.mp4"]), /unexpected/);
});

// Review findings, 2026-11-10 (GPT-6.1 Sol).
test("planShare tries every rung for a small source: the later rung's lower audio budget can fit", () => {
  const p = planShare({ width: 854, height: 480, fps: 30, seconds: 260, audio: true }, 20 * MB);
  assert.equal(p.ok, true);
  if (p.ok) { assert.equal(p.audioKbps, 96); assert.equal(p.height, 480); }
});

test("planShare gives even sizes and never upscales an odd source", () => {
  const p = planShare({ width: 1279, height: 719, fps: 60, seconds: 20, audio: true }, 20 * MB);
  assert.equal(p.ok, true);
  if (p.ok) { assert.equal(p.width % 2, 0); assert.equal(p.height % 2, 0); assert.ok(p.width <= 1279 && p.height <= 719); }
});

test("the limit a refusal suggests is one planShare accepts", () => {
  for (const seconds of [264.75, 300, 431.3, 600]) {
    const src = { width: 1920, height: 1080, fps: 29.97, seconds, audio: true };
    const p = planShare(src, 5 * MB);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(planShare(src, p.neededMb * MB).ok, true, `${seconds} s at ${p.neededMb} MB`);
  }
});
