// Film scoring's pace.stretch (a round is worth its best stretch) and the per-POV absence cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFilmWeights, loadWeights, moments, scoreKills, tempoFactor, type Weights } from "../src/score/index.ts";
import { PovAbsent, parseDemo, parseDir, povDir, type Death, type ParsedDemo } from "../src/parse/demo.ts";
import { povKey } from "../src/config.ts";
import { sha256File } from "../src/parse/clip-facts.ts";

const ME = "me";
const film = loadFilmWeights();
const s = film.pace.stretch!;
const noStretch: Weights = { ...film, pace: { ...film.pace, stretch: undefined } };
const kill = (tick: number): Death => ({
  tick, round: 1, attacker: ME, victim: `v${tick}`, assister: null, weapon: "ak47", headshot: false, penetrated: false,
  noscope: false, thrusmoke: false, attackerblind: false, distance: 10, victimHpBefore: 100, airborne: false, attackerName: "me", victimName: `v${tick}`,
});
/** One round with these kills (seconds from freeze end); alone: he is 1vN from freeze end, else a teammate lives through it. */
function round(secs: number[], o: { alone?: boolean; winner?: "T" | "CT"; extraEnemies?: number } = {}): ParsedDemo {
  const deaths = secs.map((x) => kill(10 + Math.round(x * 64)));
  const enemies = Object.fromEntries([...deaths.map((d) => d.victim), ...Array.from({ length: o.extraEnemies ?? 0 }, (_, i) => `e${i}`)].map((v) => [v, "CT"]));
  return {
    demo: { tickrate: 64 }, identity: { steamid: ME }, fires: [], flicks: [], hurts: [], deaths,
    rounds: [{ n: 1, phase: "regular", startTick: 0, freezeEndTick: 10, endTick: 64 * 200, winner: o.winner ?? "T", reason: null, rosterChanged: false,
      teams: { [ME]: "T", ...(o.alone ? {} : { mate: "T" }), ...enemies } }],
  } as unknown as ParsedDemo;
}
const one = (p: ParsedDemo, w: Weights) => { const ms = moments(p, w); assert.equal(ms.length, 1); return ms[0]; };
const full = (p: ParsedDemo, w: Weights, kills = p.deaths) => { const m = moments(p, noStretch)[0]; return scoreKills(p, kills, m.clutch, m.roundWon, w); };
const sum = (b: Record<string, number>) => Object.values(b).reduce((a, x) => a + x, 0);

test("without pace.stretch: scores and breakdowns as before, slow and fast multi-kills", () => {
  for (const p of [round([0, 30, 60, 90]), round([0, 1, 2, 3])]) {
    for (const w of [noStretch, loadWeights()]) {
      const m = one(p, w), before = full(p, w);
      assert.equal(m.score, before.score);
      assert.deepEqual(m.breakdown, before.breakdown);
      assert.equal(m.stretch, undefined);
    }
  }
  assert.equal(loadWeights().pace.stretch, undefined, "scoring.json has no stretch");
});

test("a fast 4k (gaps under fullSeconds): unchanged by the stretch rule, no stretch field", () => {
  const p = round([0, 1, 2, 2.9]);
  const m = one(p, film);
  assert.equal(m.score, full(p, film).score);
  assert.deepEqual(m.breakdown, full(p, film).breakdown);
  assert.equal(m.stretch, undefined);
});

test("a slow 4k (30 s gaps): scored as its best stretch, far below the fast 4k; parts sum to the score", () => {
  const slow = one(round([0, 30, 60, 90]), film), fast = one(round([0, 1, 2, 3]), film);
  assert.ok(slow.score < fast.score / 4, `${slow.score} vs ${fast.score}`);
  assert.ok(slow.score < full(round([0, 30, 60, 90]), film).score);
  assert.ok(slow.breakdown.tempo! < 0, "the tempo factor took its share");
  assert.ok(Math.abs(sum(slow.breakdown) - slow.score) < 0.11, JSON.stringify(slow.breakdown));
  assert.equal(slow.kills.length, 4, "the moment still holds all the round's kills");
});

test("three fast kills and a fourth 40 s later: the stretch is the first three, scored as that 3k", () => {
  const p = round([0, 1, 2, 42]);
  const m = one(p, film);
  assert.deepEqual(m.stretch, { from: 0, to: 2 });
  assert.equal(m.score, full(p, film, p.deaths.slice(0, 3)).score);
  assert.equal(m.breakdown.tempo, undefined, "tempo 1: no tempo part");
  assert.deepEqual(m.kills.map((k) => k.tick), p.deaths.map((k) => k.tick), "the kill list is still all the kills");
});

test("tempo: interpolated between fullSeconds and zeroSeconds, floor beyond", () => {
  const mid = (s.fullSeconds + s.zeroSeconds) / 2;
  assert.equal(tempoFactor(s.fullSeconds, s), 1);
  assert.ok(Math.abs(tempoFactor(mid, s) - (1 + s.floor) / 2) < 1e-9);
  assert.equal(tempoFactor(s.zeroSeconds + 10, s), s.floor);
  // A 2k at the midpoint keeps the pair (its factor beats a single kill), with the change as `tempo`.
  const p = round([0, mid]);
  const m = one(p, film), whole = full(p, film);
  const f = tempoFactor(mid, s);
  assert.equal(m.score, Math.round(whole.score * f * 10) / 10);
  assert.equal(m.breakdown.tempo, Math.round((m.score - whole.score) * 10) / 10);
  assert.equal(m.stretch, undefined);
  // Beyond zeroSeconds the pair counts floor x its score, or a single kill when that is more.
  const far = round([0, s.zeroSeconds + 10]);
  const mf = one(far, film), single = full(far, film, far.deaths.slice(0, 1)).score;
  assert.equal(mf.score, Math.max(single, Math.round(full(far, film).score * s.floor * 10) / 10));
});

test("an exceptional clutch is exempt: a slow won 1v5 with 5 clutch kills scores as without pace.stretch", () => {
  const p = round([0, 20, 40, 60, 80], { alone: true });
  const m = one(p, film), before = one(p, noStretch);
  assert.equal(m.clutch?.vs, 5);
  assert.equal(m.score, before.score);
  assert.deepEqual(m.breakdown, before.breakdown);
  assert.equal(m.stretch, undefined);
});

test("the same slow clutch lost, or won with only 3 clutch kills, falls under the stretch rule", () => {
  const lost = round([0, 20, 40, 60, 80], { alone: true, winner: "CT" });
  assert.ok(one(lost, film).score < one(lost, noStretch).score);
  const three = round([0, 30, 60], { alone: true });
  assert.equal(one(three, film).clutch?.vs, 3);
  assert.ok(one(three, film).score < one(three, noStretch).score);
  const fourOfFive = round([0, 20, 40, 60], { alone: true, extraEnemies: 1 });
  assert.equal(one(fourOfFive, film).score, one(fourOfFive, noStretch).score, "a won 1v5 with 4 kills: exempt");
});

test("absence cache: a player not in the demo is cached per (demo, povKey); the second call does not parse", async () => {
  const MAIN = "76561198000000001", A = "76561198000000077";
  const tmp = mkdtempSync(path.join(os.tmpdir(), "croclipper-absent-"));
  const demo = path.join(tmp, "x.dem");
  writeFileSync(demo, randomBytes(512));
  const sha = await sha256File(demo);
  try {
    let calls = 0;
    const absent = () => { calls++; throw new PovAbsent(`player ${povKey(A)} not found in this demo's match rounds`); };
    await assert.rejects(parseDemo(demo, A, MAIN, absent), PovAbsent);
    await assert.rejects(parseDemo(demo, A, MAIN, absent), PovAbsent);
    assert.equal(calls, 1, "second call answered from the marker");
    const marker = path.join(povDir(sha, povKey(A)), "absent.json");
    assert.ok(!readFileSync(marker, "utf8").includes(A), "no SteamID in the marker");
    // A marker from another parser schema re-checks.
    writeFileSync(marker, JSON.stringify({ key: `${sha}:demoparser2@0:schema1` }));
    await assert.rejects(parseDemo(demo, A, MAIN, absent), PovAbsent);
    assert.equal(calls, 2);
    // The main POV's marker sits in the demo's own folder: another main POV is checked, not answered from it.
    const B = "76561198000000088";
    let mainCalls = 0;
    const mainAbsent = () => { mainCalls++; throw new PovAbsent("POV player (STEAM_ID64) not found in this demo's match rounds"); };
    await assert.rejects(parseDemo(demo, MAIN, MAIN, mainAbsent), PovAbsent);
    await assert.rejects(parseDemo(demo, MAIN, MAIN, mainAbsent), PovAbsent);
    assert.equal(mainCalls, 1);
    await assert.rejects(parseDemo(demo, B, B, mainAbsent), PovAbsent);
    assert.equal(mainCalls, 2, "a changed main POV is parsed, not read as absent");
    // A real parse failure is never cached as absent.
    rmSync(marker);
    let fails = 0;
    const broken = () => { fails++; throw new Error("EntityNotFound"); };
    await assert.rejects(parseDemo(demo, A, MAIN, broken), /EntityNotFound/);
    await assert.rejects(parseDemo(demo, A, MAIN, broken), /EntityNotFound/);
    assert.equal(fails, 2);
    assert.ok(!existsSync(marker));
  } finally {
    rmSync(parseDir(sha), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
