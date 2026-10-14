# Modules (M1)

`PLAN.md` is the design; this page is what the code does not say by itself.

## Running

```
pnpm clip "<demo.dem>" <startTick> <endTick> [--timeout <s>] [--force] [--dry-run]
```

One clip from a hand-written spec, no hands after the command: guarded
render → post → `library/clips/<id>.mp4` + `library/index.json`.
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
| `config.json` | render settings: capture size and fps (defaults from the main account's `cs2_video.txt`, 1152×864, and 60), HLAE's intermediate `captureCrf`, final `crf`, `fadeSeconds` |
| `.env` | identities and tool paths (`.env.example`; M0.2 setup in `docs/spikes.md`) |
| `src/cli/clip.ts` | the entry; resume check, failure record |
| `src/parse/clip-facts.ts` | tickrate, demo hash, map, POV slot, round |
| `src/render/controller/` | `index.ts` state machine, `guards.ts`, `processes.ts`, `cfg.ts` |
| `src/render/capture/hlae.ts` | HLAE launch arguments and `mirv_streams` lines |
| `src/post/` | trim and fade (`index.ts`), FFmpeg probes (`ffmpeg.ts`) |
| `src/library/index.ts` | clip id, atomic publish, index and failures |
| `state/render/<id>/<attempt>/` | per-attempt work dir: generated cfgs, raw capture, `console.log`, `render.json` |

## Decisions made in M1

- **Tick mapping, measured per job.** The capture records `MARGIN_TICKS`
  (32) on each side of the requested ticks. The frame rate is locked (HLAE's
  "Finishing movie … [N frames" line, the demuxed frame count and the WAV
  length must agree), but where recording starts varies by 0–3 frames per
  launch (M0.2; the first M1 render started 50 ms late). So post measures
  the origin from the POV player's isolated shots (`weapon_fire`, >300 ms
  after the previous shot): every offset in ±150 ms is scored by how many of
  them have an onset in HLAE's WAV there; at least two must agree, and an
  equally supported offset more than a frame away means "ambiguous", never a
  guess. That offset moves frame 0 to its true tick. Then post cuts exactly
  `round((end − start) · fps / 64)` frames and measures the final file with
  the same anchors (a check of trim and encode, not of the association);
  more than 2 frames off fails the job. Limit: clips with fewer than two
  isolated POV shots, or noisy ones, fail as "tick origin not measurable"
  (one older capture of the test interval is refused as ambiguous). Audio
  follows video within 10 ms (M0.2); on the M1 clip the muzzle flashes of
  the kill shot and a later shot sit on their exact frames.
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
