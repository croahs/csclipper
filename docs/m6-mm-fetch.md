# M6: Valve matchmaking demos fetched through CS2, no login

The execution plan for PLAN.md milestone M6. A fresh session works from
this file: read `AGENTS.md`, PLAN.md's M5 and M6 entries, then this, in
that order. Every phase names who does it (per
`~/.claude/01-model-map.md`), what done looks like, and who reviews.
Phases run in order unless marked parallel. Nothing in a later phase is
built on a gate that has not passed.

## Why

Today the Valve source (`src/ingest/sources/valve.ts`) finds new
matchmaking share codes through the Steam Web API (main account's key
and match-history auth code) and resolves each code to a replay URL
through a headless Steam login of the render account
(`src/ingest/sources/valve-gc.ts`: a QR code scanned once in the
render account's Steam mobile app, refresh token in
`state/sources/valve-session.json`). The QR scan is the barrier: it
needs the second account inside the phone app and a terminal command
(`pnpm grab --steam-login`). Peder's rules for sharing (PLAN.md M5):
no passwords handled or stored, ever; the only terminal a user sees is
the setup line; everything else is a double-click file.

The way around: the Steam desktop client is already logged in with the
render account while clips render. CS2 itself downloads a match from a
share code (`csgo_download_match <code>`, what the Watch tab does) into
`game/csgo/replays/`, which `pnpm grab`'s folders source already
watches. So `pnpm grab` launches CS2 as its own child with the pending
codes, waits for the files, closes the game it started, and ingest does
the rest. No login, no token, no phone. The three Web API values stay:
the render account in CS2 cannot see the main account's matches, so
listing new matches still goes through the main account's key.

## Decisions (fixed unless a gate overturns them)

- One mechanism, not two: when the fetch launch works, `valve-gc.ts`,
  `pnpm grab --steam-login`, `state/sources/valve-session.json` and the
  packages `steam-session`, `steam-user`, `globaloffensive`,
  `qrcode-terminal` go. `globaloffensive-sharecode` stays (decoding a
  share code to match id and reservation id gives the replay file stem).
- The fetch launch is a launch like a render launch: same guards
  (`guard(ids)` in `src/render/controller/guards.ts`: render account
  logged in, never the main account, no cs2.exe or HLAE.exe running),
  same lock (`state/.render.lock`), same ownership and kill machinery
  (`src/render/controller/processes.ts`: `OwnedTree`, `killExact`,
  `snapshot`), same fail-closed cleanup (exit 3 when a game process may
  be left). No HLAE: cs2.exe is spawned directly. `-insecure` is always
  passed (Astra, phase 0: it is the one barrier against a secure server
  that does not depend on what a hand on the window does). If gate M0.4
  finds that the download works only without it, M6 pauses and Peder
  decides whether the rule in AGENTS.md gets a named exception (a fetch
  launch joins no server and loads no HLAE, so it has no ban mechanism
  of its own); the gate never applies that exception by itself.
- Budget: one fetch launch per pending code (the gate: the game plays a
  downloaded demo at once, and a multi-code launch is unmeasured), at
  most `sources.valve.maxMatchesPerRun` (default 5) per `pnpm grab` run,
  next to the one render launch per demo. Written into AGENTS.md's
  standing order in phase 4.
- No terminal for the user: the three `.env` values are entered through
  a double-click file (`Set up matchmaking.cmd` running `pnpm prep
  --valve`), which prints the two web pages to get them from.
- The checkpoint (`state/sources/valve.json` → `lastShareCode`)
  advances only over codes whose demo is complete (header and
  `DEM_FileInfo`, see the contract) and copied into the inbox, or that
  are gone: a console line the gate has proven to mean Valve no longer
  has the match, attributable to that code, or 30 days pending (Valve
  keeps demos about that long).

## Phase 0: the fetch-launch contract (main session, then GPT-6 Astra)

**Who:** the main session (Fable or Opus) writes it; GPT-6 Astra reads
it as the second strong voice from another family (model map rule 4:
a change that is hard to undo). One round; findings folded in before
phase 1.

**Write** a short section into this file, "Contract", covering:

- Spawn: `cs2.exe` directly (`ids.cs2Exe` from `.env`), arguments
  `-novid`, `-condebug` (so `game/csgo/console.log` is this launch's
  evidence, as the controller uses it), a window size and `-windowed`
  so it never goes fullscreen, `-insecure` per the gate, then
  `+csgo_download_match <code>` once per pending code. Check in
  `src/render/capture/hlae.ts` how the controller passes CS2 arguments
  and in `src/render/controller/index.ts` lines 200-260 how it spawns,
  identifies the owned tree and reads `console.log`.
- Evidence of progress: the `replays/match730_<stem>_<tv>.dem` file per
  code (stem = `<matchId>_<reservationId>` from the decoded share code;
  `valve.ts` already has `replayStem` and `DEMO_STEM` for the GC form),
  plus whatever `console.log` prints (gate finds out).
- Completion: a file counts as done when its size has not changed for
  10 s and it starts with `PBDEMS2` (ingest's check), or when the game
  reports the download failed; a code whose file never appears within
  a per-code timeout is reported pending, not failed, unless the console
  says the match is gone.
- Exit: kill the owned tree once every code is done or timed out
  (`killExact` through the handle, re-discover, verify no cs2.exe is
  left, else exit 3 and the lock stays, exactly as `render()` does).
- Safety: the launch is refused on anything `guard()` refuses; the
  render lock is held from before the spawn until cleanup is verified;
  the game must never be told to connect anywhere (no `+connect`, no
  `+map`); the whole thing is skipped on `--dry-run` with the codes
  listed.
- Interaction with `pnpm go`: a fetch launch and a render launch never
  overlap (both take `.render.lock`); `pnpm go` after `pnpm grab`
  ingests `replays/` through the folders source as today.

**Astra's brief:** the contract above with `guards.ts`, `processes.ts`,
`index.ts` (the controller) and `hlae.ts` inlined; the question is
what could get an account banned, leave a game running, or download
the wrong thing, and whether the process-ownership model holds when
Steam, not us, may respawn cs2.exe through the client. Astra runs
through the Codex worker on the Sol lane's rules: inline everything,
no commands (the exec policy kills runs that shell out).

**Done:** the contract section exists, Astra's findings are folded in or
answered in the section, no open blocker.

## Contract: the fetch launch (phase 0, 2026-10-25, Astra's review and the gate folded in)

What `pnpm grab` does to get a matchmaking demo, as the code will do it.
GPT-6 Astra reviewed the first draft (14 findings, 4 blockers); every
finding is folded in below or answered under "Astra's findings". Gate
M0.4 (`docs/spikes.md`, eight launches on this PC the same day) checked
every fact that was marked *gate*; the marks stay as the record of what
was checked, and "What the gate changed" at the end lists the three
rules it added.

**Spawn.** `ids.cs2Exe` directly, as `pnpm grab`'s own child, no HLAE:
`spawn(cs2Exe, args, { env, stdio: "ignore", windowsHide: true })` where
`env` is built from `process.env` with every key equal to `USRLOCALCSGO`
(any casing; Windows env keys are case-insensitive) removed: the game must
write to its normal `replays/`, and the render account's own user config is
the Watch tab's normal case. The argument list, in this order:

```
-insecure -novid -sw -width 1280 -height 720 -condebug
+echo croclip_fetch_<stamp> +csgo_download_match <code> [+csgo_download_match <code> …]
```

`-insecure` is always passed: it is the one barrier that keeps the game
from a secure server whatever a hand on the window does, and a fetch launch
has no reason to be secure-capable. The gate settled the other direction:
without `-insecure` the game schedules the command but never runs it (no
`Executing deferred download match` in 178 s, runs 6 and 6b), so the
exception the plan held open is moot. `-sw` keeps it a window (the controller uses the same
flag). `-condebug` makes `game/csgo/console.log` this launch's evidence: CS2
truncates it per launch (one `[CommandLine] command line arguments:` line
per file, checked 2026-10-25) and echoes the whole argument list in that
line, so `croclip_fetch_<stamp>` (stamp = spawn time in ms) proves the log
is ours, the way `+exec croclip_<stamp>` does for a render; the log counts
only when its mtime is after the spawn and it holds the marker. The
`[CommandLine]` line is also how the gate checks the *surviving* game's
arguments (finding 1), together with `Win32_Process.CommandLine` in the
snapshots. `+` commands are logged as `[CommandLine] DELAYED COMMAND: …`
lines, one per code, in order; that proves scheduling, not execution.
Every `<code>` is checked against `SHARE_CODE` (`^CSGO(-[A-Za-z0-9]{5}){5}$`)
before it goes on the command line: a share code is the only thing the
launch ever hands the game console, and it comes from the Steam Web API,
never from user input. No `+connect`, no `+map`, no `+playdemo`, no `+exec`,
nothing that joins a server. The user is told not to touch the window, as
with a render.

**Identity.** `guard(ids)` reads the Steam client's active account from the
registry at check time; it binds nothing. It runs before the lock work and
again immediately before the spawn, and the race between that read and the
game's own logon stays (as it does for a render). *Gate:* whether
`console.log` names the account the game logs on as. It does, on every
launch, 3-12 s in: `[SteamNetSockets] AuthStatus (steamid:<SteamID64>):
OK`; the fetcher reads it and kills the launch when it is not
`RENDER_STEAM_ID64`, and the controller can do the same. `-insecure` stays the independent barrier either way.

**Files and names.** The Watch tab writes two files per match into
`game/csgo/replays/`: `match730_<A>_<B>_<C>.dem` and
`match730_<A>_<B>_<C>.dem.info`. `<A>` is the share code's `outcomeId`
padded to 21 digits: checked on this PC against the GC path's own file for
the one code in the history (`valve-003850170963031228525_0309642818.dem.bz2`
for a code decoding to `outcomeId 3850170963031228525`), and the two
Watch-tab `.info` files decode (`CDataGCCStrike15_v2_MatchInfo`) to a field 1
`matchid` smaller than their `<A>`, consistent with `<A>` being the outcome
(reservation) id, not the match id. `<B>` and `<C>` are `watchablematchinfo`
fields 2 and 1 and are not in the share code, so the file name cannot be
computed in full. *Gate:* `<A>` equals `outcomeId` for a real code's
Watch-tab file too. Ids are kept as decimal strings end to end (they exceed
`Number`'s safe range); nothing converts them. A code's candidate file is
found by parsing, not substring: `^match730_(\d{21})_\d+_\d+\.dem$` with
group 1 equal to the padded `outcomeId`; the stored-demo check in `grab.ts`
parses both forms, `match730_(\d{21})_` and `valve-(\d{21})_`, and compares
group 1. `replayStem` and `DEMO_STEM` go with the GC path.

**Completion.** A code is `done` when all of this holds for its candidate:
the `.dem` appeared or changed after the spawn (a file that was already
there with the same size and mtime at spawn is never done on its own, only
when the game rewrote it); its `.dem.info` is present and decodes with
field 1 equal to the code's `matchId` as a string; the `.dem` begins with
`PBDEMS2\0` and `readFileInfo` (`src/parse/fileinfo.ts`) returns a
`DEM_FileInfo` frame at the offset the header names (the fileinfo sits at
the end of the file and is written when the demo is finalized, so a
cut-short transfer, a stalled one or a half-decompressed file fails this
check; the folders source and ingest get the same check, below); and size
and mtime have not changed for 10 s after that. The console's own sequence is the second
signal, never the only one: `Executing deferred download match: <code>`
→ `MatchInfo Download prepared replays/<name>.dem.info...` →
`Match is downloaded and can be watched immediately...`, and then the
game plays the demo (`Host activate: Playing Demo (replays/<name>.dem)`). *Gate:* whether a `.dem.bz2` or other temporary name
appears first (then the `.dem` is published whole after decompression) or
the `.dem` grows in place; both are handled by the rule above.

A code is `gone` only in two cases: the console prints
`Full match info indicates that the match has expired!` after
`Executing deferred download match: <code>` and no file appears (the
line does not name the code; with one code per launch it needs no
attribution; the gate saw it only for a public 2018 code, so the 30-day
rule below is the backstop if it ever means something else), or the code was first seen pending more than 30 days
ago (`state/sources/valve.json` → `pending[code].firstSeenAt`; Valve keeps
demos about that long, so after that the demo is gone whatever the reason).
Everything else that is not done is `pending`, including a line the gate
could not classify or attribute; pending blocks the checkpoint, and the
30-day rule is what unblocks it.

**One code per launch.** The game plays the demo as soon as it is
downloaded (that is what the Watch tab's button does), and whether it
would still run a second `+csgo_download_match` while playing is not
measured (the gate had one code). So each pending code gets its own
launch, in order, inside the same `pnpm grab` run, each under the full
guard, lock, kill and quiet-period cycle (about 85 s per code: the
deferred command runs 8-28 s after spawn, the file is complete 15 s
later, 10 s settle, kill, 10 s quiet, 30 s watch). A code's state:
queued → downloading when its `.info` or `.dem` appears → done / gone /
pending. A launch ends when its code is done or gone, or when nothing
under `replays/` has changed for `idleS` (default 180 s); then the code
is pending, the run stops there, and the remaining codes wait for the
next run. Hard cap per launch: 300 s. A measured multi-code launch
(three codes, PLAN.md question 3) may later collapse this back to one
launch per run.

**Handing the file over.** The fetcher copies a done `.dem` into
`demos/inbox/` itself, the way the folders source does (copy under a `.part`
name, re-stat the original, rename; the folders source's 2 GiB limit
applies, a larger file is `failed` with the reason), and only then counts
the code as done for the checkpoint. The folders source still scans
`replays/` by default and finds the same demo "in store" by content hash on
its next pass; a custom `sources.folders.dirs` that leaves `replays/` out
changes nothing about fetching. Done means in the inbox, not ingested;
ingest runs at the end of the same `pnpm grab`.

**Incomplete files.** The completeness check above (`PBDEMS2\0` header and
a valid `DEM_FileInfo` at the header's offset) moves into one function used
by the fetcher, the folders source (a `.dem` that fails it is `pending`
"incomplete or still being written", never copied, never remembered as
handled) and ingest (rejected as "incomplete demo"). That is what keeps a
download the game left half-written out of the store, whoever left it:
this fetcher's kill, a crash, or a human closing CS2 mid-download. No
exclusion list, nothing persisted about leftovers. *Gate* (7) found the
one leftover there is: the game writes `<name>.dem.info` first and the
`.dem` whole about 15 s later (no partial `.dem`, no temporary name), and
a kill in between leaves the `.info` alone, and with it present the next
two launches printed `Download container is corrupt!` right after the
deferred command and downloaded nothing (runs 5 and 5b, 60 s and 170 s);
after the operator moved the `.info` out, the next launch downloaded
normally (run 5c). The fetcher logs that line when it sees it; the
pre-launch repair below is what prevents it. So before requesting a
code the fetcher looks for `match730_<padded outcomeId>_*.dem.info` with
no complete `.dem` beside it and whose field 1 is the code's `matchId`,
and deletes that one file. This is the single write under `game/` the
fetcher makes: to a file its own kind of launch produced, identified by
name and content, and without which the user's match is lost for good
with no visible reason.

**Exit.** In a normal end (every code settled, or idle, or the hard cap)
the owned tree is killed: `killExact` by handle (identity re-checked under
an open handle), re-discovery, and any owned process found running during
verification goes back into the kill rounds (today's `cleanup()` only waits
for such a process; this is the one behaviour change to the shared code,
and the controller gets it too when the code is shared in phase 2, flagged
for Sol). Verification then requires a quiet period: no owned process, no
suspect orphan and no `cs2.exe` at all, continuously for 10 s after the
first empty snapshot, lock held throughout (`guard()` proved no `cs2.exe`
was running at launch, so any `cs2.exe` is unexplained). Verified → the
lock is released; not verified → exit 3, the lock stays, the message names
what is left. Emergency ends (a signal, an uncaught exception) run the same
cleanup at once, whatever is downloading; a kill mid-download is then
possible, and the completeness check is what makes it harmless. A
controller killed from outside (task manager, a closed terminal without a
signal) runs nothing: the game may stay up and the lock stays with a dead
pid; `RenderLock` refuses the next run until a human checks for `cs2.exe`
and removes the lock, as for a render. The game is never asked to `quit`
by a command scheduled in advance: nothing here runs a cfg.

**Ownership.** `OwnedTree(child.pid, "cs2.exe", spawnedAt)`: the root is
adopted only as `pnpm grab`'s own child with that image, created within the
spawn window; descendants as today. Two hand-off cases are possible if a
directly started game re-executes itself through the Steam client: the
first `cs2.exe` exits before it is ever seen (the tree never roots, and the
final "no `cs2.exe` at all" check fails cleanup), or it is seen, then exits
and a `cs2.exe` whose parent is `steam.exe` appears (the tree is rooted but
the game is outside it; `suspects()` does not cover a child of an unowned
parent). The fetcher adopts nothing it did not start: in both cases cleanup
is not verified, exit 3, and the gate is failed as written. *Gate:* the
spike logs every `cs2.exe` creation and exit it sees at 0.5 s polls (pid,
parent, creation time, `Win32_Process.CommandLine`) from before the spawn
to after verification, three runs, and in addition watches for 30 s after
verification for a delayed respawn. Three snapshots are not that evidence.

**Safety.** The launch is refused on anything `guard(ids)` refuses (not the
render account, the main account, a `cs2.exe` or `HLAE.exe` running).
`.render.lock` is taken before the guard and held until cleanup is
verified; it is released only by the fetcher, never by `grab.ts`: today
`grab.ts` releases `.render.lock` in its `finally` and on signals because
the GC path held it; that goes in phase 2, `grab.ts` releases `.grab.lock`
only. A lock held by someone else, or `.clip.lock` / `.go.lock` present,
makes the source `blocked` with every code `pending`, never a crash (as
`gcOpener` does today). An unverified cleanup is sticky: `pnpm grab` runs
no further source and no ingest after it, and exits 3 whatever else
happened (the controller's `cleanupUnverified()` latch is the model).
`--dry-run` lists the codes and launches nothing; so does a `todo` of zero
codes. Nothing is written under `game/` by us except the orphan-`.info` repair
above: the game writes its replays, we read them.

**Result.** `fetch(codes) → { code, outcome: "done" | "pending" | "gone" |
"failed", file?, reason? }[]` plus `cleanupVerified`. The Valve source
advances `lastShareCode` over done and gone codes in order and stops at the
first pending or failed one; `failed` is for the launch itself (spawn
error, cleanup not verified, an oversize demo) and sets `result.failed`.
Exit codes of `pnpm grab`: 1 on failed, 3 on cleanup not verified.

**Interaction with `pnpm go`.** A fetch launch and a render launch never
overlap: both hold `.render.lock`, and `guard()` refuses on a running
`cs2.exe` either way. One fetch launch per pending code, at most
`sources.valve.maxMatchesPerRun` (5) launches per `pnpm grab` run. *Gate* (6), as observable
checks: a new demo reaches the store exactly once (registry has one entry
for its hash); a demo already in the store is not copied again by the
folders source (its state says "in store"); a code whose demo is already
stored is not re-requested (the parsed-name check); an intermediate archive
left in `replays/` does not produce a second inbox copy.

**Astra's findings and where they went** (run 2026-10-25, `gpt-6-astra`,
high effort, read-only). 1 `-insecure` → always passed, the exception is
Peder's decision. 2 `grab.ts` releases `.render.lock` → fetcher-only
release, sticky exit 3, no further sources or ingest. 3 completion accepts
partials → `DEM_FileInfo` check plus "appeared or changed after the spawn".
4 folders ingests a leftover → the same completeness check in the folders
source and ingest, no exclusion list. 5 hand-off after rooting → both cases
named, nothing adopted, event log in the gate. 6 no quiet period, survivors
only waited for → 10 s continuous quiet, survivors re-killed, flagged as the
one controller behaviour change. 7 `gone` → console line proven and
attributable, or 30 days pending. 8 names and ids → parsed forms, strings
only, `.info` match on every done, GC-form pairing checked on this PC. 9
timers → per-code state, one idle rule, reconcile before kill. 10 and 11
checkpoint hand-off and gate 6 → the fetcher copies into the inbox itself,
gate 6 split into four checks. 12 `USRLOCALCSGO` → explicit env. 13
account binding → stated as a preflight, gate looks for the game's own
logon line. 14 question 7 missing, kill promise → question 7 added,
emergency ends described, forced termination described. No open blocker.

**What the gate changed** (M0.4, 2026-10-25, `docs/spikes.md`): one code
per launch, because the game plays the demo it downloaded; the orphan
`.info` repair, because that leftover blocks the match for good; the
exact gone line and the exact identity line. Everything else held as
written, `-insecure` included.

## Phase 1: gate M0.4, CS2 downloads a match from a share code (Opus writes, main session runs, Sol verifies)

**Who:** Opus writes `spikes/m0-4-cs2-download.ts` after the pattern of
`spikes/m0-2-capture.ts` (env from `.env`, refusals, owned-process
tracking, exit codes 0/1/2/3, `--dry-run`). The main session runs it on
this PC, since it needs CS2 closed and the render account logged in,
and writes the result into `docs/spikes.md` as "M0.4". GPT-6.1 Sol
verifies the write-up against the spike's output (PLAN.md, Who does
what: "verifying gate claims on this machine").

**Inputs:** a share code of a recent match of the main account. Get one
from `state/sources/valve.json` (`lastShareCode`, the last one handled)
or from the Steam Web API with the `.env` values the way `valve.ts`
does. Never print the auth code or the API key.

**The spike must answer, each with the exact command and output:**

1. Does `cs2.exe` launched directly with `+csgo_download_match <code>`
   download the demo? Where does the file land and what is it called
   (expected `game/csgo/replays/match730_<outcomeId>_<n>_<n>.dem` plus
   `.dem.info`; see the contract)?
   Is there a `.bz2` stage first?
2. Does it work with `-insecure`? Run both ways; record both.
3. How long from spawn to a complete file for one code, and for three
   codes in one launch? Does the game download them in sequence?
4. What does `console.log` print for a successful download, for a code
   whose demo Valve no longer has (use a code older than a month, from
   the Web API walk), and for a code of a match the render account
   never played (the main account's; this is the normal case)?
5. Does the owned-tree kill leave nothing behind, and does Steam
   respawn or re-attach anything after cs2.exe is killed? Three runs.
6. The four hand-over checks in the contract ("Interaction with
   `pnpm go`"): one registry entry per demo, "in store" for a stored
   one, no re-request of a stored code, no second copy from an archive.
7. Kill the game mid-transfer and, if there is one, mid-decompression
   (`--kill-after`): what is left in `replays/`, does the next launch
   with the same code overwrite, resume or refuse, and does the
   completeness check (`readFileInfo`) reject the leftover?
8. Process events: every `cs2.exe` seen from before the spawn to 30 s
   after verification, with pid, parent, creation time and command line.
   Does the surviving game carry our arguments (`-insecure` included)?
   Does anything re-execute through `steam.exe`? Does anything respawn
   late?
9. Does `console.log` name the account the game logs on as, and does
   anything in it per download say started / finished / failed, with the
   match or outcome id, so that a line can be attributed to a code?

Inputs on this PC (checked 2026-10-25): the share-code chain from
`STEAM_LAST_SHARE_CODE` holds exactly one code, the newest match, whose
demo the GC path already stored; the Steam Web API cannot walk backwards,
so older codes of the main account are not available here, and more codes
need Peder's Watch tab (main account, "copy share code"). For the gone
case a public CS:GO-era example code (`globaloffensive-sharecode`'s
README, 2018) is used; it is certainly gone, but it is not a main-account
match, so a line it produces is recorded, not yet trusted as the gone
line. Question 3's three-code launch needs more codes and is run when
they exist; the one-code timing is recorded now.

**Fail is a result.** If the download does not happen from the launch
line in today's CS2, the gate is written up as failed with what was
tried, M6 stops, and phase 4's fallback applies (the guide's MM section
goes, the QR path stays undocumented for Peder). No silent retry with
another approach (AGENTS.md).

**Done:** `docs/spikes.md` has the M0.4 section, pass or fail, with
versions (CS2 build from `steam.inf`, Node, OS), Sol has read it and
its findings are in.

## Phase 2: the fetch launch in the Valve source (Opus, Sol review)

Runs in parallel with phase 3 (different files). Only after the gate
passes.

**Who:** Opus implements; GPT-6.1 Sol reviews before it is called done
(touches game launch: always reviewed).

**Changes:**

- New `src/ingest/sources/valve-fetch.ts`: `fetchLauncher(ids)` →
  a `DemoFetcher` that, given share codes, runs one launch per code per
  the contract (orphan-`.info` repair first, then the launch, the
  identity line checked, the exact console lines, the completeness
  check, the copy into the inbox) and returns per code
  `done | pending | gone | failed` with the inbox path for done,
  stopping at the first pending or failed code. Reuses `guard`, `RenderLock`, `OwnedTree`,
  `killExact`, `snapshot`, `imageRunning`, and the `console.log`
  identification trick from the controller (a per-launch marker; the
  gate says what is available without a cfg, for example a unique
  window title or the `[CommandLine]` line). No code copied from
  `index.ts`: if a piece is needed in both, move it to
  `processes.ts` or a new `src/render/controller/launch.ts` and have
  both use it. The controller's behaviour must not change; its tests
  (`pnpm test`) and a `pnpm go --dry-run` prove that.
- `src/ingest/sources/valve.ts`: `GcOpener`/`GcSession` and the HTTP
  replay download go; `ValveOptions` takes the fetcher; step 2-3
  becomes "one fetch launch for every code in `todo`, then advance the
  checkpoint over done and gone codes in order, stop at the first
  pending or failed one". The fetcher copies each done demo into the
  inbox (the folders source's copy-rename pattern and size limit) before
  it counts as done. `replayStem` and `DEMO_STEM` go; the stored-demo
  check parses `match730_(\d{21})_` and `valve-(\d{21})_` and compares
  the padded `outcomeId` as a string. Pending codes get
  `pending[code].firstSeenAt` in the state; 30 days later they are gone.
  `NO_KEYS` no longer mentions `--steam-login`.
- Completeness: one function (header `PBDEMS2\0` plus a valid
  `DEM_FileInfo` at the header's offset, via `src/parse/fileinfo.ts`)
  used by the fetcher, by the folders source (an incomplete `.dem` is
  pending "incomplete or still being written", never copied, never
  remembered) and by ingest (rejected as "incomplete demo").
- `src/cli/grab.ts`: `--steam-login`, `gcOpener`, `steamLogin` go, and so
  does every release of `.render.lock` (the fetcher alone holds and
  releases it); a sticky "cleanup not verified" from the fetcher stops
  the source loop and ingest and exits 3. The header comment and
  `docs/modules.md` Running block lose `--steam-login`.
- Shared cleanup (`src/render/controller/launch.ts` or `processes.ts`):
  owned survivors found during verification go back into the kill
  rounds, and verification holds a 10 s continuous quiet period; the
  controller gets both when it uses the shared code. This is the one
  controller behaviour change in M6; Sol reviews it as such.
- Delete `src/ingest/sources/valve-gc.ts`, `src/ingest/sources/sharecode.d.ts`
  only if it typed something that is gone, remove the four packages
  from `package.json` (`pnpm remove`), keep `globaloffensive-sharecode`.
  `state/sources/valve-session.json` on Peder's PC is left alone and
  mentioned in the commit message as deletable.
- Tests: `test/valve.test.ts` replaces the fake GC with a fake fetcher
  (codes in → outcomes out, files written into a temp `replays/`
  folder) and keeps the Web API fake; cases: three new codes all done,
  one pending stops the checkpoint, a gone code is skipped over, dry
  run launches nothing, a refusal from the guard reports every code
  pending. No test launches a game.

**Done:** `pnpm typecheck` and `pnpm test` green; on this PC `pnpm grab`
with one real pending code fetches the demo through a launch and the
next `pnpm grab` reports nothing new; `pnpm go --dry-run` unchanged;
Sol's review folded in.

## Phase 3: setup without a terminal (Sonnet, Sol review)

Parallel with phase 2.

**Who:** Sonnet (bounded, clear done criterion); GPT-6.1 Sol reviews
(it writes `.env`).

**Changes:**

- `pnpm prep --valve` in `src/cli/setup.ts`: prints the two pages
  (`https://steamcommunity.com/dev/apikey` for `STEAM_WEB_API_KEY`;
  `https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128`
  for `STEAM_MATCH_AUTH_CODE`) and the Watch-tab instruction for
  `STEAM_LAST_SHARE_CODE`, asks for the three values in that order
  (readline, like the SteamID prompts), validates each (key: 32 hex;
  auth code: `^[A-Z0-9]{4}-[A-Z0-9]{5}-[A-Z0-9]{4}$`; share code:
  `SHARE_CODE` from `valve.ts`), writes them with the `src/prep.ts`
  helpers (bare values, round-trip check, never overwriting a set
  value unless the user answers yes to "replace?"), prints nothing it
  was given. Without a terminal it says so and lists the keys.
- `Set up matchmaking.cmd` at the repo root, like `Make clips.cmd`:
  `cd /d "%~dp0"`, `call pnpm prep --valve`, `pause`.
- `pnpm check` lists the three as "set" / "not set (optional)" as today.

**Done:** running the cmd on this PC with the three values already set
asks nothing and reports them set; with one cleared it asks for that
one only and the round trip holds; `pnpm test` green; Sol's review in.

## Phase 4: texts (main session, Sol reads text against code)

- `GUIDE.md`: the "Valve matchmaking demos on their own" section
  becomes: double-click `Set up matchmaking`, paste the three things it
  asks for from the pages it opens, done; after that `Make clips`
  fetches new matches itself and CS2 opens briefly to download them.
  No terminal, no QR, no phone. The links table loses nothing.
- `README.md`: the Valve paragraph loses `--steam-login`.
- `docs/modules.md`: the valve paragraph and the Running block describe
  the fetch launch, the lock, the budget, the checkpoint rule.
- `docs/faceit-api.md`: untouched.
- `PLAN.md`: M6 marked done with the date and the gate's numbers.
- `AGENTS.md`: the standing order's `pnpm grab` line and the launch
  budget sentence get the fetch launch; the `-insecure` rule gets its
  exception only if the gate forced one.
- If the gate failed: the GUIDE section is removed, README's Valve
  paragraph says the Watch tab is the way, PLAN.md M6 records the
  failure, nothing else changes.

**Done:** every command and path in the texts exists in the code; Sol
confirms.

## Phase 5: verification on the surface Peder judges (main session)

1. A real pending matchmaking match on this PC: `Make clips` double-
   clicked; CS2 opens, downloads, closes; the demo is in
   `demos/store/`; the clips render; the library page shows them.
2. `pnpm check` green; `git status` clean; everything pushed.
3. Still open after this: a PC that is not this one. The guide is the
   test script for whoever goes first.

## What a fresh session needs to know

- Run nothing against CS2 while a render or grab is in progress; check
  `state/.render.lock`, `state/.go.lock`, `state/.grab.lock`.
- The render account must be logged in to Steam for phases 1, 2 and 5;
  `pnpm check` says which account is logged in.
- Sol and Astra run through the `ikkeseb-skills:codex-worker` agent
  with `model: gpt-6.1-sol` or `gpt-6-astra`, `sandbox: read-only`,
  a prompt file with every relevant file inlined, and the instruction
  to run no commands (the exec policy kills a run on the first
  PowerShell read).
- Commit per phase with the attribution line; push when Peder says so.
- Never print or commit the `.env` values; `pnpm check` output is safe.
