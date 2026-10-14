# Modules (M1, M2)

`PLAN.md` is the design; this page is what the code does not say by itself.

## Running

```
pnpm moments "<demo.dem>"
pnpm clip "<demo.dem>" --top <n> [--timeout <s>] [--force] [--dry-run]
pnpm clip "<demo.dem>" <startTick> <endTick> [same options]
```

`pnpm moments` parses, scores and ranks a demo's moments (no launch;
`docs/scoring-notes.md`). `pnpm clip --top n` renders the n-th ranked
moment, `pnpm clip <start> <end>` a hand-written tick range; either way no
hands after the command: guarded render → post → `library/clips/<id>.mp4`
+ `library/index.json` (a ranked clip's entry carries its `moment`: rank,
score, breakdown, kills, flags).
Exit codes: 0 ok or already in the library, 1 failed (recorded in
`state/failures.json`), 2 refused (nothing launched), 3 cleanup not
verified (a game process may still run; `state/.render.lock` stays and is
deleted by hand after checking no cs2.exe / HLAE.exe is left).
`--dry-run` resolves the facts, id and render key without the guards or a
launch. Keep hands off the game window while it renders: a click changes
the spectated player (docs/spikes.md, M0.2 open items).

## Where things are

| Path | What |
|---|---|
| `config.json` | render settings: `hud` (`full` default = in-play HUD, `bare` = crosshair and killfeed only), output `width`×`height` (default 1920×1080, 16:9, whatever the player's own `cs2_video.txt` says), `aspect`, `fps` (60), HLAE's intermediate `captureCrf`, final `crf`, `fadeSeconds` |
| `.env` | identities and tool paths (`.env.example`; M0.2 setup in `docs/spikes.md`) |
| `scoring.json` | ranking weights; tuning and current picks in `docs/scoring-notes.md` |
| `src/cli/clip.ts`, `src/cli/moments.ts` | the entries; resume check, failure record |
| `src/parse/demo.ts` | per-demo extraction, cached in `state/<demo sha256>/parse.json` |
| `src/parse/clip-facts.ts` | what one render needs: tickrate, demo hash, map, POV slot at the clip's ticks, round |
| `src/score/index.ts` | round context (1vX), kill clusters, scoring |
| `src/clip/` | clip specs (`index.ts`: boundaries, merge, 30 s cap, id, title); `moments.ts` writes `moments.json` / `moments.txt` |
| `src/render/controller/` | `index.ts` state machine, `guards.ts`, `processes.ts`, `cfg.ts` |
| `src/render/capture/hlae.ts` | HLAE launch arguments and `mirv_streams` lines |
| `src/post/` | trim and fade (`index.ts`), FFmpeg probes (`ffmpeg.ts`) |
| `src/library/index.ts` | clip id, atomic publish, index and failures |
| `state/render/<id>/<attempt>/` | per-attempt work dir: generated cfgs, raw capture, `console.log`, `render.json` |

## Decisions made in M1

- **Tick mapping, measured per job.** The capture records `MARGIN_TICKS`
  (32) on each side of the requested ticks. The frame rate is locked (HLAE's
  "Finishing movie … [N frames" line, the demuxed frame count and the WAV
  length must agree), but where recording starts varies per launch (0–4
  frames late in M0.2/M1). Post measures it from the POV player's shots
  (`weapon_fire`): the muzzle flash in the lower-right quarter of the video
  (`src/post/flash.ts`) decides, the gunshot onsets in HLAE's WAV
  (`src/post/sync.ts`) cross-check it (more than 1.5 frames apart fails the
  job) or decide alone when the flash is not measurable. Both search only
  origin errors in [−5, +1.5] frames (every capture so far: −0.4 to −3.5)
  and use only POV shots with no other POV shot within that window's width
  (6.5 frames), so a shot cannot be matched to its neighbour; a second,
  separate peak makes the result ambiguous and the job fails. Then post
  cuts exactly `round((end − start) · fps / 64)` frames and measures the
  final file the same way (shots whose window touches a fade skipped);
  more than 2 frames off fails the job. On seven captures of this machine
  the flash resolved all seven and agreed with audio within 0.9 frames where
  audio resolved. Limits: a clip needs two such shots (fast sprays alone do
  not qualify); the flash region assumes a right-hand viewmodel; an origin
  error outside the bound is not found.
- **HUD.** `full` (default) aims at the HUD as in play
  (`docs/hud-reference-inplay.webp`): `cl_draw_only_deathnotices 0`,
  `cl_radar_square_when_spectating 0` in the cfg body (round, rotating
  radar; the player's look cfg sets it true), and HLAE `mirv_panorama
  panelStyle … opacity=0` 8 ticks before recording on `SPECTATOR_PANELS`
  (`src/render/controller/cfg.ts`): `panelClassName=Frame` (the equipment
  block of all ten cards), `panelId=jsHudSpecplayer__Bg` (observed name,
  clan, weapon name) and `panelId=HudSpecplayer__Avatar` (so the bottom
  centre shows the team emblem). `panelId` hits only the first panel with an
  id; `panelClassName` matches the C++ panel class. Known leftovers, no id
  reaches them: the player names above the card avatars, the health number
  under each card, and the marker under the observed player's card. `bare`:
  crosshair and killfeed only. `--debug-cmd
  "__mirv_panorama_print_children <PanelId>"` schedules a panel dump after
  `spec_player` (output in the job's `console.log`); nothing else is
  accepted, and debug commands are part of the render key.
- **Two encodes.** HLAE writes the intermediate at `captureCrf` 12; post
  re-encodes once at crf 18 (trim and fades need a re-encode anyway).
- **Clip id** = first 16 hex of sha256(demo sha256, round, start, end).
  A clip counts as done only when `index.json` has it with the same render
  key (settings, tool versions, look cfg hash, POV and slot) and the file
  still validates (frame count, duration, full decode). A validated raw
  capture (`capture.json` in its work dir) with the same key is reused, so a
  failed post never costs another launch. `--force` re-renders.
- **Ownership and kill.** The loader counts only as this controller's own
  child created in the spawn window; processes are keyed by pid + creation
  time + image. `killExact` opens a handle, re-checks that identity and kills
  through the handle, closing the check-to-kill pid-reuse race noted in
  M0.2. Cleanup kills in rounds with re-discovery (an encoder orphaned by a
  killed cs2.exe is adopted if created in its parent's lifetime), and fails
  closed: a loader never identified, any owned process left, or any cs2.exe
  at all means exit 3. Residual, no Windows Job Object: a descendant that
  starts and exits between two 0.5 s polls is never seen.
- **Launch evidence.** `-condebug` rewrites `game\csgo\console.log` in the
  CS2 install each launch; the job cfg has a per-launch name
  (`croclip_<ms>`), and the log counts as this launch's only when its
  `[CommandLine]` line carries that name.

## Decisions made in M2

- **Match rounds.** A round is a `round_end` with a winner after the last
  `begin_new_match` (FACEIT's warmup and knife restarts come before it; a
  demo without it is refused). Rounds are numbered 1…n from there; above 24
  is overtime. A knife round is one where every shot fired was a knife.
- **Alive state** is every player's team and alive flag at each round's
  freeze end and round end, plus the deaths in between, instead of a full
  per-tick table: that is what 1vX needs. A round where someone alive at
  freeze end neither died nor was alive on the same team at round end
  (disconnect, team change) is `rosterChanged` and gets no clutch.
- **Events** belong to the round whose start they follow, up to the next
  round's start; scoring ignores anything after the round end.
- **Parse cache key** = demo sha256 + demoparser2 version + schema version
  + POV; a mismatch re-parses. Temp file per writer, then rename.
- **Clip id** for a ranked moment = the same `clipId` over (demo sha256,
  match round, start, end); `pnpm clip --top` refuses if the render's own
  facts give another id.
