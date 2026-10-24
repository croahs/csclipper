# csclipper

Automatic highlight clips from your CS2 demos. Drop a demo in, run one
command, and CS2 replays your best rounds through HLAE and records real
in-game video: every highlight that scores well, a deaths reel (every
death of yours from the killer's view) and a kills reel (every kill of
yours from the victim's view). The clips land in a library page you open
from disk.

Everything runs on your own PC: a Node command line, CS2, HLAE and
FFmpeg. No account, no cloud, no AI tools.

## You need

- Windows 11 with Steam and Counter-Strike 2 installed.
- A second Steam account to render on. [Why](#why-a-second-steam-account).
- Node 22 or newer, pnpm and git. (Node from nodejs.org; then
  `corepack enable` gives you pnpm.)
- An NVIDIA GPU makes the final encode faster; without one it uses x264.

## Set up

```
git clone https://github.com/croahs/csclipper.git
cd csclipper
pnpm install
pnpm prep
```

`pnpm prep` finds Steam and CS2, downloads HLAE and FFmpeg into `tools/`
(pinned versions, checksums verified), and asks for two SteamIDs: your own
account and the render account. Paste the 17-digit SteamID64 or your
profile link in the `steamcommunity.com/profiles/<number>` form. They go
into `.env`, which stays on your PC.

If you have never launched CS2 on your main account on this PC, do it
once: your crosshair and viewmodel are read from its saved settings.

`pnpm check` prints what is installed, what is missing and which Steam
account is logged in. Run it whenever something does not work; it prints
no IDs or keys.

## Make clips

1. Get a demo. On FACEIT, open the match room and click "Watch demo"
   (the FACEIT client saves it into CS2's folder) or download it. Valve
   matchmaking demos download from the Watch tab inside CS2. Drop the
   file into `demos/inbox/` (`.dem`, or zipped as `.zip`, `.bz2`, `.gz`,
   `.zst`). `pnpm grab` copies new demos from CS2's folder and your
   Downloads into the inbox for you.
2. Log in to Steam with the render account and close CS2.
3. Run `pnpm go` and keep your hands off the game window while it
   records. One CS2 launch per demo, a few minutes each.
4. Open `library/index.html`.

`pnpm go` again later renders only what is new. `pnpm drop <clip number>`
removes a clip. More commands and every setting (`config.json`) are in
[docs/modules.md](docs/modules.md).

## Why a second Steam account

HLAE injects into the game to drive the camera and record. Renders always
launch with `-insecure` and never connect to a server, but an account that
reaches a secure server with HLAE loaded can be banned. So the tool only
ever launches CS2 on the account named `RENDER_STEAM_ID64`, refuses to
launch on your main account, refuses while CS2 is already running, and
kills the game process when the job ends. A free Steam account with CS2
added to its library is enough: it shares this PC's CS2 install. While
clips render you cannot be playing on your main account.

## When something breaks

- Run `pnpm check` first.
- HLAE breaks on CS2 updates. If renders start failing right after one,
  a newer HLAE is needed: the pin lives in `src/cli/setup.ts`.
- A render that failed is listed in `state/failures.json` with its attempt
  folder under `state/render/`; `pnpm go --retry-failed` tries again.
- Open an issue with the `pnpm check` output and the failure entry.

## FACEIT automation (optional)

With a FACEIT Data API key in `.env`, `pnpm grab` lists your new matches
and prints the room link of each one whose demo you do not have yet.
Downloading them automatically through your own logged-in browser
(`pnpm grab --login` once, then `pnpm grab --browser`) no longer works:
since October 2026 FACEIT runs a bot check behind "Watch demo" that fails
in an automated browser, and this tool never tries to get past one. The
click in your own browser works as before.
See [docs/faceit-api.md](docs/faceit-api.md).

## How it works

[PLAN.md](PLAN.md) is the design, [docs/modules.md](docs/modules.md) maps
the code, [docs/scoring-notes.md](docs/scoring-notes.md) explains the
ranking. MIT licensed.
