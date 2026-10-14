# M0 gate results

One section per gate from `PLAN.md` → Milestones → M0. Each records:
pass/fail, date, tool versions (CS2 build, HLAE, demoparser2, FFmpeg,
Node), the exact commands and config that worked, and what did not.

## Demo source on this machine

Five FACEIT demos (`1-<uuid>-1-1.dem`, 228–345 MB, server name
"FACEIT.com register to play here") sit in the CS2 install root:
`C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\`.
How they got there: unknown. `game/csgo/replays/` (where Steam's Watch
tab is expected to save matchmaking demos) does not exist; whether MM
demos were ever downloaded here is unknown.

| File (uuid prefix) | File date | Map | Demo `patch_version` |
|---|---|---|---|
| 8e8743a8 | 2026-10-04 | de_inferno | 14188 |
| 4f41ff3c | 2026-10-01 | de_anubis | 14188 |
| 898d9c8a | 2026-05-23 | de_cache | 14164 |
| e6aac266 | 2026-05-23 | de_anubis | 14164 |
| 0c14eb44 | 2026-05-13 | de_cache | 14160 |

## M0.1 Parser, identity, time

**Pass — 2026-10-14.** Script: `spikes/m0-1-parse.ts`. It exits non-zero
when any check below fails and never prints the SteamID64. Reviewed by
GPT-6.1 Sol (two rounds: first "fail" on a circular tickrate and a
weak join, then "pass after fixes"); all findings are folded in.

Versions: Windows 11 x64, Node 24.21.0, pnpm 12.6.0,
`@laihoe/demoparser2` 0.42.0, TypeScript 7.0.2, tsx 4.23.15.

Commands that ran (SteamID64 from `.env` as `STEAM_ID64`), each exit 0
with "gate checks: all passed":

```
pnpm install
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-0c14eb44-2f46-4523-a286-583a65f3477d-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-4f41ff3c-8b12-4d76-a974-1b4ed8cda7f1-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-898d9c8a-60de-4735-9d02-5121904ad843-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-8e8743a8-4f10-4d4d-ad39-859ccae31fa6-1-1.dem"
pnpm exec tsx spikes/m0-1-parse.ts "C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\1-e6aac266-651c-4aee-a197-04bec8309770-1-1.dem"
```

Per demo:

| Demo | user_id | entity_id | kills joined | ticks with no sample | playback_ticks − playback_frames |
|---|---|---|---|---|---|
| 8e8743a8 | 5 | 791 | 16/16 | 0 | 0 |
| 4f41ff3c | 4 | 361 | 29/29 | 0 | 0 |
| 898d9c8a | 5 | 401 | 21/21 | 6 | 6 |
| e6aac266 | 5 | 220 | 24/24 | 2 | 2 |
| 0c14eb44 | 10 | 390 | 16/16 | 24 | 23 (parser starts at tick 0 here) |

**Node binding on Windows.** `pnpm add @laihoe/demoparser2` pulls the
prebuilt `@laihoe/demoparser2-win32-x64-msvc` (an optionalDependency,
napi-rs). No build step, no Rust toolchain. The package is CommonJS;
the ESM spike loads it with `createRequire`. Every export returns `any`
in `index.d.ts`, so the types below are runtime observations. pnpm 12
blocks esbuild's postinstall (a tsx dependency); it is set to `false`
in `pnpm-workspace.yaml` and tsx runs without it.

**Identity.** Steam IDs come back as strings everywhere the spike
looked (`parsePlayerInfo`, every `parseTicks` row, `attacker_steamid` /
`user_steamid` / `assister_steamid` in events), exact to 17 digits.
`steamid` is the join key. Other identifiers for the same player:

- `user_id` and `entity_id` (numbers, `parseTicks`): one value each for
  the whole demo in all five, different per demo (see table).
- name: `name` in `parsePlayerInfo`/`parseTicks`, `attacker_name` /
  `user_name` in events.
- `player_slot` and `account_id` as tick props: accepted, always null.

CS Demo Manager passes `spec_player <user_id + 1>`; M0.2 confirmed that
value selects this player (slot 6 in 8e8743a8).

**Join.** A kill is a `player_death` with `attacker_steamid` = me and
`user_steamid` a different string. Each must have exactly one
`player_hurt` at the same tick, me → same victim, `health` 0; a
`parseTicks` sample for me at the kill tick with `is_alive` true; a
victim sample one tick before with `health` > 0; and a victim sample at
the kill tick with `health` 0 and `is_alive` false. 106 of 106 kills
across the five demos meet all of it; no teamkills among them (team_num
compared at the kill tick).

**`player_death`** (with `other_extra = ["total_rounds_played"]`):
`assistedflash` boolean, `assister_name` string|null,
`assister_steamid` string|null, `attacker_name` string,
`attacker_steamid` string, `attackerblind` boolean, `attackerinair`
boolean, `distance` number, `dmg_armor` number, `dmg_health` number,
`dominated` number, `event_name` string, `headshot` boolean, `hitgroup`
string, `noreplay` boolean, `noscope` boolean, `penetrated` number,
`revenge` number, `thrusmoke` boolean, `tick` number,
`total_rounds_played` number, `user_name` string, `user_steamid`
string, `weapon` string (no `weapon_` prefix, e.g. `ak47`, `glock`),
`weapon_fauxitemid` string, `weapon_itemid` string,
`weapon_originalowner_xuid` string, `wipe` number.

**`player_hurt`:** `armor` number, `attacker_name` string|null,
`attacker_steamid` string|null, `dmg_armor` number, `dmg_health`
number, `event_name` string, `health` number (after the hit),
`hitgroup` string, `tick` number, `total_rounds_played` number,
`user_name` string, `user_steamid` string, `weapon` string. Rows with a
null attacker (0–10 per demo) all have `weapon` "" (cause not
established). On 104 of the 106 lethal hits `dmg_health` exceeds the
victim's `health` at the previous tick, so `dmg_health` is not capped
at remaining HP; "victim low HP" must come from the victim's `health`,
not from subtracting damage.

**`parseTicks`** with `["health","is_alive","team_num","X","Y","Z","pitch","yaw"]`:
numbers, and `is_alive` boolean, plus `name` string, `steamid` string,
`tick` number in every row.

**Round events.** `listGameEvents` lists neither `round_start` nor
`round_end`, but `parseEvent` returns rows for both: `round_start`
{`round` number, `tick`, `total_rounds_played`},
`round_end` {`reason` string|null, `winner` string|null, `round`
number, `tick`, `total_rounds_played`}. `round_officially_ended` and
`begin_new_match` are listed events. Whether these round rows are
right for warmup and round boundaries is an M2 question.

**Time.** `parseHeader` has no tickrate (map_name, patch_version,
server_name, demo_version_name, …), and demoparser2 0.42.0 computes
`game_time` as `net_tick / 64`, so the parser cannot be the source.
The spike reads the demo's own `CDemoFileInfo` frame (header bytes
8–11 give its offset; field 1 `playback_time` float, field 2
`playback_ticks`, field 3 `playback_frames`): `playback_ticks /
playback_time` = 64.000 in all five, and `playback_ticks` equals the
parser's last tick in all five, so parser ticks and the file's tick
count are the same coordinate. Three demos have ticks where
`parseTicks` returns no row for any player (missing parser samples);
in each, the file's own `playback_frames` is lower than
`playback_ticks` by the same count (by one less in 0c14eb44, where the
parser starts at tick 0). That fits the demo having no frame at those
ticks but does not prove it per tick. Whether `demo_gototick` uses the
same coordinate is M0.2. `demo_listhighlights` was not tried.

## M0.2 Repeatable unattended capture

Not run.

## M0.3 Old demo

Not run.
