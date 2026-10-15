// Per-demo extraction into state/<demo sha256>/parse.json (PLAN.md §2): the
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
import { STATE_DIR } from "../config.ts";
import { DEMOPARSER_VERSION, TICKRATE, sha256File } from "./clip-facts.ts";
import { readFileInfo } from "./fileinfo.ts";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");

const SCHEMA = 6; // 3: airborne on deaths, POV flicks; 4: flicks from gunshots only; 5: names on deaths; 6: equipment per team
const REGULATION_ROUNDS = 24; // MR12; later match rounds are overtime

export type Team = "T" | "CT";
export type Death = {
  tick: number; round: number; attacker: string | null; victim: string; assister: string | null;
  weapon: string; headshot: boolean; penetrated: boolean; noscope: boolean; thrusmoke: boolean; attackerblind: boolean;
  distance: number; victimHpBefore: number; // victim's health before the killing hit (100 if unhurt this round)
  airborne: boolean; // attackerinair on the death event
  attackerName: string; victimName: string; // as the death event names them (reel overlays)
};
// The POV's view turn before each of his gun kills: the largest yaw change from 100-200 ms
// before the kill shot (his last gunshot at or before the kill, within 1 s) to the shot itself.
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
};

const sid = (v: unknown) => (typeof v === "string" && /^\d{17}$/.test(v) ? v : null);
const teamOf = (n: number): Team | null => (n === 2 ? "T" : n === 3 ? "CT" : null);
const winnerOf = (w: unknown): Team | null => (w === "T" || w === "CT" ? w : null);
const isKnife = (w: string) => w.startsWith("knife") || w === "bayonet";
/** Weapons whose weapon_fire or kill is not a gunshot: knives, grenades and their fire, the bomb. */
export const NOT_A_GUN = /^(knife|bayonet|hegrenade|flashbang|smokegrenade|molotov|incgrenade|inferno|decoy|c4|planted_c4|world)/;

export function parseDir(sha256: string) {
  return path.join(STATE_DIR, sha256);
}

function extract(demo: string, sha256: string, pov: string, key: string): ParsedDemo {
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
  if (!mine.length) throw new Error("POV player (STEAM_ID64) not found in this demo's match rounds");
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

  // Flicks: the POV's yaw over the 100-200 ms before each kill shot (his last gunshot within 1 s
  // before a gun kill; none, no flick), one parse for all of them. Offsets stay inside the window.
  const FLICK_FROM = Math.ceil(0.1 * TICKRATE), FLICK_TO = Math.floor(0.2 * TICKRATE);
  const shots = deaths.filter((d) => d.attacker === pov && !NOT_A_GUN.test(d.weapon)).flatMap((d) => {
    const shot = fires.filter((f) => f.player === pov && f.round === d.round && f.tick <= d.tick && f.tick >= d.tick - TICKRATE && !NOT_A_GUN.test(f.weapon)).at(-1);
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

  for (const r of rounds) {
    // A knife round: shots were fired and every one was a knife swing.
    const shots = fires.filter((f) => f.round === r.n && f.tick <= r.endTick);
    if (shots.length && shots.every((f) => isKnife(f.weapon))) r.phase = "knife";
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
  };
}

/** Parse once per demo, cached; a cached file counts only if its key matches. */
export async function parseDemo(demo: string, pov: string): Promise<ParsedDemo> {
  const sha256 = await sha256File(demo);
  const key = `${sha256}:demoparser2@${DEMOPARSER_VERSION}:schema${SCHEMA}:pov${pov}`;
  const dir = parseDir(sha256);
  const file = path.join(dir, "parse.json");
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as ParsedDemo;
      if (cached.key === key) return { ...cached, demo: { ...cached.demo, path: demo } };
    } catch {}
  }
  const parsed = extract(demo, sha256, pov, key);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // unique per writer
  writeFileSync(tmp, JSON.stringify(parsed));
  renameSync(tmp, file);
  return parsed;
}
