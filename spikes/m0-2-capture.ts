// M0.2 spike: one unattended capture job, HLAE + FFmpeg. Throwaway; results go in docs/spikes.md.
// Usage: pnpm exec tsx spikes/m0-2-capture.ts <demo.dem> <startTick> <endTick>
//          [--out <new dir>] [--timeout <s>] [--kill-after <s>] [--env <file>] [--dry-run] [--test-spec-next] [--test-crash-after <s>]
//          [--test-snapshot-fail-after <s>]
// Env file (default .env, required): STEAM_ID64 (POV player), RENDER_STEAM_ID64 (the only Steam
// account allowed to run this), HLAE_EXE, CS2_EXE. Exit codes: 0 ok, 1 job failed, 2 refused,
// 3 cleanup could not be verified (a game process may still be running: check by hand).
import { createRequire } from "node:module";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import path from "node:path";
import { readFileInfo } from "./demo-fileinfo.ts";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");

const STEAMID64_BASE = 76561197960265728n;
const TICKRATE = 64;
const FPS = 60;
const WIDTH = 1280;
const HEIGHT = 720;
const SETTLE_TICKS = 2 * TICKRATE;
const DEMO_PREDICT = 2; // TrueView forced; 1 (auto) is disabled by CS2 for demos from another game build // seek target sits this far before the record start
const FIRST_SCHEDULE = 96; // CS Demo Manager #1343: the game may skip ticks before ~96 after load
const LOCK = path.resolve("spikes", "out", ".render.lock");

class Refusal extends Error {}
// Set once something has been launched; uncaught errors and signals run it
// before choosing the exit code, and a failed cleanup always means exit 3.
let cleanupHook: ((reason: string) => boolean) | undefined;
process.on("uncaughtException", (e) => {
  console.error(String(e.message));
  const clean = cleanupHook ? cleanupHook(`uncaught: ${e.message}`) : true;
  process.exit(!clean ? 3 : e instanceof Refusal ? 2 : 1);
});

// --- arguments and identities ---------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
// Discovery mode: same guarded launch, cfg and cleanup, but only the listing
// commands and quit are scheduled (tick 96), so nothing is seeked or recorded.
// Tested once: the listings' output did not reach console.log (docs/spikes.md).
const discover = args.includes("--discover");
// Candidate sweep (HUD discovery while recording): each candidate is set at the
// start of its own 2 s window of demo time and reset at the end; the table goes
// into job.json so every frame maps to a candidate. Window 0 and the last are
// the baseline.
// --panorama: same window machinery, for HLAE's mirv_panorama panelStyle on the
// full HUD; windows are cumulative (no reset) and the last restores opacity 1.
const panoramaMode = args.includes("--panorama");
const candidatesMode = args.includes("--candidates") || panoramaMode;
const WINDOW_TICKS = 2 * TICKRATE;
// Run 1 (job 1792008667208) used HudSpecplayerRoot (not a panel id: "Could not find
// panel") and HudTeamCounter (whole top bar, timer and score included). Run 2 uses
// ids and classes from the game's hud CSS (teamcounter, healthammocenter).
const pano = (sel: string, o: number) => `mirv_panorama panelStyle ${sel} opacity=${o}`;
// Run 3 (in-play HUD): ids decoded from the compiled hudteamcounter / hudhealthammocenter
// layouts (LZ4 in pak01_386.vpk). panelClassName matches the C++ panel class, not CSS classes.
const PANORAMA: { name: string; set: string; reset: string }[] = [
  { name: "baseline (full HUD, round radar in cfg body)", set: "", reset: "" },
  { name: "cl_show_equipment_value 0", set: "cl_show_equipment_value 0", reset: "" },
  { name: "+ EquipmentInfo opacity 0", set: pano("panelId=EquipmentInfo", 0), reset: "" },
  { name: "+ HealthBarContainer opacity 0", set: pano("panelId=HealthBarContainer", 0), reset: "" },
  { name: "+ jsHudSpecplayer__Bg opacity 0", set: pano("panelId=jsHudSpecplayer__Bg", 0), reset: "" },
  { name: "+ HudSpecplayer__Avatar, WeaponName opacity 0", set: [pano("panelId=HudSpecplayer__Avatar", 0), pano("panelId=WeaponName", 0)].join("; "), reset: "" },
];
const SWEEP_CANDIDATES: { name: string; set: string; reset: string }[] = [
  { name: "baseline", set: "", reset: "" },
  { name: "cl_draw_only_deathnotices 1", set: "cl_draw_only_deathnotices 1", reset: "cl_draw_only_deathnotices 0" },
  { name: "cl_teamcounter_playercount_instead_of_avatars 1", set: "cl_teamcounter_playercount_instead_of_avatars 1", reset: "cl_teamcounter_playercount_instead_of_avatars 0" },
  { name: "cl_hide_avatar_images 1", set: "cl_hide_avatar_images 1", reset: "cl_hide_avatar_images 0" },
  { name: "cl_spec_show_bindings 0 + cl_spec_stats 0", set: "cl_spec_show_bindings 0; cl_spec_stats 0", reset: "cl_spec_show_bindings 1; cl_spec_stats 1" },
  { name: "cl_force_spec_hud_color_to_team 1", set: "cl_force_spec_hud_color_to_team 1", reset: "cl_force_spec_hud_color_to_team 0" },
  { name: "cl_drawhud_force_teamid_overhead -1", set: "cl_drawhud_force_teamid_overhead -1", reset: "cl_drawhud_force_teamid_overhead 0" },
  { name: "baseline", set: "", reset: "" },
];
const CANDIDATES = panoramaMode ? PANORAMA : SWEEP_CANDIDATES;
// Test hook: issue spec_next (what MOUSE1 does in spectator mode) twice mid-clip,
// to check the POV lock holds against a stray click on the game window.
const testSpecNext = args.includes("--test-spec-next");
// Test hook: make every process snapshot fail <s> seconds after launch, to show
// that an enumeration failure ends as "cleanup not verified" (exit 3).
const testSnapshotFailAfter = flag("--test-snapshot-fail-after") === undefined ? undefined : Number(flag("--test-snapshot-fail-after"));
let testSnapshotFailAt: number | undefined;
// Test hook: throw an uncaught error <s> seconds after launch, to exercise the
// crash path (cleanup before exit).
const testCrashAfter = flag("--test-crash-after") === undefined ? undefined : Number(flag("--test-crash-after"));
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const demo = path.resolve(positional[0] ?? "");
const startTick = Number(positional[1]);
const endTick = Number(positional[2]);
const timeoutS = Number(flag("--timeout") ?? 300);
const killAfter = flag("--kill-after") === undefined ? undefined : Number(flag("--kill-after"));
if (!existsSync(demo)) throw new Error(`demo not found: ${demo}`);
if (!Number.isInteger(startTick) || !Number.isInteger(endTick) || endTick <= startTick) throw new Error("bad tick range");
if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("--timeout must be a positive number");
if (killAfter !== undefined && (!Number.isFinite(killAfter) || killAfter < 0)) throw new Error("--kill-after must be >= 0");

// The env file is the only source for the safety identities; a shell variable
// that disagrees with it is refused, never silently preferred.
const envFile = path.resolve(flag("--env") ?? ".env");
if (!existsSync(envFile)) throw new Refusal(`refusing: env file ${envFile} missing`);
const fileEnv = parseEnv(readFileSync(envFile, "utf8"));
const cfgValue = (k: string) => {
  const v = fileEnv[k]?.trim();
  if (!v) throw new Refusal(`refusing: ${k} missing in ${envFile}`);
  const inherited = process.env[k]?.trim();
  if (inherited && inherited !== v) throw new Refusal(`refusing: ${k} in the environment differs from ${envFile}`);
  return v;
};
const steamId = (k: string) => {
  const v = cfgValue(k);
  if (!/^\d{17}$/.test(v) || BigInt(v) <= STEAMID64_BASE) throw new Refusal(`refusing: ${k} is not a SteamID64`);
  return v;
};
const pov = steamId("STEAM_ID64");
const renderAccount = steamId("RENDER_STEAM_ID64");
const hlaeExe = cfgValue("HLAE_EXE");
const cs2Exe = cfgValue("CS2_EXE");

// --- process helpers ------------------------------------------------------------
function imageRunning(image: string): boolean {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 15_000 });
  return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
}
// Process identity = pid + creation time + image name, from Win32_Process, so a
// reused pid is never mistaken for one of ours.
type Proc = { pid: number; ppid: number; name: string; created: string };
// One Win32_Process snapshot per call (a single PowerShell run), filtered in JS.
// Fails closed: any PowerShell/CIM error throws, and a snapshot that does not
// contain this controller's own process is rejected rather than read as
// "nothing running".
function snapshot(): Proc[] {
  if (testSnapshotFailAt !== undefined && Date.now() >= testSnapshotFailAt) throw new Error("test snapshot failure (--test-snapshot-fail-after)");
  const ps = "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }) } }) | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 15_000 }).trim();
  const v = out ? JSON.parse(out) : [];
  const list: Proc[] = Array.isArray(v) ? v : [v];
  if (!list.some((x) => x.pid === process.pid)) throw new Error("process snapshot does not contain the controller itself");
  return list;
}
const sameProc = (a: Proc, b: Proc) => a.pid === b.pid && a.created === b.created && a.name.toLowerCase() === b.name.toLowerCase();
const isRunning = (owned: Proc, snap: Proc[]) => snap.some((p) => sameProc(p, owned));

function activeSteamAccountId(): string {
  // ActiveUser is the 32-bit account id of the logged-in Steam user, 0 when nobody is logged in.
  const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess", "/v", "ActiveUser"], { encoding: "utf8" });
  const m = out.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (!m) throw new Refusal("refusing: could not read Steam ActiveUser from the registry");
  return BigInt("0x" + m[1]).toString();
}

function guard() {
  const want = (BigInt(renderAccount) - STEAMID64_BASE).toString();
  const main = (BigInt(pov) - STEAMID64_BASE).toString();
  const have = activeSteamAccountId();
  if (have === "0") throw new Refusal("refusing: no Steam user logged in");
  if (have === main || want === main) throw new Refusal("refusing: never render on the main account");
  if (have !== want) throw new Refusal("refusing: logged-in Steam account is not RENDER_STEAM_ID64");
  if (imageRunning("cs2.exe")) throw new Refusal("refusing: CS2 is already running");
  if (imageRunning("HLAE.exe")) throw new Refusal("refusing: HLAE is already running");
}

// One controller at a time: an exclusive lock file holding our pid. Any
// existing lock refuses; a stale one is removed by hand after checking that no
// cs2.exe / HLAE.exe is left (never automatically: two controllers could race).
function acquireLock() {
  mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const fd = openSync(LOCK, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let holder = "";
    try { holder = readFileSync(LOCK, "utf8"); } catch {}
    throw new Refusal(`refusing: ${LOCK} exists (pid ${holder || "?"}); if no controller is running and no cs2.exe/HLAE.exe is left, delete it by hand`);
  }
}
function releaseLock() {
  try { if (readFileSync(LOCK, "utf8") === String(process.pid)) rmSync(LOCK); } catch {}
}

// --- parser-side job facts ----------------------------------------------------------
const idRows: { user_id: number }[] = dp.parseTicks(demo, ["user_id"], [startTick], [pov]);
if (idRows.length !== 1) throw new Error(`POV player not present at tick ${startTick}`);
const slot = idRows[0].user_id + 1; // CS Demo Manager: spec_player slot = user_id + 1
const info = readFileInfo(demo);
const rate = info.playback_ticks / info.playback_time;
if (Math.round(rate) !== TICKRATE) throw new Error(`demo tickrate ${rate} != ${TICKRATE}`);
if (endTick > info.playback_ticks) throw new Error("end tick past the end of the demo");
const seekTick = startTick - SETTLE_TICKS;
const candidateTable = CANDIDATES.map((c, i) => ({
  window: i,
  candidate: c.name,
  set_tick: startTick + i * WINDOW_TICKS,
  reset_tick: startTick + (i + 1) * WINDOW_TICKS - 1,
  video_seconds: [i * 2, (i + 1) * 2],
}));
if (candidatesMode && endTick < startTick + CANDIDATES.length * WINDOW_TICKS) throw new Error(`--candidates needs endTick >= ${startTick + CANDIDATES.length * WINDOW_TICKS}`);
if (seekTick <= FIRST_SCHEDULE + 1) throw new Error("start tick too early for a seek");

// --- refuse before anything is written or launched ------------------------------------
let locked = false;
if (!dryRun) {
  try {
    acquireLock();
    locked = true;
    guard();
  } catch (e) {
    if (locked) releaseLock();
    console.error(String((e as Error).message));
    process.exit(e instanceof Refusal ? 2 : 1);
  }
}

// --- job files -----------------------------------------------------------------------
const jobId = `${path.basename(demo, ".dem").slice(0, 10)}-${startTick}-${endTick}`;
const outDir = path.resolve(flag("--out") ?? path.join("spikes", "out", `${jobId}-${Date.now()}`));
if (existsSync(outDir)) {
  if (locked) releaseLock();
  throw new Error(`output folder already exists: ${outDir}`);
}
const usrDir = path.join(outDir, "usrlocal"); // USRLOCALCSGO: the game's user config goes here, not to Peder's
const takeDir = path.join(outDir, "hlae");
const videoPath = path.join(takeDir, "video.mp4");
mkdirSync(path.join(usrDir, "cfg"), { recursive: true });
mkdirSync(takeDir, { recursive: true });

const q = (p: string) => p.replaceAll("\\", "/");

// --- the player's own look, from the MAIN account's convars (read only) -------
// The alt has none of Peder's settings, and a demo is drawn with the
// spectator's config. Steam keeps them under userdata/<account id>/730/local/cfg/
// (remote/ holds the same convars on this machine). Only look-related convars
// are copied; split-screen variants (name$N) are skipped.
const steamRoot = path.resolve(path.dirname(cs2Exe), "..", "..", "..", "..", "..", "..");
const mainCfgDir = path.join(steamRoot, "userdata", (BigInt(pov) - STEAMID64_BASE).toString(), "730", "local", "cfg");
const LOOK = /^(cl_crosshair|crosshair$|cl_grenadecrosshair|cl_ironsight_|viewmodel_|cl_prefer_lefthanded$|cl_showloadout$|hud_showtargetid$|cl_hud_color$|cl_hud_radar_|cl_radar_|safezone[xy]$|cl_teamid_overhead|cl_show_clan_in_death_notice$)/;
// KeyValues lines: "name" "value", optionally followed by a // comment.
// Any other line that carries a quote is refused, so nothing is dropped silently.
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
const lookSources = ["cs2_user_convars_0_slot0.vcfg", "cs2_machine_convars.vcfg"].map((f) => path.join(mainCfgDir, f));
for (const f of lookSources) if (!existsSync(f)) throw new Error(`main account convars not found: ${f}`);
const look = lookSources.flatMap(readConvars).filter(([k]) => LOOK.test(k));
const lookCfg = [`// generated from ${lookSources.join(" + ")}`, ...look.map(([k, v]) => `${k} "${v}"`), ""].join("\n");
writeFileSync(path.join(usrDir, "cfg", "croclip_look.cfg"), lookCfg);
// HLAE's mirv_cmd joins its arguments with spaces and the console strips
// quotes, so only quote-free commands are scheduled; paths are set up front.
// HLAE runs every command whose tick lies in (previous frame tick, this frame
// tick], so nothing may be scheduled inside the range the seek jumps over.
const at = (tick: number, cmd: string) => `mirv_cmd addAtTick ${tick} ${cmd}`;
const cfg = [
  `// croclipper M0.2 job ${jobId}`,
  "mirv_cmd clear",
  "sv_cheats 1",
  "exec croclip_look", // the player's crosshair, viewmodel, HUD colour, radar (see above)
  // Fixed render settings (PLAN.md, "Looks like real gameplay"); after the look so they win.
  "demo_ui_mode 0", // CS Demo Manager: must be set before playback starts, or the demo UI is drawn
  "spec_show_xray 0", // never xray (hard rule)
  "cl_spec_show_bindings 0", // no "[MOUSE]/[SPACE]" spectator hints
  "cl_show_observer_crosshair 2", // game help: 0 = off, 1 = friends and party only, 2 = everyone; 0/1/2 all drew the same reticle (docs/spikes.md)
  "cl_drawhud 1",
  // Spectator HUD (team cards, observed name) cannot be hidden on its own (see docs/spikes.md);
  // Peder accepted crosshair + killfeed only as the fallback.
  // --panorama tests the full HUD from the start, so the panel dump sees it.
  `cl_draw_only_deathnotices ${panoramaMode ? 0 : 1}`,
  ...(panoramaMode ? ["cl_radar_square_when_spectating 0"] : []), // the look cfg sets it true; in play the radar is round
  "cl_radar_show_all_players_when_spectating 0", // radar as in play, not the spectator's full view
  `cl_demo_predict ${DEMO_PREDICT}`, // TrueView: 1 = auto, 2 = force (see docs/spikes.md)
  "cl_showfps 0",
  "fps_max 0",
  "engine_no_focus_sleep 0",
  "volume 0.5",
  "cl_hud_telemetry_frametime_show 0",
  "cl_hud_telemetry_net_misdelivery_show 0",
  "cl_hud_telemetry_ping_show 0",
  "cl_hud_telemetry_serverrecvmargin_graph_show 0",
  "cl_trueview_show_status 0",
  "r_show_build_info 0",
  // help output was expected in console.log; in the one test it did not appear.
  ...["spec_show_xray", "cl_spec_show_bindings", "cl_show_observer_crosshair", "cl_drawhud", "cl_draw_only_deathnotices", "cl_demo_predict", "cl_radar_show_all_players_when_spectating", "engine_no_focus_sleep", "fps_max", "demo_ui_mode"].map((c) => `help ${c}`),
  `mirv_streams record name "${q(takeDir)}"`,
  "mirv_streams record startMovieWav 1",
  `mirv_streams settings add ffmpeg croclip "-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p {QUOTE}${q(videoPath)}{QUOTE}"`,
  "mirv_streams record screen settings croclip",
  "mirv_streams record screen enabled 1",
  `mirv_streams record fps ${FPS}`,
  ...(!discover ? [] : [
    ...["find spec", "find hud", "find observer", "find panel", "find scoreboard", "find teamcounter", "help cl_spec_stats", "help cl_teamcounter_playercount_instead_of_avatars", "help cl_show_observer_crosshair", "help spec_show_xray", "help cl_spec_show_bindings", "help cl_demo_predict", "cvarlist"].map((c) => at(FIRST_SCHEDULE, c)),
    at(FIRST_SCHEDULE, "quit"),
  ]),
  ...(discover ? [] : [
    at(FIRST_SCHEDULE, `demo_gototick ${seekTick}`),
    at(seekTick + 16, "spec_mode 1"),
    at(seekTick + 17, `spec_player ${slot}`),
    at(startTick, "mirv_streams record start"),
    ...(candidatesMode ? [
      // The sweep's baseline is the full spectator HUD, whatever the render cfg uses.
      ...(panoramaMode ? [] : [at(startTick, "cl_draw_only_deathnotices 0"), at(startTick, "cl_spec_show_bindings 1"), at(startTick, "cl_spec_stats 1")]),
      // ";" would end the mirv_cmd line in the cfg, so each part is scheduled on its own.
      ...candidateTable.flatMap((w, i) => CANDIDATES[i].set ? [...CANDIDATES[i].set.split("; ").map((c) => at(w.set_tick, c)), ...(CANDIDATES[i].reset ? CANDIDATES[i].reset.split("; ").map((c) => at(w.reset_tick, c)) : [])] : []),
      // Panel tree dump once the spectator HUD exists; where its output lands is part of the test.
      // Run 1 showed the bare dump lists only the Hud root's children; whether it takes a panel id is untested.
      ...(panoramaMode ? ["TeamLargeCT", "TeamLargeT", "EquipmentInfo", "HealthBarContainer", "jsHudSpecplayer__Bg", "HudBottomCenter"].map((id, i) => at(seekTick + 40 + i, `__mirv_panorama_print_children ${id}`)) : []),
    ] : []),
    ...(testSpecNext ? [at(startTick + 3 * TICKRATE, "spec_next"), at(startTick + 6 * TICKRATE, "spec_next")] : []),
    at(endTick, "mirv_streams record end"),
    at(endTick + TICKRATE, "quit"),
  ]),
  "mirv_cmd print",
  "",
].join("\n");
writeFileSync(path.join(usrDir, "cfg", "croclip_job.cfg"), cfg);

const csArgs = ["-insecure", "-novid", "-sw", "-width", String(WIDTH), "-height", String(HEIGHT), "-condebug", "+exec", "croclip_job", "+playdemo", `"${demo}"`];
const hlaeArgs = [
  "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage",
  "-customLoader",
  "-hookDllPath", path.join(path.dirname(hlaeExe), "x64", "AfxHookSource2.dll"),
  "-programPath", cs2Exe,
  "-cmdLine", csArgs.join(" "),
];
if (!hlaeArgs[hlaeArgs.length - 1].split(" ").includes("-insecure")) throw new Error("refusing: launch without -insecure");
const job = { jobId, demo, startTick, endTick, seekTick, slot, ...(candidatesMode ? { candidates: candidateTable } : {}), fps: FPS, size: `${WIDTH}x${HEIGHT}`, outDir, hlaeExe, hlaeArgs };
writeFileSync(path.join(outDir, "job.json"), JSON.stringify(job, null, 2));
console.log(JSON.stringify(job, null, 2));
console.log(cfg);
if (dryRun) process.exit(0);

// --- owned processes and cleanup --------------------------------------------------------
// Only processes this controller started are ever killed: the HLAE loader (by
// spawn pid, created after the spawn) and every descendant found while the job
// runs (cs2.exe, HLAE's FFmpeg encoder), each identified by pid + creation
// time + image name and killed one by one.
const owned = new Map<number, Proc>();
const cleanupErrors: string[] = [];
let hlaeSpawnPid: number | undefined;
let spawnedAt = 0;
let cleanedUp = false;

function discoverOwned(snap: Proc[] = snapshot()) {
  if (hlaeSpawnPid !== undefined && !owned.has(hlaeSpawnPid)) {
    const p = snap.find((x) => x.pid === hlaeSpawnPid);
    if (p && p.name.toLowerCase() === "hlae.exe" && Date.parse(p.created) >= spawnedAt - 2000) owned.set(p.pid, p);
  }
  // A child is adopted only while its parent is in the same snapshot with the
  // exact identity we recorded, so a reused parent pid cannot pass ownership on.
  let grew = true;
  while (grew) {
    grew = false;
    for (const parent of [...owned.values()]) {
      if (!isRunning(parent, snap)) continue;
      for (const c of snap.filter((x) => x.ppid === parent.pid)) {
        if (!owned.has(c.pid) && c.created >= parent.created) { owned.set(c.pid, c); grew = true; }
      }
    }
  }
  return snap;
}
const ownedGames = () => [...owned.values()].filter((p) => p.name.toLowerCase() === "cs2.exe");
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function cleanup(reason: string): boolean {
  if (cleanedUp) return cleanupErrors.length === 0;
  cleanedUp = true;
  if (hlaeSpawnPid === undefined) { releaseLock(); return true; }
  try { discoverOwned(); } catch (e) { cleanupErrors.push(`could not list owned processes: ${(e as Error).message}`); }
  // Loader first, so it cannot start another game, then everything else it started.
  const order = [...owned.values()].sort((a, b) => (a.name.toLowerCase() === "hlae.exe" ? -1 : 0) - (b.name.toLowerCase() === "hlae.exe" ? -1 : 0));
  for (const p of order) {
    try {
      // Identity re-checked right before the kill; a pid recycled in the gap
      // between the two calls is a residual race (see docs/spikes.md).
      if (!isRunning(p, snapshot())) continue;
      const k = spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { encoding: "utf8", timeout: 15_000 });
      if (k.error || k.status !== 0) console.log(`taskkill ${p.name} pid ${p.pid} returned ${k.status ?? k.error?.message} (verification decides)`);
      else console.log(`killed ${p.name} pid ${p.pid}`);
    } catch (e) { cleanupErrors.push(`${p.name} pid ${p.pid}: ${(e as Error).message}`); }
  }
  // Verify every owned process is gone, and that no cs2.exe at all is left:
  // none was running at launch, so any survivor is either ours or unexplained.
  for (let i = 0; i < 50; i++) {
    let left: Proc[] = [];
    let cs2Left = false;
    try {
      const snap = snapshot();
      left = [...owned.values()].filter((o) => isRunning(o, snap));
      cs2Left = snap.some((x) => x.name.toLowerCase() === "cs2.exe");
    } catch (e) { cleanupErrors.push(`verification failed: ${(e as Error).message}`); break; }
    if (!left.length && !cs2Left) break;
    if (i === 49) {
      for (const p of left) cleanupErrors.push(`${p.name} pid ${p.pid} still running`);
      if (cs2Left) cleanupErrors.push("a cs2.exe is still running");
    }
    pause(200);
  }
  if (cleanupErrors.length) {
    console.error(`CLEANUP NOT VERIFIED (${reason}): ${cleanupErrors.join("; ")}. Check for cs2.exe by hand. The lock stays.`);
    return false;
  }
  releaseLock();
  return true;
}
for (const sig of ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const) {
  process.on(sig, () => { const ok = cleanup(sig); process.exit(ok ? 130 : 3); });
}
process.on("exit", () => { if (!cleanup("controller exit")) process.exitCode = 3; });

// --- run ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let interrupted: string | undefined;
let finished = false;
try {
  // Re-check right before launch: the account or a running CS2 may have changed
  // while the job files were written. A refusal here exits 2; the job files stay.
  try { guard(); } catch (e) {
    releaseLock();
    console.error(String((e as Error).message));
    process.exit(e instanceof Refusal ? 2 : 1);
  }
  cleanupHook = cleanup;
  const child = spawn(hlaeExe, hlaeArgs, { env: { ...process.env, USRLOCALCSGO: usrDir }, stdio: "ignore", windowsHide: true });
  let spawnError: Error | undefined;
  child.on("error", (e) => { spawnError = e; });
  hlaeSpawnPid = child.pid;
  spawnedAt = Date.now();
  if (testSnapshotFailAfter !== undefined) testSnapshotFailAt = spawnedAt + testSnapshotFailAfter * 1000;
  if (testCrashAfter !== undefined) setTimeout(() => { throw new Error("test crash (--test-crash-after)"); }, testCrashAfter * 1000);
  if (hlaeSpawnPid === undefined) throw new Error("HLAE did not start");

  let recordingSeenAt: number | undefined;
  discoverOwned();
  while (true) {
    await sleep(500);
    if (spawnError) { interrupted = `HLAE spawn error: ${spawnError.message}`; break; }
    const snap = discoverOwned();
    const games = ownedGames();
    if (games.length > 0 && !games.some((g) => isRunning(g, snap))) { finished = true; break; }
    if (games.length === 0 && Date.now() - t0 > 60_000) { interrupted = "cs2.exe never started"; break; }
    if (recordingSeenAt === undefined && existsSync(videoPath)) recordingSeenAt = Date.now();
    if (killAfter !== undefined && recordingSeenAt !== undefined && Date.now() - recordingSeenAt > killAfter * 1000) {
      interrupted = `killed ${killAfter}s into recording (--kill-after)`;
      break;
    }
    if ((Date.now() - t0) / 1000 > timeoutS) { interrupted = `timeout ${timeoutS}s`; break; }
  }
} catch (e) {
  interrupted = `controller error: ${(e as Error).message}`;
}
const cleanOk = cleanup(interrupted ?? "job end");
const ownedList = [...owned.values()].map((p) => `${p.name}:${p.pid}`);
console.log(cleanOk
  ? `game gone after ${Math.round((Date.now() - t0) / 1000)}s; owned processes: ${ownedList.join(",") || "none"}`
  : `CLEANUP NOT VERIFIED after ${Math.round((Date.now() - t0) / 1000)}s; owned processes: ${ownedList.join(",") || "none"}`);
const gameDir = path.resolve(path.dirname(cs2Exe), "..", "..", "csgo");
try { copyFileSync(path.join(gameDir, "console.log"), path.join(outDir, "console.log")); } catch {}

if (discover) {
  const r = { jobId, mode: "discover", interrupted: interrupted ?? null, cleanup_verified: cleanOk, owned_processes: ownedList, status: cleanOk && !interrupted ? "ok" : "failed" };
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  process.exit(!cleanOk ? 3 : r.status === "ok" ? 0 : 1);
}

// --- finalize: validate inputs, mux to a temp file, validate, rename -------------------
function ff(args: string[]) {
  const r = spawnSync("ffmpeg", ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  return { status: r.status, stderr: r.stderr ?? "", error: r.error };
}
function probe(file: string) {
  const r = ff(["-i", file]); // exits 1 by design (no output); the stream info is on stderr
  const d = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    video: /Stream #.*Video:/.test(r.stderr),
    audio: /Stream #.*Audio:/.test(r.stderr),
    unreadable: /moov atom not found|Invalid data found/.test(r.stderr),
  };
}
function decodeProblems(file: string): string {
  const r = ff(["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
  if (r.error) return `ffmpeg did not run: ${r.error.message}`;
  if (r.status !== 0) return `decode exit ${r.status}: ${r.stderr.slice(0, 300)}`;
  return r.stderr.trim().slice(0, 300);
}

const expected = (endTick - startTick) / TICKRATE;
const tolerance = 3 / FPS;
const takes = readdirSync(takeDir).filter((d) => d.startsWith("take")).sort();
// A fresh output folder per job means exactly one take belongs to this attempt.
const take = takes.length === 1 ? path.join(takeDir, takes[0]) : undefined;
const wav = take ? path.join(take, "audio.wav") : undefined;
const result: Record<string, unknown> = { jobId, expected_seconds: expected, interrupted: interrupted ?? null, cleanup_verified: cleanOk, owned_processes: ownedList, take: take ?? null, takes, video: videoPath, audio: wav ?? null };
const reasons: string[] = [];
if (!cleanOk) reasons.push("cleanup not verified");
if (interrupted) reasons.push(interrupted);
if (!finished && !interrupted) reasons.push("game did not exit on its own");
if (takes.length !== 1) reasons.push(`expected one take folder, found ${takes.length}`);
const finalPath = path.join(outDir, "clip.mp4");
const tmpPath = path.join(outDir, "clip.tmp.mp4");
try {
  if (existsSync(videoPath)) result.raw_video = { bytes: statSync(videoPath).size, ...probe(videoPath) };
  else reasons.push("no video");
  if (wav && existsSync(wav)) result.raw_audio = { bytes: statSync(wav).size, ...probe(wav) };
  else reasons.push("no audio");
  if (!reasons.length) {
    const v = result.raw_video as ReturnType<typeof probe>;
    const a = result.raw_audio as ReturnType<typeof probe>;
    if (!v.video || v.unreadable || v.duration === null || Math.abs(v.duration - expected) > tolerance) reasons.push(`raw video bad: ${JSON.stringify(v)}`);
    if (!a.audio || a.unreadable || a.duration === null || Math.abs(a.duration - expected) > tolerance) reasons.push(`raw audio bad: ${JSON.stringify(a)}`);
    const rawErr = decodeProblems(videoPath);
    if (rawErr) reasons.push(`raw video decode: ${rawErr}`);
  }
  if (!reasons.length) {
    const mux = ff(["-v", "error", "-y", "-i", videoPath, "-i", wav!, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", tmpPath]);
    if (mux.error || mux.status !== 0) reasons.push(`mux failed: ${mux.stderr.slice(0, 300)}`);
    else {
      const p = probe(tmpPath);
      const errs = decodeProblems(tmpPath);
      result.final = { ...p, decode_problems: errs };
      if (!p.video || !p.audio) reasons.push("final file missing a stream");
      if (p.duration === null || Math.abs(p.duration - expected) > tolerance) reasons.push(`final duration ${p.duration} vs ${expected}`);
      if (errs) reasons.push("final decode problems");
    }
  }
} catch (e) {
  reasons.push(`finalize error: ${(e as Error).message}`);
}
if (reasons.length) {
  result.status = "failed";
  result.reasons = reasons;
  rmSync(tmpPath, { force: true });
} else {
  renameSync(tmpPath, finalPath);
  result.status = "ok";
  result.clip = finalPath;
}
writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = !cleanOk ? 3 : result.status === "ok" ? 0 : 1;
