// Trades and saves (PLAN.md §3): per-kill teamplay bonuses on synthetic rounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWeights, scoreKills, teamplay } from "../src/score/index.ts";
import type { Death, Hurt, ParsedDemo } from "../src/parse/demo.ts";

const ME = "me", T = 64;
const w = loadWeights();
const tp = w.teamplay;
const death = (tick: number, attacker: string | null, victim: string, round = 1): Death => ({
  tick, round, attacker, victim, assister: null, weapon: "ak47", headshot: false, penetrated: false, noscope: false,
  thrusmoke: false, attackerblind: false, distance: 10, victimHpBefore: 100, airborne: false, attackerName: String(attacker), victimName: victim,
});
const hurt = (tick: number, attacker: string, victim: string, health: number, round = 1): Hurt => ({ tick, round, attacker, victim, dmg: 100 - health, health, weapon: "ak47" });
const round = (n: number, o: { rosterChanged?: boolean } = {}) => ({
  n, phase: "regular", startTick: (n - 1) * 10000, freezeEndTick: (n - 1) * 10000 + 10, endTick: n * 10000 - 1000, winner: "T", reason: null,
  rosterChanged: o.rosterChanged ?? false, equip: { T: 20000, CT: 20000 }, teams: { [ME]: "T", mate: "T", mate2: "T", e1: "CT", e2: "CT" },
});
const demo = (deaths: Death[], hurts: Hurt[] = [], rounds = [round(1), round(2)]) =>
  ({ demo: { tickrate: T }, identity: { steamid: ME }, rounds, deaths, hurts, fires: [], flicks: [] }) as unknown as ParsedDemo;
/** The POV kills e1 at `tick` (round of that tick's round); returns teamplay and the score breakdown. */
const at = (p: ParsedDemo, tick: number, roundNo = 1) => {
  const k = p.deaths.find((d) => d.tick === tick && d.attacker === ME) ?? death(tick, ME, "e1", roundNo);
  return { tp: teamplay(p, [k], w), b: scoreKills(p, [k], undefined, true, w).breakdown };
};

test("trade: the victim killed a teammate within the window; just outside it is not", () => {
  const inside = demo([death(1000, "e1", "mate"), death(1000 + tp.tradeWindowSeconds * T, ME, "e1")]);
  const r = at(inside, 1000 + tp.tradeWindowSeconds * T);
  assert.equal(r.tp.trades.length, 1);
  assert.equal(r.b.trade, tp.trade);
  const outside = demo([death(1000, "e1", "mate"), death(1001 + tp.tradeWindowSeconds * T, ME, "e1")]);
  assert.equal(at(outside, 1001 + tp.tradeWindowSeconds * T).tp.trades.length, 0);
  assert.equal(at(outside, 1001 + tp.tradeWindowSeconds * T).b.trade, undefined);
});

test("not a trade: the victim killed a teammate in the previous round", () => {
  // Inside the trade window in ticks, so only the round check keeps it from counting.
  const p = demo([death(9990, "e1", "mate", 1), death(10100, ME, "e1", 2)]);
  assert.ok(10100 - 9990 < tp.tradeWindowSeconds * T);
  assert.equal(at(p, 10100, 2).tp.trades.length, 0);
});

test("save: the victim hurt a teammate who survives; low HP is worth saveLowHp", () => {
  const p = demo([death(2000, ME, "e1")], [hurt(1950, "e1", "mate", 70)]);
  const r = at(p, 2000);
  assert.deepEqual(r.tp.saves.map((s) => s.low), [false]);
  assert.equal(r.b.save, tp.save);
  // Low: the victim's last hit on that teammate decides, not an earlier one.
  const low = demo([death(2000, ME, "e1")], [hurt(1900, "e1", "mate", 70), hurt(1960, "e1", "mate", tp.saveLowHpThreshold)]);
  assert.equal(at(low, 2000).b.save, tp.saveLowHp);
  // Round end comes before the survive horizon: alive at round end is enough.
  const late = demo([death(8990, ME, "e1"), death(9500, "e2", "mate")], [hurt(8950, "e1", "mate", 50)]);
  assert.equal(at(late, 8990).tp.saves.length, 1, "the teammate died after the round end");
});

test("not a save: the teammate dies within the survive window, the hit was outside its window, or the damaged player is the POV", () => {
  const dies = demo([death(2000, ME, "e1"), death(2000 + tp.saveSurviveSeconds * T, "e2", "mate")], [hurt(1950, "e1", "mate", 50)]);
  assert.equal(at(dies, 2000).tp.saves.length, 0);
  const early = demo([death(2000, ME, "e1")], [hurt(1999 - tp.saveWindowSeconds * T, "e1", "mate", 50)]);
  assert.equal(at(early, 2000).tp.saves.length, 0);
  const pov = demo([death(2000, ME, "e1")], [hurt(1950, "e1", ME, 20)]);
  assert.equal(at(pov, 2000).tp.saves.length, 0);
  assert.equal(at(pov, 2000).b.save, undefined);
});

test("both a trade and a save: counts as the save only", () => {
  const p = demo([death(1900, "e1", "mate2"), death(2000, ME, "e1")], [hurt(1950, "e1", "mate", 60)]);
  const r = at(p, 2000);
  assert.equal(r.tp.saves.length, 1);
  assert.equal(r.tp.trades.length, 0);
  assert.equal(r.b.save, tp.save);
  assert.equal(r.b.trade, undefined);
});

test("neither in a roster-changed round; a teamkill's victim and a teammate are not trades or saves", () => {
  const changed = demo([death(1900, "e1", "mate"), death(2000, ME, "e1")], [hurt(1950, "e1", "mate2", 30)], [round(1, { rosterChanged: true })]);
  const r = at(changed, 2000);
  assert.equal(r.tp.trades.length + r.tp.saves.length, 0);
  // A teammate who killed a teammate and was then killed by the POV: povKills excludes the teamkill,
  // and teamplay never treats a teammate's hits or kills on teammates as an enemy's.
  const tk = demo([death(1900, "mate2", "mate"), death(2000, ME, "e1")], [hurt(1950, "mate2", "mate", 30)]);
  assert.equal(at(tk, 2000).tp.trades.length + at(tk, 2000).tp.saves.length, 0, "the teamkiller is not the POV's victim");
  const tkByMe = demo([death(1900, "e1", "mate"), death(2000, ME, "mate2")], [hurt(1950, "mate2", "mate", 30)]);
  const k = tkByMe.deaths[1];
  assert.equal(scoreKills(tkByMe, [k], undefined, true, w).breakdown.trade, undefined);
});

test("small next to a kill: a plain 2k with a trade and a low save stays well below a plain 3k", () => {
  const twoK = demo([death(1900, "e2", "mate"), death(1000, ME, "e1"), death(2000, ME, "e2")], [hurt(950, "e1", "mate2", 10)]);
  const ks = [twoK.deaths[1], twoK.deaths[2]];
  const lifted = scoreKills(twoK, ks, undefined, true, w);
  assert.equal(lifted.breakdown.trade, tp.trade);
  assert.equal(lifted.breakdown.save, tp.saveLowHp);
  const three = scoreKills(demo([]), [death(1000, ME, "e1"), death(2000, ME, "e2"), death(3000, ME, "x")], undefined, true, w).score;
  assert.ok(lifted.score < three, `2k with trade and save ${lifted.score} vs plain 3k ${three}`);
});
