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

/** croclip_look.cfg body, from userdata/<main account id>/730/local/cfg/. */
export function lookCfg(cs2Exe: string, pov: string): string {
  const steamRoot = path.resolve(path.dirname(cs2Exe), "..", "..", "..", "..", "..", "..");
  const dir = path.join(steamRoot, "userdata", accountId(pov), "730", "local", "cfg");
  const sources = ["cs2_user_convars_0_slot0.vcfg", "cs2_machine_convars.vcfg"].map((f) => path.join(dir, f));
  for (const f of sources) if (!existsSync(f)) throw new Error(`main account convars not found: ${f}`);
  const look = sources.flatMap(readConvars).filter(([k]) => LOOK.test(k));
  return ["// generated read-only from the main account's cs2_user_convars_0_slot0.vcfg + cs2_machine_convars.vcfg", ...look.map(([k, v]) => `${k} "${v}"`), ""].join("\n");
}

export type JobCfgInput = {
  title: string;
  lookCfgName: string;
  captureSetup: string[]; // capture mode's cfg-body lines (paths allowed here)
  recordStart: string; // quote-free commands, scheduled
  recordEnd: string;
  seekTick: number;
  slot: number;
  recordStartTick: number;
  recordEndTick: number;
  quitTick: number;
};

// CS Demo Manager #1343: the game may skip ticks before ~96 after load.
export const FIRST_SCHEDULE = 96;

export function jobCfg(j: JobCfgInput): string {
  // HLAE's mirv_cmd joins its arguments with spaces and the console strips
  // quotes, so only quote-free commands are scheduled; paths go in the body.
  // HLAE runs every command whose tick lies in (previous frame tick, this frame
  // tick], so nothing may be scheduled inside the range the seek jumps over.
  const at = (tick: number, cmd: string) => {
    if (/["\n;]/.test(cmd)) throw new Error(`scheduled command must be quote-free and single: ${cmd}`);
    return `mirv_cmd addAtTick ${tick} ${cmd}`;
  };
  if (!(FIRST_SCHEDULE < j.seekTick && j.seekTick + 17 < j.recordStartTick && j.recordStartTick < j.recordEndTick && j.recordEndTick < j.quitTick)) {
    throw new Error("job ticks out of order");
  }
  return [
    `// croclipper job ${j.title}`,
    "mirv_cmd clear",
    "sv_cheats 1",
    `exec ${j.lookCfgName}`, // crosshair, viewmodel, HUD colour, radar; the fixed settings below win
    "demo_ui_mode 0", // must run before playback starts; scheduled later it does nothing
    "spec_show_xray 0", // never xray (hard rule)
    "cl_spec_show_bindings 0", // no "[MOUSE]/[SPACE]" spectator hints
    "cl_show_observer_crosshair 2", // everyone; the crosshair in frame comes from the demo
    "cl_drawhud 1",
    "cl_draw_only_deathnotices 1", // Peder's decision: crosshair and killfeed only (no spectator HUD)
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
    at(FIRST_SCHEDULE, `demo_gototick ${j.seekTick}`),
    // Never on the seek tick itself (CS Demo Manager #1238).
    at(j.seekTick + 16, "spec_mode 1"),
    at(j.seekTick + 17, `spec_player ${j.slot}`),
    at(j.recordStartTick, j.recordStart),
    at(j.recordEndTick, j.recordEnd),
    at(j.quitTick, "quit"),
    "mirv_cmd print",
    "",
  ].join("\n");
}
