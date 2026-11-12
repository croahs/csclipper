// pnpm week (the fragmovie): ISO weeks, week assignment by the page's date rule, selection, the
// shots around kills, their placement on the beat grid, the cap, the key, and the music manifest.
// Pure functions and temp folders; no FFmpeg, no library files.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClipEntry } from "../src/library/index.ts";
import { clipDate, matchDateOf } from "../src/library/match-date.ts";
import { buildShots, fastRanges, fitCap, killVideoTime, layout, tickSeconds, toFrames, type ClipCut, type Segment } from "../src/week/edit.ts";
import {
  cutInfo, isoWeekOf, latestWeek, montageKey, parseIsoWeek, parseWeekArgs, rangeLabel, selectWeek, shotLabel,
  weekCaption, weekLabel, weekRange, weeksInYear, WeekRefusal, type Dated, type KeyInput,
} from "../src/week/index.ts";
import { checkTracks, fetchTrack, loadManifest, pickTrack } from "../src/week/music.ts";

const wk = (y: number, m: number, d: number) => weekLabel(isoWeekOf(new Date(y, m - 1, d)));

test("isoWeekOf: year boundaries and week 53", () => {
  assert.equal(wk(2026, 12, 31), "2026-W53"); // Thursday: 2026 has 53 weeks
  assert.equal(wk(2027, 1, 1), "2026-W53"); // Friday, still 2026's last week
  assert.equal(wk(2027, 1, 3), "2026-W53"); // Sunday ends it
  assert.equal(wk(2027, 1, 4), "2027-W01"); // Monday
  assert.equal(wk(2024, 12, 30), "2025-W01"); // a Monday in December belongs to the next year
  assert.equal(wk(2026, 11, 10), "2026-W46");
  assert.equal(weeksInYear(2026), 53);
  assert.equal(weeksInYear(2027), 52);
});

test("parseIsoWeek, weekRange and rangeLabel", () => {
  assert.deepEqual(parseIsoWeek("2026-W45"), { year: 2026, week: 45 });
  assert.deepEqual(parseIsoWeek("2026-W53"), { year: 2026, week: 53 });
  assert.throws(() => parseIsoWeek("2027-W53"), /2027 has 52 weeks/);
  assert.throws(() => parseIsoWeek("2026-45"), /not an ISO week/);
  const r = weekRange({ year: 2026, week: 45 });
  assert.equal(r.start.getTime(), new Date(2026, 10, 2).getTime()); // Monday 2 Nov, local midnight
  assert.equal(r.end.getTime(), new Date(2026, 10, 9).getTime());
  assert.equal(weekRange({ year: 2026, week: 53 }).start.getTime(), new Date(2026, 11, 28).getTime());
  assert.equal(rangeLabel({ year: 2026, week: 45 }), "2–8 Nov 2026");
  assert.equal(rangeLabel({ year: 2026, week: 44 }), "26 Oct – 1 Nov 2026");
  assert.equal(rangeLabel({ year: 2026, week: 53 }), "28 Dec 2026 – 3 Jan 2027");
  // every week of a year maps back to itself
  for (const year of [2026, 2027]) for (let week = 1; week <= weeksInYear(year); week++) assert.deepEqual(isoWeekOf(weekRange({ year, week }).start), { year, week });
});

test("week assignment: the FACEIT match date, else the day the demo was added, else the clip's own date", () => {
  const id = "1-8e8743a8-4f10-4d4d-ad39-859ccae31fa6";
  const demo = { originalName: `${id}-1-1.dem`, addedAt: "2026-11-10T12:00:00.000Z" }; // added in W46
  const played = Date.UTC(2026, 10, 4, 12) / 1000; // played Wednesday of W45
  const byFaceit = matchDateOf(demo, { [id]: played });
  assert.equal(byFaceit.dateFrom, "faceit");
  assert.equal(weekLabel(isoWeekOf(new Date(clipDate(byFaceit, "2026-11-12T12:00:00Z")))), "2026-W45");
  const byAdded = matchDateOf(demo, {});
  assert.deepEqual(byAdded, { matchDate: "2026-11-10T12:00:00.000Z", dateFrom: "added" });
  assert.equal(weekLabel(isoWeekOf(new Date(clipDate(byAdded, "2026-11-12T12:00:00Z")))), "2026-W46");
  const mm = matchDateOf({ originalName: "match730_003.dem", addedAt: "2026-11-03T12:00:00Z" }, { [id]: played });
  assert.equal(mm.dateFrom, "added"); // no FACEIT id in the name
  const none = matchDateOf(undefined, {});
  assert.deepEqual(none, { matchDate: null, dateFrom: null });
  assert.equal(clipDate(none, "2026-11-12T12:00:00Z"), "2026-11-12T12:00:00Z");
});

const clip = (o: { no: number; score?: number; date?: string; exists?: boolean; kind?: ClipEntry["kind"]; old?: boolean }): Dated => ({
  entry: {
    id: `id${o.no}`, no: o.no, file: `clips/id${o.no}.mp4`, title: `de_cache · R${o.no} · ${o.no}k`, demo: "d", demoSha256: "s", round: o.no, startTick: 0, endTick: 640,
    seconds: 10, frames: 600, createdAt: "2026-11-01T00:00:00Z", renderKey: "k", kind: o.kind,
    render: o.old ? {} : { segments: [{ startTick: 0, endTick: 640, speed: 1, outSeconds: 10 }] },
    ...(o.score === undefined ? {} : { moment: { score: o.score, ...(o.old ? {} : { killTicks: [320] }) } }),
  } as ClipEntry,
  date: o.date ?? "2026-11-04T12:00:00Z", exists: o.exists ?? true,
});
const W45 = { year: 2026, week: 45 };

test("selectWeek: the top n by score, played in ascending order (best last)", () => {
  const clips = [clip({ no: 1, score: 50 }), clip({ no: 2, score: 90 }), clip({ no: 3, score: 70 }), clip({ no: 4, score: 120 }), clip({ no: 5, score: 60 })];
  const s = selectWeek(clips, W45, 3);
  assert.deepEqual(s.picked.map((e) => e.no), [3, 2, 4]);
  assert.deepEqual(selectWeek(clips, W45, 8).picked.map((e) => e.no), [1, 5, 3, 2, 4]);
  // ties: lower clip number first
  assert.deepEqual(selectWeek([clip({ no: 7, score: 80 }), clip({ no: 6, score: 80 })], W45, 8).picked.map((e) => e.no), [6, 7]);
});

test("selectWeek: only highlights of that week; no score, no kill ticks and missing files are skipped and named", () => {
  const clips = [
    clip({ no: 1, score: 50 }), clip({ no: 2, score: 300, kind: "deaths" }), clip({ no: 3, score: 80, kind: "highlight" }),
    clip({ no: 4 }), clip({ no: 5, score: 999, exists: false }), clip({ no: 6, score: 400, date: "2026-11-09T12:00:00Z" }), // W46
    clip({ no: 7, score: 60 }), clip({ no: 8, score: 500, old: true }),
  ];
  const s = selectWeek(clips, W45, 8);
  assert.deepEqual(s.picked.map((e) => e.no), [1, 7, 3]);
  assert.deepEqual(s.skipped.map((x) => [x.no, x.reason.split(" (")[0]]), [[4, "no score"], [5, "file missing"], [8, "no kill ticks or time map"]]);
  assert.equal(s.candidates, 6);
});

test("selectWeek: fewer than 2 to show is a refusal that names the skips", () => {
  assert.throws(() => selectWeek([clip({ no: 1, score: 50 }), clip({ no: 2, score: 60, exists: false })], W45, 8), (e) => e instanceof WeekRefusal && /1 highlight to show of 2.*2 \(file missing\)/.test(e.message));
  assert.throws(() => selectWeek([clip({ no: 1, score: 50 })], { year: 2026, week: 44 }, 8), WeekRefusal);
});

test("latestWeek: the most recent week with a highlight; reels do not count", () => {
  assert.deepEqual(latestWeek([clip({ no: 1, score: 1 }), clip({ no: 2, kind: "kills", date: "2026-11-20T12:00:00Z" }), clip({ no: 3, date: "2026-11-10T12:00:00Z" })]), { year: 2026, week: 46 });
  assert.equal(latestWeek([clip({ no: 2, kind: "deaths" })]), undefined);
});

// --- the edit -------------------------------------------------------------------------------

// 64 ticks/s: 2 s at speed 1, 32 s of demo at 8x (4 s), 3 s at speed 1: a 9 s clip.
const SEGS: Segment[] = [
  { startTick: 1000, endTick: 1128, speed: 1, outSeconds: 2 },
  { startTick: 1128, endTick: 3176, speed: 8, outSeconds: 4 },
  { startTick: 3176, endTick: 3368, speed: 1, outSeconds: 3 },
];
const RULES = { preSeconds: 0.9, postSeconds: 0.5 };
const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

test("tickSeconds: through a fast-forward stretch in the middle", () => {
  assert.equal(tickSeconds(SEGS, 1064), 1); // before it
  assert.equal(tickSeconds(SEGS, 1128), 2);
  assert.equal(tickSeconds(SEGS, 2152), 4); // inside it: half of 2048 ticks at 8x = 2 s in
  assert.equal(tickSeconds(SEGS, 3176), 6);
  assert.equal(tickSeconds(SEGS, 3240), 7); // after it: one more second
  assert.equal(tickSeconds(SEGS, 900), 0); // clamped
  assert.equal(tickSeconds(SEGS, 9999), 9);
  assert.deepEqual(fastRanges(SEGS), [[2, 6]]);
});

test("buildShots: single kills, a merged burst, clamping at both ends and at a fast-forward stretch", () => {
  const plain = buildShots([1, 3, 3.9, 8.8], 9.2, [], RULES);
  assert.ok(near(plain.map((s) => s.from), [0.1, 2.1, 7.9]) && near(plain.map((s) => s.to), [1.5, 4.4, 9.2]), "clamped at the clip's end");
  assert.deepEqual(plain.map((s) => s.kills), [[1], [3, 3.9], [8.8]]);
  assert.equal(buildShots([1, 2.4], 10, [], RULES).length, 1, "shots that touch merge");
  assert.equal(buildShots([1, 2.41], 10, [], RULES).length, 2);
  assert.deepEqual(buildShots([0.3], 10, [], RULES).map((s) => s.from), [0], "clamped at the clip's start");
  // A kill just after the 8x stretch [2, 6]: its lead-in starts at the stretch's end, not inside it.
  const ff = fastRanges(SEGS);
  const after = buildShots([6.4], 9, ff, RULES)[0];
  assert.ok(near([after.from, after.to, after.leadLimit], [6, 6.9, 6]));
  const before = buildShots([1.8], 9, ff, RULES)[0];
  assert.ok(near([before.from, before.to, before.tailLimit], [0.9, 2, 2]));
  // Synthetic: a kill inside the stretch plays the whole stretch, never cut inside it.
  const inside = buildShots([tickSeconds(SEGS, 2152)], 9, ff, RULES)[0];
  assert.deepEqual([inside.from, inside.to], [2, 6]);
  // Two kills inside one stretch are both widened to it: one shot, each kill once, never two
  // shots over the same footage.
  const both = buildShots([3, 5], 9, [[2, 6]], RULES);
  assert.deepEqual(both.map((s) => [s.from, s.to, s.kills]), [[2, 6, [3, 5]]]);
  assert.ok(both[0].leadLimit === 0 && both[0].tailLimit === 9);
  // A kill inside the stretch and one just after it: the first is widened to [2, 6], the second's
  // lead-in starts at 6; they touch, not overlap, so they stay two shots.
  assert.deepEqual(buildShots([4, 6.5], 9, [[2, 6]], RULES).map((s) => [s.from, s.to]), [[2, 6], [6, 7]]);
  // Two kills on either side of the stretch never merge, even when close in clip seconds.
  assert.equal(buildShots([1.9, 6.1], 9, ff, RULES).length, 2);
  // Neighbouring shots of the same clip limit each other's stretching.
  const two = buildShots([2, 5], 20, [], RULES);
  assert.ok(near([two[0].tailLimit, two[1].leadLimit], [4.1, 2.5]));
});

test("a clip without kill ticks cannot be cut", () => {
  assert.equal(cutInfo(clip({ no: 1, score: 5, old: true }).entry), undefined);
  assert.ok(cutInfo(clip({ no: 1, score: 5 }).entry));
});

const BAR = (4 * 60) / 175, UNIT = BAR; // 175 BPM: the unit is one bar, every anchored kill on the one
const G = { unit: UNIT, bar: BAR };
const DEF = { preSeconds: 0.65, postSeconds: 0.4 }; // config.json's shot defaults
const offGrid = (t: number, step: number) => Math.abs(t / step - Math.round(t / step)) * step;
/** A clip with kills at the given clip seconds, cut with the default shot rules. */
const cc = (clipNo: number, kills: number[], seconds = 20): ClipCut => ({ clip: clipNo, shots: buildShots(kills, seconds, [], DEF) });

/** No frame of a clip plays twice: within each clip, every shot starts at or after the previous one's end. */
function noRepeats(tl: ReturnType<typeof layout>) {
  const lastTo = new Map<number, number>();
  for (const [i, p] of tl.shots.entries()) {
    const t = lastTo.get(p.clip);
    assert.ok(t === undefined || p.from >= t - 1e-9, `shot ${i} (clip ${p.clip}) starts at ${p.from}, before the previous shot's end ${t}`);
    lastTo.set(p.clip, p.to - p.hold);
  }
}

test("layout: every first kill on an anchor (to half a frame), cuts never overlap, tails fill the slack", () => {
  const clips = [cc(0, [5, 9.3, 9.9]), cc(1, [4, 4.6, 12]), cc(2, [6, 7.7, 15])];
  const tl = layout(clips, G);
  const fr = toFrames(tl, 60);
  for (const [i, s] of fr.shots.entries()) {
    assert.ok(offGrid(s.anchor, UNIT) < 1e-9, `shot ${i} anchor ${s.anchor} is a bar line`);
    assert.ok(Math.abs(killVideoTime(s, s.kills[0], 60) - s.anchor) <= 0.5 / 60 + 1e-9, `shot ${i}: first kill within half a frame of its anchor`);
    assert.ok(s.frames > 0);
    if (i > 0) assert.equal(s.cutFrame, fr.shots[i - 1].cutFrame + fr.shots[i - 1].frames, "cuts butt, never overlap");
  }
  for (const [i, p] of tl.shots.entries()) {
    assert.ok(p.to >= p.kills[p.kills.length - 1] + 0.25 - 1e-9, `shot ${i} keeps its last kill on screen`);
    assert.ok(Math.abs(p.to - p.from - (p.end - p.cut)) < 1e-9, `shot ${i} fills its whole slot`);
  }
  assert.equal(tl.shots.reduce((n, p) => n + p.hold, 0), 0, "20 s clips: nothing held");
  noRepeats(tl);
});

test("layout: when the tail cannot fill the slack, the next lead-in starts earlier", () => {
  // The first clip ends 0.2 s after its kill's post-roll: its tail cannot stretch further.
  const tl = layout([cc(0, [5], 5.6), cc(1, [8])], G);
  const [a, b] = tl.shots;
  assert.ok(Math.abs(a.to - 5.6) < 1e-9 && a.hold === 0);
  assert.ok(b.kills[0] - b.from > DEF.preSeconds, "the second shot's lead-in took the rest");
  assert.ok(Math.abs(a.end - b.cut) < 1e-12 && Math.abs(b.cut - (b.anchor - (b.kills[0] - b.from))) < 1e-9);
});

test("layout: a gap too short to fill merges two shots of a clip instead of repeating footage", () => {
  let merges = 0;
  // Two kills of one clip whose shots do not touch (more than pre + post apart), at every spacing
  // up to a bar and a half; the gap between them is often shorter than the slack before the next anchor.
  for (let d = 1.06; d <= 2.1; d += 0.01) {
    const tl = layout([cc(0, [3, 3 + d]), cc(1, [5])], G);
    noRepeats(tl);
    const fr = toFrames(tl, 60);
    for (const s of fr.shots) assert.ok(Math.abs(killVideoTime(s, s.kills[0], 60) - s.anchor) <= 0.5 / 60 + 1e-9);
    const first = tl.shots[0];
    if (first.merged) {
      merges++;
      assert.deepEqual(first.kills, [3, 3 + d], "one continuous shot with both kills");
      assert.equal(tl.shots[1].clip, 1);
      assert.ok(Math.abs(first.to - first.from - (first.end - first.cut)) < 1e-9 && first.hold === 0, "played straight through, nothing held");
    } else assert.equal(tl.shots.length, 3);
  }
  assert.ok(merges > 0, "some spacing needed a merge");
});

test("layout: a tail stopped by the clip's end holds its last frame", () => {
  // The last clip ends 0.2 s after its kill: the hold to the bar line and the closing fade freeze it.
  const tl = layout([cc(0, [5]), cc(1, [1], 1.2)], G);
  const last = tl.shots[1];
  assert.ok(last.hold > 0 && Math.abs(last.to - last.hold - 1.2) < 1e-9, `footage to the clip's end, then held ${last.hold} s`);
  const fr = toFrames(tl, 60).shots[1];
  assert.equal(fr.inFrame + fr.frames - fr.holdFrames, 72, "the footage stops at the clip's last frame (1.2 s at 60 fps)");
  // Mid-video: a clip whose footage ends right after the kill and a next clip that cannot start earlier.
  let holds = 0;
  for (let k = 1.0; k <= 2.4; k += 0.01) {
    const tl2 = layout([cc(0, [k], k + 0.4), cc(1, [0.65]), cc(2, [5])], G);
    noRepeats(tl2);
    const h = tl2.shots[0];
    if (h.hold > 0) { holds++; assert.ok(Math.abs(h.to - h.hold - (k + 0.4)) < 1e-9); }
  }
  assert.ok(holds > 0, "some placement needed a held frame");
});

test("layout: the bar-line open and close", () => {
  const tl = layout([cc(0, [5]), cc(1, [6, 6.3])], G);
  assert.ok(Math.abs(tl.card - BAR) < 1e-9, "the card is one bar");
  assert.ok(Math.abs(tl.shots[0].cut - BAR) < 1e-9, "the first shot cuts in on the bar line");
  assert.ok(Math.abs(tl.shots[0].anchor - 2 * BAR) < 1e-9, "its kill on the next bar line");
  assert.ok(offGrid(tl.closeAt, BAR) < 1e-9 && Math.abs(tl.total - tl.closeAt - BAR) < 1e-9, "hold to a bar line, fade for one bar");
  const last = tl.shots[tl.shots.length - 1];
  const naturalEnd = last.anchor + 0.3 + DEF.postSeconds;
  assert.ok(tl.closeAt >= naturalEnd - 1e-9 && tl.closeAt - naturalEnd < BAR, "the next bar line after the natural end");
});

test("layout: single kills come one bar apart at 175 BPM", () => {
  const tl = layout([cc(0, [5]), cc(1, [5]), cc(2, [5]), cc(3, [5])], G);
  const gaps = tl.shots.slice(1).map((s, i) => (s.anchor - tl.shots[i].anchor) / BAR);
  assert.deepEqual(gaps.map((g) => Math.round(g * 1e6) / 1e6), [1, 1, 1]);
});

test("fitCap: drops low-score clips first and keeps the best three", () => {
  const clips = [0, 1, 2, 3, 4, 5].map((i) => cc(i, [3, 6, 9, 12])); // play order: ascending score
  const all = layout(clips, G).total;
  const one = fitCap(clips, G, all - 1);
  assert.deepEqual(one.dropped.map((c) => c.clip), [0]);
  assert.equal(one.over, false);
  const tight = fitCap(clips, G, 10);
  assert.deepEqual(tight.kept.map((c) => c.clip), [3, 4, 5], "never the best three");
  assert.equal(tight.over, true);
  assert.equal(fitCap(clips, G, 600).dropped.length, 0);
});


test("shotLabel: the number and the title less its map and round", () => {
  assert.equal(shotLabel({ no: 257, title: "de_dust2 · R1 · 4k USP-S" }), "#257 · 4k USP-S");
  assert.equal(shotLabel({ no: 228, title: "de_mirage · R17 · 4k M4A1-S · 1v2 clutch" }), "#228 · 4k M4A1-S · 1v2 clutch");
});

test("montageKey: changes with the selection, order, a re-rendered source, the track, its offset, the shot rules and the cap", () => {
  const base: KeyInput = {
    week: W45, clips: [{ id: "a", bytes: 10, mtimeMs: 1 }, { id: "b", bytes: 20, mtimeMs: 2 }], shot: RULES, maxSeconds: 60,
    track: { bytes: 100, mtimeMs: 5, bpm: 175, phase: 0.01, start: 61.7 }, musicGainDb: -7,
  };
  const k = montageKey(base);
  assert.equal(montageKey(structuredClone(base)), k, "same inputs, same key");
  const differs = (o: Partial<KeyInput>, what: string) => assert.notEqual(montageKey({ ...base, ...o }), k, what);
  differs({ clips: [...base.clips, { id: "c", bytes: 5, mtimeMs: 3 }] }, "selection");
  differs({ clips: [...base.clips].reverse() }, "order");
  differs({ clips: [base.clips[0], { id: "b", bytes: 21, mtimeMs: 2 }] }, "re-rendered source");
  differs({ track: { ...base.track!, bytes: 101 } }, "another track");
  differs({ track: { ...base.track!, start: 63.1 } }, "offset");
  differs({ track: { ...base.track!, bpm: 175.1 } }, "bpm");
  differs({ track: { ...base.track!, phase: 0.02 } }, "phase");
  differs({ track: null }, "no music");
  differs({ shot: { preSeconds: 1, postSeconds: 0.5 } }, "shot rules");
  differs({ maxSeconds: 45 }, "cap");
  differs({ musicGainDb: -10 }, "gain");
  differs({ week: { year: 2026, week: 46 } }, "week");
});

test("parseWeekArgs and the caption", () => {
  assert.deepEqual(parseWeekArgs([]), { noMusic: false, dryRun: false, json: false });
  assert.deepEqual(parseWeekArgs(["2026-W45", "--top", "5", "--seconds", "45", "--dry-run"]), { week: { year: 2026, week: 45 }, top: 5, seconds: 45, noMusic: false, dryRun: true, json: false });
  assert.throws(() => parseWeekArgs(["--top", "1"]), />= 2/);
  assert.throws(() => parseWeekArgs(["--seconds", "5"]), />= 10/);
  assert.throws(() => parseWeekArgs(["--music", "a.mp3", "--no-music"]), /together/);
  assert.throws(() => parseWeekArgs(["45"]), /unexpected argument/);
  assert.equal(weekCaption({ year: 2026, week: 45 }, 8, null), "Best of week 45 · 8 clips #CS2");
  assert.equal(weekCaption({ year: 2026, week: 45 }, 8, "Music: X"), "Best of week 45 · 8 clips #CS2\nMusic: X");
});

// --- music ----------------------------------------------------------------------------------

test("loadManifest: the repo's music.json loads; bad entries are refused", () => {
  const tracks = loadManifest();
  assert.deepEqual(tracks.map((t) => [t.file, t.bpm]), [["smash-it.mp3", 175], ["woah.mp3", 175], ["slam.mp3", 136]]);
  assert.ok(tracks.every((t) => t.credit.startsWith("Music: ") && t.license === "CC BY 4.0"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "croclipper-test-"));
  try {
    const bad = (t: object) => { const f = path.join(dir, "m.json"); writeFileSync(f, JSON.stringify({ tracks: [{ ...tracks[0], ...t }] })); return () => loadManifest(f); };
    assert.throws(bad({ sha256: "abc" }), /sha256/);
    assert.throws(bad({ file: "../x.mp3" }), /plain audio file name/);
    assert.throws(bad({ url: "http://x/y.mp3" }), /https/);
    assert.throws(bad({ bpm: "fast" }), /bpm/);
    assert.throws(bad({ credit: "" }), /credit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fetchTrack: kept only when the sha256 matches; a wrong hash is refused and nothing is left", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "croclipper-test-"));
  try {
    const body = Buffer.from("not really an mp3");
    const sha = createHash("sha256").update(body).digest("hex");
    const fake = (async () => new Response(body)) as unknown as typeof fetch;
    const t = { ...loadManifest()[0], file: "t.mp3", sha256: sha };
    await fetchTrack(t, dir, fake);
    assert.deepEqual(readdirSync(dir), ["t.mp3"]);
    assert.deepEqual(checkTracks([t], dir).map((s) => s.state), ["ok"]);
    await assert.rejects(fetchTrack({ ...t, file: "u.mp3", sha256: "0".repeat(64) }, dir, fake), /does not match/);
    assert.deepEqual(readdirSync(dir), ["t.mp3"], "the mismatch left nothing behind");
    writeFileSync(path.join(dir, "t.mp3"), "changed");
    assert.deepEqual(checkTracks([t, { ...t, file: "gone.mp3" }], dir).map((s) => s.state), ["mismatch", "missing"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pickTrack: --music as a path or a name in music/, else the configured one, else the first by name", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "croclipper-test-"));
  try {
    assert.equal(pickTrack(undefined, "a.mp3", dir), null, "empty folder");
    for (const f of ["b.mp3", "a.wav", "c.txt"]) writeFileSync(path.join(dir, f), "x");
    assert.equal(pickTrack(undefined, "b.mp3", dir), path.join(dir, "b.mp3"));
    assert.equal(pickTrack(undefined, "missing.mp3", dir), path.join(dir, "a.wav"), "configured one absent: first by name");
    assert.equal(pickTrack("b.mp3", null, dir), path.join(dir, "b.mp3"));
    assert.equal(pickTrack(path.join(dir, "a.wav"), null, dir), path.join(dir, "a.wav"));
    assert.throws(() => pickTrack("nope.mp3", null, dir), /no such file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
