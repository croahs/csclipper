// Per-demo extraction into state/<demo sha256>/parse.json (PLAN.md §2; a film POV other than
// STEAM_ID64 into its pov-<povKey>/ under that dir): the
// match's rounds with phase, winner and reason, every player's team at each
// round's freeze end, and the events scoring needs. Cached under the
// resumability contract: the cache key covers the demo hash, the parser
// version, this file's schema version and the POV; written to a temp file,
// then renamed. Per-tick state is kept as every player's team and alive state
// at each round's freeze end and end; alive counts in between follow from the
// deaths (no respawns in competitive), which is what 1vX needs. A round where
// that does not hold (disconnect, team change) is marked rosterChanged.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, loadIdentities, povKey, povKeyFor } from "../config.ts";
import { DEMOPARSER_VERSION, TICKRATE, sha256File } from "./clip-facts.ts";
import { readFileInfo } from "./fileinfo.ts";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");

const SCHEMA = 8; // 8: the POV's yaw at each kill (a schema 8 cache comes with or without the death map's optional fields: not bumped for them, see that block); 3: airborne on deaths, POV flicks; 4: flicks from gunshots only; 5: names on deaths; 6: equipment per team; 7: victim facing
const REGULATION_ROUNDS = 24; // MR12; later match rounds are overtime

export type Team = "T" | "CT";
export type Death = {
  tick: number; round: number; attacker: string | null; victim: string; assister: string | null;
  weapon: string; headshot: boolean; penetrated: boolean; noscope: boolean; thrusmoke: boolean; attackerblind: boolean;
  distance: number; victimHpBefore: number; // victim's health before the killing hit (100 if unhurt this round)
  airborne: boolean; // attackerinair on the death event
  attackerName: string; victimName: string; // as the death event names them (reel overlays)
  // POV kills only: the angle between the victim's view (yaw) and the line from the victim to the POV,
  // the tick before the kill; undefined when the parser has no position or angle for either.
  victimFacingDeg?: number;
  povYaw?: number; // POV kills only: the POV's view yaw the tick before the kill (direction spread)
  // --- death map (optional fields, no schema bump) ---
  victimPos?: Vec3; attackerPos?: Vec3; // where each stood at the death event (game units, rounded); absent when the parser has none
  povFacingDeg?: number; // POV deaths only: facingDeg with the POV as the victim (his view vs the line to his killer), the tick before
  // --- end death map ---
};
export type Vec3 = [number, number, number]; // death map (optional fields, no schema bump)
// The POV's view turn before each gun kill: the largest yaw change from 100-200 ms
// before the kill shot (the POV's last gunshot at or before the kill, within 1 s) to the shot itself.
// A cache parsed before the bare-name fix may hold a knife swing or a grenade throw as that shot;
// scoring drops such a flick (flickYaw, src/score). No schema bump for it: docs/modules.md, Death map.
export type Flick = { killTick: number; shotTick: number; yawDegrees: number };
export type Hurt = { tick: number; round: number; attacker: string | null; victim: string; dmg: number; health: number; weapon: string };
export type Fire = { tick: number; round: number; player: string; weapon: string };
export type BombEvent = { tick: number; round: number; player: string; kind: "planted" | "defused" };
export type Blind = { tick: number; round: number; attacker: string | null; victim: string; duration: number };
export type Round = {
  n: number; // 1-based match round
  startTick: number; freezeEndTick: number; endTick: number;
  winner: Team | null; reason: string | null;
  phase: "regular" | "overtime" | "knife";
  teams: Record<string, Team>; // steamid → team at freeze end, alive players only
  // A player alive at freeze end neither died nor was alive on the same team at
  // round end (disconnect, team change): alive counts from deaths are unreliable.
  rosterChanged: boolean;
  equip: Record<Team, number>; // the team's equipment value at freeze end (current_equip_value, alive players): its buy
};
export type ParsedDemo = {
  schema: number; key: string;
  demo: { path: string; sha256: string; map: string; patch: string; tickrate: number; playbackTicks: number };
  // The POV player (STEAM_ID64). A reconnect brings a new user id; the render
  // resolves the spectator slot at its own ticks (clip-facts).
  identity: { steamid: string; name: string; userIds: number[] };
  matchStartTick: number; // last begin_new_match; earlier rounds are warmup / knife / restarts
  preMatchRounds: number;
  rounds: Round[];
  // Events are owned by the round they follow, up to the next round's start;
  // post-round events (after endTick) are kept, and scoring cuts at endTick.
  deaths: Death[]; hurts: Hurt[]; fires: Fire[]; bombs: BombEvent[]; blinds: Blind[];
  flicks: Flick[];
  footprint?: number[]; // death map (optional fields, no schema bump): every FOOTPRINT_CELL cell a live player stood in, sampled every FOOTPRINT_EVERY ticks, flat [cx, cy, ...]
};

const sid = (v: unknown) => (typeof v === "string" && /^\d{17}$/.test(v) ? v : null);
const teamOf = (n: number): Team | null => (n === 2 ? "T" : n === 3 ? "CT" : null);
const winnerOf = (w: unknown): Team | null => (w === "T" || w === "CT" ? w : null);
/** Weapons whose weapon_fire or kill is not a gunshot: knives, grenades and their fire, the bomb. Tested on bare names only. */
const NOT_A_GUN = /^(knife|bayonet|hegrenade|flashbang|smokegrenade|molotov|incgrenade|inferno|decoy|c4|planted_c4|world)/;
// weapon_fire names carry a "weapon_" prefix (weapon_knife_ursus, weapon_hegrenade) that deaths and hurts
// do not (knife_ursus, hegrenade): every weapon test goes through the bare name, one rule for all three.
export const bareWeapon = (w: string) => String(w ?? "").replace(/^weapon_/, "");
/** A knife (any skin, the bayonets): a swing in weapon_fire, a knife kill in player_death. */
export const isKnife = (w: string) => /^(knife|bayonet)/.test(bareWeapon(w));
/** A gunshot or a gun kill: not a knife, a grenade or its fire, the bomb or the world. */
export const isGunshot = (w: string) => !NOT_A_GUN.test(bareWeapon(w));
/**
 * A knife round: shots were fired in it and every one was a knife swing. Derived from the fires, so a
 * cache parsed before the bare-name fix (whose rounds were never marked "knife") reads right too.
 */
export function isKnifeRound(p: Pick<ParsedDemo, "fires">, r: Pick<Round, "n" | "endTick" | "phase">): boolean {
  if (r.phase === "knife") return true;
  // Only the match's first round can be one (the knife round decides sides before the match proper): a
  // later round where nobody fired a gun and someone was knifed is a normal round, and a highlight.
  if (r.n !== 1) return false;
  const shots = p.fires.filter((f) => f.round === r.n && f.tick <= r.endTick);
  return shots.length > 0 && shots.every((f) => isKnife(f.weapon));
}

// --- death map (optional fields, no schema bump) ---
export const FOOTPRINT_CELL = 32; // game units per footprint cell (a player is 32 wide)
export const FOOTPRINT_EVERY = 32; // ticks between footprint samples (0.5 s at 64)
/** The scoring's facing angle: degrees between the victim's view (yaw) and the line from the victim to the attacker. */
export function facingDeg(v: { X: number; Y: number; yaw: number }, a: { X: number; Y: number }): number {
  const toAttacker = (Math.atan2(a.Y - v.Y, a.X - v.X) * 180) / Math.PI;
  return Math.round(Math.abs(((v.yaw - toAttacker) % 360 + 540) % 360 - 180) * 10) / 10;
}
// --- end death map ---

export function parseDir(sha256: string) {
  return path.join(STATE_DIR, sha256);
}
/**
 * Where one POV's parse.json and moments files live: the main POV (STEAM_ID64, no key) in the demo's
 * own state dir as always, any other POV in pov-<povKey>/ under it.
 */
export const povDir = (sha256: string, key?: string) => (key ? path.join(parseDir(sha256), `pov-${key}`) : parseDir(sha256));
/** The parse cache key: demo hash, parser, schema, POV (one form for every POV). */
export const parseKey = (sha256: string, pov: string) => `${sha256}:demoparser2@${DEMOPARSER_VERSION}:schema${SCHEMA}:pov${pov}`;

/** The POV is not among the players of the demo's match rounds; for a film roster player that means "not in this demo", not an error. */
export class PovAbsent extends Error {}
const absentMessage = (pov: string, main: boolean) => (main ? "POV player (STEAM_ID64) not found in this demo's match rounds" : `player ${povKey(pov)} not found in this demo's match rounds`);

function extract(demo: string, sha256: string, pov: string, key: string, main: boolean): ParsedDemo {
  const info = readFileInfo(demo);
  const rate = info.playback_ticks / info.playback_time;
  if (Math.round(rate) !== TICKRATE) throw new Error(`demo tickrate ${rate} != ${TICKRATE}`);
  const header = dp.parseHeader(demo);

  // Without the live-match marker, warmup and knife rounds cannot be told from the match.
  const begins: { tick: number }[] = dp.parseEvent(demo, "begin_new_match", [], []);
  if (!begins.length) throw new Error("no begin_new_match in this demo: cannot tell the match from warmup");
  const matchStartTick = Math.max(...begins.map((b) => b.tick));
  const ends: { tick: number; winner: unknown; reason: unknown }[] = dp.parseEvent(demo, "round_end", [], []);
  const starts: { tick: number }[] = dp.parseEvent(demo, "round_start", [], []);
  const freezes: { tick: number }[] = dp.parseEvent(demo, "round_freeze_end", [], []);
  const matchEnds = ends.filter((e) => e.tick > matchStartTick && winnerOf(e.winner)).sort((a, b) => a.tick - b.tick);
  const preMatchRounds = ends.filter((e) => e.tick <= matchStartTick && winnerOf(e.winner)).length;

  // A round runs from the last round_start after the previous round's end to its own end.
  const rounds: Round[] = matchEnds.map((e, i) => {
    const prevEnd = i === 0 ? matchStartTick : matchEnds[i - 1].tick;
    const startTick = Math.max(prevEnd, ...starts.filter((s) => s.tick >= prevEnd && s.tick < e.tick).map((s) => s.tick));
    const freeze = freezes.filter((f) => f.tick >= startTick && f.tick < e.tick).map((f) => f.tick);
    return {
      n: i + 1, startTick, freezeEndTick: freeze.length ? Math.min(...freeze) : startTick, endTick: e.tick,
      winner: winnerOf(e.winner), reason: typeof e.reason === "string" ? e.reason : null,
      phase: i + 1 > REGULATION_ROUNDS ? "overtime" : "regular", teams: {}, rosterChanged: false, equip: { T: 0, CT: 0 },
    };
  });
  const roundAt = (tick: number) => {
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (tick > rounds[i].startTick && tick <= (rounds[i + 1]?.startTick ?? Infinity)) return rounds[i].n;
    }
    return 0;
  };

  // Teams and alive state at each freeze end and each round end, every player.
  type Row = { tick: number; steamid: string; team_num: number; is_alive: boolean; user_id: number; name: string; current_equip_value: number };
  const rows: Row[] = rounds.length
    ? dp.parseTicks(demo, ["team_num", "is_alive", "user_id", "current_equip_value"], [...new Set(rounds.flatMap((r) => [r.freezeEndTick, r.endTick]))], [])
    : [];
  for (const r of rounds) {
    for (const row of rows.filter((x) => x.tick === r.freezeEndTick)) {
      const t = teamOf(row.team_num);
      const id = sid(row.steamid);
      if (t && id && row.is_alive) { r.teams[id] = t; r.equip[t] += row.current_equip_value || 0; }
    }
  }
  const mine = rows.filter((x) => x.steamid === pov);
  if (!mine.length) throw new PovAbsent(absentMessage(pov, main));
  const identity = { steamid: pov, name: mine[0].name, userIds: [...new Set(mine.map((x) => x.user_id))] };

  const inMatch = <T extends { tick: number }>(xs: T[]) => xs.filter((x) => x.tick > matchStartTick && roundAt(x.tick) > 0);
  const hurts: Hurt[] = inMatch(dp.parseEvent(demo, "player_hurt", [], []) as any[]).map((h) => ({
    tick: h.tick, round: roundAt(h.tick), attacker: sid(h.attacker_steamid), victim: h.user_steamid, dmg: h.dmg_health, health: h.health, weapon: h.weapon,
  }));
  const deaths: Death[] = inMatch(dp.parseEvent(demo, "player_death", [], []) as any[]).map((d) => {
    const round = roundAt(d.tick);
    // Health before the killing hit: the last non-lethal hurt this round, else full.
    const prior = hurts.filter((h) => h.round === round && h.victim === d.user_steamid && h.tick <= d.tick && h.health > 0);
    return {
      tick: d.tick, round, attacker: sid(d.attacker_steamid), victim: d.user_steamid, assister: sid(d.assister_steamid),
      weapon: d.weapon, headshot: !!d.headshot, penetrated: (d.penetrated ?? 0) > 0, noscope: !!d.noscope,
      thrusmoke: !!d.thrusmoke, attackerblind: !!d.attackerblind, distance: d.distance ?? 0,
      victimHpBefore: prior.length ? prior[prior.length - 1].health : 100,
      airborne: !!d.attackerinair,
      attackerName: String(d.attacker_name ?? ""), victimName: String(d.user_name ?? ""),
    };
  });
  const fires: Fire[] = inMatch(dp.parseEvent(demo, "weapon_fire", [], []) as any[]).map((f) => ({ tick: f.tick, round: roundAt(f.tick), player: f.user_steamid, weapon: f.weapon }));
  const bombs: BombEvent[] = [
    ...inMatch(dp.parseEvent(demo, "bomb_planted", [], []) as any[]).map((b) => ({ tick: b.tick, round: roundAt(b.tick), player: b.user_steamid, kind: "planted" as const })),
    ...inMatch(dp.parseEvent(demo, "bomb_defused", [], []) as any[]).map((b) => ({ tick: b.tick, round: roundAt(b.tick), player: b.user_steamid, kind: "defused" as const })),
  ].sort((a, b) => a.tick - b.tick);
  const blinds: Blind[] = inMatch(dp.parseEvent(demo, "player_blind", [], []) as any[]).map((b) => ({ tick: b.tick, round: roundAt(b.tick), attacker: sid(b.attacker_steamid), victim: b.user_steamid, duration: b.blind_duration }));

  // Flicks: the POV's yaw over the 100-200 ms before each kill shot (the POV's last gunshot within 1 s
  // before a gun kill; none, no flick), one parse for all of them. Offsets stay inside the window.
  const FLICK_FROM = Math.ceil(0.1 * TICKRATE), FLICK_TO = Math.floor(0.2 * TICKRATE);
  const shots = deaths.filter((d) => d.attacker === pov && isGunshot(d.weapon)).flatMap((d) => {
    const shot = fires.filter((f) => f.player === pov && f.round === d.round && f.tick <= d.tick && f.tick >= d.tick - TICKRATE && isGunshot(f.weapon)).at(-1);
    return shot ? [{ killTick: d.tick, shotTick: shot.tick }] : [];
  });
  const yawTicks = [...new Set(shots.flatMap((s) => Array.from({ length: FLICK_TO + 1 }, (_, i) => s.shotTick - i)))].filter((t) => t > 0);
  const yaw = new Map<number, number>();
  if (yawTicks.length) for (const row of dp.parseTicks(demo, ["yaw"], yawTicks, [pov]) as { tick: number; yaw: number }[]) yaw.set(row.tick, row.yaw);
  const turn = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const flicks: Flick[] = shots.map((s) => {
    const at = yaw.get(s.shotTick);
    let max = 0;
    for (let k = FLICK_FROM; k <= FLICK_TO; k++) { const before = yaw.get(s.shotTick - k); if (at !== undefined && before !== undefined) max = Math.max(max, turn(at, before)); }
    return { ...s, yawDegrees: Math.round(max * 10) / 10 };
  });

  // Facing: for each POV kill, the victim's yaw against the direction to the POV, the tick before.
  // Victims without a SteamID (bots, a dropped player) have no angles to ask for.
  const povKillsAll = deaths.filter((d) => d.attacker === pov && d.victim !== pov && sid(d.victim));
  // (the POV's yaw is read with the facing data; a kill of a player without a SteamID gets neither)
  if (povKillsAll.length) {
    type Pos = { tick: number; steamid: string; X: number; Y: number; yaw: number };
    const at = new Map<string, Pos>();
    const rows2 = dp.parseTicks(demo, ["X", "Y", "yaw"], [...new Set(povKillsAll.map((d) => d.tick - 1))], [...new Set([pov, ...povKillsAll.map((d) => d.victim)])]) as Pos[];
    for (const row of rows2) at.set(`${row.tick}:${row.steamid}`, row);
    for (const d of povKillsAll) {
      const v = at.get(`${d.tick - 1}:${d.victim}`), a = at.get(`${d.tick - 1}:${pov}`);
      if (a && Number.isFinite(a.yaw)) d.povYaw = Math.round(a.yaw * 10) / 10;
      if (!v || !a || ![v.X, v.Y, v.yaw, a.X, a.Y].every(Number.isFinite)) continue;
      const toAttacker = (Math.atan2(a.Y - v.Y, a.X - v.X) * 180) / Math.PI;
      const diff = Math.abs(((v.yaw - toAttacker) % 360 + 540) % 360 - 180);
      d.victimFacingDeg = Math.round(diff * 10) / 10;
    }
  }

  // --- death map (optional fields, no schema bump) ---
  // Positions at every death (victim and attacker, from the event itself), the POV's facing at each of
  // his deaths (the scoring's facing angle the tick before, the POV as the victim), and the match's
  // footprint: where live players stood, so the death map draws the map's shape from data.
  // Additive: a failure here leaves the fields out and never fails the parse the pipeline runs on.
  let footprint: number[] | undefined;
  try {
  const deathPos = new Map<string, any>();
  for (const e of dp.parseEvent(demo, "player_death", ["X", "Y", "Z"], []) as any[]) deathPos.set(`${e.tick}:${e.user_steamid}:${e.user_name}`, e);
  const vec = (x: unknown, y: unknown, z: unknown): Vec3 | undefined =>
    [x, y, z].every((n) => typeof n === "number" && Number.isFinite(n)) ? [Math.round(x as number), Math.round(y as number), Math.round(z as number)] : undefined;
  for (const d of deaths) {
    const e = deathPos.get(`${d.tick}:${d.victim}:${d.victimName}`);
    if (!e) continue;
    const v = vec(e.user_X, e.user_Y, e.user_Z), a = d.attacker ? vec(e.attacker_X, e.attacker_Y, e.attacker_Z) : undefined;
    if (v) d.victimPos = v;
    if (a) d.attackerPos = a;
  }
  const povDeaths = deaths.filter((d) => d.victim === pov && d.attacker && d.attacker !== pov);
  if (povDeaths.length) {
    type Pos = { tick: number; steamid: string; X: number; Y: number; yaw: number };
    const at = new Map<string, Pos>();
    for (const row of dp.parseTicks(demo, ["X", "Y", "yaw"], [...new Set(povDeaths.map((d) => d.tick - 1))], [...new Set([pov, ...povDeaths.map((d) => d.attacker!)])]) as Pos[]) at.set(`${row.tick}:${row.steamid}`, row);
    for (const d of povDeaths) {
      const v = at.get(`${d.tick - 1}:${pov}`), a = at.get(`${d.tick - 1}:${d.attacker}`);
      if (v && a && [v.X, v.Y, v.yaw, a.X, a.Y].every(Number.isFinite)) d.povFacingDeg = facingDeg(v, a);
    }
  }
  const sampleTicks: number[] = [];
  for (let t = matchStartTick + FOOTPRINT_EVERY; t <= (rounds.at(-1)?.endTick ?? 0); t += FOOTPRINT_EVERY) sampleTicks.push(t);
  const cells = new Set<string>();
  if (sampleTicks.length) {
    for (const row of dp.parseTicks(demo, ["X", "Y", "is_alive"], sampleTicks, []) as { X: number; Y: number; is_alive: boolean }[]) {
      if (row.is_alive && Number.isFinite(row.X) && Number.isFinite(row.Y)) cells.add(`${Math.round(row.X / FOOTPRINT_CELL)},${Math.round(row.Y / FOOTPRINT_CELL)}`);
    }
  }
  footprint = [...cells].flatMap((c) => c.split(",").map(Number));
  } catch (e) {
    footprint = undefined;
    for (const d of deaths) { delete d.victimPos; delete d.attackerPos; delete d.povFacingDeg; }
    console.warn(`death map fields not extracted (the parse is otherwise complete): ${(e as Error).message}`);
  }
  // --- end death map ---

  for (const r of rounds) {
    // A knife round: shots were fired and every one was a knife swing (bare names, isKnifeRound).
    if (isKnifeRound({ fires }, r)) r.phase = "knife";
    // Everyone alive at freeze end either died this round or is alive on the same team at its end.
    const atEnd = rows.filter((x) => x.tick === r.endTick);
    for (const [id, team] of Object.entries(r.teams)) {
      const died = deaths.some((d) => d.round === r.n && d.victim === id && d.tick <= r.endTick);
      const end = atEnd.find((x) => x.steamid === id);
      if (!died && (!end || !end.is_alive || teamOf(end.team_num) !== team)) r.rosterChanged = true;
    }
  }

  return {
    schema: SCHEMA, key,
    demo: { path: demo, sha256, map: String(header.map_name), patch: String(header.patch_version), tickrate: TICKRATE, playbackTicks: info.playback_ticks },
    identity, matchStartTick, preMatchRounds, rounds, deaths, hurts, fires, bombs, blinds, flicks,
    footprint, // death map (optional fields, no schema bump)
  };
}

/**
 * The last match round's end: CS2's end-of-match state starts there (passesMatchEnd); a demo
 * without rounds has no match end before its last tick. One rule for highlights and reels.
 */
export const matchEndTick = (p: ParsedDemo) => (p.rounds.length ? Math.max(...p.rounds.map((r) => r.endTick)) : p.demo.playbackTicks);

/** A cached parse made by this parser version and schema (an older one lacks fields scoring reads). */
export const parseIsCurrent = (p: ParsedDemo) => p.key.includes(`:demoparser2@${DEMOPARSER_VERSION}:schema${SCHEMA}:`);

/**
 * Parse once per demo and POV, cached; a cached file counts only if its key matches. mainPov
 * (STEAM_ID64) decides the cache's place (povDir): the main POV's stays where it always was.
 */
export async function parseDemo(demo: string, pov: string, mainPov = loadIdentities().pov, extractor = extract): Promise<ParsedDemo> {
  const sha256 = await sha256File(demo);
  const key = parseKey(sha256, pov);
  const dir = povDir(sha256, povKeyFor(pov, mainPov));
  const file = path.join(dir, "parse.json");
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as ParsedDemo;
      if (cached.key === key) return { ...cached, demo: { ...cached.demo, path: demo } };
    } catch {}
  }
  // "Not in this demo", cached beside the parse (absent.json): the folder names the POV (povKey), the
  // key holds demo hash, the POV's hash (the main POV shares the demo's own folder, and STEAM_ID64 can
  // change), parser and schema, so a schema or parser bump re-checks. Only PovAbsent is cached; any
  // other failure is thrown as it was and parsed again next time.
  const absent = path.join(dir, "absent.json");
  const absentKey = `${sha256}:${povKey(pov)}:demoparser2@${DEMOPARSER_VERSION}:schema${SCHEMA}`;
  const main = pov === mainPov;
  if (existsSync(absent)) {
    try { if (JSON.parse(readFileSync(absent, "utf8")).key === absentKey) throw new PovAbsent(absentMessage(pov, main)); } catch (e) { if (e instanceof PovAbsent) throw e; }
  }
  let parsed: ParsedDemo;
  try { parsed = extractor(demo, sha256, pov, key, main); } catch (e) {
    if (e instanceof PovAbsent) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${absent}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ key: absentKey }));
      renameSync(tmp, absent);
    }
    throw e;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // unique per writer
  writeFileSync(tmp, JSON.stringify(parsed));
  renameSync(tmp, file);
  return parsed;
}

// --- death map (optional fields, no schema bump) ---
// The death map's fields are optional within schema 8: bumping the schema would make every cache
// whose demo has left the store stale for good (2026-11-10: 59 of 80), and pnpm rescore skips stale
// parses. So a cache made before them stays current, and pnpm deathmap re-parses a demo that is still
// in the store once to add them: the same key (as parseDemo builds it), temp file then rename.
export const hasPositions = (p: ParsedDemo) => p.footprint !== undefined;
export async function reparseDemo(demo: string, pov: string, mainPov = loadIdentities().pov): Promise<ParsedDemo> {
  const sha256 = await sha256File(demo);
  const key = parseKey(sha256, pov);
  const parsed = extract(demo, sha256, pov, key, pov === mainPov);
  const file = path.join(povDir(sha256, povKeyFor(pov, mainPov)), "parse.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed));
  renameSync(tmp, file);
  return parsed;
}
// --- end death map ---
