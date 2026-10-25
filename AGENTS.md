# croclipper — agent guidance

Local CS2 highlight clipper: demos in, real in-game clips of Peder's
best frags out. `PLAN.md` is the spec; build from it and keep it the
single source for design decisions; `docs/modules.md` maps the code and
how to run it. Model and review roles come from
`~/.claude/01-model-map.md`.

## The standing order

"Jeg har spilt cs, lag mine klipp" (or any demo dropped in
`demos/inbox/`) means, without asking: `pnpm grab` (Valve MM through a fetch launch: CS2 on the alt with
`-insecure`, one launch per new match, the game downloads the demo into
its `replays/` and is killed; plus the folder scan; FACEIT demos arrive
through that scan after Peder's own "Watch demo" click, since FACEIT's
bot check blocks the browser profile, 2026-10-24), then `pnpm go` for every new demo: every highlight scoring 40 or
more (at least one, the best, when none does), the deaths reel and the
kills reel from the victims' view. Report what was
made, with clip numbers. Launches are budgeted: one render launch per
demo (chained takes) and one fetch launch per new matchmaking match (at
most `sources.valve.maxMatchesPerRun` per `pnpm grab`), and CS2 must be
closed; refuse otherwise and say so.

## Rules

- pnpm, never npm (`pnpm dlx`, not `npx`). TypeScript, ESM, Node 22+.
- Secrets and identity (SteamID64, FACEIT key) live in `.env` only.
  `.env.example` lists the keys.
- Gates before build: nothing is built on an M0 gate that has not
  passed. Each gate's result, with the exact commands and versions that
  worked, goes in `docs/spikes.md`. A gate that fails is written up as a
  failure, not retried silently with a different approach.
- Renders run on Peder's alt Steam account only, never his main. The
  alt's SteamID64 is `RENDER_STEAM_ID64` in `.env`; the controller reads
  the logged-in Steam user from the registry
  (`HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser`) and refuses
  to launch on any other account, when CS2 is already running, while
  the FACEIT client's anti-cheat runs (it stops HLAE from creating
  cs2.exe, 2026-10-25), or without `-insecure`. HLAE is started only by the controller, which
  kills the game process when the job ends. The fetch launch (`pnpm
  grab`, Valve MM) is a launch under the same guards, lock and cleanup,
  without HLAE; its one write under the game folder is deleting an
  orphan `.dem.info` that would otherwise block that match for good
  (`docs/m6-mm-fetch.md`, Contract). Nothing here ever runs
  against a secure server. Joining a secure server with HLAE injected
  gets an account banned, so these are hard guards, not habits.
- A clip in the library is never re-rendered because the cfg, the
  settings or the method changed. Render keys exist to resume
  interrupted work and to skip what is already done, never to
  invalidate it. Re-rendering happens only on an explicit command that
  names the clips. Likewise a demo is settled once a `pnpm go` pass over
  it finishes (every selected moment rendered, held or failed for good):
  rescoring later never adds work for it; only `pnpm clip --rerender` or
  `pnpm unsettle` does (`state/settled.json`).
- Done means verified on the surface Peder judges: the parsed table,
  the rendered mp4 played back, the library page opened from disk.
- Claude-written changes get a Sol review before they are called done.
  The render controller and anything touching the game install or
  launch options always does.
- Code, comments, commits and docs in English.
