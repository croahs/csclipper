// Scoring (PLAN.md §3): round context (clutch state, outcome) and kill
// clusters, scored with the weights in scoring.json. First-ranking signals
// only; flick angle, trades and "saved a teammate" are deferred.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import type { Death, ParsedDemo, Round, Team } from "../parse/demo.ts";

export type Weights = {
  clusterGapSeconds: number;
  killBase: Record<string, number>;
  speed: { referenceSeconds: number; pointsPerSecondFaster: number; max: number };
  clutch: { perEnemy: number; wonBonus: number; lostFactor: number };
  flags: { headshot: number; wallbang: number; noscope: number; thrusmoke: number; attackerblind: number };
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

export function scoreKills(kills: Death[], clutch: Clutch | undefined, roundWon: boolean, w: Weights, tickrate: number): Pick<Moment, "score" | "breakdown"> {
  const b: Record<string, number> = {};
  const n = kills.length;
  const base = w.killBase[String(Math.min(n, 5))] ?? 0;
  // The multikill's weapon is the one most of its kills were made with.
  const counts = new Map<WeaponClass, number>();
  for (const k of kills) counts.set(weaponClass(k.weapon), (counts.get(weaponClass(k.weapon)) ?? 0) + 1);
  const cls = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
  b.kills = Math.round(base * (w.weaponMultiplier[cls] ?? 1) * 10) / 10;
  if (n >= 2) {
    const avgGap = (kills[n - 1].tick - kills[0].tick) / (n - 1) / tickrate;
    b.speed = Math.round(Math.min(w.speed.max, Math.max(0, (w.speed.referenceSeconds - avgGap) * w.speed.pointsPerSecondFaster)) * 10) / 10;
  }
  if (clutch) b.clutch = clutch.vs * w.clutch.perEnemy * (clutch.won ? 1 : w.clutch.lostFactor) + (clutch.won ? w.clutch.wonBonus : 0);
  const f = w.flags;
  b.flags = kills.reduce((s, k) => s + (k.headshot ? f.headshot : 0) + (k.penetrated ? f.wallbang : 0) + (k.noscope ? f.noscope : 0) + (k.thrusmoke ? f.thrusmoke : 0) + (k.attackerblind ? f.attackerblind : 0), 0);
  if (roundWon) b.roundWon = w.roundWon;
  const low = kills.filter((k) => k.victimHpBefore <= w.lowHp.threshold).length;
  if (low) b.lowHp = -low * w.lowHp.penaltyPerKill;
  return { score: Math.round(Object.values(b).reduce((a, x) => a + x, 0) * 10) / 10, breakdown: b };
}

/**
 * Moments per round: a clutch is a round property, so all POV kills from the
 * clutch start form one moment; other kills form clusters of kills at most
 * clusterGapSeconds apart. Knife rounds are excluded, overtime unless
 * includeOvertime (PLAN.md §3 excludes it). A moment needs a POV kill (a
 * clutch won without one is not a clip).
 */
export function moments(p: ParsedDemo, w: Weights): Moment[] {
  const out: Moment[] = [];
  const gap = w.clusterGapSeconds * p.demo.tickrate;
  for (const r of p.rounds.filter((x) => x.phase === "regular" || (x.phase === "overtime" && w.includeOvertime))) {
    const team = povTeam(p, r);
    if (!team) continue;
    const kills = povKills(p, r);
    if (!kills.length) continue;
    const roundWon = r.winner === team;
    const clutch = clutchState(p, r);
    const clutchKills = clutch ? kills.filter((k) => k.tick >= clutch.fromTick) : [];
    const rest = kills.filter((k) => !clutchKills.includes(k));
    const clusters: Death[][] = [];
    for (const k of rest) {
      const last = clusters[clusters.length - 1];
      if (last && k.tick - last[last.length - 1].tick <= gap) last.push(k);
      else clusters.push([k]);
    }
    // Kills just before the clutch start that chain into it belong to it.
    if (clutchKills.length && clusters.length) {
      const last = clusters[clusters.length - 1];
      if (clutchKills[0].tick - last[last.length - 1].tick <= gap) clutchKills.unshift(...clusters.pop()!);
    }
    for (const c of clusters) out.push({ round: r.n, kills: c, roundWon, ...scoreKills(c, undefined, roundWon, w, p.demo.tickrate) });
    if (clutch && (clutchKills.length || clutch.won)) out.push({ round: r.n, kills: clutchKills, clutch, roundWon, ...scoreKills(clutchKills, clutch, roundWon, w, p.demo.tickrate) });
  }
  return out.filter((m) => m.kills.length).sort((a, b) => b.score - a.score);
}
