# Modules (M1-M4a)

`PLAN.md` is the design; this page is what the code does not say by itself.

## Running

```
setup.ps1                      (one line for a new PC: git, Node, pnpm, clone or pull, pnpm prep; GUIDE.md)
Make clips.cmd                 (double-click: pnpm grab, then pnpm go, window stays open)
Set up matchmaking.cmd         (double-click: pnpm prep --valve, window stays open)
pnpm prep                      (first time on a PC: tools, .env; pnpm check reports only)
pnpm prep --valve              (only the three Valve matchmaking .env values: where to get them, asks for the unset ones)
pnpm check
pnpm grab [--dry-run] [--browser] [--last <n>]
pnpm grab --login
pnpm go [--dry-run] [--retry-failed] [--repost] [--settle-existing] [--no-reels]
pnpm moments "<demo.dem>"
pnpm clip "<demo.dem>" --top <n> [--timeout <s>] [--dry-run]
pnpm clip "<demo.dem>" <startTick> <endTick> [same options]
pnpm clip --rerender <no|id> [--lead <s>] [--timeout <s>] [--dry-run]
pnpm deaths "<demo.dem>" [--timeout <s>] [--dry-run]
pnpm victims "<demo.dem>" [--timeout <s>] [--dry-run]
pnpm library [--port <n>]
pnpm drop <no>...
pnpm trash --empty
pnpm tidy
pnpm unsettle <demo sha256 prefix | clip no>...
```

**Reels** (`src/reel/`). `pnpm go` makes two reels for every new demo, in
the same launch as its highlights (`config.json` → `reels`, each with
`enabled`, `beforeSeconds`, `afterSeconds`; `--no-reels` skips them for
one run): **deaths**, every death of
the POV player from the killer's first person (7 s before, 4 s after; a
suicide or a world death from the POV player's own view), and **kills**,
every kill by the POV player from the victim's first person (7 s before,
2 s after; after the death the game
shows its death camera). Each take spectates that player's slot with the
same HUD, crosshair and TrueView rules as a highlight, carries a line of
text (round, weapon, the other player; Segoe UI Semibold, `drawtext` with
`expansion=none`), fades in and out, and the takes are concatenated into
one library clip (`kind` deaths or kills, title `<map> · deaths` /
`<map> · kills`, `reel.takes` in the entry). Takes that overlap are
reached by backward seeks. A reel's render key names each take's event
and slot, not its window, so a capture with a wider window serves a
narrower one (post trims). A reel is held per demo and kind; frames are
checked mid-take, never on a seam where the fades meet. `pnpm deaths` /
`pnpm victims` make one for any demo, settled or not.

**Deleting.** `pnpm drop <no>` (not `pnpm rm`: pnpm's own `rm` removes a
dependency) moves the clip's mp4 to `library/trash/`, removes its index
entry (the number is never reused) and keeps it in `state/deleted.json`,
which counts as held: `pnpm go` never makes that moment or reel again.
`pnpm trash --empty` deletes the trash for good. **Raw captures** (HLAE's
intermediate video and audio per take under `state/render/`, about 700 MB
per clip, kept so a failed post never costs another launch) are deleted
right after the clip they belong to is published, and `pnpm go` ends with
a sweep of every capture of a clip the library holds or `state/deleted.json`
lists; `pnpm tidy` runs that sweep alone, launching nothing (for captures
from before this rule, or ones a publish could not delete). The sweep runs
under `state/.clip.lock`, which every render run holds from its resume
check to its index write: a same-id `--rerender` writes its fresh capture
while the old entry is still held, and a sweep meanwhile would eat it. A
held lock skips the sweep (`pnpm tidy` exits 2), never waits. Only files
named `video*.mp4` / `audio.wav` physically under `state/render/` (a
junction inside it does not count) are ever deleted;
`capture.json`, `console.log`, the cfgs and `render.json` stay. A capture's
recorded path is re-rooted under this checkout's `state/render/`, since the
record holds an absolute path and the folder may have moved
(`src/queue/prune.ts`). Captures of failed-for-good units and launch dirs
no clip refers to are not touched. `pnpm library` serves
`library/` at `http://127.0.0.1:8765/` (127.0.0.1 only, no dependencies,
Range requests; Host and Origin checked, so no other site can delete
through it); served that way the page has a Delete button and the Delete
key (with a confirm), opened from disk it shows the `pnpm drop <no>`
command to copy. Index writes (publish, delete) take a short lock,
`state/.index.lock`, so a delete during a run is never lost.

`pnpm prep` (PLAN.md M5; pnpm's own `setup` and `doctor` commands take the
obvious names, so `pnpm check` is the report-only form) makes a PC ready:
Steam and CS2 from the registry and `libraryfolders.vdf`, the pinned HLAE
and FFmpeg downloaded into `tools/` with their sha256 checked (the pins
and hashes are constants in `src/cli/setup.ts`; a new pin goes there and
in `docs/spikes.md`), `tools/hlae/ffmpeg/ffmpeg.ini` written when there
is none, and `.env` created from `.env.example` with `HLAE_EXE` and
`CS2_EXE` filled and the two SteamIDs asked for. A value that is set is
never changed. Both forms end with one line per requirement (Node, Steam,
CS2, the `.env` keys, HLAE, the FFmpeg HLAE captures through, the FFmpeg
post encodes with and whether it has NVENC, the POV account's saved CS2
convars, which account Steam is logged in with, cs2.exe / HLAE.exe
running, a browser for `--browser`), never an ID or a key, and exit 1
when a required one is missing.

`pnpm grab` (PLAN.md's `pnpm fetch`; pnpm's own `fetch` command takes that
name) runs the demo sources, each writing new demos into `demos/inbox/`,
then ingests the inbox; it renders nothing. Sources: **folders** copies new
demos, read-only, from watched folders (default CS2's `game/csgo/`, where
the FACEIT client's "Watch demo" and manual downloads land, its `replays/`,
where the Watch tab's downloads land, and `~/Downloads`; `config.json` →
`sources.folders.dirs` overrides; not recursive), skipping
any whose content is already in the store; **faceit** (with
`FACEIT_API_KEY`) lists new FACEIT matches and downloads their demos, by
the Downloads API (needs a scope FACEIT did not grant) or, with `--browser`
(or `config.json` → `sources.faceit.via: "browser"`), through the user's
logged-in FACEIT session in the installed Chrome or Edge, signed in once
with `pnpm grab --login` (`docs/faceit-api.md`); since 2026-10-24 that
click runs a Cloudflare bot check that fails in the automated browser, so
the source stops within 30 s of the click with every new match pending
and its room link printed, and the demo is downloaded by hand (below). `--last <n>` backfills
instead: the demos of the last n FACEIT matches through the browser
session, oldest first, one at a time with a random 4–8 s pause (`sources.faceit.pauseSeconds`) between
downloads, skipping matches already in the store (match id in a stored
file name; ingest drops content duplicates) and stopping on the first
failure with a screenshot in `state/browser-failures/`; a rerun resumes
(`state/sources/faceit-backfill.json`). A pending FACEIT match is printed
with its room link: "Download demo" there lands the file in Downloads,
where the folders source picks it up on the next run. **valve** (with
`STEAM_WEB_API_KEY`, `STEAM_MATCH_AUTH_CODE`, `STEAM_LAST_SHARE_CODE`)
walks the main account's share codes after the last one handled
(`state/sources/valve.json`; the start code itself is not fetched), at
most `sources.valve.maxMatchesPerRun` (5) per run, oldest first, and has
CS2 download each match itself (`sources/valve-fetch.ts`; the contract and
its reasons are in `docs/m6-mm-fetch.md`, the measurements in
`docs/spikes.md` M0.4): one launch per code, in order, `cs2.exe` started
directly on the render account with `-insecure … +csgo_download_match
<code>` and nothing that joins a server, under the render launch's guards
and lock (`state/.render.lock` taken before the guard and released by the
fetch launch alone, once its cleanup is verified; a lock held by a
render, `.clip.lock` / `.go.lock`, a running CS2, the FACEIT client or the
wrong Steam account makes the source blocked with every code pending, never a
failure). The game's own logon line in `console.log` must name
`RENDER_STEAM_ID64`, or the launch is killed. A code is done when that
line has named the render account, its
`replays/match730_<outcome id>_….dem` appeared or changed after the
spawn, its `.dem.info` names the code's match id, the demo is complete
and it held still 10 s (a complete demo without the logon line ends the
launch pending, nothing advanced); then the game is killed and its cleanup
verified, then the demo is copied into the inbox (the folders source's
copy-and-rename, 2 GiB limit), about 55 s per code on the author's PC
(the gate's 85 s included a 30 s watch the product does not run). It is
gone when the game says the match has expired, or
when it has been pending over 30 days (`pending[code].firstSeenAt` in the
state; Valve keeps demos about that long). Otherwise it is pending
(replays/ idle 180 s, or the 300 s cap) and the run stops there. The
checkpoint advances only over done and gone codes, in order; a code whose
demo is already stored (its padded outcome id leads a stored demo's name,
`match730_<id>_` or the old GC path's `valve-<id>_`) is passed without a
launch. Before each launch an orphan `match730_<id>_*.dem.info` (no
complete `.dem` beside it, field 1 the code's match id) is deleted: a
download killed between the two files leaves it, and while it is there
the game never downloads that match again; that is the one write under
`game/`. A launch's cleanup that cannot be verified stops `pnpm grab`
(no further source, no ingest; exit 3, the lock stays). A `.dem` anywhere
that is not complete (no valid `DEM_FileInfo` at the header's offset:
cut short or still being written) is pending in the folders source and
rejected by ingest as "incomplete demo" (`demoIncomplete` in
`src/parse/fileinfo.ts`). Pending items are
not failures; exit 1 means a source failed or ingest rejected a file, 3
a fetch launch's cleanup was not verified.

`pnpm go` is the one command: drop demos (`.dem`, or `.zip` / `.bz2` /
`.gz` / `.zst`) into `demos/inbox/`, run it, come back to clips. It
ingests the inbox, ranks every registered demo, renders the moments
`config.json` → `batch` selects (every moment scoring at least `minScore`,
40; when none in a demo does and `fallbackBest` is true, its single best)
that the library does not hold yet (settled demos, listed in
`state/settled.json`, are skipped whole: a demo is settled when a pass
over it finishes, with every selected moment rendered, held or failed
for good (not on a dry run, a repost or a `--no-reels` pass), or by
`pnpm go --settle-existing`; rule changes apply from the
next new demo, never to settled ones; `pnpm unsettle <hash prefix | clip
no>` reopens one), with one CS2 launch per demo for all
of them (chained takes, below), and rewrites
`library/index.html` (open it from disk). It refuses to start while CS2 or
the FACEIT client runs (its anti-cheat stops HLAE from creating cs2.exe, 2026-10-25;
exit the client from its tray icon; a dry run does not care) and stops the
whole batch on the first guard refusal (exit 2) or unverified
cleanup (exit 3); exit 1 means a job or demo failed (`state/failures.json`).
Run it again to resume: nothing new means no launch. `--dry-run` lists what
it would render. While a launch runs, the controller prints a `[controller]`
line for every state it reaches and, in between, a heartbeat roughly every
5 s (`<title>: waiting for the game to start, 12 s of 60`, `take 2 of 5:
capturing, 8 s of 150`; a log-based limit is only counted once the game's
console.log is live, and the line says so until then); a launch that
times out before the demo has loaded
also reports HLAE's hidden error dialog, when there is one
(`src/render/controller/hlae-dialog.ts`, e.g. `HLAE error 2002: Loader
could not create requested process. GetLastWin32Error = 5: Access is
denied. …`), in the console and in the failure reason.

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
refuses). `--lead <s>` (ranked moments only, 0 to 30 s) builds that clip's spec with an s-second lead-in
instead of `clip.leadInSeconds` (the moments cache is neither read nor
written for it); the entry records `leadOverride`. Every entry has `no`, the human clip number
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
| `config.json` | render settings: `hud` (`full` default = in-play HUD, `bare` = crosshair and killfeed only), output `width`×`height` (default 1920×1080, 16:9, whatever the player's own `cs2_video.txt` says), `aspect`, `fps` (60), HLAE's intermediate `captureCrf`, final `crf`, `fadeSeconds`; `ingest.keepOriginals` (default false: the file a demo arrived in is deleted once the store holds it) |
| `.env` | identities and tool paths (`.env.example`; `pnpm prep` fills it; M0.2 setup in `docs/spikes.md`) |
| `src/cli/setup.ts` | `pnpm prep` / `pnpm check`: tool pins with their sha256, Steam and CS2 lookup, the requirement report |
| `docs/m6-mm-fetch.md` | the execution plan for M6 (matchmaking demos fetched through a CS2 launch, no login): phases, agents, gate, tests |
| `setup.ps1`, `GUIDE.md` | the one-line bootstrap (`irm … | iex`: winget for git and Node, corepack or pnpm's installer for pnpm, clone or fast-forward pull of a checkout of this repo, `pnpm prep`, every exit code checked, nothing installed when winget is missing) and the step-by-step guide it points to |
| `scoring.json` | ranking weights; tuning and current picks in `docs/scoring-notes.md` |
| `src/cli/go.ts`, `src/cli/clip.ts`, `src/cli/moments.ts` | the entries |
| `src/ingest/` | watch folder (`index.ts`), the source contract (`sources.ts`), sources (`sources/folders.ts`, `sources/faceit.ts` with its browser path `sources/faceit-browser.ts`, `sources/valve.ts` with its CS2 fetch launch `sources/valve-fetch.ts`) |
| `test/` | `pnpm test`: FACEIT source against recorded fixtures (`test/fixtures/faceit/`), the Valve source against a fake Web API and fetcher, and the folders source on temp folders; no network, no game launch |
| `src/queue/` | the batch and its job ledger (`index.ts`); one clip job, shared by `pnpm clip` and the batch (`job.ts`) |
| `src/library/page.html`, `page.ts` | the library page template and its writer |
| `demos/` | `inbox/` (drop here), `store/<sha256>.dem` (ingested demos, the only copy by default), `ingested/` (the archives demos arrived in, only with `config.json` → `ingest.keepOriginals`), `rejected/` (with `.reason.txt`) |
| `state/demos.json`, `state/queue.json`, `state/sources/<name>.json` | demo registry; job ledger; each source's progress |
| `src/parse/demo.ts` | per-demo extraction, cached in `state/<demo sha256>/parse.json` |
| `src/parse/clip-facts.ts` | what one render needs: tickrate, demo hash, map, POV slot at the clip's ticks, round |
| `src/score/index.ts` | round context (1vX), one moment per round, scoring |
| `src/clip/` | clip specs (`index.ts`: boundaries, merge, action windows, id, title); `moments.ts` writes `moments.json` / `moments.txt` |
| `src/render/controller/` | `index.ts` state machine, `guards.ts`, `processes.ts`, `launch.ts` (cleanup, emergency hooks, console.log reader; shared with the fetch launch), `hlae-dialog.ts` (HLAE's hidden error dialog read on a launch timeout), `cfg.ts` |
| `src/render/capture/hlae.ts` | HLAE launch arguments and `mirv_streams` lines |
| `src/post/` | trim and fade (`index.ts`), FFmpeg probes (`ffmpeg.ts`) |
| `src/library/index.ts` | clip id, atomic publish, index and failures |
| `state/render/<id>/<attempt>/` | per-attempt work dir: generated cfgs, `capture.json`, `console.log`, `render.json`; the raw capture itself only until the clip is published (Deleting, above) |

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
  outcome + 1 s if later, past round end too, capped only by the next
  round's start, after the last round by the demo's end) always play in full. About 30 s is a
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
  i.e. the main account's). Empty (absent, `null`, `""`) means always the demo's. The
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
  M0.2. Cleanup (`src/render/controller/launch.ts`, shared with the fetch
  launch) kills in rounds with re-discovery (an encoder orphaned by a
  killed cs2.exe is adopted if created in its parent's lifetime), re-kills
  an owned process still found during verification (bounded), needs 10 s
  of continuous quiet (no owned process, no suspect orphan, no cs2.exe)
  within 60 s, and fails closed: a loader never identified, any owned
  process left, or any cs2.exe at all means exit 3. Residual, no Windows Job Object: a descendant that
  starts and exits between two 0.5 s polls is never seen.
- **Launch evidence.** `-condebug` rewrites `game\csgo\console.log` in the
  CS2 install each launch; the job cfg has a per-launch name
  (`croclip_<ms>`), and the log counts as this launch's only when its
  `[CommandLine]` line carries that name.
- **Post overlaps the next launch.** `pnpm go` renders a demo (`runJobs`
  with `renderOnly`), then hands its captured units to a post worker
  (`src/cli/post-worker.ts`, its own process: post is synchronous FFmpeg
  and would stall the controller's polling) and launches the next demo
  meanwhile; at most one worker runs, and the batch waits for the last one.
  The worker only posts (every unit post-only, so a missing capture is a
  refusal, never a launch), takes no clip lock, and writes results to a
  file; `pnpm go` alone writes the ledger. Index writes are serialised by
  `state/.index.lock`. Measured on the 19-demo run of 2026-10-15 before
  this: capture 2000 s, post 1246 s (24 s per clip), post blocking the
  next launch.
- **Final encode.** `config.json` → `post.encoder`: `auto` (default) uses
  h264_nvenc (`-preset p5 -tune hq -rc vbr -cq <crf + 4>`, so 22 for CRF
  18) whenever a one-frame test encode works on either FFmpeg, else x264
  (`-preset slow -crf 18`); a failed NVENC encode falls back to x264 and
  logs why. The entry's `render.encoder` says which made it. Post runs
  the FFmpeg in PATH (`postFfmpeg()`, on this machine the same system
  build HLAE's capture pipe uses via `tools/hlae/ffmpeg/ffmpeg.ini`, which
  the render key names), else the pinned `tools/ffmpeg/ffmpeg.exe` that
  `pnpm prep` downloads (on a fresh PC `ffmpeg.ini` points at it too). The
  NVENC probe tries the post FFmpeg first, then the pin
  (`nvencFfmpeg()`): FFmpeg 9 opens NVENC only
  on NVIDIA driver 610+, and the pin is FFmpeg 7.1.1, which also works on
  older drivers (it did on 591.86). With driver 617.42 the system FFmpeg
  9.0.1 passes and the pin goes unused. Pin source:
  `https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip`
  (92,234,348 bytes, sha256 `04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4`;
  no checksum is published for it any more, so this one is as
  downloaded); `bin/ffmpeg.exe` extracted, sha256
  `b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997`.
  Measured 2026-10-15: on one 15 s 1080p60 capture segment, x264 CRF 18
  16.2 s, 42.4 MB, SSIM 0.9769 against the raw; NVENC CQ 22 6.9 s,
  49.3 MB, SSIM 0.9773; a crop of the same frame shows no visible
  difference. Whole post of clip 59 (system FFmpeg 9.0.1, driver
  617.42, validation included): x264 44.0 s, 105.1 MB; NVENC 20.1 s,
  126.2 MB.
- **Chained takes.** One launch renders every take of a demo
  (`runJobs`, `src/queue/job.ts`): the jobs the library does not hold and
  that have no validated capture, in tick order. The main cfg schedules
  take 0; each take's record end runs the next take's cfg
  (`croclip_<ms>_t<i>`), which clears every scheduled command, points the
  recorder at its own ffmpeg slot (`croclip<i>`, video `video<i>.mp4`),
  seeks with `demo_gototick` (forward or back) and schedules its own
  spectate (its own slot), record and next step; the last quits. The
  state machine waits for each take's seek, start and "Finishing movie"
  in turn. A take is validated on its own: a usable take is kept even
  when another take of the launch failed; an unverified cleanup voids
  them all. Each clip's attempt dir gets its own `capture.json` pointing
  into the shared `state/render/launch-<demo>-<ms>/`. Measured on
  2026-10-15 (`docs/spikes.md`): seeks take 1–2 s either way, a rewind
  is frame-aligned, and the 2 s settle is enough.

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
  missing from the registry is registered on the next run. The store copy
  is the demo from then on: the archive it arrived in, and a file whose
  demo the store already holds, are deleted once the registry has the
  demo (decided 2026-10-26: `ingested/` had doubled the disk use), or moved
  to `ingested/` with `config.json` → `ingest.keepOriginals: true`. A zip
  that also holds files that are not demos is kept in `ingested/` either
  way: those are never unpacked, so the zip is their only copy. Bad
  input goes to `rejected/` and is never deleted; an archive one of whose
  members was rejected goes there too, beside that member.
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
  `pnpm grab`'s `state/.grab.lock` guards no game process, so a run whose
  pid is gone (a closed terminal tab is a hard kill) is taken over by the
  next grab, which says so. The takeover is serialized by an exclusive
  `.grab.lock.takeover` file, held only while the stale lock is replaced;
  a grab hard-killed inside that moment (milliseconds, and only after an
  earlier crash) strands it, and later grabs refuse until both files are
  deleted by hand. Ctrl-C releases `.grab.lock`; during a fetch launch it
  also runs that launch's cleanup, which releases `.render.lock` once
  verified (exit 3 and the lock stays otherwise); a hard kill mid-launch
  leaves the game and `.render.lock`, handled like any other.
- **Library page.** `src/library/page.html` (committed) with the clip
  index inlined as JSON, every `<` escaped, so it works from `file://`;
  videos load by relative path. One static dark file, plain CSS and JS:
  a sidebar with Find (clip number or title), sort and the categories kind
  (highlight, deaths, kills; entry `kind`, absent = highlight), map and
  match (one per demo, dated by `state/sources/matches.json`, which
  `pnpm grab` fills from FACEIT history when there is a key; any other
  demo shows "added <day>", the day it was ingested, since a demo carries
  no match time of its own); the selected clip plays as large as the
  window allows at 16:9, with sound (browsers allow sound only after a
  click or key, so the first clip on load waits); a compact list of the
  category's clips (number, title, score, length) with the playing one
  marked; left/right or j/k step through it. Controls reset on every
  load, so a browser restoring old form values cannot leave it looking
  empty. "Newest clips" at the top of the sidebar clears the filters and
  sorts by date added; the playing clip is marked by a tint and a bold
  number. `src/library/page.ts` rewrites it (temp, then rename) after every
  clip a job publishes and at the end of `pnpm go`; inside a run it says
  "Run in progress: N clips so far".
- **Stretched aspect** is wired end to end (`captureSize` sets the game
  window, post scales); it has been checked in post only, no game capture
  at 1440x1080 yet.
- **Test hook.** `pnpm go --test-exit-after <s>` ends the process that many
  seconds into the first job that may launch, to exercise the interrupted
  path; not for normal use.
