// Per-job cfg generation. Everything is decided in docs/spikes.md (M0.2) and
// PLAN.md ("Looks like real gameplay").
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { accountId } from "../../config.ts";

// --- the player's own look, from the MAIN account's convars (read only) -------
// The alt has none of Peder's settings, and a demo is drawn with the
// spectator's config. Only look-related convars are copied; split-screen
// variants (name$N) are skipped. Nothing is ever written to userdata.
const LOOK = /^(cl_crosshair|crosshair$|cl_grenadecrosshair|cl_ironsight_|viewmodel_|cl_prefer_lefthanded$|cl_showloadout$|hud_showtargetid$|cl_hud_color$|cl_hud_radar_|cl_radar_|safezone[xy]$|cl_teamid_overhead|cl_show_clan_in_death_notice$)/;

// KeyValues lines: "name" "value", optionally followed by a // comment. Any
// other line that carries a quote is refused, so nothing is dropped silently.
function readConvars(file: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes('"')) continue;
    const m = line.match(/^\s*"([^"\\]+)"\s+"([^"\\]*)"\s*(\/\/.*)?$/);
    if (m) { if (!m[1].includes("$")) out.push([m[1], m[2]]); continue; }
    if (/^\s*"(config|convars)"\s*(\/\/.*)?$/.test(line)) continue;
    throw new Error(`unparsed line in ${file}: ${line.trim()}`);
  }
  return out;
}

// --- crosshair --------------------------------------------------------------
// Since CS2's 22 September 2026 update a demo carries the player's crosshair, so the
// observer shows it (cl_show_observer_crosshair 2) and none of the main account's
// cl_crosshair* convars are exec'd. Older demos do not: they get his saved crosshair
// convars and cl_show_observer_crosshair 0, so the spectator's own (his) crosshair shows.
export type CrosshairSource = "demo" | "own";
const CROSSHAIR = /^(cl_crosshair|crosshair$)/;

/** cutoff undefined (config empty): always the demo's crosshair. */
export function crosshairSource(demoPatch: number, cutoff: number | undefined): CrosshairSource {
  return cutoff === undefined || demoPatch >= cutoff ? "demo" : "own";
}

/** croclip_look.cfg body, from userdata/<main account id>/730/local/cfg/. Crosshair convars only for "own". */
export function lookCfg(cs2Exe: string, pov: string, crosshair: CrosshairSource): string {
  const steamRoot = path.resolve(path.dirname(cs2Exe), "..", "..", "..", "..", "..", "..");
  const dir = path.join(steamRoot, "userdata", accountId(pov), "730", "local", "cfg");
  const sources = ["cs2_user_convars_0_slot0.vcfg", "cs2_machine_convars.vcfg"].map((f) => path.join(dir, f));
  for (const f of sources) if (!existsSync(f)) throw new Error(`main account convars not found: ${f}`);
  const look = sources.flatMap(readConvars).filter(([k]) => LOOK.test(k) && (crosshair === "own" || !CROSSHAIR.test(k)));
  return ["// generated read-only from the main account's cs2_user_convars_0_slot0.vcfg + cs2_machine_convars.vcfg", ...look.map(([k, v]) => `${k} "${v}"`), ""].join("\n");
}

// Spectator-only HUD elements blanked in the "full" look, so the frame shows
// the HUD as in play (docs/hud-reference-inplay.webp; ids decoded from the
// game's compiled hudteamcounter / hudhealthammocenter layouts, docs/spikes.md).
// panelId matches the first panel with that id only; panelClassName matches
// the C++ panel class, so every instance.
export const SPECTATOR_PANELS = [
  "panelClassName=Frame", // EquipmentInfo in each of the ten cards: money, weapon, nades, armor
  "panelId=jsHudSpecplayer__Bg", // bottom bar: observed name, clan, ADR, weapon name, side panels
  "panelId=HudSpecplayer__Avatar", // centre circle avatar; the team emblem shows instead, as in play
];

/** One take: seek, settle, spectate `slot`, record [recordStartTick, recordEndTick]. */
export type CfgTake = {
  seekTick: number;
  slot: number;
  recordStartTick: number;
  recordEndTick: number;
  select: string; // quote-free command that points the recorder at this take's output
};

export type JobCfgInput = {
  title: string;
  hud: "full" | "bare";
  debugCommands: string[]; // scheduled after the first take's spec_player, e.g. panel tree dumps
  lookCfgName: string;
  crosshair: CrosshairSource;
  captureSetup: string[]; // capture mode's cfg-body lines (paths allowed here)
  recordStart: string; // quote-free commands, scheduled
  recordEnd: string;
  takes: CfgTake[];
  takeCfgName: (i: number) => string; // the cfg file (without .cfg) that runs take i >= 1
};

// CS Demo Manager #1343: the game may skip ticks before ~96 after load.
export const FIRST_SCHEDULE = 96;
/** After a take's record end: the next take's cfg runs this many ticks later; after the last, quit. */
export const CHAIN_AFTER_TICKS = 16;
export const QUIT_AFTER_TICKS = 64;

/**
 * The cfgs of one launch (chained takes, PLAN.md §5): the main cfg sets everything up and
 * schedules take 0; each take's record end schedules `exec` of the next take's cfg, which
 * clears every scheduled command, points the recorder at its own output, seeks (forward or
 * back) and schedules its own spectate and record; the last take schedules quit. Clearing
 * first means a backward seek never replays an earlier take's commands.
 */
export function jobCfgs(j: JobCfgInput): { main: string; takes: { name: string; body: string }[] } {
  // HLAE's mirv_cmd joins its arguments with spaces and the console strips
  // quotes, so only quote-free commands are scheduled; paths go in the body.
  // HLAE runs every command whose tick lies in (previous frame tick, this frame
  // tick], so nothing may be scheduled inside the range the seek jumps over.
  const at = (tick: number, cmd: string) => {
    if (/["\n;]/.test(cmd)) throw new Error(`scheduled command must be quote-free and single: ${cmd}`);
    return `mirv_cmd addAtTick ${tick} ${cmd}`;
  };
  if (!j.takes.length) throw new Error("a job needs at least one take");
  const schedule = (i: number): string[] => {
    const t = j.takes[i];
    const debug = i === 0 ? j.debugCommands : [];
    if (/["\n;]/.test(t.select)) throw new Error(`take select must be quote-free: ${t.select}`);
    if (!((i > 0 || FIRST_SCHEDULE < t.seekTick) && t.seekTick + 24 + debug.length < t.recordStartTick - 8 && t.recordStartTick < t.recordEndTick)) {
      throw new Error(`take ${i}: ticks out of order`);
    }
    const last = i === j.takes.length - 1;
    return [
      // Take 0 seeks once the demo has loaded; a later take's cfg runs mid-playback and seeks at once.
      ...(i === 0 ? [at(FIRST_SCHEDULE, `demo_gototick ${t.seekTick}`)] : ["mirv_cmd clear", t.select, `demo_gototick ${t.seekTick}`]),
      // Never on the seek tick itself (CS Demo Manager #1238).
      at(t.seekTick + 16, "spec_mode 1"),
      at(t.seekTick + 17, `spec_player ${t.slot}`),
      ...debug.map((c, k) => at(t.seekTick + 24 + k, c)),
      // HLAE panel styling needs the HUD to exist, so it runs after spec_player, before recording.
      ...(j.hud === "full" ? SPECTATOR_PANELS.map((p) => at(t.recordStartTick - 8, `mirv_panorama panelStyle ${p} opacity=0`)) : []),
      at(t.recordStartTick, j.recordStart),
      at(t.recordEndTick, j.recordEnd),
      last ? at(t.recordEndTick + QUIT_AFTER_TICKS, "quit") : at(t.recordEndTick + CHAIN_AFTER_TICKS, `exec ${j.takeCfgName(i + 1)}`),
    ];
  };
  const main = [
    `// croclipper job ${j.title}: ${j.takes.length} take(s)`,
    "mirv_cmd clear",
    "sv_cheats 1",
    `exec ${j.lookCfgName}`, // crosshair, viewmodel, HUD colour, radar; the fixed settings below win
    "demo_ui_mode 0", // must run before playback starts; scheduled later it does nothing
    "spec_show_xray 0", // never xray (hard rule)
    "cl_spec_show_bindings 0", // no "[MOUSE]/[SPACE]" spectator hints
    // "demo": everyone's, the crosshair in frame comes from the demo; "own": the spectator's (the look cfg's).
    `cl_show_observer_crosshair ${j.crosshair === "demo" ? 2 : 0}`,
    "cl_drawhud 1",
    `cl_draw_only_deathnotices ${j.hud === "bare" ? 1 : 0}`, // "bare": crosshair and killfeed only
    "cl_radar_square_when_spectating 0", // round, rotating radar as in play (the look cfg sets it true)
    "cl_radar_show_all_players_when_spectating 0",
    "cl_demo_predict 2", // TrueView forced; 1 is disabled for any demo from another build
    "cl_showfps 0",
    "cl_hud_telemetry_frametime_show 0",
    "cl_hud_telemetry_net_misdelivery_show 0",
    "cl_hud_telemetry_ping_show 0",
    "cl_hud_telemetry_serverrecvmargin_graph_show 0",
    "cl_trueview_show_status 0",
    "r_show_build_info 0",
    "fps_max 0",
    "engine_no_focus_sleep 0",
    "volume 0.5",
    ...j.captureSetup,
    j.takes[0].select,
    ...schedule(0),
    "mirv_cmd print",
    "",
  ].join("\n");
  const takes = j.takes.slice(1).map((_, k) => ({
    name: j.takeCfgName(k + 1),
    body: [`// croclipper job ${j.title}: take ${k + 1}`, ...schedule(k + 1), "mirv_cmd print", ""].join("\n"),
  }));
  return { main, takes };
}
