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
  be left). No HLAE: cs2.exe is spawned directly. Whether `-insecure`
  is passed is decided by gate M0.4: pass it if the download works
  with it (fewer exceptions to the rule that nothing here runs against
  a secure server); if it does not, the launch is `-insecure`-free and
  the rule in AGENTS.md gets this one named exception: a fetch launch
  joins no server and loads no HLAE.
- Budget: one fetch launch per `pnpm grab` run, carrying every pending
  code (at most `sources.valve.maxMatchesPerRun`, default 5), next to
  the one render launch per demo. Written into AGENTS.md's standing
  order in phase 4.
- No terminal for the user: the three `.env` values are entered through
  a double-click file (`Set up matchmaking.cmd` running `pnpm prep
  --valve`), which prints the two web pages to get them from.
- The checkpoint (`state/sources/valve.json` → `lastShareCode`)
  advances only over codes whose demo file exists complete in
  `replays/`, or that Valve no longer has (the Watch tab download
  fails the same way the GC did for demos older than about 30 days;
  the gate records what that looks like).

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
   (expected `game/csgo/replays/match730_<matchId>_<reservationId>_<tv>.dem`)?
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
6. Does the folders source then ingest the file on the next
   `pnpm grab` without a second copy (the stem is in the file name;
   `haveDemo` in `src/cli/grab.ts` line 84 checks that)?

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
  a `DemoFetcher` that, given share codes, runs one launch per the
  contract and returns per code `done | pending | gone | failed` with
  the file path for done. Reuses `guard`, `RenderLock`, `OwnedTree`,
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
  pending or failed one". `replayStem` is replaced by a stem from the
  decoded share code (`globaloffensive-sharecode`). `NO_KEYS` no longer
  mentions `--steam-login`.
- `src/cli/grab.ts`: `--steam-login`, `gcOpener`, `steamLogin` go; the
  render lock handling stays (the fetcher holds it); the header comment
  and `docs/modules.md` Running block lose `--steam-login`.
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
