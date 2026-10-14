// M0.1 spike: parser, identity, time. Throwaway; results go in docs/spikes.md.
// Usage: pnpm exec tsx spikes/m0-1-parse.ts <demo.dem>   (STEAM_ID64 from .env)
// Exits non-zero when any gate check fails. Never prints the SteamID64 or account id.
import { createRequire } from "node:module";
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");
const parserVersion: string = require("@laihoe/demoparser2/package.json").version;

const STEAMID64_BASE = 76561197960265728n;

if (existsSync(".env")) process.loadEnvFile(".env");
const me = process.env.STEAM_ID64?.trim();
const demo = process.argv[2];
if (!me || !/^\d{17}$/.test(me)) throw new Error("STEAM_ID64 missing or not 17 digits in .env");
if (!demo || !existsSync(demo)) throw new Error(`demo not found: ${demo}`);

type Row = Record<string, unknown>;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  return ok;
};
const redact = (v: unknown) => JSON.stringify(v, null, 2).replaceAll(me, "<ME>");

// Field name -> set of runtime types seen across rows.
function schema(rows: Row[]): Record<string, string> {
  const seen: Record<string, Set<string>> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      (seen[k] ??= new Set()).add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
    }
  }
  return Object.fromEntries(Object.entries(seen).map(([k, s]) => [k, [...s].sort().join("|")]));
}

function section(title: string, body: unknown) {
  console.log(`\n== ${title} ==`);
  console.log(typeof body === "string" ? body : redact(body));
}

section("versions", { node: process.version, demoparser2: parserVersion, platform: `${process.platform}-${process.arch}` });

// --- header -----------------------------------------------------------------
section("parseHeader", dp.parseHeader(demo));

// --- identity ---------------------------------------------------------------
const players: Row[] = dp.parsePlayerInfo(demo);
section("parsePlayerInfo schema", schema(players));
const mine = players.filter((p) => p.steamid === me);
if (mine.length !== 1) throw new Error(`expected exactly one player with STEAM_ID64, found ${mine.length}`);
check(typeof mine[0].steamid === "string", "steamid is delivered as a string");
section("identity (parsePlayerInfo)", { steamid: "<ME>", steamid_type: typeof mine[0].steamid, name: mine[0].name, team_number: mine[0].team_number });

// Per-tick identifier props. Probe each on its own: an unknown prop throws.
const idProps = ["user_id", "entity_id", "player_slot", "account_id", "player_name"];
const probe: Record<string, string> = {};
for (const prop of idProps) {
  try {
    const rows: Row[] = dp.parseTicks(demo, [prop], null, [me]);
    const values = [...new Set(rows.map((r) => r[prop]).filter((v) => v !== null && v !== undefined))];
    probe[prop] = values.length ? `${typeof values[0]}, ${values.length} distinct value(s) over ${rows.length} rows` : `all null over ${rows.length} rows`;
  } catch (e) {
    probe[prop] = `throws: ${(e as Error).message.slice(0, 120)}`;
  }
}
section("per-tick identifier props for me", probe);

// The mapping is only usable per demo if it is stable for the whole demo.
const idRows: Row[] = dp.parseTicks(demo, ["user_id", "entity_id"], null, [me]);
const userIds = [...new Set(idRows.map((r) => r.user_id))];
const entityIds = [...new Set(idRows.map((r) => r.entity_id))];
check(userIds.length === 1 && typeof userIds[0] === "number", "user_id is one number for the whole demo");
check(entityIds.length === 1 && typeof entityIds[0] === "number", "entity_id is one number for the whole demo");
section("my identifiers over the whole demo", { user_id: userIds, entity_id: entityIds, spec_player_slot_candidate: userIds.map((u) => Number(u) + 1) });

// --- events -----------------------------------------------------------------
const gameEvents: string[] = dp.listGameEvents(demo);
section("listGameEvents", gameEvents.sort().join(", "));

const deaths: Row[] = dp.parseEvent(demo, "player_death", [], ["total_rounds_played"]);
const hurts: Row[] = dp.parseEvent(demo, "player_hurt", [], ["total_rounds_played"]);
section("player_death schema", schema(deaths));
section("player_hurt schema", schema(hurts));

// Round events: the parser may synthesize these even when listGameEvents omits them.
for (const name of ["round_start", "round_end", "round_officially_ended", "begin_new_match"]) {
  try {
    const rows: Row[] = dp.parseEvent(demo, name, [], ["total_rounds_played"]);
    section(`${name}: ${rows.length} rows`, { schema: schema(rows), first: rows[0] ?? null, ticks_first_3: rows.slice(0, 3).map((r) => r.tick) });
  } catch (e) {
    section(`${name}`, `throws: ${(e as Error).message}`);
  }
}

const nullAttackerHurts = hurts.filter((h) => h.attacker_steamid === null);
section("player_hurt with attacker_steamid null", { count: nullAttackerHurts.length, weapons: [...new Set(nullAttackerHurts.map((h) => h.weapon))] });

// Non-self deaths attributed to me; teams are checked at the event tick below.
const myKills = deaths.filter((d) => d.attacker_steamid === me && d.user_steamid !== me && typeof d.user_steamid === "string");
const myHurts = hurts.filter((h) => h.attacker_steamid === me && h.user_steamid !== me);
section("counts", {
  non_self_deaths_attributed_to_me: myKills.length,
  my_deaths: deaths.filter((d) => d.user_steamid === me).length,
  hurt_events_i_caused_on_others: myHurts.length,
});
check(myKills.length > 0, "at least one kill to join");

// --- join: deaths x damage x tick samples -----------------------------------
// For each kill: exactly one lethal player_hurt (me -> victim, same tick,
// health 0), my sample at the kill tick, and the victim's samples one tick
// before and at the kill.
const wantedTicks = [...new Set(myKills.flatMap((k) => [Number(k.tick) - 1, Number(k.tick)]))];
const victims = [...new Set(myKills.map((k) => String(k.user_steamid)))];
const tickProps = ["health", "is_alive", "team_num", "X", "Y", "Z", "pitch", "yaw"];
const samples: Row[] = dp.parseTicks(demo, tickProps, wantedTicks, [me, ...victims]);
section("parseTicks schema", schema(samples));
const at = (sid: string, tick: number) => samples.filter((s) => s.steamid === sid && s.tick === tick);

const joined = myKills.map((k) => {
  const tick = Number(k.tick);
  const victim = String(k.user_steamid);
  const lethal = myHurts.filter((h) => h.tick === tick && h.user_steamid === victim && h.health === 0);
  const [meNow] = at(me, tick);
  const [vBefore] = at(victim, tick - 1);
  const [vNow] = at(victim, tick);
  const row = {
    tick,
    round: k.total_rounds_played,
    weapon: k.weapon,
    headshot: k.headshot,
    lethal_hurts: lethal.length,
    dmg_health: lethal[0]?.dmg_health ?? null,
    me_sample: !!meNow,
    me_alive: meNow?.is_alive ?? null,
    me_team: meNow?.team_num ?? null,
    victim_team: vNow?.team_num ?? null,
    victim_health_before: vBefore?.health ?? null,
    victim_health_at: vNow?.health ?? null,
    victim_alive_at: vNow?.is_alive ?? null,
  };
  const problems = [
    lethal.length !== 1 && `lethal_hurts=${lethal.length}`,
    !meNow && "no sample for me at kill tick",
    !vBefore && "no victim sample at tick-1",
    !vNow && "no victim sample at kill tick",
    meNow && meNow.is_alive !== true && "me not alive at kill tick",
    vBefore && !(Number(vBefore.health) > 0) && "victim health not > 0 at tick-1",
    vNow && !(vNow.health === 0 && vNow.is_alive === false) && "victim not dead at kill tick",
  ].filter(Boolean);
  return { ...row, teamkill: row.me_team !== null && row.me_team === row.victim_team, problems };
});
section("kills joined across player_death, player_hurt, parseTicks", joined);
const bad = joined.filter((j) => j.problems.length);
check(bad.length === 0, `${bad.length} of ${joined.length} kills failed the join`);
section("join result", {
  kills: joined.length,
  fully_joined: joined.length - bad.length,
  teamkills: joined.filter((j) => j.teamkill).length,
  dmg_health_above_victim_health: joined.filter((j) => Number(j.dmg_health) > Number(j.victim_health_before)).length,
});

// --- time -------------------------------------------------------------------
// Tickrate from the demo file itself, independent of the parser: the
// CDemoFileInfo frame the header points to holds playback_time (field 1,
// float) and playback_ticks (field 2, varint). demoparser2 0.42.0 derives
// game_time as net_tick / 64, so the parser cannot serve as the source.
function readFileInfo(file: string) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    if (head.subarray(0, 8).toString("latin1") !== "PBDEMS2\0") throw new Error("not a CS2 demo");
    const offset = head.readInt32LE(8);
    const buf = Buffer.alloc(Math.min(4096, fstatSync(fd).size - offset));
    readSync(fd, buf, 0, buf.length, offset);
    let p = 0;
    const varint = () => {
      let r = 0, s = 0, x: number;
      do {
        if (p >= buf.length) throw new Error("DEM_FileInfo truncated");
        x = buf[p++]; r += (x & 127) * 2 ** s; s += 7;
      } while (x & 128);
      return r;
    };
    const cmd = varint(), tick = varint(), size = varint();
    if ((cmd & ~64) !== 2) throw new Error(`frame at fileinfo offset is cmd ${cmd}, expected DEM_FileInfo (2)`);
    if (cmd & 64) throw new Error("compressed DEM_FileInfo not handled");
    const end = p + size;
    if (end > buf.length) throw new Error("DEM_FileInfo larger than the read buffer");
    const out: Record<string, number> = { frame_tick: tick };
    while (p < end) {
      const key = varint(), field = key >> 3, wire = key & 7;
      if (wire === 5) { if (p + 4 > end) throw new Error("DEM_FileInfo truncated"); if (field === 1) out.playback_time = buf.readFloatLE(p); p += 4; }
      else if (wire === 0) { const v = varint(); if (field === 2) out.playback_ticks = v; if (field === 3) out.playback_frames = v; }
      else if (wire === 2) { const length = varint(); p += length; }
      else throw new Error(`unexpected wire type ${wire}`);
    }
    if (p !== end) throw new Error("DEM_FileInfo fields overran the frame");
    return out;
  } finally {
    closeSync(fd);
  }
}
const info = readFileInfo(demo);
const fileRate = info.playback_ticks / info.playback_time;
check(Number.isFinite(fileRate) && Math.abs(fileRate - Math.round(fileRate)) < 0.01, "tickrate from CDemoFileInfo is a whole number");

// Sample coverage for me, from the raw tick rows (no filtering).
const tickRows: Row[] = dp.parseTicks(demo, ["is_alive"], null, [me]);
const ticks = tickRows.map((r) => r.tick as number);
const gaps: [number, number][] = [];
for (let i = 1; i < ticks.length; i++) if (ticks[i] - ticks[i - 1] !== 1) gaps.push([ticks[i - 1], ticks[i]]);
const missing = gaps.flatMap(([a, b]) => Array.from({ length: b - a - 1 }, (_, k) => a + 1 + k));
const anyone: Row[] = missing.length ? dp.parseTicks(demo, ["is_alive"], missing) : [];
section("time", {
  file_info: info,
  tickrate_from_file_info: fileRate,
  tickrate: Math.round(fileRate),
  parser_first_tick: ticks[0],
  parser_last_tick: ticks[ticks.length - 1],
  last_tick_matches_playback_ticks: ticks[ticks.length - 1] === info.playback_ticks,
  ticks_with_no_sample_for_me: missing.length,
  rows_for_any_player_at_those_ticks: anyone.length,
});

section("gate checks", failures.length ? { failed: failures } : "all passed");
if (failures.length) process.exitCode = 1;
