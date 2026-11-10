// pnpm cut: times, the refusals, the file name, the key and the FFmpeg arguments. Pure functions; no FFmpeg.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { cutArgs, cutFade, cutKey, cutName, CutRefusal, isCutName, parseCutArgs, parseTime, planCut, RECIPE, tenths } from "../src/share/cut.ts";

test("parseTime: seconds and m:ss.s", () => {
  assert.equal(parseTime("4.5"), 4.5);
  assert.equal(parseTime("12"), 12);
  assert.equal(parseTime("0:04.5"), 4.5);
  assert.equal(parseTime("1:02"), 62);
  assert.equal(parseTime("2:5.25"), 125.25);
  for (const bad of ["", "abc", "4,5", "1:60", "1:2:3", ".5", "4.", "-1", "1e2", "0:-4"]) assert.throws(() => parseTime(bad), /not a time/, bad);
});

test("parseCutArgs", () => {
  assert.deepEqual(parseCutArgs(["259", "4.5", "18.2"]), { no: 259, from: 4.5, to: 18.2, json: false });
  assert.deepEqual(parseCutArgs(["12", "0:04.5", "0:12", "--json"]), { no: 12, from: 4.5, to: 12, json: true });
  assert.deepEqual(parseCutArgs(["12", "-1", "5"]), { no: 12, from: -1, to: 5, json: false }, "a negative time parses, planCut refuses it");
  assert.throws(() => parseCutArgs([]), /usage/);
  assert.throws(() => parseCutArgs(["12", "4.5"]), /usage/);
  assert.throws(() => parseCutArgs(["12", "4.5", "8", "9"]), /usage/);
  assert.throws(() => parseCutArgs(["0", "4.5", "8"]), /clip number/);
  assert.throws(() => parseCutArgs(["x", "4.5", "8"]), /clip number/);
  assert.throws(() => parseCutArgs(["12", "four", "8"]), /not a time/);
  assert.throws(() => parseCutArgs(["12", "4", "8", "--fast"]), /unexpected/);
});

test("planCut: the refusals", () => {
  const refused = (from: number, to: number, re: RegExp) => assert.throws(() => planCut(from, to, 14.83), (e: Error) => e instanceof CutRefusal && re.test(e.message), `${from}-${to}`);
  refused(-0.1, 5, /before the clip starts/);
  refused(4, 14.9, /past the clip's end/);
  refused(4, 4.9, /at least 1 s/);
  refused(8, 4, /at least 1 s/);
  refused(0, 14.83, /whole clip/);
  refused(0.08, 14.79, /whole clip/);
  refused(NaN, 5, /numbers/);
});

test("planCut: clamps inside the end slack, rounds to the millisecond, a 1 s cut is fine", () => {
  assert.deepEqual(planCut(4, 14.87, 14.83), { from: 4, to: 14.83 });
  assert.deepEqual(planCut(4.5, 12, 14.83), { from: 4.5, to: 12 });
  assert.deepEqual(planCut(4.51666666, 5.51666666, 14.83), { from: 4.517, to: 5.517 });
  assert.deepEqual(planCut(0, 14.6, 14.83), { from: 0, to: 14.6 }, "one end trimmed is a cut");
  assert.deepEqual(planCut(0.2, 14.83, 14.83), { from: 0.2, to: 14.83 });
});

test("cutName: tenths without a dot, four digits or more", () => {
  const e = { no: 259, title: "de_dust2 · R18 · 2k Tec-9" };
  assert.equal(cutName(e, 4.5, 18.2), "259-de-dust2-r18-2k-tec-9_0045-0182.mp4");
  assert.equal(cutName(e, 0, 1), "259-de-dust2-r18-2k-tec-9_0000-0010.mp4");
  assert.equal(tenths(182.04), "1820");
  assert.equal(tenths(1234.5), "12345");
  assert.ok(isCutName(e, "259-de-dust2-r18-2k-tec-9_0045-0182.mp4"));
  for (const bad of ["258-de-dust2-r18-2k-tec-9_0045-0182.mp4", "259-de-dust2-r18-2k-tec-9_0045-0182.mp4.tmp.mp4x", "259-de-dust2-r18-2k-tec-9_../x_0045-0182.mp4", "259-de-dust2-r18-2k-tec-9_45-182.mp4"]) assert.ok(!isCutName(e, bad), bad);
});

test("cutKey: changes with from, to, the fade, the CRF, the source and the recipe", () => {
  const base = { id: "b359ef8784b05b96", bytes: 38507147, mtimeMs: 1760530260000, from: 4.5, to: 12, fadeSeconds: 0.25, settings: { crf: 18 } };
  const k = cutKey(base);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(cutKey({ ...base, recipe: RECIPE }), k);
  assert.equal(cutKey({ ...base, from: 4.5000001 }), k, "below a millisecond is the same cut");
  for (const [what, v] of [["from", { from: 4.6 }], ["to", { to: 12.1 }], ["fade", { fadeSeconds: 0.5 }], ["crf", { settings: { crf: 20 } }], ["re-render", { mtimeMs: base.mtimeMs + 1000 }], ["recipe", { recipe: RECIPE + 1 }]] as const)
    assert.notEqual(cutKey({ ...base, ...v }), k, what);
});

test("cutArgs: input seek and length, fades capped at a quarter of the cut, raw sound", () => {
  const p = { source: "src.mp4", dest: "out.mp4", from: 4.5, to: 12, fade: 0.25, crf: 18, audio: true, key: "abc" };
  const a = cutArgs(p);
  const at = (flag: string) => a[a.indexOf(flag) + 1];
  assert.ok(a.indexOf("-ss") < a.indexOf("-i") && a.indexOf("-t") < a.indexOf("-i"), "an input seek: frame-accurate, decoded");
  assert.equal(at("-ss"), "4.500");
  assert.equal(at("-t"), "7.500");
  assert.equal(at("-vf"), "fade=t=in:st=0:d=0.25,fade=t=out:st=7.250000:d=0.25");
  assert.equal(at("-af"), "afade=t=in:st=0:d=0.25,afade=t=out:st=7.250000:d=0.25");
  assert.ok(!a.includes("copy"), "never a stream copy");
  assert.deepEqual([at("-c:v"), at("-preset"), at("-crf"), at("-pix_fmt"), at("-c:a"), at("-b:a"), at("-movflags"), at("-metadata")], ["libx264", "slow", "18", "yuv420p", "aac", "192k", "+faststart", "comment=croclipper-cut:abc"]);
  assert.equal(a[a.length - 1], "out.mp4");
  // A 1.2 s cut with a 0.5 s fade gets 0.3 s at each end.
  assert.equal(cutFade(0.5, 1.2), 0.3);
  const short = cutArgs({ ...p, from: 2, to: 3.2, fade: 0.5 });
  assert.equal(short[short.indexOf("-vf") + 1], "fade=t=in:st=0:d=0.3,fade=t=out:st=0.900000:d=0.3");
  const none = cutArgs({ ...p, fade: 0, audio: false });
  assert.ok(!none.includes("-vf") && !none.includes("-af") && none.includes("-an"));
});
