# Local CS2 highlight clipper — project plan

A locally run Allstar.gg alternative: pull in your CS2 demos, find your
best frags, render them as real in-game footage, and browse the result
in a local library.

Status: plan, nothing built. Written 2026-10-14 by Fable, reviewed the
same day by GPT-6 Astra; the review's accepted findings are folded in
below, so this is the version to build from.

## Reading of the ask

- **Game:** Counter-Strike 2. CS:GO demos are out of scope.
- **Footage:** real in-game video (the demo replayed in CS2 and
  captured), not 2D radar renders. Decided.
- **Machine:** this Windows 11 PC, with CS2 installed. The renderer
  takes over the game while it runs, so rendering is a "while you are
  not playing" job. It must detect a running CS2 and refuse, never
  reuse or kill your session.
- **Player:** one Steam account (yours). Multi-user is out of scope.
- **No accounts, no cloud, no backend service.** A CLI on this machine
  plus a static HTML library.

## Pipeline

```
sources ──> ingest ──> parse ──> score ──> clip specs ──> render ──> post ──> library
 (dem)     (watch     (events,  (rank     (tick ranges,  (replay    (ffmpeg  (mp4 +
           folder,     ticks,    rounds +  POV, id)       controller trim,    static
           FACEIT,     identity) clusters)                + capture) overlay) page)
           Valve MM)
```

### Resumability contract (applies to every stage)

- Each stage has a cache key over its input hash plus the settings and
  tool versions that affect its output (parser version, scoring.json
  hash, CS2 build, HLAE version, FFmpeg build, capture settings).
- Write to a temp path, validate (a playable, finalized mp4; a parse
  that contains your identity), then atomically rename to the final
  path. A file existing is never proof a stage finished.
- Failures are recorded as failures, separate from valid empty results
  ("this demo has no moments above threshold" is a result).
- Re-running the CLI resumes from the first incomplete stage.

### 1. Ingest

- **Watch folder** is the baseline: drop a `.dem` (or the `.bz2`/`.zip`
  Valve hands out) in `demos/inbox/`. Ingest waits until the file has
  stopped growing, unpacks with path and size limits, hashes the
  unpacked `.dem`, and registers it in `state/demos.json`.
- **FACEIT**: the FACEIT Data API gives a demo URL per match for a
  player ID. Poll recent matches, download new ones. Needs a free
  FACEIT API key in a local `.env` (never committed). After the render
  gate (see milestones).
- **Valve matchmaking**: no clean path. Demos live ~30 days and the
  official route is the in-game Watch tab. The workable automation is
  the Game Coordinator route (`@akiver/boiler-writter` or
  `cs-demo-downloader`), which needs your match-history auth code and
  a share code to start from. Last milestone. Until then: click
  download in-game, point the watch folder at where Steam puts it
  (location to confirm on this machine).

### 2. Parse

- **Parser:** `demoparser2` (LaihoE). Rust core, Python and Node
  bindings, query-style API that returns tables. Used by awpy and most
  current CS2 tooling.
- **Identity:** your SteamID64 is the canonical key, stored and passed
  as a string everywhere. JavaScript `Number` cannot hold it. The parse
  stage must resolve you to whatever the demo uses (account id, user
  id, entity index, name) and store that mapping per demo; every later
  stage joins on it.
- **Time:** tickrate is read from the demo, never assumed per source.
  The parse stage records the mapping between parser ticks and the
  tick coordinate `demo_gototick` uses, verified in spike M0.2 (they
  are expected to be the same coordinate, which is the thing to prove).
- Extract once per demo into `state/<hash>/`, with the actual field
  names and types verified against the parser in M0.1 (the names below
  are the expected ones, not a demonstrated schema):
  - events: `player_death` (attacker, victim, weapon, headshot,
    penetrated, noscope, thrusmoke, attackerblind, distance),
    `player_hurt`, `weapon_fire`, `round_start`, `round_end` with
    reason and winner, `bomb_planted/defused`, `player_blind`.
  - per-tick for every player: alive state and team (needed for 1vX
    detection). For you also position, view angles and health.
  - metadata: map, tickrate, your identity mapping, team per half,
    final score, which rounds are warmup/knife/overtime.

### 3. Score

Two layers, because a clutch is a round property and a multikill is a
sequence property, and clip boundaries differ between them.

- **Round context** (per round you were alive in): round outcome, your
  kills, whether you were the last alive on your team and how many
  enemies were alive then (1vX), whether you won it, whether the round
  ended by your kill, defuse or plant. Defines warmup, knife, overtime,
  team changes, suicides and teamkills explicitly and excludes them.
- **Kill clusters**: your kills within a sliding window (~6 s between
  kills, same round).

Score per moment from, first ranking only:

| Signal | Why it matters |
|---|---|
| kill count in cluster (2k…5k) | multikills are the backbone |
| time between kills | fast 3k > slow 3k |
| clutch state (1vX, won) | highest-value single signal |
| headshot, wallbang, no-scope, through smoke, while blind | flavour, straight from the death event |
| weapon class (pistol/Deagle/scout vs rifle vs AWP) | difficulty |
| round won after the moment | impact |
| victim already low HP (reconstructed from `player_hurt` before the kill) | penalty |

Deferred until their definitions and inputs are proven: flick angle
(yaw delta is recoil and movement as much as flicks, and needs angle
wrapping and timing rules), trades, "saved a teammate".

Weights live in one `scoring.json`. Validation: you hand-pick the best
moments from 3–5 of your demos; the ranking is tuned until it agrees
with your picks, and that sample stays in the repo as the regression
set. CS2's own highlight markers (`demo_listhighlights`) are read as a
second opinion in that comparison, not used as the ranking.

### 4. Clip specs

For each moment above a threshold (or top N per demo):

- `start_tick` = first engagement signal in that round within 5 s
  before the first kill (your first `weapon_fire`, or damage dealt or
  taken), minus 2 s of lead-in.
- `end_tick` = the moment's outcome event, not just its last kill: the
  last kill + 2.5 s, or the defuse/plant/round end that resolves a
  clutch, capped at round end + 1 s.
- Overlapping moments merge. Hard cap 30 s; a longer moment is split,
  and only the fragment that contains the outcome keeps the clutch
  label.
- `pov` = your identity mapping, first-person spectate.
- `id` = stable hash of (demo hash, round, start_tick, end_tick). Files
  are named by id; the title is metadata, so a title collision can
  never overwrite a clip.
- `title` = `<map> · R<round> · 3k Deagle clutch`, generated from the
  signals.

### 5. Render

Two separate things: a **replay controller** that gets CS2 to the right
place in the right view, and a **capture mode** that turns frames into
a file. They are designed and tested separately.

**Replay controller.** An explicit state machine: launch → demo loaded
→ seeked → settled → POV locked → capturing → stopped → finalized →
validated. Each transition has observable evidence (a file appearing,
a console log line, a frame count), a timeout, and a recovery action
(kill the game, mark the job failed, continue the queue). Spike M0.2
establishes which of these CS2 and HLAE actually expose; the ones that
cannot be observed get a conservative settle delay and a validation
step on the output instead.

**Capture mode, recommended: HLAE (`mirv_streams`) piping to FFmpeg.**
This is the path CS Demo Manager uses for CS2 video export on Windows,
so it is proven in principle and its open-source driver code is the
reference for launch options and command sequence. Expected shape:

1. Generate a `.cfg` per job from the clip spec: `playdemo`, jump to
   `start_tick` with `demo_gototick`, lock spectator to your identity,
   first-person mode, demo UI and spectator controls hidden (exact
   commands to verify), `mirv_streams record start`, and a scheduled stop
   at `end_tick` via HLAE's tick scheduling (`mirv_cmd addAtTick`),
   which replaces the VDM files CS2 dropped. Exact commands to verify.
2. Launch CS2 through HLAE with `-insecure`, `-novid`, fixed window
   size, `+exec <job>.cfg`.
3. HLAE pipes frames to FFmpeg, which writes the mp4 directly. No raw
   TGA folders (CS Demo Manager warns about 40 GB+ for those).
4. Record the output-time to demo-tick mapping per job so post can trim
   exactly; the lead-in margin is defined by that mapping, not assumed.
5. Validate the output, kill the game, next job. One launch per clip is
   the baseline; chaining clips in one launch is an optimization that
   comes after the gate passes.

**Audio is a capture-mode decision.** HLAE's own audio stream is first
choice because it shares the video timebase. There is an open report of
no audio from `mirv_streams` in CS2; if that reproduces, the fallback
is a system-audio capture, but only if a sync test proves the demo is
rendered at real time. Whether the FFmpeg build on this machine has a
WASAPI loopback input is unknown and part of the spike.

**Fallback capture mode: OBS via obs-websocket.** Real-time playback,
OBS records the window. It replaces only the capture step: loading,
seeking and POV still come from the controller's cfg, and without
HLAE's tick scheduling the stop has to be wall-clock. Whether that
works without HLAE is unknown until tested; it is a documented option,
not a promise.

Known risks, decided up front:

- **HLAE breaks on CS2 updates.** Every render records the CS2 build,
  HLAE version, parser version, FFmpeg build and capture settings.
  HLAE version is pinned in config. When CS2 updates, the render gate
  test (below) is the smoke test.
- **Old demos may not replay** on a newer CS2 build or without the map
  assets. Unknown; one representative old demo goes through the gate
  before a historical library is promised.
- **`-netconport` (telnet into the client) is reported dead in CS2**,
  so no live remote control. Everything goes through the generated cfg
  and tick scheduling.
- **Never run HLAE against secure servers.** Renders always launch with
  `-insecure` and never touch matchmaking. The controller refuses to
  start if CS2 is already running.

### 6. Post

FFmpeg only:

- trim to exact seconds using the per-job tick mapping, fade in/out.
- overlay: map, round, score, title. Simple drawtext, no HTML
  compositing.
- optional later: custom killfeed via HLAE `mirv_deathmsg`.
- montage mode: top N clips of a week concatenated, optional music
  track from a local folder.
- outputs `library/clips/<id>.mp4` + `library/index.json`.

### 7. Library

`library/index.html` is generated with the clip index inlined, so it
works opened straight from disk (a `fetch` of `index.json` over
`file://` does not). Grid of clips with `<video>`, filters by
map/kill count/score, sort by score or date. No server, no backend.

## Stack

**Decided: TypeScript on Node 22, pnpm, one package.**

- `@laihoe/demoparser2` has Node bindings, so parsing stays in the same
  language as the orchestration and the library page shares the types.
- Driving a game process, polling files and shelling out to FFmpeg is
  plain Node.
- Matches your tooling (pnpm, static sites).

Python (demoparser2 + polars + awpy) was the alternative. It only wins
if analysis gets heavy, and it costs a second language. If spike M0.1
finds no Windows binary for the Node bindings, that is a dependency
decision to bring back here with options (build from source, a Python
parse step called from Node, or switch), not an automatic switch.

Dependencies on the machine: CS2 (Steam), HLAE, FFmpeg. Nothing else
installed globally.

Layout:

```
cs-clips/
  src/ingest/   watch folder, faceit, (later) valve-gc
  src/parse/    demoparser2 wrapper, identity + time mapping, events
  src/score/    round context, clusters, scoring.json
  src/clip/     clip spec generation
  src/render/   controller/ (state machine, cfg generation), capture/hlae, capture/obs
  src/post/     ffmpeg trim, overlay, montage
  src/library/  index writer, static page template
  demos/inbox/  you drop demos here
  state/        per-demo parse + moments (gitignored)
  library/      output mp4s + index (gitignored)
  docs/spikes.md  results of M0, with the exact commands that worked
  AGENTS.md     operating rules; CLAUDE.md one-line adapter
```

## Milestones

**M0. Gates.** Throwaway scripts; results and the exact working
commands go in `docs/spikes.md`. Nothing is built on a gate that did
not pass.

1. **Parser, identity, time.** Parse one of your demos on Windows via
   Node. Show your SteamID64 resolving to the demo's identifiers and
   joining across deaths, damage and tick samples. Confirm the field
   names and types. Read the tickrate from the demo. Record what the
   Node binding situation on Windows actually is.
2. **Repeatable unattended capture.** Read CS Demo Manager's renderer
   source first. Then, from a generated cfg, record a hand-picked
   interval of your demo: correct player, first-person throughout,
   lead-in present, first frames present, audio present and in sync,
   file finalized and playable, and no demo UI in the frame (no
   playback panel, no spectator controls, no console; the normal game
   HUD stays). Then: a second, different interval in
   a fresh launch; a restart and repeat; one job interrupted mid-way
   and recovered by the queue; and the behaviour when CS2 is already
   open. Confirm that parser ticks, `demo_gototick` and HLAE
   scheduling agree on the tick coordinate, including across a seek.
3. **Old demo.** One demo from months ago through gate 2.

**M1. One clip, by hand.** Clip spec written by hand → controller →
capture → post → file in `library/`. Proves the seams before scoring
exists.

**M2. One clip, automatic.** Ingest → parse → round context + clusters
→ one clip spec → the M1 path. First ranking, validated against your
hand-picked moments from 3–5 demos. The text-only moment list is a
tuning tool here, not a milestone of its own.

**M3. Batch and resume.** Queue, the resumability contract end to end,
crash recovery, library page with players and filters. "Drop demos in,
run one command, come back to clips."

**M4. Sources and polish.** FACEIT auto-download, overlays, killfeed,
montage builder, OBS fallback, Valve GC download, deferred scoring
signals.

## Who does what

Per `~/.claude/01-model-map.md`. The main session keeps the concept,
the seams and the assembly; cheaper models get pieces.

| Work | Model |
|---|---|
| Plan, scoring design, clip-boundary rules, controller interface | Fable (main session) |
| Second opinion on this plan before M0 starts | GPT-6 Astra (done 2026-10-14) |
| M0 gates, M1–M4 implementation, library page, docs | Opus |
| Bounded pieces with a clear done-criterion (FFmpeg post step, FACEIT client) | Sonnet |
| Review of every Opus/Sonnet change before it is called done; verifying gate claims on this machine | GPT-6.1 Sol |
| Parallel reads (CS Demo Manager source, HLAE wiki), extraction, screenshots | Haiku, never in project code or docs |

The render controller and anything touching the game install or Steam
launch options counts as hard to undo: Sol reviews before it lands.

## Open decisions

1. Sources for v1: FACEIT, Valve MM, or both. Affects which demos go
   through the gates.
2. Your SteamID64 (needed for M0.1). Keep it in local config, not in
   the repo.
3. Where the repo lives, so M0 can start in a real folder.
