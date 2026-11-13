// The bloopers' one extra parser pass: every player's position, view and alive state every
// TRACK_EVERY ticks (0.25 s at 64) from each match round's freeze end to its end, plus who had
// each player spotted (the game's own spotted-by mask, CCSPlayerPawn.m_bSpottedByMask through
// demoparser2's approximate_spotted_by: a positive line-of-sight signal, set for the victim at
// 71 % of one demo's non-wallbang gun kills the tick before and at none of its wallbangs; its
// absence proves nothing), and where the smokes were: each smoke's centre and its active ticks, so
// shots into a smoke are not counted as missed bullets (src/film/bloopers.ts).
// Cached as state/<demo sha256>/bloopers-track.json.gz under the resumability contract: the key
// covers the demo hash, the parser version and this file's schema; temp file, then rename.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DEMOPARSER_VERSION, sha256File } from "../parse/clip-facts.ts";
import { loadIdentities, povKeyFor } from "../config.ts";
import { PovAbsent, parseDemo, parseDir, parseKey, povDir, type ParsedDemo } from "../parse/demo.ts";

const require = createRequire(import.meta.url);

const SCHEMA = 2; // 2: smokes
export const TRACK_EVERY = 16; // ticks between samples
/** Values per player per sample in Track.data: X, Y, Z, yaw, pitch, alive (0/1), spottedBy (bit i: players[i] had this player spotted). */
export const TRACK_STRIDE = 7;
const MAX_SPOTTERS = 31; // bitmask width; a demo has 10 (a substitute or two more)
/**
 * A smoke's life when the demo holds no smokegrenade_expired for it: 22 s, measured (bloom to
 * expire was 22.06 s, 1412 ticks at 64, for every expired smoke of one demo). Capped at the round's end.
 */
export const SMOKE_SECONDS = 22;

export type Track = {
  schema: number; key: string;
  every: number;
  ticks: number[]; // sample ticks, ascending, multiples of `every`
  players: string[]; // SteamID64s; index = bit in spottedBy
  names: string[];
  // data[player][sample * TRACK_STRIDE + k], rounded ints (a dead or absent player: zeros)
  data: number[][];
  // The match rounds' smokes. Absent (a Track built without it, as in tests): no smokes.
  smokes?: Smoke[];
};
/** A smoke: its centre (the detonation point, rounded), the tick it bloomed and the tick it ended. */
export type Smoke = { X: number; Y: number; Z: number; from: number; to: number };
export type Sample = { X: number; Y: number; Z: number; yaw: number; pitch: number; alive: boolean; spottedBy: number };

/** A player's state at sample i (track.players index). */
export function sampleAt(track: Track, player: number, i: number): Sample {
  const d = track.data[player], o = i * TRACK_STRIDE;
  return { X: d[o], Y: d[o + 1], Z: d[o + 2], yaw: d[o + 3], pitch: d[o + 4], alive: d[o + 5] === 1, spottedBy: d[o + 6] };
}

/** Whether a spottedBy mask has players[spotter]'s bit; an index of MAX_SPOTTERS or more never does (extract stores none, and 1 << 32 would wrap to bit 0). */
export const hasSpotter = (mask: number, spotter: number) => spotter >= 0 && spotter < MAX_SPOTTERS && (mask & (1 << spotter)) !== 0;

/** The sample ticks of the match rounds: every `every`-th tick from freeze end to round end. */
export function trackTicks(p: ParsedDemo, every = TRACK_EVERY): number[] {
  const out: number[] = [];
  for (const r of p.rounds) for (let t = Math.ceil(r.freezeEndTick / every) * every; t <= r.endTick; t += every) out.push(t);
  return [...new Set(out)].sort((a, b) => a - b);
}

const sid = (v: unknown) => (typeof v === "string" && /^\d{17}$/.test(v) ? v : null);

/** One parser pass over the demo: the samples and the smokes (sampleTrack caches it). */
export function extractTrack(demo: string, p: ParsedDemo, key: string): Track {
  const dp = require("@laihoe/demoparser2");
  const ticks = trackTicks(p);
  const index = new Map(ticks.map((t, i) => [t, i]));
  type Row = { tick: number; steamid: string; name: string; X: number; Y: number; Z: number; yaw: number; pitch: number; is_alive: boolean; approximate_spotted_by: string[] | null };
  const rows: Row[] = ticks.length ? dp.parseTicks(demo, ["X", "Y", "Z", "yaw", "pitch", "is_alive", "approximate_spotted_by"], ticks, []) : [];
  const players: string[] = [], names: string[] = [];
  const slot = new Map<string, number>();
  for (const r of rows) {
    const id = sid(r.steamid);
    if (!id || slot.has(id)) continue;
    slot.set(id, players.length);
    players.push(id);
    names.push(String(r.name ?? ""));
  }
  const data = players.map(() => new Array<number>(ticks.length * TRACK_STRIDE).fill(0));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
  for (const r of rows) {
    const pi = slot.get(r.steamid), i = index.get(r.tick);
    if (pi === undefined || i === undefined || !r.is_alive) continue;
    let mask = 0;
    for (const s of r.approximate_spotted_by ?? []) { const b = slot.get(s); if (b !== undefined && b < MAX_SPOTTERS) mask |= 1 << b; }
    const o = i * TRACK_STRIDE;
    const d = data[pi];
    d[o] = num(r.X); d[o + 1] = num(r.Y); d[o + 2] = num(r.Z); d[o + 3] = num(r.yaw); d[o + 4] = num(r.pitch); d[o + 5] = 1; d[o + 6] = mask >>> 0;
  }
  const smokes = smokesOf(p, dp.parseEvent(demo, "smokegrenade_detonate", [], []), dp.parseEvent(demo, "smokegrenade_expired", [], []));
  return { schema: SCHEMA, key, every: TRACK_EVERY, ticks, players, names, data, smokes };
}

type SmokeEvent = { tick: number; entityid: number; x: number; y: number; z: number };
/** The match rounds' smokes: each detonation, ended by its entity's first expire after it in that round, else SMOKE_SECONDS on, never past its round's end. */
export function smokesOf(p: Pick<ParsedDemo, "rounds" | "demo">, detonated: SmokeEvent[], expired: SmokeEvent[]): Smoke[] {
  const out: Smoke[] = [];
  for (const d of detonated) {
    const r = p.rounds.find((x) => d.tick > x.startTick && d.tick <= x.endTick);
    if (!r) continue;
    // Only an expire in the same round ends it: an entity id is reused in later rounds.
    const exp = Math.min(...expired.filter((e) => e.entityid === d.entityid && e.tick > d.tick && e.tick <= r.endTick).map((e) => e.tick));
    const to = Math.min(Number.isFinite(exp) ? exp : d.tick + Math.round(SMOKE_SECONDS * p.demo.tickrate), r.endTick);
    out.push({ X: Math.round(d.x), Y: Math.round(d.y), Z: Math.round(d.z), from: d.tick, to });
  }
  return out;
}

/**
 * The demo's parse for bloopers: rounds, deaths, hurts and fires do not depend on the POV, so the
 * first of `povs` (roster order) whose own cache (povDir) holds a current parse, else the first who
 * played in the demo, parsed into that player's cache. PovAbsent when none of them is in it; an
 * absent player is told by the error's class (any POV's message differs), so the next one is tried.
 * parse: a test seam.
 */
export async function parseAnyPov(demo: string, povs: string[], mainPov = loadIdentities().pov, parse = parseDemo): Promise<ParsedDemo> {
  const sha256 = await sha256File(demo);
  for (const pov of povs) {
    const file = path.join(povDir(sha256, povKeyFor(pov, mainPov)), "parse.json");
    if (!existsSync(file)) continue;
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as ParsedDemo;
      if (cached.key === parseKey(sha256, pov)) return { ...cached, demo: { ...cached.demo, path: demo } };
    } catch {}
  }
  for (const pov of povs) {
    try { return await parse(demo, pov, mainPov); } catch (e) { if (!(e instanceof PovAbsent)) throw e; }
  }
  throw new PovAbsent("none of these players is in this demo's match rounds");
}

/** The SteamID64s on a team (T or CT) in the demo's player info, in its order (pnpm bloopers --all parses through any of them). */
export function demoPlayers(demo: string): string[] {
  const dp = require("@laihoe/demoparser2");
  return (dp.parsePlayerInfo(demo) as { steamid: unknown; team_number: number }[])
    .filter((x) => x.team_number === 2 || x.team_number === 3).map((x) => sid(String(x.steamid))).filter((x): x is string => !!x);
}

/** The demo's track, from the cache when its key matches, else one parser pass (seconds), then cached. */
export function sampleTrack(demoPath: string, p: ParsedDemo): Track {
  const key = `${p.demo.sha256}:demoparser2@${DEMOPARSER_VERSION}:track${SCHEMA}:every${TRACK_EVERY}`;
  const file = path.join(parseDir(p.demo.sha256), "bloopers-track.json.gz");
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Track;
      if (cached.key === key) return cached;
    } catch {}
  }
  const track = extractTrack(demoPath, p, key);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // unique per writer
  writeFileSync(tmp, gzipSync(JSON.stringify(track)));
  renameSync(tmp, file);
  return track;
}
