# Local CS2 highlight clipper — project plan

A locally run Allstar.gg alternative: pull in your CS2 demos, find your
best frags, render them as real in-game footage, and browse the result
in a local library.

Status: built through M3, with both reels and M6. M5 is built; its check
on a PC that is not this one is open. M4 is built in part: the sources,
the reel overlays and the montage builder (`pnpm week`) are in, the
OBS fallback is not, and M6 replaced the Valve GC download. See `docs/modules.md`
for the code and the decisions made while building.
Written 2026-10-14 by Fable,
reviewed the same day by GPT-6 Astra; the review's accepted findings are
folded in below, so this is the version to build from.

## Reading of the ask

- **Game:** Counter-Strike 2. CS:GO demos are out of scope.
- **Footage:** real in-game video (the demo replayed in CS2 and
  captured), not 2D radar renders. Decided.
- **Machine:** a Windows 11 PC with CS2 installed (this one first;
  others' since M5). The renderer
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
- Re-running the CLI resumes from the first incomplete stage. A
  changed key never invalidates finished output: existing clips stay
  as they are until an explicit re-render command names them (Peder's
  rule, 2026-10-15).

### 1. Ingest

The user-facing entry point is one command, `pnpm grab` (pnpm reserves `fetch`): "I have
played some games" means running it, followed by `pnpm go`, which
makes every clip type for each new demo (all highlights scoring 40
or more, or the single best when none does; deaths reel; kills reel)
without asking; see AGENTS.md "The standing order". It asks every configured source
for matches newer than the last one it saw, downloads the demos it
does not have into `demos/inbox/`, and the normal pipeline takes over.
State per source (last FACEIT match id, last Valve share code) lives
in `state/`. It runs on demand, not on a schedule, because the Valve
route needs a Steam session on the alt and must not collide with
rendering or with Peder playing.

- **Watch folder** is the baseline: drop a `.dem` (or the `.bz2`/`.zip`
  Valve hands out) in `demos/inbox/`. Ingest waits until the file has
  stopped growing, unpacks with path and size limits, hashes the
  unpacked `.dem`, and registers it in `state/demos.json`.
- **FACEIT**: click "Watch demo" in the FACEIT client or the match
  room; the file lands in CS2's folder or in Downloads, and `pnpm grab`
  takes it in through the folders source. With a free FACEIT API key in
  a local `.env` (never committed), `pnpm grab` also prints each pending
  match with its room link. The automated browser download is blocked by
  FACEIT's bot check (M5).
- **Valve matchmaking**: demos live ~30 days; the official route is
  the in-game Watch tab. The automation is two steps. (a) The Steam
  Web API `GetNextMatchSharingCode` walks forward from the last known
  share code, using your main account's match-history auth code and a
  Steam Web API key (both in `.env`; the auth code grants read access
  to match history and replays, nothing else, and can be revoked
  in-game). (b) Each share code is downloaded by CS2 itself: a fetch launch of
  `cs2.exe` on the alt with `-insecure` and `+csgo_download_match`, one
  per match, under the render launch's guards, lock and cleanup, the
  demo landing in the game's `replays/` and copied into the inbox (M6,
  2026-10-25; it replaced a headless GC login by QR code, M4, 2026-10-24,
  which was the one setup step a stranger could not do without a phone
  and a terminal). Manual fallback: the Watch tab in-game; the folders
  source picks the demo up from `replays/`.

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

Two layers, both per round: round context (clutch, outcome) and the
round's kill sequence.

- **Round context** (per round you were alive in): round outcome, your
  kills, whether you were the last alive on your team and how many
  enemies were alive then (1vX), whether you won it, whether the round
  ended by your kill, defuse or plant. Defines warmup, knife, overtime,
  team changes, suicides and teamkills explicitly and excludes them.
- **Kill clusters**: replaced on 2026-10-15 by Peder's rule: all of
  your kills in a round are one moment, however far apart, so a 5k is
  always one clip and the stretches between kills are fast-forwarded
  in post. No gap threshold.

Score per moment from, first ranking only:

| Signal | Why it matters |
|---|---|
| kill count in cluster (2k…5k) | multikills are the backbone |
| time between kills | fast 3k > slow 3k; decided by Peder 2026-11-02: weighted up and sliding, every second between kills counts (1 s more than 2 s, ... 7 s more than 8 s), flat from 8 s, not a step at a cutoff |
| collateral (one shot, several kills: POV gun kills on the same tick, shotgun blasts included) | decided by Peder 2026-11-02: a flat bonus per extra kill, on par with a third kill's tempo |
| clutch state (1vX, won) | highest-value single signal, but scaled by X and by kills in the clutch: a 1v1 with one kill is small, 1v3+ is big (recalibrated 2026-10-15 after clip 90) |
| headshot, wallbang, no-scope, through smoke, while blind | flavour, straight from the death event |
| weapon class (pistol/Deagle/scout vs rifle vs AWP) | difficulty |
| round won after the moment | impact |
| victim already low HP (reconstructed from `player_hurt` before the kill) | penalty, capped, and reduced when the earlier damage was your own |
| style multipliers per kill: no-scope, airborne (`attackerinair`), one-bullet kill, flick (yaw turned in the 100–200 ms before the shot, angle-wrapped, above a threshold). Each scales that kill's base value (about 1.3–1.5× each) and they stack multiplicatively | decided 2026-10-15: two one-tap flicks roughly double a boring 2k, while a single stylish kill cannot lift a weak round over a strong one, because multipliers only scale what is there. Replaces the earlier flat capped bonuses |

| economy: ratio of the enemy team's equipment value to your team's at freeze end (per-player equipment values from the demo). Kills against a much richer team scale the round up; kills against a much poorer team scale it down. A round-level multiplier, capped (about 0.7–1.4×) | decided by Peder 2026-10-15: kills on an eco are easy, kills while on an eco are hard |

| direction spread: yaw turned between consecutive kills in a run (kills in several directions within seconds) | added 2026-10-15 from clip 29; the per-kill flick window misses it |
| facing: whether the victim was looking at you at the kill tick (victim view yaw against the vector from victim to attacker, within about 60 degrees = facing). A small per-kill multiplier: facing slightly up, from behind slightly down | decided by Peder 2026-10-15: few bullets in the back is easy, less impressive |
| trade: a kill of an enemy who killed one of your teammates at most 4 s earlier in the same round. A flat per-kill bonus, outside the economy factor | added 2026-11-10: a fast trade is disciplined play, not a highlight on its own, so it is worth about a fifth of a plain kill |
| save: a kill of an enemy who hurt a living teammate (not you) within 2 s before it, the teammate still alive 3 s after the kill or at round end, whichever is first; more when that enemy's last hit left the teammate at 40 HP or less. A kill that is both a trade and a save is a save. Neither in a round with a roster change (alive state unreliable) | added 2026-11-10: like the style multipliers, it can lift a good round, never carry a weak one over a strong one (at most 4 points a kill) |

Peder's hand-picks (guidance, not hard constraints) live in
`docs/hand-picks.md`; every scoring change reports which hold.

Weights live in one `scoring.json`. Validation: you hand-pick the best
moments from 3–5 of your demos; the ranking is tuned until it agrees
with your picks, and that sample stays in the repo as the regression
set. CS2's own highlight markers (`demo_listhighlights`) are read as a
second opinion in that comparison, not used as the ranking.

### 4. Clip specs

For each moment above a threshold (or top N per demo):

- `start_tick` = first engagement signal in that round within 5 s
  before the first kill (your first `weapon_fire`, or damage dealt or
  taken), minus 4 s of lead-in (raised from 2 s by Peder, 2026-10-15).
  A re-render may override the lead-in per clip.
- `end_tick` = the moment's outcome event, not just its last kill: the
  last kill + 5.5 s (Peder: 2.5 s to 5.5 s on 2026-10-15; briefly
  7.5 s, set back to 5.5 the same day once the round-end cap that had
  been cutting some clips short was removed), or the defuse/plant/round end that resolves a
  clutch, whichever is later. The tail is always honoured even when
the last kill ends the round (the win banner and freeze time are part
of the clip); the only cap is the next round's start. Changed
2026-10-15 after clips 59 and 79 ended right after their last kill.
- Overlapping moments merge. A moment is never cut short: every kill
  in it and its outcome event are inside the captured span, however
  long. Length is controlled in post instead: stretches with no action
  (no POV kill, damage dealt or taken, or weapon fire for more than a
  few seconds) are fast-forwarded at a fixed high speed with the audio
  muted, so the finished clip stays around 30 s while the action
  windows around each kill play at normal speed. Decided by Peder on
  2026-10-15 after a 1v2 clip came out with one kill and 30 s of
  walking.
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

Decided 2026-10-25: the controller reports while it waits. Polling a
state, it prints one plain status line roughly every 5 s (job title, what
it is waiting for, elapsed seconds of that state's limit; no cursor
tricks, so the `Make clips.cmd` window and a log file read the same;
synchronous process snapshots can stretch the interval), and when a
launch times out before the demo has loaded it reads the texts of every
window of the HLAE process and its children, visible or not, and puts
HLAE's own dialog text into the failure reason. Why: HLAE runs with
`-noGui` and is spawned hidden, so on 2026-10-25 its "HLAE Error" box
(code 2002, "Loader could not create requested process … Access is
denied", the FACEIT client's anti-cheat) was never seen, and every demo
sat 60 s in silence and then failed with a bare timeout, for hours.

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
   M1 measures it from the POV player's gunshots (`docs/modules.md`).
5. Validate the output, kill the game, next job. Decided 2026-10-15:
   one launch per demo, never per clip. All takes for a demo (every
   selected moment, and every death for the deaths reel) are scheduled
   in one cfg: seek to the next take's start tick, settle, lock POV
   (which may be a different player per take), record, stop, seek
   again, and quit after the last. The game is never restarted between
   takes.

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

**Looks like real gameplay.** The alt account has none of your
settings, and a demo is drawn with the spectator's config, not the
player's. So every render job starts by executing a cfg generated
from your main account's `cs2_user_convars.vcfg` (crosshair, viewmodel,
HUD scale and colour, radar) found under Steam `userdata/<your account
id>/730/local/cfg/` (or `remote/`; which one is live on this machine is
unknown until M0.2 checks). Video quality is set explicitly by the
controller, not inherited. On top of that the cfg sets:

| Setting | Why |
|---|---|
| `cl_demo_predict 2` (TrueView forced; `1` is reported disabled for any demo older than the running build, which is every demo by the time it is rendered) | Valve's Nov 2025 demo mode that re-runs the player's client-side prediction, so first person shows what you saw, not the server's view. Auto for demos recorded after 2025-11-04; disabled by CS2 when the demo is from a different game build, so old demos may lose it |
| `spec_show_xray 0` | never xray; a hard rule from Peder |
| `cl_show_observer_crosshair 2` (demos from CS2's 22 September 2026 update on), `0` plus your saved `cl_crosshair*` convars (older demos) | the crosshair in frame is yours either way: newer demos carry it (M0.2 showed it comes from the demo, not from exec'd convars), older ones do not, so the spectator's own crosshair is set to yours. The gate is the demo's build against `config.json` → `crosshairFromDemoSincePatch` (Peder, 2026-10-15; `docs/modules.md`, Crosshair) |
| `cl_draw_only_deathnotices 0` plus HLAE `mirv_panorama panelStyle panelId=<id> opacity=0` lines scheduled after `spec_player` | Decided 2026-10-14: the HUD exactly as in play. The top bar with both teams' avatars and alive state stays (it is always visible in play); the spectator-only additions inside the cards (health, money, weapons) and the observed-player name card next to health are blanked. Hiding the whole top bar (`TeamLargeCT`/`TeamLargeT`) was tried and rejected: it removes the alive overview. The ids of the spectator-only children come from HLAE's `__mirv_panorama_print_children <panel>` dumps. `docs/hud-reference-inplay.webp` is a screenshot of the real in-play HUD and is the target to compare frames against. The radar must be the in-play round, rotating radar, not the square spectator overview (convars to verify: `cl_radar_rotate 1`, `cl_radar_always_centered`, `cl_radar_square_with_scoreboard 0`). The bare look (`cl_draw_only_deathnotices 1`) stays available as a setting |
| `demo_ui_mode 0` in the cfg body, `cl_spec_show_bindings 0` | no playback panel or spectator hints; `demo_ui_mode` must run before playback starts, a scheduled call does nothing |
| `cl_showfps 0`, HUD telemetry off, `r_show_build_info 0` | no overlays |
| `fps_max 0`, `engine_no_focus_sleep 0`, HLAE fixed framerate | capture is frame-locked, not wall-clock |
| 16:9 output, default 1920x1080 at 60 fps, never inherited from the game's own video settings; FFmpeg at a visually lossless CRF | decided by Peder; sharpness and anti-aliasing, downscale in post if supersampled |
| `aspect` setting: `native` (capture 16:9) or `stretched` (capture 4:3, e.g. 1440x1080, and scale to 1920x1080 in post ignoring aspect, which is what a stretched monitor shows) | decided by Peder: the final product offers both; the output file is 16:9 either way |

Even with TrueView, Valve says recoil, muzzle flash, blood and
ragdoll effects land one or two frames later in playback than they
did live, and frame timings are not reconstructed. Hit frames are
accurate. M0.2 records a moment with TrueView on and notes what still
differs from live play. TrueView is reported disabled at the default value
for any demo older than the current build, and enabled with `2` on
both a current and a five-month-old demo.

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
  start if CS2 is already running or the FACEIT client's anti-cheat is
  (2026-10-25: it stops HLAE from creating cs2.exe).

### 6. Post

FFmpeg only:

- trim to exact seconds using the per-job tick mapping, fade in/out.
- overlay: map, round, score, title. Simple drawtext, no HTML
  compositing.
- optional later: custom killfeed via HLAE `mirv_deathmsg`.
- best of the week, the fragmovie (decided 2026-11-11; it replaced
  the long version of 2026-11-10, eight whole clips with crossfades
  and quiet music, 3 min 21 s for 2026-W46, after the owner asked for
  "relevant royalty-free music, timed so it looks cool, shorter and
  snappier, like a fragmovie"; one mode, no flag for the old one):
  `pnpm week [<yyyy-Www>] [--top <n>] [--seconds <n>] [--music
  <file>] [--no-music] [--dry-run] [--json]` writes
  `library/montage/<yyyy>-W<ww>.mp4`. No week given: the latest ISO
  week (Monday to Sunday, local time) with a highlight. A clip belongs
  to the week of the date the library page shows it under (FACEIT
  match date, else the day its demo was added, else when the clip was
  made; one rule, `src/library/match-date.ts`, so the page and the
  montage cannot disagree).
  - Selection: highlights only, the top `montage.top` (10) by moment
    score, one clip per (demo, round); one without a score, a file,
    `moment.killTicks` or `render.segments` (entries made before those
    were recorded cannot be cut into shots) is skipped and named;
    fewer than 2 is refused (exit 2). Played in ascending score, the
    best clip's shots last; inside a clip, its shots in time order.
  - Shots, only the kills: a kill's time in the clip is its tick
    through `render.segments` (proportional inside a segment, so a
    fast-forward stretch maps right). A shot runs from
    `montage.shot.preSeconds` (0.65) before a kill to `postSeconds`
    (0.4) after it, so a single-kill shot fits one bar at 175 BPM;
    kills whose shots touch or overlap merge into one shot (a burst
    plays in real time) unless a fast-forward stretch lies between
    them; shots are clamped to the clip and never start or end inside
    a segment whose speed is not 1 (moved to its edge), and shots whose
    extents overlap after those moves become one, each kill once.
  - The grid is the music's (revised 2026-11-11 after the first W46
    render: shots of about 2 s with a kill every three half-bars read
    as a steady trot, and half the kills sat on beat 3, where two-step
    drum and bass has no kick): the unit is one bar when a bar lasts
    at most 1.8 s, else half a bar, counted from a bar line, so every
    anchored kill sits on the one (175 BPM: 1.371 s per kill; 136 BPM:
    1.765 s; 100 BPM: half bars of 1.2 s). Every shot's first kill
    lands on an anchor to within half a frame (cuts on video frames,
    in-points on clip frames). The cut into a shot is its lead-in
    before its anchor; the next shot takes the first anchor late
    enough that the current one has played to its natural end (last
    kill + post) first, and the slack is filled by the current shot's
    tail, else by the next one's lead-in, else the anchor moves one
    unit earlier when the current shot still shows its last kill +
    0.25 s. Footage never plays twice: failing all three, when the
    neighbouring shot of the same clip is what stopped the fill, the
    two merge into one continuous shot (its later kills off the grid,
    like a burst); when the clip's end or a fast-forward stretch
    stopped it, the shot holds its last frame (silent). The plan line
    names either. A tail or lead-in never stretches past the clip's
    ends, into a fast-forward stretch, or into the neighbouring shot
    of the same clip. Hard cuts only.
  - Open and close: a title card (`Best of week 46`, the dates under
    it) of one bar, the music starting with it, so the first shot cuts
    in on a bar line; when that clip has too little footage before its
    first kill to reach back to the bar line, the card stays up longer
    instead (the kill still lands on its anchor). After the last
    shot's natural end its footage keeps playing (not frozen) to the
    next bar line and on through the closing fade, picture and music
    fading out over one bar; a frame is held only where the clip runs
    out of footage. Each clip's first shot carries `#257 · 4k USP-S`
    (number and title less map and round) bottom left for 1.2 s.
  - Length: `montage.maxSeconds` (60) caps the video (`--seconds` for
    one run); over it, whole clips are dropped from the low-score end
    and named, never the best three; if those alone are longer,
    nothing is shortened and the run says it exceeds the cap.
  - Music is the spine. `music.json` (tracked) lists the default
    tracks with url, sha256, BPM, licence and credit; `pnpm music`
    downloads the missing ones into `music/` (gitignored: music is
    never committed), each checked against its sha256 (temp, then
    rename; a mismatch is deleted and reported); `--check` only
    reports. The three defaults are CC BY 4.0 by Shane Ivers
    (silvermansound.com, verified 2026-11-11): Smash It and WOAH
    (175 BPM), Slam (136: the publisher lists 138, the file measures
    136.0 with and without a prior; `music.json` says both). The
    track: `--music`
    (a path or a name in `music/`), else `montage.music`
    (`smash-it.mp3`), else the first audio file by name in `music/`
    (any file dropped there works without a manifest entry); none:
    refused (exit 2), naming `pnpm music`. `--no-music`: the same cut
    on a fixed 0.6 s grid (bar 2.4 s), game sound only. CC BY requires
    the credit wherever the video is posted, so a manifest track's
    `credit` is in the output, the `--json` result and the caption; a
    track without one prints "no credit known for <file>".
  - Beats (`src/week/beats.ts`, pure, no dependencies): FFmpeg decodes
    the track to mono 22.05 kHz PCM; the onset envelope is log-energy
    flux in an 11.6 ms trailing window every 2.9 ms, the low band
    (two 150 Hz biquads, the kick) weighted 0.6 and the full band 0.4.
    Tempo: with the manifest's BPM as prior, the best fold of the
    envelope onto the beat period within ±1.5 % of it (so half and
    double time cannot happen); without one, the strongest
    autocorrelation lag in 80–190 BPM, then the same ±1.5 % fit.
    Phase: the fold's peak. Bar phase: of the four beats, the one with
    the most low-band onset. Start: the bar line opening the loudest
    stretch of the needed bars (a bonus for a jump in loudness into
    it: the drop), never so late that the track ends first; a track
    too short even from its first bar loops its whole bars from the
    first downbeat; one with fewer than 8 whole bars after its first
    downbeat is refused (exit 1), not looped. Drift: the
    first and last 16 beats of the used section are folded alone (peak
    looked for within ±60 ms of the grid, so a breakdown with off-beat
    hats does not read as a half-beat error); over 10 ms off at either
    end, the tempo and phase are refitted on the used section, and the
    refit is kept only when both ends show a clear peak with both
    grids, the worse end improves and neither end gets worse past
    10 ms, and only when the refitted section still ends inside the
    track (a slower refit lengthens the same bars); otherwise the
    whole-file grid stays (a refit on the sparse
    intro of Smash It measured -41 ms against FFmpeg's low band, the
    whole-file grid -17 ms).
    Cached as `music/<file>.beats.json`, keyed by the file's size and
    mtime, the prior and `ANALYSIS_VERSION`; a cache with a matching key
    but unsound contents (a BPM outside 40–240, a non-finite phase, a
    bar phase outside 0–3, arrays of the wrong length) is a miss and
    analysed again. `--dry-run` analyses in memory and writes nothing,
    not even the cache.
  - Sound: each shot's game audio at full level with 20 ms fades at
    both ends (no clicks at cuts), silent under the card and the
    closing fade; the music at `montage.musicGainDb` (-7, up front),
    ducked lightly by the game audio (`sidechaincompress`
    threshold 0.1, ratio 2.5, 5/250 ms), then the limiter (-1 dB).
  - Picture: each shot at the first clip's size and rate (letterboxed,
    never cropped). Each shot is cut to a lossless intermediate (x264
    `-qp 0`, PCM, NUT for exact time bases) in a temp dir, joined by
    the concat demuxer with each part's duration stated, then one
    encode: x264 slow CRF 18, AAC 192k, `+faststart`. Not one
    `filter_complex`: 25–40 shots would be 25–40 open HEVC decoders
    (8 held 2.1 GB in the long version), and per-shot input seeking
    decodes seconds, not whole clips.
  - The share-file contract: temp path, validate (decodes, one video
    and one audio stream, h264, length within 0.25 s of the plan),
    rename; the key (clip ids with their files' size and time, in play
    order, the shot rules, the cap, the track's size and time, the BPM,
    phase and start offset used, the gain, the recipe) sits in the
    file's comment tag, so an unchanged week is reused and a changed
    one remade; never written to `index.json`. `--dry-run` and
    `--json` print the plan: track, BPM, start offset in the track,
    grid unit, and per shot the clip number, in/out in the clip, cut
    in/out in the video, its anchor and its kills.
- outputs `library/clips/<id>.mp4` + `library/index.json`.
- share copies (decided 2026-11-10): library clips are H.265, which
  Discord, many browsers and phones do not play inline, and often
  larger than chat upload limits. `pnpm share <no> [--max-mb <n>]`
  writes `library/share/<no>-<slug>.mp4`: H.264 (libx264), AAC,
  yuv420p, `+faststart`, never over the limit (`config.json` →
  `share.maxMegabytes`, default 20, Discord's free upload limit; MB is
  1024² bytes; aimed at 94 % of it). Quality first: a constant-quality
  encode (CRF 20) at the source size and rate is kept when it fits
  (`-fs` stops it at the limit, so a miss costs little); otherwise a
  two-pass encode at the computed bitrate on a ladder, 1080p60 →
  720p60 → 720p30 → 480p30, each rung used only above its floor
  (5000 / 2500 / 1400 / 500 kbps video), never upscaled. Below the
  bottom floor the clip is refused, naming a limit that would work.
  Same contract as every stage: temp path, validate (decodes, h264,
  audio when the source has it, duration within 0.5 s, under the
  limit), rename. The file carries its own key (clip id, source size
  and time, limit, recipe) in its metadata, so a valid one is reused;
  share files are derived output found by name, never written to
  `index.json`, and the source clip is only read. A one-line caption
  comes with it (`3k Deagle clutch · Cache · round 12 #CS2`; reels:
  `Cache · all 9 deaths from the killer's view #CS2`).
- vertical copies (decided 2026-11-10): Reels, TikTok and Shorts want
  9:16. `pnpm vertical <no> [--shift <percent>]` writes
  `library/vertical/<no>-<slug>.mp4` (the share file's name): the
  centre 9:16 column of the source at full height (from the probed
  size, even numbers: 1920x1080 → `crop=608:1080` at x=656), scaled
  with lanczos to `config.json` → `vertical` (`width` 1080, `height`
  1920). The crosshair is the frame's centre, so the action stays in
  view; the radar and the kill feed fall outside, which is intended.
  No blurred side bars, no letterboxing. `--shift` moves the column by
  that percent of the source width (negative left), clamped to the
  frame; the only framing control. A source already narrower than 9:16
  is refused. Encode: H.264 (libx264) `-preset slow`, CRF
  `vertical.crf` (18), yuv420p, the source frame rate, AAC 128 kbps,
  `+faststart`; no size limit and no ladder, since these apps
  re-encode on upload. Same contract as share: temp path, validate
  (decodes, h264, exactly the configured size, audio when the source
  has it, duration within 0.5 s), rename; the key (clip id, source size
  and time, crop, output size, CRF, recipe) sits in the file's own
  metadata, so a valid one is reused and any other is made again under
  the same name: one vertical file per clip, the last crop asked for
  wins. Never written to `index.json`; the source only read. Prints
  share's caption.
- cuts (decided 2026-11-10): a clip often runs longer than the moment
  worth sending. `pnpm cut <no> <from> <to>` (seconds as the clip
  plays, `4.5` or `0:04.5`) writes
  `library/cuts/<no>-<slug>_<from>-<to>.mp4`, the times in tenths
  without a dot (4.5 s to 18.2 s is `_0045-0182`), so several cuts of
  one clip sit side by side; two that differ by less than a tenth
  share the name and the later replaces the earlier. The library clip
  is never changed: a cut is derived output like a share file, never
  written to `index.json`, the source only read. Refused (exit 2):
  from below 0, to more than 0.05 s past the end (inside that, clamped
  to the end: a player's last frame), a cut under 1 s, and the whole
  clip (within 0.1 s at both ends: nothing to cut). Frame-accurate, so
  decoded and re-encoded, never a keyframe-snapped stream copy: an
  input seek (`-ss` before `-i`, which decodes from the keyframe
  before and drops what precedes `from`) and `-t`; H.264 (libx264)
  `-preset slow`, CRF `config.json` → `cut.crf` (18), yuv420p, the
  source size and rate, AAC 192 kbps, `+faststart`, with the library
  clips' fade in and out (`render.fadeSeconds`, at most a quarter of
  the cut) on picture and sound. The sound stays raw, as the master
  has it; `pnpm share` evens it. Same contract as share: temp path,
  validate (decodes, h264, the source size and rate, audio when the
  source has it, duration within 0.1 s of to − from), rename; the key
  (clip id, source size and time, from and to to the millisecond, the
  fade, CRF, recipe) sits in the file's comment tag, so the same cut
  is reused. Prints the path, size, length and share's caption.
- even sound (decided 2026-11-10): an AWP crack sits 30-40 dB over the
  footsteps between shots, so a clip turned up to hear the footsteps
  blasts at the shot. One pure function (`src/post/audio.ts`) builds
  the chain from `config.json` → `audio`: a fast compressor with
  make-up gain, then a lookahead peak limiter whose ceiling leaves room
  for the AAC encode's overshoot; one pass, no two-pass `loudnorm` (a
  measuring pass per clip buys nothing on 30 s of gunfire). Share
  copies are even by default (`share.audio`, `--raw-audio` for one
  run), the audio filter part of the share file's key. Library masters
  default to raw (`post.audio`): a master is never re-rendered and its
  capture is deleted after publish, so a sound baked into it cannot be
  taken back, while a share copy can always be made again. `"even"`
  runs the chain in the final encode's single pass, after the
  fast-forward concat (muted stretches stay silent) and before the
  fades; the entry records `render.audio` (absent on older clips). The
  setting is outside the render key, so changing it never makes a
  finished clip look undone.

### 7. Library

`library/index.html` is generated with the clip index inlined, so it
works opened straight from disk (a `fetch` of `index.json` over
`file://` does not). Layout decided by Peder 2026-10-15: a left
sidebar with categories (kind: highlight, deaths, kills; map; match by
date) and the sort; a main area where the selected clip's player fills
most of the viewport; a compact list of the clips in the current
category to pick from, with number, title, score and length. Keyboard
next/previous. A "newest" sort stays available at the top.
Deleting while watching (decided 2026-10-15): `pnpm library` starts a
minimal local server (Node, localhost only, no accounts) that serves
the same page and accepts the page's delete action; opened straight
from disk the page shows the equivalent `pnpm drop <no>` command
instead (pnpm's own `rm` removes a dependency). Delete moves the file to `library/trash/`, removes the index
entry, and marks the moment as deleted in the ledger so no run renders
it again; `pnpm trash --empty` frees the disk. No framework.
Sharing follows the same two modes (decided 2026-11-10): served, a
Share button (in the Share / Vertical / Trim group, below) asks the server to make the share file
(§6) in a child process, so the server keeps serving while it
encodes and a second click joins the running encode; the page then
shows the file name and size, "Copy caption" and "Show in folder"
(Explorer with the file selected). Opened from disk the button shows the
`pnpm share <no>` command and the caption to copy (with a fallback
where the async clipboard API is unavailable). The share and reveal
routes sit behind the same Host and Origin checks as delete and take
a clip number only, never a path.
Stars and filters (decided 2026-11-10): Peder stars favourite clips;
the stars live in `library/stars.json` (`{ version: 1, stars: [<no>] }`,
temp then rename), never in `index.json`, so starring cannot collide
with a clip run's index write. A missing or garbled file is no stars.
The same two modes: served, a star control on the playing clip and on
each list row, and the `s` key, toggle through `POST /star/<no>` /
`/unstar/<no>` (same Host and Origin checks, a clip number only); the
page updates in place, the server rewrites `index.html`, and on load
the served page asks the server for the current stars, since the
inlined list may be older. Opened from disk the page shows the
inlined stars and the `pnpm fav <no>` / `pnpm unfav <no>` command
(pnpm's own `star` and `unstar` star npm packages and take those
names). A deleted clip's star is ignored by the page and dropped at
the next write; numbers are never reused, so it can never mark
another clip. The sidebar gains "Starred", feats (Ace = 5 kills, 4k,
3k, Clutch = a clutch won) and the weapons of the moment's kills, each
with its count, most frequent first, six shown and the rest behind
"More"; a group with no clip is hidden. They are derived from what the
highlight's index entry already carries (`moment.kills`, `.clutch`,
`.weapons`), so the pipeline writes nothing new; reels and entries
without a moment match no feat or weapon. Every filter combines with
the others, Find and the sort; "Newest clips" clears them all.
Death map (decided 2026-11-10): `pnpm deathmap` writes
`library/deaths.html`, a second static page in the same visual
language with its data inlined (every `<` escaped), opened from disk,
showing per map where and how the POV player dies: each death at its
place, a line to where the killer stood, side by shape (CT circle, T
triangle) and weapon class by colour (rifle, sniper, SMG, pistol,
shotgun, other); filters for side, weapon class, from behind (the
scoring's facing rule and `facingMaxDegrees`), headshot, opening death
(first of his team that round) and match; a summary recomputed per
filter (deaths, per round played, shares from behind and headshot,
average distance, top weapons, and killer and death positions
clustered into spots); a death links to its take in the demo's deaths
reel as `index.html#clip=<no>&t=<seconds>`. Knife rounds are out and
warmup is never a match round, as in scoring; overtime counts (a death
there is still a death). Suicide, world and team deaths are counted
apart and left off the killer analysis. There is no radar art: Valve's
overview images are game assets this repo neither ships nor downloads
(no network at build or view time), and each needs its own per-map
scale and origin; the map's shape is drawn instead from the parse's
footprint (every 32-unit cell a live player stood in, sampled every
half second, plus every death's two positions). Those fields are
optional within parse schema 8, not a schema bump: on 2026-11-10 only
21 of the 80 registered demos were still in `demos/store/`, and a bump
would have made the other 59 caches stale for good, so `pnpm rescore`
would skip their clips. A cache without positions is re-parsed once
when its demo is still there, else counted and left as it is; the
page says per map how many matches have positions. One floor plane:
multi-level maps (Nuke, Vertigo) overlap.
Trim, vertical, the death map and deep links (decided 2026-11-10):
Share, Vertical and Trim sit in one joined group in the action row, so
the row stays one line served at 1366x768; what they make shows on
one line under the title (file name, size, length, "Show in folder").
Served, Vertical runs `pnpm vertical <no>` through `POST
/vertical/<no>` as Share does. Trim opens a bar under the player: the
clip's timeline with an in and an out handle (drag, or the track
moves the nearer one; arrow keys nudge the focused handle a frame,
shift a second; `i` and `o` set them at the playing position), kept at
least 1 s apart, the length shown, playback looping inside the
selection while the bar is open, and the picture following a dragged
handle. Save cut sends `POST /cut/<no>` with `{ from, to }` (two
numbers, checked as the CLI checks them before anything runs; one
encode per cut at a time, a second identical request joins it).
Reveal takes which file by kind (`/reveal/<no>`, `/vertical`, or
`/cut/<name>` with a name `pnpm cut` would give that clip), never a
path. Opened from disk, Share and Vertical show their commands and
the bar shows `pnpm cut <no> <from> <to>` with Copy. While the bar
has focus or a handle is dragged, the page's keys (next/previous,
`s`, Delete) stay off; Escape closes it, and so does another clip.
The sidebar links "Death map" (`deaths.html`) when the page data says
there is one (`hasDeathMap`). `#clip=<no>[&t=<seconds>]` on load and on
`hashchange` clears the filters, selects that clip and seeks to `t`
once its metadata is in (clamped to its length), never starting
playback, so sound still waits for a gesture; an unknown number
changes nothing. The parser is `src/library/hash.ts`, whose source
`page.ts` inlines.

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
croclipper/
  src/ingest/   watch folder, sources/ (folders, faceit, valve + valve-fetch)
  src/parse/    demoparser2 wrapper, identity + time mapping, events
  src/score/    round context, clusters, scoring.json
  src/clip/     clip spec generation
  src/render/   controller/ (state machine, cfg generation), capture/hlae (the OBS fallback is not built)
  src/post/     ffmpeg trim, fades, reel overlays, the even-sound chain
  src/library/  index writer, static page template, stars, filters, the match-date rule
  src/share/    derived copies of a clip: share, vertical, cut
  src/week/     best of the week (the fragmovie: selection, shots, beats, music)
  music.json    the default tracks for pnpm week (url, sha256, BPM, licence, credit)
  music/        the downloaded tracks and their beat caches (gitignored)
  src/deathmap/ the death map page
  demos/inbox/  you drop demos here
  state/        per-demo parse + moments (gitignored)
  library/      output mp4s + index, and the derived folders share/, vertical/, cuts/, montage/ (gitignored)
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
   file finalized and playable, no xray, and no demo UI in the frame
   (no playback panel, no spectator controls, no console; the normal
   game HUD stays), with your crosshair and viewmodel from the main
   account's config. Then: a second, different interval in
   a fresh launch; a restart and repeat; one job interrupted mid-way
   and recovered by the queue; and the behaviour when CS2 is already
   open. Confirm that parser ticks, `demo_gototick` and HLAE
   scheduling agree on the tick coordinate, including across a seek.
Dropped by Peder on 2026-10-14: a separate old-demo gate. Before the
drop, one five-month-old FACEIT demo (patch 14160 on client 14190)
replayed, seeked and recorded through the M0.2 path with TrueView
forced on (`cl_demo_predict 2`); see `docs/spikes.md`. Older demos and
demos from before a map change are untested, and old demos are out of
scope for now.

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

**Deaths reel** (decided 2026-10-15, after M4a). One clip per demo
showing every death of Peder from the killer's first person: 7 s
before the kill to 4 s after (10 s cut to 7 by Peder, 2026-10-15), each take spectating the killer's slot
with the same HUD, crosshair and TrueView rules, a small overlay per
death (round, weapon, killer), concatenated with short fades into one
library clip with its own number. All takes in one launch.

**Victims reel** (decided 2026-10-15, after the deaths reel). The
mirror image: one clip per demo showing every kill of Peder's from
the victim's first person, 7 s before to 2 s after (only the death camera follows), same overlay and
concatenation. Takes overlap when kills are close, so the chained
controller must seek backwards between takes (a backward
`demo_gototick` rewinds and fast-forwards internally; slower, works).
After the victim's death the take shows what the game gives a dead
player, normally the death camera; that is accepted.

**M4. Sources and polish.** FACEIT auto-download, overlays, killfeed,
montage builder (built 2026-11-10, `pnpm week`; a fragmovie cut to music since 2026-11-11), OBS fallback, Valve GC download.

**M5. Sharing** (decided 2026-10-25). Other players run it on their
own Windows PC from the public repo (github.com/croahs/csclipper).
Still one player per install, no accounts, no service. Nobody needs
Claude, Claude for Chrome or any AI tool: the FACEIT browser path is
Playwright driving the user's own Chrome or Edge profile.

Decisions:

- The alt-account rule stays for everyone: `RENDER_STEAM_ID64` must be
  a second Steam account, logged in while clips render. A free account
  with CS2 added is enough. The ban guard is not softened for strangers.
- The folders source is the documented way to get FACEIT demos: click
  "Watch demo" in the FACEIT client or the match room, the file lands
  in CS2's `game/csgo/` or in Downloads, `pnpm grab` copies it into the
  inbox and `pnpm go` makes the clips.
  No key, no browser profile, no extra install. The automated browser
  path is retired as the hands-off way: since 2026-10-24 FACEIT runs a
  Cloudflare Turnstile check behind "Watch demo" that fails in the
  Playwright-driven browser (diagnosed 2026-10-25, `docs/faceit-api.md`),
  and nothing here answers a bot check. The code stays, stops within
  30 s of the click as blocked and prints the room link; it comes back on
  its own if FACEIT drops the check.
- v1 distribution is `git clone`, `pnpm install`, `pnpm prep`. A
  one-line PowerShell bootstrap (winget Node, corepack pnpm, clone) comes
  after two or three people have gone through v1. No installer, no
  bundled exe at this scale.

Phases:

1. **Runnable by someone else.** `pnpm prep`: finds Steam and CS2 from
   the registry and `libraryfolders.vdf`, downloads the pinned HLAE and
   FFmpeg zips with sha256 checks into `tools/`, writes HLAE's
   `ffmpeg.ini` to the pinned FFmpeg when there is none, fills `.env`
   (prompts for the two SteamIDs, never overwrites a value that is
   set). Post falls back to the pinned FFmpeg when PATH has none.
   `pnpm check` (= `pnpm prep --check`; pnpm's own `setup` and `doctor` take those names) writes nothing and reports
   every requirement, including the logged-in Steam account and whether
   the POV account's CS2 convars exist on this machine; its output is
   what goes into an issue. A README for humans, MIT license, issue
   template, and "you" / "the player" instead of Peder in user-facing
   text. Verified on a machine that is not this one. The setup command
   touches tool paths that the launch uses, so Sol reviews it.
2. **FACEIT for others.** Done 2026-10-25 for the diagnosis: the path
   is blocked by a bot check, not a locator, and is retired (above).
   The library page dates a demo without a FACEIT date by the day it was
   added, labelled "added", so the key is never needed (2026-10-25).
3. **Easy tier.** Done 2026-10-25, ahead of v1 feedback by Peder's
   call: `setup.ps1` (one `irm … | iex` line: winget installs git and
   Node LTS when missing, pnpm comes through Node's corepack or pnpm's
   own installer; without winget it prints the official download pages
   and stops before installing anything; clone, or fast-forward pull of
   a folder whose origin is this repo, into `~\csclipper`; `pnpm
   install`; `pnpm prep`; every exit code checked) and `GUIDE.md`, the
   friendly walkthrough
   with an official link for everything the script does not download:
   the second Steam account, the SteamID64 lookup, the three tools. No
   GUI: the terminal line plus two questions is the setup.

**M6. Matchmaking demos through CS2, no login** (planned 2026-10-25).
The QR login of the render account (M4's Valve GC download) is the one
barrier left for someone else: it needs the second account in the
Steam mobile app and a terminal command, and Peder's rule for sharing
is that no password is ever handled and the only terminal a user sees
is the setup line. Steam has no SSO that yields a Game Coordinator
session, so the way around is the Steam client that is already logged
in: `pnpm grab` launches CS2 itself with `+csgo_download_match` for the
pending share codes, waits for the files in `game/csgo/replays/`, and
closes the game it started, under the same guards, lock and kill
machinery as a render launch. The three Web API values stay (the render
account cannot see the main account's matches) and are entered through
a double-click file. Gate first (M0.4: does the launch line download
in today's CS2, with `-insecure`, how long, what the console says, is
the kill clean); a failed gate ends M6 and the guide's MM section goes.
The execution plan with agents, files, tests and done-criteria per
phase is `docs/m6-mm-fetch.md`.

Done 2026-10-25. Gate M0.4 passed the same day (`docs/spikes.md`): the
launch line downloads a match in 25-30 s with `-insecure` (and never
ran without it), the file name carries the share code's outcome id, the
`.dem.info` carries the match id, `console.log` names the account, and
the owned-tree cleanup verified in all nine launches. Two findings shaped
the code: the game plays a downloaded demo at once, so it is one launch
per match until a multi-code launch is measured; and a download killed
between the `.dem.info` and the `.dem` leaves an orphan `.info` that
blocks that match until it is removed, which the fetcher now does before
each launch. The QR login, `valve-gc.ts` and the four Steam packages are
gone; the three Web API values are entered through `Set up
matchmaking.cmd`. Still open: a three-code launch, and an end-to-end
`pnpm grab` on a new match (phase 5, the next time Peder plays).

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

None. The three this plan started with are settled: the sources are
both (Valve MM through the fetch launch, FACEIT through the folder scan;
M5 and M6), the SteamID64 lives in `.env` as `STEAM_ID64`, and the repo
is github.com/croahs/csclipper.
