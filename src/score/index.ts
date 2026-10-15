// Scoring (PLAN.md §3): one moment per round with all of the POV's kills in it,
// scored with the weights in scoring.json: kill count, pace (the tightest run
// inside the round), clutch, outcome, flags and weapon as the backbone, and
// per-kill style multipliers for one-bullet kills, flicks, no-scopes and
// airborne kills. Trades and "saved a teammate" are deferred.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import { NOT_A_GUN, type Death, type ParsedDemo, type Round, type Team } from "../parse/demo.ts";

export type Weights = {
  killBase: Record<string, number>;
  speed: { referenceSeconds: number; pointsPerSecondFaster: number; max: number };
  tightness: { windowSeconds: number; perKillBeyondTwo: number };
  clutch: { perEnemy: number; wonBonus: number; lostFactor: number };
  flags: { headshot: number; wallbang: number; thrusmoke: number; attackerblind: number };
  style: { oneBulletKill: number; flick: number; flickMinDegrees: number; noscope: number; airborne: number };
  economy: { perLnRatio: number; min: number; max: number; pistolRounds: number[] };
  weaponMultiplier: Record<WeaponClass, number>;
  roundWon: number;
  lowHp: { threshold: number; penaltyPerKill: number };
  threshold: number;
  includeOvertime: boolean;
};
export const loadWeights = (file = path.join(ROOT, "scoring.json")) => JSON.parse(readFileSync(file, "utf8")) as Weights;

export type WeaponClass = "pistol" | "deagle" | "scout" | "smg" | "shotgun" | "rifle" | "awp" | "knife" | "other";
const CLASSES: Record<Exclude<WeaponClass, "other">, string[]> = {
  pistol: ["glock", "hkp2000", "usp_silencer", "p250", "fiveseven", "tec9", "cz75a", "elite", "revolver"],
  deagle: ["deagle"],
  scout: ["ssg08"],
  smg: ["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"],
  shotgun: ["nova", "xm1014", "sawedoff", "mag7"],
  rifle: ["ak47", "m4a1", "m4a1_silencer", "m4a1_silencer_off", "galilar", "famas", "aug", "sg556", "m249", "negev", "g3sg1", "scar20"],
  awp: ["awp"],
  knife: ["knife", "bayonet"],
};
export function weaponClass(weapon: string): WeaponClass {
  for (const [c, ws] of Object.entries(CLASSES)) if (ws.some((w) => weapon === w || (c === "knife" && weapon.startsWith("knife")))) return c as WeaponClass;
  return "other";
}

export type Clutch = { vs: number; won: boolean; fromTick: number };
export type Moment = {
  round: number;
  kills: Death[];
  clutch?: Clutch;
  roundWon: boolean;
  score: number;
  breakdown: Record<string, number>;
};

/** The POV's team in a round, from the freeze-end teams. */
const povTeam = (p: ParsedDemo, r: Round): Team | undefined => r.teams[p.identity.steamid];

/**
 * 1vX: the tick the POV became the last one alive on their team with enemies
 * still alive, and how many. Alive state follows from freeze-end teams minus deaths.
 */
export function clutchState(p: ParsedDemo, r: Round): Clutch | undefined {
  const me = p.identity.steamid;
  const team = povTeam(p, r);
  if (!team || r.rosterChanged) return undefined;
  const alive = new Set(Object.keys(r.teams));
  const check = (tick: number): Clutch | undefined => {
    if (!alive.has(me)) return undefined;
    const mates = [...alive].filter((id) => r.teams[id] === team);
    const enemies = [...alive].filter((id) => r.teams[id] !== team);
    return mates.length === 1 && enemies.length > 0 ? { vs: enemies.length, won: r.winner === team, fromTick: tick } : undefined;
  };
  // Already alone at freeze end, or after some death up to the round end.
  const first = check(r.freezeEndTick);
  if (first) return first;
  for (const d of p.deaths.filter((x) => x.round === r.n && x.tick <= r.endTick).sort((a, b) => a.tick - b.tick)) {
    alive.delete(d.victim);
    if (d.victim === me) return undefined;
    const c = check(d.tick);
    if (c) return c;
  }
  return undefined;
}

/** POV kills that count: enemies only, up to the round end, no suicides, no teamkills. */
export function povKills(p: ParsedDemo, r: Round): Death[] {
  const team = povTeam(p, r);
  return p.deaths
    .filter((d) => d.round === r.n && d.tick <= r.endTick && d.attacker === p.identity.steamid && d.victim !== d.attacker && r.teams[d.victim] && r.teams[d.victim] !== team)
    .sort((a, b) => a.tick - b.tick);
}

const ENGAGE_S = 5; // the first kill's bullets count from this long before it

/** The most kills inside any `windowS` window (ties: the shortest such run), and that run's kills. */
export function tightestRun(kills: Death[], windowS: number, tickrate: number): Death[] {
  let best: Death[] = kills.slice(0, 1);
  for (let i = 0; i < kills.length; i++) {
    let j = i;
    while (j + 1 < kills.length && kills[j + 1].tick - kills[i].tick <= windowS * tickrate) j++;
    const span = (r: Death[]) => r[r.length - 1].tick - r[0].tick;
    const run = kills.slice(i, j + 1);
    if (run.length > best.length || (run.length === best.length && span(run) < span(best))) best = run;
  }
  return best;
}

export function scoreKills(p: ParsedDemo, kills: Death[], clutch: Clutch | undefined, roundWon: boolean, w: Weights): Pick<Moment, "score" | "breakdown"> {
  const tickrate = p.demo.tickrate;
  const b: Record<string, number> = {};
  const n = kills.length;
  const base = w.killBase[String(Math.min(n, 5))] ?? 0;
  // The multikill's weapon is the one most of its kills were made with.
  const counts = new Map<WeaponClass, number>();
  for (const k of kills) counts.set(weaponClass(k.weapon), (counts.get(weaponClass(k.weapon)) ?? 0) + 1);
  const cls = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
  b.kills = Math.round(base * (w.weaponMultiplier[cls] ?? 1) * 10) / 10;
  // Pace: kills in quick succession are worth more than the same kills spread over the round.
  const run = tightestRun(kills, w.tightness.windowSeconds, tickrate);
  if (run.length >= 2) {
    const avgGap = (run[run.length - 1].tick - run[0].tick) / (run.length - 1) / tickrate;
    b.speed = Math.round(Math.min(w.speed.max, Math.max(0, (w.speed.referenceSeconds - avgGap) * w.speed.pointsPerSecondFaster)) * 10) / 10;
    if (run.length >= 3) b.tight = (run.length - 2) * w.tightness.perKillBeyondTwo;
  }
  if (clutch) b.clutch = clutch.vs * w.clutch.perEnemy * (clutch.won ? 1 : w.clutch.lostFactor) + (clutch.won ? w.clutch.wonBonus : 0);
  const f = w.flags;
  b.flags = kills.reduce((s, k) => s + (k.headshot ? f.headshot : 0) + (k.penetrated ? f.wallbang : 0) + (k.thrusmoke ? f.thrusmoke : 0) + (k.attackerblind ? f.attackerblind : 0), 0);
  // Style: per-kill multipliers on that kill's share of the kill base (one-bullet, flick, no-scope,
  // airborne), stacking on the kill. A kill with none counts 1, so a plain round scores as before.
  const st = w.style;
  const me = p.identity.steamid;
  const factor = kills.map((k, i) => {
    let f = 1;
    if (k.noscope) f *= st.noscope;
    if (k.airborne) f *= st.airborne;
    const from = i > 0 ? kills[i - 1].tick : k.tick - ENGAGE_S * tickrate;
    const bullets = p.fires.filter((x) => x.player === me && x.round === k.round && x.tick > from && x.tick <= k.tick && !NOT_A_GUN.test(x.weapon)).length;
    if (bullets === 1 && !NOT_A_GUN.test(k.weapon)) f *= st.oneBulletKill;
    if ((p.flicks.find((x) => x.killTick === k.tick)?.yawDegrees ?? 0) > st.flickMinDegrees) f *= st.flick;
    return f;
  });
  const extra = factor.reduce((a, f) => a + (f - 1), 0) / n; // the average factor beyond 1
  if (extra > 0) b.style = Math.round(b.kills * extra * 10) / 10;
  if (roundWon) b.roundWon = w.roundWon;
  const low = kills.filter((k) => k.victimHpBefore <= w.lowHp.threshold).length;
  if (low) b.lowHp = -low * w.lowHp.penaltyPerKill;
  // Economy: the round's score scaled by the buy difference at freeze end; `economy` holds the change.
  const eco = economyFactor(p, kills[0]?.round, w);
  const sum = Object.values(b).reduce((a, x) => a + x, 0);
  if (eco !== 1) b.economy = Math.round(sum * (eco - 1) * 10) / 10;
  return { score: Math.round(Object.values(b).reduce((a, x) => a + x, 0) * 10) / 10, breakdown: b };
}

/** 1 + perLnRatio x ln(enemy buy / own buy), within [min, max]; 1 for pistol rounds or when a buy is unknown. */
export function economyFactor(p: ParsedDemo, round: number | undefined, w: Weights): number {
  const r = (p.rounds ?? []).find((x) => x.n === round);
  const team = r ? povTeam(p, r) : undefined;
  if (!r || !team || !r.equip || w.economy.pistolRounds.includes(r.n)) return 1;
  const own = r.equip[team], enemy = r.equip[team === "T" ? "CT" : "T"];
  if (!(own > 0) || !(enemy > 0)) return 1;
  const e = w.economy;
  return Math.min(e.max, Math.max(e.min, 1 + e.perLnRatio * Math.log(enemy / own)));
}

/**
 * One moment per round (Peder, 2026-10-15): all of the POV's kills in it, however far
 * apart, with the round's clutch state. Knife rounds are excluded, overtime unless
 * includeOvertime (PLAN.md §3 excludes it). A moment needs a POV kill (a clutch won
 * without one is not a clip).
 */
export function moments(p: ParsedDemo, w: Weights): Moment[] {
  const out: Moment[] = [];
  for (const r of p.rounds.filter((x) => x.phase === "regular" || (x.phase === "overtime" && w.includeOvertime))) {
    const team = povTeam(p, r);
    if (!team) continue;
    const kills = povKills(p, r);
    if (!kills.length) continue;
    const roundWon = r.winner === team;
    const clutch = clutchState(p, r);
    out.push({ round: r.n, kills, ...(clutch ? { clutch } : {}), roundWon, ...scoreKills(p, kills, clutch, roundWon, w) });
  }
  return out.sort((a, b) => b.score - a.score);
}
