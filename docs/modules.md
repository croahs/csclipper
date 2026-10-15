# Modules (M1-M4a)

`PLAN.md` is the design; this page is what the code does not say by itself.

## Running

```
pnpm grab [--dry-run] [--browser] [--last <n>]
pnpm grab --login
pnpm go [--dry-run] [--retry-failed] [--repost]
pnpm moments "<demo.dem>"
pnpm clip "<demo.dem>" --top <n> [--timeout <s>] [--dry-run]
pnpm clip "<demo.dem>" <startTick> <endTick> [same options]
pnpm clip --rerender <no|id> [--timeout <s>] [--dry-run]
```

`pnpm grab` (PLAN.md's `pnpm fetch`; pnpm's own `fetch` command takes that
name) runs the demo sources, each writing new demos into `demos/inbox/`,
then ingests the inbox; it renders nothing. Sources: **folders** copies new
demos, read-only, from watched folders (default CS2's `game/csgo/`, where
the FACEIT client's "Watch demo" and manual downloads land, and
`~/Downloads`; `config.json` → `sources.folders.dirs` overrides), skipping
any whose content is already in the store; **faceit** (with
`FACEIT_API_KEY`) lists new FACEIT matches and downloads their demos, by
the Downloads API (needs a scope FACEIT did not grant) or, with `--browser`
(or `config.json` → `sources.faceit.via: "browser"`), through Peder's
logged-in FACEIT session in the installed Chrome or Edge, signed in once
with `pnpm grab --login` (`docs/faceit-api.md`). `--last <n>` backfills
instead: the demos of the last n FACEIT matches through the browser
session, oldest first, one at a time with a random 10–20 s pause between
downloads, skipping matches already in the store (match id in a stored
file name; ingest drops content duplicates) and stopping on the first
failure with a screenshot in `state/browser-failures/`; a rerun resumes
(`state/sources/faceit-backfill.json`). A pending FACEIT match is printed
with its room link: "Download demo" there lands the file in Downloads,
where the folders source picks it up on the next run. Pending items are
not failures; exit 1 means a source failed or ingest rejected a file.

`pnpm go` is the one command: drop demos (`.dem`, or `.zip` / `.bz2` /
`.gz` / `.zst`) into `demos/inbox/`, run it, come back to clips. It
ingests the inbox, ranks every registered demo, renders the moments
`config.json` → `batch` selects (every moment scoring at least `minScore`,
40; when none in a demo does and `fallbackBest` is true, its single best)
that the library does not hold yet, and rewrites
`library/index.html` (open it from disk). It refuses to start while CS2 runs
and stops the whole batch on the first guard refusal (exit 2) or unverified
cleanup (exit 3); exit 1 means a job or demo failed (`state/failures.json`).
Run it again to resume: nothing new means no launch. `--dry-run` lists what
it would render.

`pnpm moments` parses, scores and ranks a demo's moments (no launch;
`docs/scoring-notes.md`). `pnpm clip --top n` renders the n-th ranked
moment, `pnpm clip <start> <end>` a hand-written tick range; either way no
hands after the command: guarded render → post → `library/clips/<id>.mp4`
+ `library/index.json` (a ranked clip's entry carries its `moment`: rank,
score, breakdown, kills, flags). A clip the library holds is never made
again by `pnpm go` or `pnpm clip`, whatever changed (AGENTS.md); `pnpm clip
--rerender <no|id>` is the one way: it ranks the demo afresh, renders that
moment now, and when the span rules gave the moment a new id, moves the
old clip to `library/replaced/` in the same index write that adds the new
one, which keeps the old one's number (the file moves after that write). A hand-written range re-renders by
its ticks; a ranked moment takes the ranked spec with its id, else the one
sharing the most kills with it that shares none with another clip (a tie
refuses). Every entry has `no`, the human clip number
("clip 17"): sequential in the order clips entered the library, stable,
never reused or renumbered (`nextNo` in `index.json` only grows; entries
from before numbering got theirs oldest first). The page shows it on each
card and finds a clip by it ("17", "clip 17", "#17") or by title text;
the content-hash id stays the file name.
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
| `src/cli/go.ts`, `src/cli/clip.ts`, `src/cli/moments.ts` | the entries |
| `src/ingest/` | watch folder (`index.ts`), the source contract (`sources.ts`), sources (`sources/folders.ts`, `sources/faceit.ts` with its browser path `sources/faceit-browser.ts`; Valve matchmaking later, same shape) |
| `test/` | `pnpm test`: FACEIT source against recorded fixtures (`test/fixtures/faceit/`) and the folders source on temp folders; no network |
| `src/queue/` | the batch and its job ledger (`index.ts`); one clip job, shared by `pnpm clip` and the batch (`job.ts`) |
| `src/library/page.html`, `page.ts` | the library page template and its writer |
| `demos/` | `inbox/` (drop here), `store/<sha256>.dem` (ingested demos), `ingested/` (originals), `rejected/` (with `.reason.txt`) |
| `state/demos.json`, `state/queue.json`, `state/sources/<name>.json` | demo registry; job ledger; each source's progress |
| `src/parse/demo.ts` | per-demo extraction, cached in `state/<demo sha256>/parse.json` |
| `src/parse/clip-facts.ts` | what one render needs: tickrate, demo hash, map, POV slot at the clip's ticks, round |
| `src/score/index.ts` | round context (1vX), one moment per round, scoring |
| `src/clip/` | clip specs (`index.ts`: boundaries, merge, action windows, id, title); `moments.ts` writes `moments.json` / `moments.txt` |
| `src/render/controller/` | `index.ts` state machine, `guards.ts`, `processes.ts`, `cfg.ts` |
| `src/render/capture/hlae.ts` | HLAE launch arguments and `mirv_streams` lines |
| `src/post/` | trim and fade (`index.ts`), FFmpeg probes (`ffmpeg.ts`) |
| `src/library/index.ts` | clip id, atomic publish, index and failures |
| `state/render/<id>/<attempt>/` | per-attempt work dir: generated cfgs, raw capture, `console.log`, `render.json` |

## Decisions made in M1

- **Fast-forward.** A moment is never cut short: its span runs from the
  engagement start to its outcome event, however long. Length is handled in
  post. The spec's `windows` (`actionWindows`, `src/clip/index.ts`) run from
  2 s before to 1.5 s after each POV kill, damage dealt or taken, weapon
  fire and outcome event (the clutch's plant, defuse or round end), clamped
  to the span (a clutch's ends 1 s after its outcome). Windows
  closer than `FAST_FORWARD_GAP_S` (4 s) merge, so short pauses play as
  they are. Post (`segments`, `src/post/index.ts`) plays each window at
  normal speed and each gap between two windows at `FAST_FORWARD_SPEED`
  (8x) with the audio muted: trim/setpts per segment, fps resampling for
  the fast ones, then concat, with fades over the whole clip. The first
  window starts at the clip start and the last ends at its end, so the
  lead-in (`config.json` → `clip.leadInSeconds`, 4 s) and the tail after
  the last kill (`clip.tailSeconds`, 5.5 s; the span runs on to the clutch
  outcome + 1 s if later, capped at round end + 1 s) always play in full. About 30 s is a
  goal, not a cap.
  A hand-written range has no windows and plays whole. The library entry's
  `render.segments` lists what was played at which speed, and `seconds` is
  the output length.
- **Tick mapping, scheduled.** The capture records `MARGIN_TICKS` (32) on
  each side of the requested ticks. The frame rate is locked (HLAE's
  "Finishing movie … [N frames" line, the demuxed frame count and the WAV
  length must agree), but where recording starts varies per launch. Post
  does not measure it: it trims by the scheduled record-start tick shifted
  by `RECORD_START_OFFSET_FRAMES` (−3.4, `src/post/index.ts`), the median of
  the seven per-capture offsets measured on this machine in M0–M3 (−0.4 to
  −3.5 frames). So a clip can land up to about 3 frames (50 ms) off either
  way. Every library entry says `timing: "scheduled"`. The finished clip is
  validated only: it decodes cleanly, has one video and one audio stream,
  the configured size, a duration within 0.5 s of the requested interval,
  and frames sampled at 10/30/50/70/90 % are not black (mean luma > 12).
  Entries made before this have no `timing` field (they were timed from
  the muzzle flash and gunshots) and stay as they are. `pnpm go --repost`
  launches nothing: it posts every selected moment that is not in the
  library and has a completed capture (e.g. jobs a post change failed),
  ignoring the attempt limit; selected moments without a capture are
  listed, and a normal `pnpm go` renders them.
- **Crosshair.** Demos recorded since CS2's 22 September 2026 update carry
  the player's crosshair; older ones do not. The gate is the demo header's
  `patch_version` against `config.json` → `crosshairFromDemoSincePatch`
  (`crosshairSource`, `src/render/controller/cfg.ts`): at or above it,
  the look cfg leaves out every `cl_crosshair*` / `crosshair` convar and
  the job sets `cl_show_observer_crosshair 2` (the demo's crosshair);
  below it, the look cfg keeps the main account's saved crosshair convars
  and the job sets `cl_show_observer_crosshair 0` (the spectator's own,
  i.e. his). Empty (absent, `null`, `""`) means always the demo's. The
  value 14182 is inferred, not looked up: Valve's notes give no build
  number, and the store's demos show 14181 on 15 September and 14182 from
  23 September on (FACEIT match dates). The render key changes only where
  the picture does: for "demo" the look hash lacks the crosshair lines
  (they never showed), for "own" the inputs add `crosshair: "own"`. Each
  library entry records `crosshair: { source, demoPatch, cutoff }`;
  clips made before the policy have none and stay as they are.
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
  A moment counts as done once `index.json` holds it (Ledger, below), with
  any render key. The render key (settings, tool versions, look cfg hash,
  POV and slot) picks what an unfinished job may resume: a validated raw
  capture (`capture.json` in its work dir) with the same key is reused, so a
  failed post never costs another launch. Only `--rerender` renders a held
  clip again.
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

## Decisions made in M3

- **Ingest.** A file in `demos/inbox/` is taken when its size, mtime and
  file id held for 2 s; writers must use a temporary name (leading dot,
  `.part`, `.tmp`, `.crdownload`) and rename when done. `.zip` goes through
  Windows' own `tar.exe` (listed first; only `.dem` members, no `..`,
  wildcard, option-like, colon or duplicate names; 20 members, 2 GiB per
  demo, 6 GiB total); `.bz2` through `seek-bzip` (the one added dependency;
  Node has no bzip2), `.gz` / `.zst` through Node's zlib, all bounded while
  unpacking. The result must start with `PBDEMS2`. Demos are hashed and
  moved to `demos/store/<sha256>.dem`, registered per demo; a store file
  missing from the registry is registered on the next run. Nothing is
  deleted: originals go to `ingested/`, bad input to `rejected/`.
- **Stage keys.** parse.json (demo hash + parser + schema + POV),
  moments.json (parse key + weights + clip rules + schema; an empty list is a valid
  result, a parse error is a failure in `state/failures.json` under
  `demo:<sha256>`), the library entry and `capture.json` (render key).
- **Ledger.** `state/queue.json`, keyed by clip id + render key, so a
  settings or tool change starts a fresh attempt budget. A job is marked
  running before it may launch; a run that dies mid-job leaves it running
  and the next run retries it once (two attempts in all, then it is listed
  as given up until `--retry-failed`). A moment the library holds is done
  whatever the ledger or the render key says: the same clip id, or a clip
  of the same demo and round sharing a kill (made under other span
  rules; sharing one kill is enough on purpose, even when the new span
would add kills). A held entry whose file is missing is reported, not
re-made. Only a guard refusal gives
  the attempt back. Locks (`state/.go.lock`, `.clip.lock`, `.render.lock`)
  are released on normal exit, errors and signals; a hard-killed run leaves
  them, to be deleted by hand after checking no cs2.exe / HLAE.exe is left.
- **Library page.** `src/library/page.html` (committed) with the clip
  index inlined as JSON, every `<` escaped, so it works from `file://`;
  videos load by relative path. One static file, plain CSS and JS: filter
  by map, kill count and score, sort by score or date; rank, title, score,
  kills, clutch and flags per clip.
- **Stretched aspect** is wired end to end (`captureSize` sets the game
  window, post scales); it has been checked in post only, no game capture
  at 1440x1080 yet.
- **Test hook.** `pnpm go --test-exit-after <s>` ends the process that many
  seconds into the first job that may launch, to exercise the interrupted
  path; not for normal use.
