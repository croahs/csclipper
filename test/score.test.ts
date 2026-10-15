// Per-round scoring (pace from the tightest run, the light signals' cap) and the batch selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWeights, moments, scoreKills, tightestRun } from "../src/score/index.ts";
import type { Death, ParsedDemo } from "../src/parse/demo.ts";
import { pickMoments } from "../src/config.ts";

const ME = "me";
const w = loadWeights();
const kill = (tick: number, o: Partial<Death> = {}): Death => ({
  tick, round: 1, attacker: ME, victim: `v${tick}`, assister: null, weapon: "ak47", headshot: false, penetrated: false,
  noscope: false, thrusmoke: false, attackerblind: false, distance: 10, victimHpBefore: 100, airborne: false, ...o,
});
const demo = (o: { fires?: number[]; flicks?: { killTick: number; yawDegrees: number }[] } = {}) => ({
  demo: { tickrate: 64 }, identity: { steamid: ME },
  fires: (o.fires ?? []).map((tick) => ({ tick, round: 1, player: ME, weapon: "ak47" })),
  flicks: (o.flicks ?? []).map((f) => ({ ...f, shotTick: f.killTick })),
}) as unknown as ParsedDemo;

test("tightest run: the most kills inside the window", () => {
  const ks = [kill(0), kill(1000), kill(1200), kill(1300), kill(5000)];
  assert.deepEqual(tightestRun(ks, 6, 64).map((k) => k.tick), [1000, 1200, 1300]);
  assert.deepEqual(tightestRun([kill(0), kill(1000)], 6, 64).map((k) => k.tick), [0], "nothing within 6 s: one kill");
  assert.deepEqual(tightestRun([kill(0), kill(384), kill(1920), kill(1926)], 6, 64).map((k) => k.tick), [1920, 1926], "equal size: the faster pair");
});

test("all kills of a round are one moment, however far apart", () => {
  const p = {
    ...demo(), identity: { steamid: ME },
    rounds: [{ n: 1, phase: "regular", startTick: 0, freezeEndTick: 10, endTick: 9000, winner: "T", reason: null, rosterChanged: false,
      teams: { [ME]: "T", mate: "T", v100: "CT", v4000: "CT", v8000: "CT" } }],
    deaths: [kill(100), kill(4000), kill(8000)],
  } as unknown as ParsedDemo;
  const ms = moments(p, w);
  assert.equal(ms.length, 1);
  assert.deepEqual(ms[0].kills.map((k) => k.tick), [100, 4000, 8000]);
});

test("a 3k in 4 s beats a 3k over 40 s by a visible margin; a quick 2k gains only speed", () => {
  const fast = scoreKills(demo(), [kill(0), kill(128), kill(256)], undefined, false, w).score;
  const slow = scoreKills(demo(), [kill(0), kill(1280), kill(2560)], undefined, false, w).score;
  assert.ok(fast - slow >= 15, `fast ${fast} vs slow ${slow}`);
  assert.equal(scoreKills(demo(), [kill(0), kill(128)], undefined, false, w).breakdown.tight, undefined);
});

test("light signals are capped below the gap between kill counts", () => {
  const all = { noscope: true, airborne: true };
  const ks = [kill(0, all), kill(2000, all)];
  const flicks = ks.map((k) => ({ killTick: k.tick, yawDegrees: 90 }));
  const s = scoreKills(demo({ fires: [0, 2000], flicks }), ks, undefined, false, w);
  assert.equal(s.breakdown.light, w.light.maxPerMoment);
  assert.ok(w.light.maxPerMoment < w.killBase["3"] - w.killBase["2"], "the cap stays well below the base gap between kill counts");
});

test("grenade throws and knife swings are not bullets; an inferno kill is not a one-bullet kill", () => {
  const p = { ...demo(), fires: [{ tick: 50, round: 1, player: ME, weapon: "hegrenade" }, { tick: 100, round: 1, player: ME, weapon: "ak47" }] } as unknown as ParsedDemo;
  assert.equal(scoreKills(p, [kill(100)], undefined, false, w).breakdown.light, w.light.oneBulletKill, "the grenade does not count");
  assert.equal(scoreKills(demo({ fires: [100] }), [kill(100, { weapon: "inferno" })], undefined, false, w).breakdown.light, undefined);
});

test("one-bullet kills count guns only; flicks below the threshold score nothing", () => {
  const one = scoreKills(demo({ fires: [100] }), [kill(100)], undefined, false, w).breakdown.light;
  const three = scoreKills(demo({ fires: [60, 80, 100] }), [kill(100)], undefined, false, w).breakdown.light;
  const knife = scoreKills(demo({ fires: [100] }), [kill(100, { weapon: "knife" })], undefined, false, w).breakdown.light;
  const smallFlick = scoreKills(demo({ flicks: [{ killTick: 100, yawDegrees: 20 }] }), [kill(100)], undefined, false, w).breakdown.light;
  assert.equal(one, w.light.oneBulletKill);
  assert.equal(three, undefined);
  assert.equal(knife, undefined);
  assert.equal(smallFlick, undefined);
});

test("selection: every moment at or over minScore; none → the best one when fallbackBest", () => {
  const ranked = [{ score: 70 }, { score: 45 }, { score: 30 }];
  assert.deepEqual(pickMoments(ranked, { minScore: 40, fallbackBest: true }), [{ score: 70 }, { score: 45 }]);
  assert.deepEqual(pickMoments([{ score: 30 }, { score: 20 }], { minScore: 40, fallbackBest: true }), [{ score: 30 }]);
  assert.deepEqual(pickMoments([{ score: 30 }], { minScore: 40, fallbackBest: false }), []);
  assert.deepEqual(pickMoments([], { minScore: 40, fallbackBest: true }), []);
});
