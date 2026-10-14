# croclipper — agent guidance

Local CS2 highlight clipper: demos in, real in-game clips of Peder's
best frags out. `PLAN.md` is the spec; build from it and keep it the
single source for design decisions. Model and review roles come from
`~/.claude/01-model-map.md`.

## Rules

- pnpm, never npm (`pnpm dlx`, not `npx`). TypeScript, ESM, Node 22+.
- Secrets and identity (SteamID64, FACEIT key) live in `.env` only.
  `.env.example` lists the keys.
- Gates before build: nothing is built on an M0 gate that has not
  passed. Each gate's result, with the exact commands and versions that
  worked, goes in `docs/spikes.md`. A gate that fails is written up as a
  failure, not retried silently with a different approach.
- Renders launch CS2 with `-insecure` only, and refuse to start when
  CS2 is already running. Nothing here ever runs against a secure
  server.
- Done means verified on the surface Peder judges: the parsed table,
  the rendered mp4 played back, the library page opened from disk.
- Claude-written changes get a Sol review before they are called done.
  The render controller and anything touching the game install or
  launch options always does.
- Code, comments, commits and docs in English.
