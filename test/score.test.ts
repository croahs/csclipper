// Per-round scoring (pace from the tightest run, the light signals' cap) and the batch selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { economyFactor, loadWeights, moments, scoreKills, tightestRun } from "../src/score/index.ts";
import type { Death, ParsedDemo } from "../src/parse/demo.ts";
import { pickMoments } from "../src/config.ts";

const ME = "me";
const w = loadWeights();
const kill = (tick: number, o: Partial<Death> = {}): Death => ({
  tick, round: 1, attacker: ME, victim: `v${tick}`, assister: null, weapon: "ak47", headshot: false, penetrated: false,
  noscope: false, thrusmoke: false, attackerblind: false, distance: 10, victimHpBefore: 100, airborne: false, attackerName: "me", victimName: `v${tick}`, ...o,
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
  // The anchored scale (scoring-notes, Calibration anchor): 15 for the third kill in the window, nothing for a 2k.
  assert.equal(scoreKills(demo(), [kill(0), kill(128), kill(256)], undefined, false, w).breakdown.tight, 15);
  assert.equal(scoreKills(demo(), [kill(0), kill(64), kill(128), kill(192)], undefined, false, w).breakdown.tight, 30);
  assert.equal(scoreKills(demo(), [kill(0), kill(128)], undefined, false, w).breakdown.tight, undefined);
});

test("style multiplies each kill's share: two one-tap flicks about double a plain 2k; a fully stylish 1k stays below a strong 3k", () => {
  const plain = scoreKills(demo(), [kill(0), kill(2000)], undefined, false, w).score;
  const flicks = [0, 2000].map((t) => ({ killTick: t, yawDegrees: 30 }));
  const stylish = scoreKills(demo({ fires: [0, 2000], flicks }), [kill(0), kill(2000)], undefined, false, w);
  assert.equal(stylish.breakdown.style, Math.round(w.killBase["2"] * (w.style.oneBulletKill * w.style.flick - 1) * 10) / 10);
  assert.ok(stylish.score >= 1.8 * plain, `stylish ${stylish.score} vs plain ${plain}`);
  // One stylish kill among plain ones: half the kill part gets its factor (the weapon multiplier is the moment's).
  const mixed = scoreKills(demo({ fires: [2000] }), [kill(0), kill(2000)], undefined, false, w);
  assert.equal(mixed.breakdown.style, Math.round(mixed.breakdown.kills * (w.style.oneBulletKill - 1) / 2 * 10) / 10);
  const all = { noscope: true, airborne: true };
  const one = scoreKills(demo({ fires: [0], flicks: [{ killTick: 0, yawDegrees: 30 }] }), [kill(0, all)], undefined, false, w).score;
  const three = scoreKills(demo(), [kill(0), kill(1280), kill(2560)], undefined, false, w).score;
  assert.ok(one < three, `stylish 1k ${one} vs spread 3k ${three}`);
  // With a big flick (45 degrees or more) the same 1k can pass a spread 3k, but not a strong (quick) 3k.
  const big = scoreKills(demo({ fires: [0], flicks: [{ killTick: 0, yawDegrees: 60 }] }), [kill(0, all)], undefined, false, w).score;
  const quick = scoreKills(demo(), [kill(0), kill(128), kill(256)], undefined, false, w).score;
  assert.ok(big < quick, `big-flick 1k ${big} vs quick 3k ${quick}`);
});

test("grenade throws and knife swings are not bullets; an inferno kill is not a one-bullet kill", () => {
  const p = { ...demo(), fires: [{ tick: 50, round: 1, player: ME, weapon: "hegrenade" }, { tick: 100, round: 1, player: ME, weapon: "ak47" }] } as unknown as ParsedDemo;
  assert.equal(scoreKills(p, [kill(100)], undefined, false, w).breakdown.style, Math.round(w.killBase["1"] * (w.style.oneBulletKill - 1) * 10) / 10, "the grenade does not count");
  assert.equal(scoreKills(demo({ fires: [100] }), [kill(100, { weapon: "inferno" })], undefined, false, w).breakdown.style, undefined);
});

test("flick tiers: 15-45 degrees the flick factor, 45 or more the big-flick factor instead", () => {
  const at = (deg: number) => scoreKills(demo({ flicks: [{ killTick: 100, yawDegrees: deg }] }), [kill(100)], undefined, false, w).breakdown.style;
  const share = w.killBase["1"];
  assert.equal(at(30), Math.round(share * (w.style.flick - 1) * 10) / 10);
  assert.equal(at(45), Math.round(share * (w.style.bigFlick - 1) * 10) / 10);
  assert.equal(at(90), at(45));
});

test("one-bullet kills count guns only; flicks below the threshold multiply nothing", () => {
  const one = scoreKills(demo({ fires: [100] }), [kill(100)], undefined, false, w).breakdown.style;
  const three = scoreKills(demo({ fires: [60, 80, 100] }), [kill(100)], undefined, false, w).breakdown.style;
  const knife = scoreKills(demo({ fires: [100] }), [kill(100, { weapon: "knife" })], undefined, false, w).breakdown.style;
  const smallFlick = scoreKills(demo({ flicks: [{ killTick: 100, yawDegrees: 10 }] }), [kill(100)], undefined, false, w).breakdown.style;
  assert.equal(one, Math.round(w.killBase["1"] * (w.style.oneBulletKill - 1) * 10) / 10);
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

test("economy: about 1.4 on an eco against a full buy, 0.7 farming an eco, 1 near parity and in pistol rounds", () => {
  const round = (n: number, own: number, enemy: number) => ({ ...demo(), rounds: [{ n, teams: { [ME]: "T" }, equip: { T: own, CT: enemy } }] }) as unknown as ParsedDemo;
  assert.equal(economyFactor(round(5, 2800, 20700), 5, w), w.economy.max);
  assert.equal(economyFactor(round(5, 20700, 2800), 5, w), w.economy.min);
  assert.ok(Math.abs(economyFactor(round(5, 20000, 22000), 5, w) - 1) < 0.05, "within 25 % of parity: under 5 %");
  assert.equal(economyFactor(round(1, 800, 4500), 1, w), 1, "pistol round");
  assert.equal(economyFactor(round(5, 0, 4500), 5, w), 1, "an unknown buy counts as parity");
});

test("economy scales the whole score; breakdown.economy is the change", () => {
  const p = { ...demo(), rounds: [{ n: 5, teams: { [ME]: "T" }, equip: { T: 2800, CT: 20700 } }] } as unknown as ParsedDemo;
  const even = { ...demo(), rounds: [{ n: 5, teams: { [ME]: "T" }, equip: { T: 20000, CT: 20000 } }] } as unknown as ParsedDemo;
  const ks = [kill(0, { round: 5 }), kill(2000, { round: 5 })];
  const base = scoreKills(even, ks, undefined, false, w);
  const eco = scoreKills(p, ks, undefined, false, w);
  assert.equal(base.breakdown.economy, undefined, "parity: no change");
  assert.equal(eco.breakdown.economy, Math.round(base.score * (w.economy.max - 1) * 10) / 10);
  assert.ok(Math.abs(eco.score - base.score * w.economy.max) < 0.2);
});
