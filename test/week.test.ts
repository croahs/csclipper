// pnpm week: ISO weeks, week assignment by the page's date rule, selection, order, the key and the
// planned length. Pure functions; no FFmpeg, no library files.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClipEntry } from "../src/library/index.ts";
import { clipDate, matchDateOf } from "../src/library/match-date.ts";
import {
  buildGraph, CARD_S, FADE_S, isoWeekOf, latestWeek, montageKey, parseIsoWeek, parseWeekArgs, plannedSeconds,
  rangeLabel, selectWeek, weekCaption, weekLabel, weekRange, weeksInYear, WeekRefusal, type Dated, type KeyInput,
} from "../src/week/index.ts";

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

const clip = (o: { no: number; score?: number; date?: string; exists?: boolean; kind?: ClipEntry["kind"] }): Dated => ({
  entry: { id: `id${o.no}`, no: o.no, file: `clips/id${o.no}.mp4`, title: `de_cache · R${o.no} · ${o.no}k`, demo: "d", demoSha256: "s", round: o.no, startTick: 0, endTick: 1, seconds: 10, frames: 600, createdAt: "2026-11-01T00:00:00Z", renderKey: "k", render: {}, kind: o.kind, ...(o.score === undefined ? {} : { moment: { score: o.score } }) } as ClipEntry,
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

test("selectWeek: only highlights of that week; no score and missing files are skipped and named", () => {
  const clips = [
    clip({ no: 1, score: 50 }), clip({ no: 2, score: 300, kind: "deaths" }), clip({ no: 3, score: 80, kind: "highlight" }),
    clip({ no: 4 }), clip({ no: 5, score: 999, exists: false }), clip({ no: 6, score: 400, date: "2026-11-09T12:00:00Z" }), // W46
    clip({ no: 7, score: 60 }),
  ];
  const s = selectWeek(clips, W45, 8);
  assert.deepEqual(s.picked.map((e) => e.no), [1, 7, 3]);
  assert.deepEqual(s.skipped.map((x) => [x.no, x.reason]), [[4, "no score"], [5, "file missing"]]);
  assert.equal(s.candidates, 5);
});

test("selectWeek: fewer than 2 to show is a refusal that names the skips", () => {
  assert.throws(() => selectWeek([clip({ no: 1, score: 50 }), clip({ no: 2, score: 60, exists: false })], W45, 8), (e) => e instanceof WeekRefusal && /1 highlight to show of 2.*2 \(file missing\)/.test(e.message));
  assert.throws(() => selectWeek([clip({ no: 1, score: 50 })], { year: 2026, week: 44 }, 8), WeekRefusal);
});

test("latestWeek: the most recent week with a highlight; reels do not count", () => {
  assert.deepEqual(latestWeek([clip({ no: 1, score: 1 }), clip({ no: 2, kind: "kills", date: "2026-11-20T12:00:00Z" }), clip({ no: 3, date: "2026-11-10T12:00:00Z" })]), { year: 2026, week: 46 });
  assert.equal(latestWeek([clip({ no: 2, kind: "deaths" })]), undefined);
});

test("montageKey: changes with the selection, its order, a re-rendered source and the music", () => {
  const base: KeyInput = { week: W45, clips: [{ id: "a", bytes: 10, mtimeMs: 1 }, { id: "b", bytes: 20, mtimeMs: 2 }], music: null, musicGainDb: -14 };
  const k = montageKey(base);
  assert.equal(montageKey(structuredClone(base)), k, "same inputs, same key");
  assert.notEqual(montageKey({ ...base, clips: [...base.clips, { id: "c", bytes: 5, mtimeMs: 3 }] }), k);
  assert.notEqual(montageKey({ ...base, clips: [...base.clips].reverse() }), k);
  assert.notEqual(montageKey({ ...base, clips: [base.clips[0], { id: "b", bytes: 21, mtimeMs: 2 }] }), k);
  const music = montageKey({ ...base, music: { bytes: 100, mtimeMs: 5 } });
  assert.notEqual(music, k);
  assert.notEqual(montageKey({ ...base, music: { bytes: 100, mtimeMs: 6 } }), music);
  assert.notEqual(montageKey({ ...base, music: { bytes: 100, mtimeMs: 5 }, musicGainDb: -10 }), music);
  assert.equal(montageKey({ ...base, musicGainDb: -10 }), k, "the gain matters only with music");
  assert.notEqual(montageKey({ ...base, week: { year: 2026, week: 46 } }), k);
});

test("plannedSeconds and the graph's crossfade offsets agree", () => {
  assert.equal(CARD_S, 2);
  assert.equal(FADE_S, 0.25);
  assert.equal(plannedSeconds([10, 20, 5]), 2 + 35 - 0.75);
  const g = buildGraph({ width: 1920, height: 1080, fps: 60, clips: [{ seconds: 10, audio: true, labelFile: "a" }, { seconds: 20, audio: false, labelFile: "b" }], cardTitleFile: "t", cardRangeFile: "r", music: null, font: null });
  assert.deepEqual([...g.matchAll(/offset=([\d.]+)/g)].map((m) => Number(m[1])), [1.75, 11.5]);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=duration=20\.000000/); // the clip without audio gets silence
  assert.doesNotMatch(g, /sidechaincompress/);
  // Three clips: the running length accumulates per joint, so an off-by-one would show from the third offset on.
  const g3 = buildGraph({ width: 1920, height: 1080, fps: 60, clips: [10, 20, 5].map((seconds, i) => ({ seconds, audio: true, labelFile: String(i) })), cardTitleFile: "t", cardRangeFile: "r", music: { input: 3, gainDb: -14 }, font: null });
  assert.deepEqual([...g3.matchAll(/offset=([0-9.]+)/g)].map((m) => Number(m[1])), [1.75, 11.5, 31.25]);
  assert.ok(g3.includes("[3:a]") && g3.includes("atrim=duration=36.250000"), "the music is cut to the planned length");
  const m = buildGraph({ width: 1920, height: 1080, fps: 60, clips: [{ seconds: 10, audio: true, labelFile: "a" }, { seconds: 20, audio: true, labelFile: "b" }], cardTitleFile: "t", cardRangeFile: "r", music: { input: 2, gainDb: -14 }, font: null });
  assert.match(m, /\[2:a\].*atrim=duration=31\.500000.*volume=-14dB,afade=t=out:st=28\.500000:d=3/);
  assert.match(m, /\[mus\]\[key\]sidechaincompress/);
});

test("parseWeekArgs and the caption", () => {
  assert.deepEqual(parseWeekArgs([]), { noMusic: false, dryRun: false, json: false });
  assert.deepEqual(parseWeekArgs(["2026-W45", "--top", "5", "--dry-run"]), { week: { year: 2026, week: 45 }, top: 5, noMusic: false, dryRun: true, json: false });
  assert.throws(() => parseWeekArgs(["--top", "1"]), />= 2/);
  assert.throws(() => parseWeekArgs(["--music", "a.mp3", "--no-music"]), /together/);
  assert.throws(() => parseWeekArgs(["45"]), /unexpected argument/);
  assert.equal(weekCaption({ year: 2026, week: 45 }, 8), "Best of week 45 · 8 clips #CS2");
});
