# M0 gate results

One section per gate from `PLAN.md` → Milestones → M0. Each records:
pass/fail, date, tool versions (CS2 build, HLAE, demoparser2, FFmpeg,
Node), the exact commands and config that worked, and what did not.

## Demo source on this machine

Five FACEIT demos (`1-<uuid>-1-1.dem`, 228–345 MB, server name
"FACEIT.com register to play here") sit in the CS2 install root:
`C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\`.
How they got there: unknown. `game/csgo/replays/` (where Steam's Watch
tab is expected to save matchmaking demos) does not exist; whether MM
demos were ever downloaded here is unknown.

| File (uuid prefix) | File date | Map | Demo `patch_version` |
|---|---|---|---|
| 8e8743a8 | 2026-10-04 | de_inferno | 14188 |
| 4f41ff3c | 2026-10-01 | de_anubis | 14188 |
| 898d9c8a | 2026-05-23 | de_cache | 14164 |
| e6aac266 | 2026-05-23 | de_anubis | 14164 |
| 0c14eb44 | 2026-05-13 | de_cache | 14160 |

## M0.1 Parser, identity, time

**Pass — 2026-10-14.** Script: `spikes/m0-1-parse.ts`. It exits non-zero
when any check below fails and never prints the SteamID64. Reviewed by
GPT-6.1 Sol (two rounds: first "fail" on a circular tickrate and a
weak join, then "pass after fixes"); all findings are folded in.

Versions: Windows 11 x64, Node 24.21.0, pnpm 12.6.0,
`@laihoe/demoparser2` 0.42.0, TypeScript 7.0.2, tsx 4.23.15.

Commands that ran (SteamID64 from `.env` as `STEAM_ID64`), each exit 0
with "gate checks: all passed":

```
pnpm install
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-0c14eb44-2f46-4523-a286-583a65f3477d-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-4f41ff3c-8b12-4d76-a974-1b4ed8cda7f1-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-898d9c8a-60de-4735-9d02-5121904ad843-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-8e8743a8-4f10-4d4d-ad39-859ccae31fa6-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-e6aac266-651c-4aee-a197-04bec8309770-1-1.dem"
```

Per demo:

| Demo | user_id | entity_id | kills joined | ticks with no sample | playback_ticks − playback_frames |
|---|---|---|---|---|---|
| 8e8743a8 | 5 | 791 | 16/16 | 0 | 0 |
| 4f41ff3c | 4 | 361 | 29/29 | 0 | 0 |
| 898d9c8a | 5 | 401 | 21/21 | 6 | 6 |
| e6aac266 | 5 | 220 | 24/24 | 2 | 2 |
| 0c14eb44 | 10 | 390 | 16/16 | 24 | 23 (parser starts at tick 0 here) |

**Node binding on Windows.** `pnpm add @laihoe/demoparser2` pulls the
prebuilt `@laihoe/demoparser2-win32-x64-msvc` (an optionalDependency,
napi-rs). No build step, no Rust toolchain. The package is CommonJS;
the ESM spike loads it with `createRequire`. Every export returns `any`
in `index.d.ts`, so the types below are runtime observations. pnpm 12
blocks esbuild's postinstall (a tsx dependency); it is set to `false`
in `pnpm-workspace.yaml` and tsx runs without it.

**Identity.** Steam IDs come back as strings everywhere the spike
looked (`parsePlayerInfo`, every `parseTicks` row, `attacker_steamid` /
`user_steamid` / `assister_steamid` in events), exact to 17 digits.
`steamid` is the join key. Other identifiers for the same player:

- `user_id` and `entity_id` (numbers, `parseTicks`): one value each for
  the whole demo in all five, different per demo (see table).
- name: `name` in `parsePlayerInfo`/`parseTicks`, `attacker_name` /
  `user_name` in events.
- `player_slot` and `account_id` as tick props: accepted, always null.

CS Demo Manager passes `spec_player <user_id + 1>`; M0.2 confirmed that
value selects this player (slot 6 in 8e8743a8).

**Join.** A kill is a `player_death` with `attacker_steamid` = me and
`user_steamid` a different string. Each must have exactly one
`player_hurt` at the same tick, me → same victim, `health` 0; a
`parseTicks` sample for me at the kill tick with `is_alive` true; a
victim sample one tick before with `health` > 0; and a victim sample at
the kill tick with `health` 0 and `is_alive` false. 106 of 106 kills
across the five demos meet all of it; no teamkills among them (team_num
compared at the kill tick).

**`player_death`** (with `other_extra = ["total_rounds_played"]`):
`assistedflash` boolean, `assister_name` string|null,
`assister_steamid` string|null, `attacker_name` string,
`attacker_steamid` string, `attackerblind` boolean, `attackerinair`
boolean, `distance` number, `dmg_armor` number, `dmg_health` number,
`dominated` number, `event_name` string, `headshot` boolean, `hitgroup`
string, `noreplay` boolean, `noscope` boolean, `penetrated` number,
`revenge` number, `thrusmoke` boolean, `tick` number,
`total_rounds_played` number, `user_name` string, `user_steamid`
string, `weapon` string (no `weapon_` prefix, e.g. `ak47`, `glock`),
`weapon_fauxitemid` string, `weapon_itemid` string,
`weapon_originalowner_xuid` string, `wipe` number.

**`player_hurt`:** `armor` number, `attacker_name` string|null,
`attacker_steamid` string|null, `dmg_armor` number, `dmg_health`
number, `event_name` string, `health` number (after the hit),
`hitgroup` string, `tick` number, `total_rounds_played` number,
`user_name` string, `user_steamid` string, `weapon` string. Rows with a
null attacker (0–10 per demo) all have `weapon` "" (cause not
established). On 104 of the 106 lethal hits `dmg_health` exceeds the
victim's `health` at the previous tick, so `dmg_health` is not capped
at remaining HP; "victim low HP" must come from the victim's `health`,
not from subtracting damage.

**`parseTicks`** with `["health","is_alive","team_num","X","Y","Z","pitch","yaw"]`:
numbers, and `is_alive` boolean, plus `name` string, `steamid` string,
`tick` number in every row.

**Round events.** `listGameEvents` lists neither `round_start` nor
`round_end`, but `parseEvent` returns rows for both: `round_start`
{`round` number, `tick`, `total_rounds_played`},
`round_end` {`reason` string|null, `winner` string|null, `round`
number, `tick`, `total_rounds_played`}. `round_officially_ended` and
`begin_new_match` are listed events. Whether these round rows are
right for warmup and round boundaries is an M2 question.

**Time.** `parseHeader` has no tickrate (map_name, patch_version,
server_name, demo_version_name, …), and demoparser2 0.42.0 computes
`game_time` as `net_tick / 64`, so the parser cannot be the source.
The spike reads the demo's own `CDemoFileInfo` frame (header bytes
8–11 give its offset; field 1 `playback_time` float, field 2
`playback_ticks`, field 3 `playback_frames`): `playback_ticks /
playback_time` = 64.000 in all five, and `playback_ticks` equals the
parser's last tick in all five, so parser ticks and the file's tick
count are the same coordinate. Three demos have ticks where
`parseTicks` returns no row for any player (missing parser samples);
in each, the file's own `playback_frames` is lower than
`playback_ticks` by the same count (by one less in 0c14eb44, where the
parser starts at tick 0). That fits the demo having no frame at those
ticks but does not prove it per tick. Whether `demo_gototick` uses the
same coordinate is M0.2. `demo_listhighlights` was not tried.

## M0.2 Repeatable unattended capture

**Fail — 2026-10-14. Observed failure: the spectator HUD is drawn** —
both teams' player cards across the top with names, health and money,
and the observed player's name next to health at the bottom; live
first-person play shows neither (see "Looks like real gameplay" below).
Latest full-cfg run: `spikes/out/1-8e8743a8-5669-6103-1792005302266`.
Still unverified rather than failed: whether TrueView playback matches
live play, and where the viewmodel comes from. Verified on the final
controller: correct player first-person
throughout, lead-in, first frames, audio in sync, finalized playable
file, no xray, no demo UI, the second interval, restart and repeat,
interrupted job recovered by the queue, the CS2-already-open refusal,
and the tick coordinate across a seek. Scripts: `spikes/m0-2-capture.ts` (one job:
guards, cfg, launch, wait, cleanup, mux, validate), `spikes/m0-2-queue.ts`
(retry around it), `spikes/m0-2-sync.ts` (final clip's audio vs parser
ticks), `spikes/demo-fileinfo.ts` (tickrate from the demo file).
Reviewed by GPT-6.1 Sol in five rounds (fail ×3 on guard/cleanup
robustness, then "pass after fixes" before the look criteria were added,
then write-up fixes); all findings are folded in except the residual pid
race below, which Sol accepted as an open M1 item for a spike.

Versions: CS2 PatchVersion 1.41.9.0 (ClientVersion 2000930, client
protocol 14190 per the console), HLAE 2.192.8 (AfxHookSource2 0.41.8;
`hlae_2_192_8.zip` from github.com/advancedfx/advancedfx releases,
sha256 `f28a2d7c…69b1` matching GitHub's asset digest), FFmpeg 9.0.1
essentials_build (gyan.dev) at `C:\WINDOWS\system32\ffmpeg.exe`, Node
24.21.0, demoparser2 0.42.0. Demo 8e8743a8 (de_inferno, patch 14188).

### CS Demo Manager source read first

akiver/cs-demo-manager at commit `b45a5f29283590c3fd0fc6526564b49567c0b931`
(2026-10-04). Files read: `src/node/counter-strike/launcher/start-counter-strike-with-hlae.ts`
(HLAE and CS2 launch arguments, kills a running CS2 — we refuse
instead), `src/node/video/generation/create-cs2-video-json-file.ts`
(per-sequence command list), `src/node/counter-strike/json-actions-file/json-actions-file-generator.ts`
(`spec_mode 1` before `spec_player <slot>`, minimum action tick 96),
`src/node/counter-strike/launcher/define-cfg-folder-location.ts`
(`USRLOCALCSGO`), `src/node/database/match/fetch-match-players-slots.ts`
(slot = user id + 1), `cs2-server-plugin/cs2-server-plugin/main.cpp`
(`demo_ui_mode 0` before playback). CS Demo Manager schedules commands
with its own server plugin (a `server.dll` it installs into
`game/csgo/csdm/bin`, patching `gameinfo.gi`); we use HLAE's
`mirv_cmd addAtTick` instead and touch nothing in the game install.
HLAE's scheduler (`AfxHookSource2/main.cpp`, `shared/CommandSystem.cpp`
in advancedfx/advancedfx) reads `IDemoFile::GetDemoTick()`.

### Setup

- HLAE unpacked to `tools\hlae\` (gitignored). `tools\hlae\ffmpeg\ffmpeg.ini`:
  ```
  [Ffmpeg]
  Path=C:\WINDOWS\system32\ffmpeg.exe
  ```
- `.env` (gitignored, required): `STEAM_ID64` (POV player),
  `RENDER_STEAM_ID64` (the alt), `HLAE_EXE=C:\Users\--\croclipper\tools\hlae\HLAE.exe`,
  `CS2_EXE=C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe`.
  The capture script reads these from the file only; a shell variable
  that disagrees with the file is refused.

### Guards (AGENTS.md)

Order: take the lock, check, write the job folder, check again,
launch. Every refusal exits 2; a refusal at the first check writes
nothing, one at the second check leaves the job folder (no launch).

- Lock: `spikes\out\.render.lock` created exclusively (`wx`) with the
  controller's pid. Any existing lock refuses; there is no automatic
  takeover (two controllers could race on a stale one). A lock left by a
  crashed controller is deleted by hand after checking no cs2.exe /
  HLAE.exe is left. Released only by its owner, only after cleanup is
  verified.
- Logged-in Steam account: `reg query HKCU\Software\Valve\Steam\ActiveProcess /v ActiveUser`
  → `REG_DWORD 0x…`, the 32-bit account id (0 = nobody logged in).
  Refuse unless it equals `RENDER_STEAM_ID64 − 76561197960265728`;
  refuse outright if it, or `RENDER_STEAM_ID64`, is the main account.
- `cs2.exe` or `HLAE.exe` in `tasklist` → refuse.
- The CS2 command line must contain `-insecure`. No server is ever
  joined: the only map load is `playdemo`.

Refusals tested, each exit 2 with no output folder and no launch:

| Test | Message |
|---|---|
| shell `STEAM_ID64` differs from `.env` | refusing: STEAM_ID64 in the environment differs from …\.env |
| env file with `RENDER_STEAM_ID64` = main account | refusing: never render on the main account |
| env file with `RENDER_STEAM_ID64` = unrelated id | refusing: logged-in Steam account is not RENDER_STEAM_ID64 |
| an existing lock file | refusing: …\.render.lock exists (pid 99999); if no controller is running and no cs2.exe/HLAE.exe is left, delete it by hand |
| a process named `cs2.exe` running (a renamed `PING.EXE`) | refusing: CS2 is already running — the process was left alone |
| second job while a job's own CS2 ran (earlier controller version) | refusing: CS2 is already running; the running job finished normally |

Not tested against a CS2 Peder started himself (by rule); the check is
by image name, so it does not depend on who started the game.

### Cleanup: only owned processes

The controller owns the HLAE loader it spawned (its spawn pid, image
HLAE.exe, created after the spawn) and every descendant of it, found
from one `Get-CimInstance Win32_Process` snapshot per 0.5 s poll: a
process whose `ParentProcessId` is an owned process that is present in
the same snapshot with the exact identity recorded for it, and whose
creation time is later than its parent's. Identity = pid + creation
time + image name, so a reused pid is never treated as ours. Every
process query has a 15 s timeout. In every final run the owned tree
was `HLAE.exe → cs2.exe → ffmpeg.exe + conhost.exe`, found before HLAE
exited.

Cleanup (job end, timeout, `--kill-after`, a caught or uncaught error,
SIGINT/SIGBREAK/SIGHUP/SIGTERM): loader first, then each owned process
still running, individually `taskkill /PID <pid> /F` after re-checking
its identity; then poll up to 10 s until
no owned process is running **and no cs2.exe at all** is running (none
was at launch). Anything left = "cleanup not verified": exit 3, lock
kept, the queue stops. An uncaught error runs cleanup before choosing
its exit code, and the exit handler sets exit 3 if cleanup fails.
Before anything is launched there is nothing to clean up, so a refusal
stays exit 2.

- Enumeration failure, tested with `--test-snapshot-fail-after 15`
  (every process snapshot throws from 15 s after launch): exit 3,
  "CLEANUP NOT VERIFIED (controller error: test snapshot failure …)",
  lock kept, the job's cs2.exe left running as designed; it was then
  closed by hand (`taskkill /PID <its pid> /F` after checking the pid
  was still that cs2.exe) and the lock deleted. The controller's summary
  line says "CLEANUP NOT VERIFIED" in that case, never "game gone".
- Crash path, tested with `--test-crash-after 20` (uncaught error 20 s
  after launch, during load): "killed cs2.exe pid 20672", exit 1, lock
  released,
  nothing left in `tasklist`.
- Controller hard-killed (`taskkill /PID <node pid> /F`, 15 s after
  launch, during load; previous controller version): `cs2.exe` was gone
  within 3 s too, its `console.log` ending mid-load with no quit line,
  no `result.json`, lock left behind. The likely mechanism is that Node
  (libuv) puts spawned processes in a kill-on-close job object that
  HLAE's `cs2.exe` inherits; that is an inference from one test, not
  verified. Killing the controller during recording, and closing its
  console window, were not tested.

### Launch (what the script runs)

Environment `USRLOCALCSGO=<job>\usrlocal` (CS Demo Manager's
approach): CS2 reads `cfg\croclip_job.cfg` from there and writes its
user config (convars, keys, video) there instead of the normal
location. It still logs "Saved 'cs2_user_convars.vcfg' to
SteamRemoteStorage" on quit, so the convars the cfg sets reach the
alt's Steam Cloud despite `-afxDisableSteamStorage`.

```
tools\hlae\HLAE.exe -noGui -autoStart -noConfig -afxDisableSteamStorage -customLoader
  -hookDllPath C:\Users\--\croclipper\tools\hlae\x64\AfxHookSource2.dll
  -programPath "…\game\bin\win64\cs2.exe"
  -cmdLine "-insecure -novid -sw -width 1280 -height 720 -condebug +exec croclip_job +playdemo \"<demo path>\""
```

HLAE exits after injecting; the job is over when the owned `cs2.exe`
exits. `-condebug` writes `game\csgo\console.log` in the CS2 install
(copied into the job folder).

### Job cfg (interval A, generated)

```
// croclipper M0.2 job 1-8e8743a8-5669-6103
mirv_cmd clear
sv_cheats 1
exec croclip_look
demo_ui_mode 0
spec_show_xray 0
cl_spec_show_bindings 0
cl_spec_stats 0
cl_show_observer_crosshair 2
cl_drawhud 1
cl_draw_only_deathnotices 0
cl_radar_show_all_players_when_spectating 0
cl_demo_predict 2
cl_showfps 0
fps_max 0
engine_no_focus_sleep 0
volume 0.5
cl_hud_telemetry_frametime_show 0
cl_hud_telemetry_net_misdelivery_show 0
cl_hud_telemetry_ping_show 0
cl_hud_telemetry_serverrecvmargin_graph_show 0
cl_trueview_show_status 0
r_show_build_info 0
help spec_show_xray
help cl_spec_show_bindings
help cl_show_observer_crosshair
help cl_drawhud
help cl_draw_only_deathnotices
help cl_demo_predict
help cl_radar_show_all_players_when_spectating
help engine_no_focus_sleep
help fps_max
help demo_ui_mode
mirv_streams record name "<job folder>/hlae"
mirv_streams record startMovieWav 1
mirv_streams settings add ffmpeg croclip "-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p {QUOTE}<job folder>/hlae/video.mp4{QUOTE}"
mirv_streams record screen settings croclip
mirv_streams record screen enabled 1
mirv_streams record fps 60
mirv_cmd addAtTick 96 demo_gototick 5541
mirv_cmd addAtTick 5557 spec_mode 1
mirv_cmd addAtTick 5558 spec_player 6
mirv_cmd addAtTick 5669 mirv_streams record start
mirv_cmd addAtTick 6103 mirv_streams record end
mirv_cmd addAtTick 6167 quit
mirv_cmd print
```

What came out of this:

- **No demo UI:** `demo_ui_mode 0` in the cfg body, i.e. before
  playback starts. Scheduled from `mirv_cmd` after the seek it does
  nothing and the playback panel and "[MOUSE]: Next Player / [SPACE]:
  Next Camera" hints are captured. With it in the cfg, the frames show
  no playback panel, no spectator hints and no console; radar,
  scoreboard strip, killfeed, health, money and ammo stay.
- `mirv_cmd addAtTick <tick> <cmd…>` joins its arguments with spaces
  and the console strips quotes, so only quote-free commands are
  scheduled; anything with a path goes in the cfg body.
- HLAE fires every scheduled command whose tick lies in (previous
  frame's tick, this frame's tick] (`CommandSystem::OnExecuteCommands`),
  so a forward `demo_gototick` fires everything scheduled inside the
  jumped range at once. Nothing is scheduled between the seek command
  (tick 96) and the seek target.
- `spec_mode 1` / `spec_player <user_id + 1>` run 16–17 ticks after the
  seek target, never on the seek tick (CS Demo Manager #1238).
- `echo` from a scheduled command does not appear in `console.log`.
- Finalize: probe raw `video.mp4` and `audio.wav` (stream present,
  duration within 3 frames of the interval), decode raw video with
  `ffmpeg -v error -xerror -f null` (exit 0, no stderr), mux
  `ffmpeg -i video.mp4 -i audio.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest clip.tmp.mp4`,
  probe and decode that the same way, then rename to `clip.mp4`. One
  fresh output folder per attempt (an existing one is refused) and
  exactly one `take*` folder in it.

### Looks like real gameplay (PLAN.md render settings)

Added after the runs below, in four launches on the final controller
(the capture path is unchanged; only cfg lines were added), plus one
discovery launch and one more render.

- **Player's own look, read only.** `croclip_look.cfg` is generated per
  job from the main account's
  `C:\Program Files (x86)\Steam\userdata\<main account id>\730\local\cfg\cs2_user_convars_0_slot0.vcfg`
  (crosshair, viewmodel) and `…\local\cfg\cs2_machine_convars.vcfg` (HUD
  colour, radar, safezone, `viewmodel_presetpos`); `…\730\remote\cs2_user_convars.vcfg`
  holds the same convars on this machine (both dated 2026-10-11). Only
  look convars are copied (`cl_crosshair*`, `crosshair`,
  `cl_grenadecrosshair*`, `cl_ironsight_*`, `viewmodel_*`, `cl_hud_color`,
  `cl_hud_radar_*`, `cl_radar_*`, `safezonex/y`, `cl_teamid_overhead*`,
  `hud_showtargetid`, `cl_showloadout`, `cl_prefer_lefthanded`,
  `cl_show_clan_in_death_notice`); split-screen variants (`name$N`, e.g.
  `hud_scaling$3`, `cl_teamid_overhead_mode$2`) are skipped. Nothing is
  written to either account's userdata. The job cfg execs it first,
  then the fixed settings, so those win.
- **Convar names** checked against `client.dll` / `engine2.dll` strings:
  all present as exact names except `spec_show_lineup`, which does not
  exist in this build. The spectator-hints convar is
  `cl_spec_show_bindings` ("Toggle the visibility of the spectator
  bindings."); an earlier cfg used `spec_show_bindings`, which is not a
  convar. In the runs tested, console command output did not reach
  `console.log` under `-condebug`: `echo`, `help`, `find` and `cvarlist` were run from
  `mirv_cmd` after load in a discovery launch (`--discover`, job
  `1-8e8743a8-5669-6103-1792005255770`, no recording) and only HLAE's
  own listing appeared. So a missing "Unknown command" line proves
  nothing; names were checked against the binaries instead.
- **No xray:** `spec_show_xray 0`. Frame at 3.0 s of
  `1-8e8743a8-5669-6103-1792004525217`: no outlines or name/health labels
  through walls (the earlier `1792000445442` had them).
- **HUD:** `cl_drawhud 1`, `cl_draw_only_deathnotices 0`,
`cl_spec_show_bindings 0`, `cl_radar_show_all_players_when_spectating 0`,
  `cl_showfps 0`, telemetry off, `r_show_build_info 0`. The frames show
  the full HUD in Peder's safezone and radar layout, no demo UI.
- **Spectator HUD — fails.** The top bar shows all ten player cards with
  name, health and money, and the bottom panel shows the observed
  player's name ("croa") next to health. Live play shows neither.
  Tried `cl_spec_stats 0` (job `1792005302266`, frame at 3.0 s): no
  change. Other candidates from `client.dll`, not tried:
  `cl_teamcounter_playercount_instead_of_avatars` (sits next to
  `CSGOHudTeamCounter`; would replace avatars with a count, which is
  not how live play looks either), `cl_force_spec_hud_color_to_team`
  (colour only). No convar was found that switches the HUD from the
  spectator layout to the player layout.
- **Frame pacing:** `fps_max 0`, `engine_no_focus_sleep 0`, HLAE
  `mirv_streams record fps 60`.
- **TrueView:** with `cl_demo_predict 1` the console says "Demo is
  version 14188, client is version 14190. TrueView is DISABLED as per
  cl_demo_predict=1" (and the same for the May demo, 14160). With
  `cl_demo_predict 2`: "TrueView is ENABLED as per cl_demo_predict=2"
  and "Added TrueView prediction for player slot 5 (croa)" on the
  October demo; slot 10 (croa) on the May demo. The cfg uses 2. Run
  `1792005302266` logs "TrueView active for slot 5" (croa) plus 532
  lines of "TrueView can't determine last executed command number on
  server from command lookahead"; what that costs visually is unknown.
  What visibly changes with TrueView, and whether recoil, viewmodel
  kick and aim punch look like live play: **unknown** (no side-by-side
  with live footage was made; Valve's note that recoil, muzzle flash,
  blood and ragdolls land one or two frames late in playback is not
  checked here).
- **Crosshair — passes, from the demo.** The game's own description:
  "cl_show_observer_crosshair: Show the crosshair of the player being
  observed. 0 = off, 1 = friends and party only, 2 = everyone". Runs
  with 1 (`1792004525217`), 2 (`1792004711895`) and 0 (`1792004771260`)
  all show the same small white X-shaped crosshair, also present in
  clips without the main account's crosshair convars. Peder confirmed
  (via the parent session) that this X is his crosshair, so the
  crosshair in frame passes. Where it comes from is unknown: it does
  not follow the vcfg crosshair convars or the observer-crosshair value
  (0, "off", still drew it); plausibly the demo carries it. The cfg uses
  2 (everyone); whether that holds for other demos is unknown.
- **Viewmodel:** looks identical with and without the main account's
  `viewmodel_*` convars (frame 120 of A); plausibly the demo's own
  player viewmodel is drawn, i.e. Peder's at match time. Not proven.

### Launch count

61 job folders in `spikes/out/` hold a config CS2 wrote at launch, i.e.
61 CS2 launches by this session's controller up to and including job
`1792005302266` (10 more folders are dry runs and refusals that never
launched). The parent session counted 66 windows; the difference is
unexplained. This log documents the runs that carry evidence; the rest
were earlier controller and cfg versions.

### Runs (final controller)

Interval A = ticks 5669–6103 (pistol-round 2k, 6.78 s), B =
52698–54302 (round-8 3k, 25.06 s). Every run is a fresh CS2 launch
after the previous one exited; A ran twice in a row this way (restart
and repeat). Folders under `spikes/out/` (gitignored). All runs:
`cleanup_verified: true`, lock released, no cs2.exe / HLAE.exe /
ffmpeg.exe left.

| Run | Folder suffix | Wall | Frames (expected) | Result |
|---|---|---|---|---|
| A | 5669-6103-1792003507171 | 32 s | 408 (406.9) | ok, 6.79 s |
| B, second interval | 52698-54302-1792003544263 | 46 s | 1503 (1503.75) | ok, 25.04 s |
| A, repeat | 5669-6103-1792003596729 | 32 s | 408 | ok, 6.79 s |
| queue: B interrupted (`--kill-after 2`) | 52698-54302-1792003633709-a1 | — | — | failed as intended: owned cs2.exe and ffmpeg.exe killed, raw `video.mp4` 11.5 MB with no moov atom (unreadable), no `clip.mp4` |
| queue: B retry, fresh launch | 52698-54302-1792003665741-a2 | — | — | ok, 25.04 s; queue exit 0 |
| crash test (`--test-crash-after 20`) | 52698-54302 (no result.json by design) | — | — | exit 1, owned cs2 killed, lock released |

Commands (demo = the 8e8743a8 path from M0.1):

```
pnpm exec tsx spikes/m0-2-capture.ts "<demo>" 5669 6103 --timeout 240
pnpm exec tsx spikes/m0-2-capture.ts "<demo>" 52698 54302 --timeout 300
pnpm exec tsx spikes/m0-2-queue.ts "<demo>" 52698-54302 --interrupt-first 2
pnpm exec tsx spikes/m0-2-capture.ts "<demo>" 52698 54302 --timeout 300 --test-crash-after 20
pnpm exec tsx spikes/m0-2-sync.ts spikes/out/<folder>
```

Checked on the final clips (A 1792003507171 and 1792003596729, B
1792003544263), frames sampled every 0.5 s across the whole clip (14 per
A, 50 for B): the first frame is the game, not a loading screen;
first-person on the POV player in every sample (the player's own
viewmodel; the spectator HUD shows the player's name next to health;
the killfeed shows the player's kills); 3 s (A) and 2 s (B) of lead-in
before the first kill; no demo UI. The one odd frame in A (white box
mid-screen at 2.0 s) is the in-game "MATCH START" banner animating in.
All have an AAC track and decode clean. Not played back in a player
with sound yet (frame sampling and decode checks only).

### Tick coordinate and A/V sync

- Parser → `demo_gototick`: the seek to the parser tick lands exactly
  there in every run ("Demo Skipping finished at tick 5541 / 52570 /
  87441").
- Parser → HLAE scheduling → final clip, measured on shots: the HUD ammo
  count (video) and the gunshot onset in the clip's AAC track (audio,
  `m0-2-sync.ts`), at a shot near the start and one near the end of each
  interval, in seconds after the record-start tick:

  | Run | Shot (parser) | Video | Audio |
  |---|---|---|---|
  | A 1792003507171 | 3.000 / 3.969 | 3.000 / 3.967 | 3.000 / 3.960 |
  | A 1792003596729 | 3.000 / 3.969 | 3.000 / 3.967 | 3.000 / 3.960 |
  | B 1792003544263 | 9.781 / 22.563 | 9.750 / 22.533 | 9.740 / 22.525 |

- So parser ticks, `demo_gototick` and HLAE's tick scheduling use the
  same coordinate, including after a long seek (96 → 52570). Video and
  audio in the final file agree within 10 ms at both ends of both
  intervals. Each launch's clip sits 0–2 frames (0–36 ms) early against
  the parser ticks (across all launches in this log), the same at start and end, varying between launches;
  frame counts for the same interval vary by ±2. The cause is not
  established. PLAN.md's per-job output-time ↔ tick mapping therefore
  has to be measured per job rather than assumed (an M1 decision).
- `m0-2-sync.ts` matches each shot to the nearest onset; only isolated
  shots (>300 ms after the previous one) are meaningful, since sprays
  mask onsets, and a few isolated shots still match another player's
  sound (offsets of 100–900 ms in its output).

Earlier runs on previous controller versions (image-name kills; the
demo panel visible while `demo_ui_mode 0` was scheduled; per-process
polling slow enough that a "4 s" interrupt landed after recording
ended; ownership by parent pid without the same-snapshot check) are in
`spikes/out/` too; they are superseded.

### Not done / open

- **Stray input moves the camera.** A click on the CS2 window during a
  render switches the spectated player (MOUSE1 = next player in
  spectator mode); it happened in an M0.3 run when Peder clicked the
  window. Emulated with `--test-spec-next` (schedules `spec_next` at
  +3 s and +6 s): neither `spec_lock_to_accountid <account id>` nor
  `spec_lock_to_current_player 1` after `spec_player` stops it, so both
  were dropped again (`spec_autodirector 0` was tried alongside and is
  not needed). Options for M1: unbind mouse/keys in the render-only
  user config (`USRLOCALCSGO`; it syncs to the alt's Steam Cloud),
  re-issue `spec_player` every few ticks, or detect it in validation.
  Until then: hands off the game window while it renders.
- Residual race: a pid recycled between the identity re-check and
  `taskkill /PID` (milliseconds apart) would be killed; descendants
  that live shorter than one 0.5 s poll are never seen. Closing this
  needs handle-based termination or a Windows Job Object, which is M1
  controller work.
- Controller killed during recording, or its console closed: untested.
- The 0–2 frame per-launch offset is measured, not explained.
- `-condebug` writes into the CS2 install folder; `con_logfile` to a
  job path was not tried.
- Resolution (1280×720), 60 fps and x264 crf 18 are spike values, not
  decisions.

## M0.3 Old demo (gate dropped)

Peder dropped this gate from PLAN.md on 2026-10-14, after these runs;
no verdict. The evidence stays as a data point: one five-month-old
demo went through the M0.2 path. Its full-cfg run
`1-0c14eb44-87569-88322-1792004563487` shows the same X crosshair (later
confirmed as Peder's) and the same spectator HUD as M0.2. The old demo itself plays, seeks and records like the
current one, and TrueView stays available: `cl_demo_predict 1` →
"TrueView is DISABLED", `cl_demo_predict 2` → "Demo is version 14160,
client is version 14190. TrueView is ENABLED as per cl_demo_predict=2"
and "Added TrueView prediction for player slot 10 (croa)". No xray, no
demo UI in that run.

Demo 0c14eb44 (de_cache, FACEIT, file date
2026-05-13, five months old; demo `patch_version` 14160). The
measurements below are from run `1792003744767`: the final M0.2
controller, before the look settings were added (`cl_demo_predict`
unset, i.e. 1; no look cfg). The full-cfg run is `1792004563487` (above).

```
pnpm exec tsx spikes/m0-2-capture.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-0c14eb44-2f46-4523-a286-583a65f3477d-1-1.dem" 87569 88322 --timeout 300
pnpm exec tsx spikes/m0-2-sync.ts spikes/out/1-0c14eb44-87569-88322-1792003744767
```

Interval: round 12 Glock 4k (kills at ticks 87761–88162), 87569–88322,
11.77 s. POV `spec_player 11` (user_id 10 + 1).

- CS2 loads it: console "Demo is version 14160, client is version
  14190. TrueView is DISABLED as per cl_demo_predict=1" — a warning, no
  failure. The map loaded from the current install.
- Seek: "Demo Skipping finished at tick 87441" = the scheduled seek
  target. Record: 705 frames @ 60 against 706 expected.
- `result.json`: ok, `cleanup_verified` true (owned tree HLAE → cs2 →
  ffmpeg + conhost), `clip.mp4` 11.75 s, video and audio streams,
  decodes clean. Wall time 38 s; no cs2.exe/HLAE.exe/ffmpeg.exe left afterwards.
- Audio (final clip) vs parser shots: isolated-shot offsets −53, −33,
  −31, −24, +12 ms (one more matched another sound at +402 ms).
- Frames sampled every 0.5 s across the clip: first-person on the POV
  player throughout (Glock, then knife),
  the 4k in the killfeed and the round-win banner at the end, no
  demo playback panel or spectator hints.

An earlier run of this interval (1792001366897, previous controller
version) is void: Peder clicked
the CS2 window during it, and the camera left the POV player (see M0.2,
stray input).

Covers one old demo, as the gate asks. The other two May demos (patch
14164) were not rendered. Demos older than five months, or from before
a map change, are untested.
