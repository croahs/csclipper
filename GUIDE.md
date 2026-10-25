# Getting started, step by step

csclipper turns your CS2 demos into real in-game clips of your best
rounds, plus a reel of every death and a reel of every kill from the
other side. You drop a demo in, run one command, and watch the clips on
a page in your browser. It all runs on your own PC.

Time: about 20 minutes the first time, most of it waiting for downloads.
After that it is one click on FACEIT and one command.

Everything you have to download yourself comes from the official page
linked here. The setup line fetches the two tools it needs (HLAE and
FFmpeg) from their release pages and checks them against known
checksums before using them.

## What you need

- A Windows 11 PC with Steam and Counter-Strike 2 installed, the one you
  play on.
- A second Steam account. Step 2 explains why and how.
- 10 GB of free disk space for demos and clips.

Do the steps in this order: step 1 while Steam is logged in with your
main account, step 2 switches to the second one, step 3 runs the setup
with the second one logged in.

## Step 1: find your SteamID64

This is the 17-digit number of your main account, the one whose clips
you want. The setup asks for it once. Steam shows it on your account
page:

1. Open https://store.steampowered.com/account/ in a browser where you
   are logged in to Steam (or in the Steam app: your name at the top
   right, then **Account details**).
2. Under your name it says **Steam ID: 7656119...**. Copy that number.
   That is your SteamID64.

Another way: in the Steam app open your **Profile**, right-click the
page and choose **Copy Page URL**. If the link ends in
`/profiles/7656119...`, the number is your SteamID64, and the setup
accepts that link as it is. If the link has `/id/yourname` instead, the
number is not in it: paste the link into https://steamid.io/ (a
community lookup site) and copy the line **steamID64**.

Keep the number somewhere; step 3 asks for it.

## Step 2: make a second Steam account

Clips are recorded by replaying your demo inside CS2 with a tool called
HLAE that hooks into the game. Doing that on a secure server can get an
account banned, so csclipper only ever launches CS2 on a separate
account and never lets it connect anywhere. A brand new account is
enough: CS2 is free and it shares the CS2 already installed on your PC.

1. Create the account: https://store.steampowered.com/join
2. Log out of Steam, log in with the new account, and add CS2 to its
   library (open https://store.steampowered.com/app/730/ and click
   "Play Game"; nothing new is downloaded).
3. Stay logged in with this account. The setup sees which account is
   logged in and offers it as the render account, so you only press
   Enter for that question.

**Already have an account you would not mind losing?** Use that one
instead of making a new one: log in with it and skip to step 3. How
risky is this, really? Low, as far as we can tell. HLAE is a well-known
tool that has been used for CS movies for fifteen years, csclipper
starts CS2 with `-insecure`, which switches VAC off and makes it
impossible to join a VAC-secured server, nothing is ever injected into a
game you are playing, and the game is closed when the clips are done.
Bans happen when HLAE is loaded while connecting to a secure server,
which this never does. But a VAC ban is permanent, Valve does not
explain its decisions, and we are not Valve: so do not use the account
you care about. It does need to be a different account from your main
one; the tool refuses to run on your main account.

While clips are rendering you cannot play on your main account, since
Steam is logged in with the second one.

## Step 3: run the setup line

1. Press the Windows key, type `powershell`, press Enter. A blue or
   black window opens.
2. Paste this line into it and press Enter:

```powershell
irm https://raw.githubusercontent.com/croahs/csclipper/main/setup.ps1 | iex
```

It is a short script you can read first:
https://github.com/croahs/csclipper/blob/main/setup.ps1. In order it

- installs git and Node if you do not have them, using Windows' own
  package manager (winget); Windows may ask you to allow those two
  installers. Then it turns on pnpm, which comes with Node (if that
  fails, it runs pnpm's own installer from https://pnpm.io). If your
  Windows has no winget, the script prints the official download pages
  instead and stops before installing anything, and you run the line
  again after installing them: https://git-scm.com/download/win and
  https://nodejs.org/en/download
- puts csclipper in `C:\Users\<you>\csclipper`
- downloads HLAE and FFmpeg into that folder
- asks you two questions: your SteamID64 from step 1 (the number, or
  the `/profiles/` link), and the render account, where you press Enter
  to take the account logged in now.

If something is not right it says so and what to do. The line can be
run again any time; it then only updates.

## Your first clips

1. **Get a demo.** On FACEIT, open the match room of a game you played
   and click **Watch demo**. The FACEIT client saves the demo into CS2's
   folder, where csclipper finds it. For Valve matchmaking, open CS2,
   go to **Watch**, **Your Matches**, and download the match. If you
   have a demo file from somewhere else, drop it into
   `C:\Users\<you>\csclipper\demos\inbox`.
2. **Close CS2** and make sure Steam is logged in with the second
   account.
3. **Double-click `Make clips`** in the csclipper folder (Windows key +
   R, paste `%USERPROFILE%\csclipper`, Enter). A window opens, collects
   new demos from CS2's folder and your Downloads, then CS2 opens by
   itself, replays your best rounds and records them. Keep your hands
   off the game window while it does; a click changes what is being
   recorded. A match takes a few minutes. When it is done the game
   closes and the window lists the clips it made.

To have `Make clips` on your desktop: right-click it, **Show more
options**, **Send to**, **Desktop (create shortcut)**.

The same thing typed, if you prefer a terminal in that folder:
`pnpm grab`, then `pnpm go`.

## Watch and bookmark the library

The clips are on one page. Open it once and bookmark it; it is rewritten
after every run, so the bookmark always shows the latest clips.

1. Press Windows key + R, paste `%USERPROFILE%\csclipper\library\index.html`,
   press Enter. It opens in your browser.
2. Press Ctrl+D to bookmark it. Name it "CS2 clips".

The page has a search box, sorting, and a list of matches and maps on
the left. The arrow keys step through clips. Each clip is also a normal
mp4 file in `csclipper\library\clips`, ready to share.

To delete clips from the page, run `pnpm library` in the terminal and
open http://127.0.0.1:8765/ while it runs; that page has a Delete
button. Bookmark that one too if you like, it only works while the
command runs.

## Every time after that

Play. Click **Watch demo** in the FACEIT room. Log in with the second
account, double-click **Make clips**, open the bookmark.

## If something goes wrong

- Run `pnpm check` in the csclipper folder. It prints what is installed
  and what is missing, and prints no IDs or keys.
- "refusing: CS2 is already running": close CS2 first.
- "refusing: logged-in Steam account is not RENDER_STEAM_ID64": log in
  with the second account.
- "running scripts is disabled on this system" when you type `pnpm` in
  PowerShell: Windows blocks PowerShell launcher scripts by default.
  `Make clips` is not affected. In a terminal, type `pnpm.cmd` instead
  of `pnpm`, or allow signed scripts for your own user, Microsoft's
  documented setting for this:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies).
- A render that failed is listed in `csclipper\state\failures.json`;
  `pnpm go --retry-failed` tries it again.
- Still stuck: open an issue with the `pnpm check` output.
  https://github.com/croahs/csclipper/issues/new/choose

## Links used on this page

| What | Where | Who runs it |
|---|---|---|
| Your SteamID64 | https://store.steampowered.com/account/ | Steam |
| SteamID64 from a `/id/` link | https://steamid.io/ | a community site, lookup only |
| Second Steam account | https://store.steampowered.com/join | Steam |
| CS2 on Steam | https://store.steampowered.com/app/730/ | Steam |
| The setup script, to read | https://github.com/croahs/csclipper/blob/main/setup.ps1 | this project |
| git (only without winget) | https://git-scm.com/download/win | the git project |
| Node (only without winget) | https://nodejs.org/en/download | the Node project |
| pnpm (only if corepack fails) | https://pnpm.io/installation | the pnpm project |
| HLAE, downloaded for you | https://github.com/advancedfx/advancedfx/releases | the HLAE project |
| FFmpeg, downloaded for you | https://github.com/GyanD/codexffmpeg/releases | Gyan Doshi's Windows builds of FFmpeg, the ones FFmpeg's own site links to |
| Report a problem | https://github.com/croahs/csclipper/issues/new/choose | this project |
