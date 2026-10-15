// Action windows (clip specs) and the segments post plays from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionWindows } from "../src/clip/index.ts";
import { FAST_FORWARD_SPEED, segments } from "../src/post/index.ts";
import type { ParsedDemo } from "../src/parse/demo.ts";

const ME = "me";
const demo = (o: { kills?: number[]; fires?: number[]; hurtsBy?: number[]; hurtsOn?: number[]; otherRound?: number[] }) => ({
  demo: { tickrate: 64 },
  identity: { steamid: ME },
  deaths: [...(o.kills ?? []).map((tick) => ({ tick, round: 1, attacker: ME, victim: "x" })), ...(o.otherRound ?? []).map((tick) => ({ tick, round: 2, attacker: ME, victim: "x" }))],
  fires: (o.fires ?? []).map((tick) => ({ tick, round: 1, player: ME, weapon: "ak47" })),
  hurts: [...(o.hurtsBy ?? []).map((tick) => ({ tick, round: 1, attacker: ME, victim: "x" })), ...(o.hurtsOn ?? []).map((tick) => ({ tick, round: 1, attacker: "x", victim: ME }))],
}) as unknown as ParsedDemo;

test("windows: 2 s before to 1.5 s after each action, clamped to the span", () => {
  assert.deepEqual(actionWindows(demo({ kills: [1000] }), 1, 0, 5000), [{ startTick: 872, endTick: 1096 }]);
  assert.deepEqual(actionWindows(demo({ kills: [100] }), 1, 50, 5000), [{ startTick: 50, endTick: 196 }]);
});

test("windows: actions within 4 s of each other play through; a longer gap splits", () => {
  // The kill's window ends at 1096; a fire at 1480 opens one at 1352: a gap of 256 ticks = 4 s, merged.
  assert.equal(actionWindows(demo({ kills: [1000], fires: [1480] }), 1, 0, 9000).length, 1);
  // one tick further apart: two windows
  assert.equal(actionWindows(demo({ kills: [1000], fires: [1481] }), 1, 0, 9000).length, 2);
});

test("windows: damage dealt or taken and the outcome count; other rounds and other players' kills do not", () => {
  const w = actionWindows(demo({ kills: [1000], hurtsOn: [3000], otherRound: [2000] }), 1, 0, 9000, [6000]);
  assert.deepEqual(w.map((x) => x.startTick), [872, 2872, 5872]);
});

const m = { tickrate: 64, fps: 60, recordStartTick: 0, recordEndTick: 10_000, frames: 10_000 * 60 / 64 };

test("segments: windows at normal speed, the gaps between them fast-forwarded, the ends cut", () => {
  const s = segments(m, 0, 8000, [{ startTick: 640, endTick: 1280 }, { startTick: 5120, endTick: 5760 }]);
  assert.deepEqual(s.map((x) => [x.startTick, x.endTick, x.speed]), [[640, 1280, 1], [1280, 5120, FAST_FORWARD_SPEED], [5120, 5760, 1]]);
  const total = s.reduce((n, x) => n + x.outSeconds, 0);
  assert.ok(Math.abs(total - (10 + 10 + 60 / FAST_FORWARD_SPEED)) < 0.05, `total ${total}`);
});

test("segments: unaligned boundaries neither overlap nor skip a frame", () => {
  const s = segments(m, 0, 8000, [{ startTick: 641, endTick: 1283 }, { startTick: 5127, endTick: 5765 }]);
  for (let i = 1; i < s.length; i++) assert.equal(s[i].startFrame, s[i - 1].startFrame + s[i - 1].frames, `segment ${i}`);
});

test("segments: no windows plays the whole range; bad windows refuse", () => {
  const s = segments(m, 640, 1280);
  assert.deepEqual(s.map((x) => [x.startTick, x.endTick, x.speed]), [[640, 1280, 1]]);
  assert.throws(() => segments(m, 640, 1280, [{ startTick: 600, endTick: 700 }]), /outside/);
  assert.throws(() => segments(m, 0, 8000, [{ startTick: 640, endTick: 1280 }, { startTick: 1000, endTick: 2000 }]), /out of order/);
});
