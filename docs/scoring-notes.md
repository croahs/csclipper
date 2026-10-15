# Scoring notes

How moments are ranked, how to tune it, and what the current weights pick.
The design is `PLAN.md` §3–§4; the weights live in `scoring.json`, and
every change to them gets a line in its `_changes` list with the reason.

## Run it

```
pnpm moments "<demo.dem>"
```

Parses the demo once (cached in `state/<demo sha256>/parse.json`), scores,
builds clip specs and prints the ranked table; the same table is written to
`state/<sha>/moments.txt` and the full specs to `moments.json`. No game
launch. `pnpm clip "<demo.dem>" --top <n>` renders the n-th row.

## How a score is built

A moment is a kill cluster in one round: the POV player's kills with at
most `clusterGapSeconds` between consecutive kills. A clutch is a round
property: from the moment the POV is the last one alive on the team with
enemies alive (1vX), all later kills, plus any cluster chaining into it,
form one clutch moment. Knife rounds and pre-match rounds never count;
overtime only with `includeOvertime`. Teamkills, suicides and kills after
the round end do not count. A moment needs at least one POV kill.

`score` = sum of these parts (each part is in `moments.json` → `breakdown`):

| Part | From `scoring.json` | Meaning |
|---|---|---|
| kills | `killBase[n]` × `weaponMultiplier[class]` | 1k…5k, times the class most of its kills used (pistol, deagle, scout, smg, shotgun, rifle, awp, knife) |
| speed | `speed` | (referenceSeconds − average seconds between kills) × pointsPerSecondFaster, 0…max |
| clutch | `clutch` | vs × perEnemy, + wonBonus when won; × lostFactor when lost |
| flags | `flags` | per kill: headshot, wallbang, no-scope, through smoke, while blind |
| roundWon | `roundWon` | the POV's team won the round |
| lowHp | `lowHp` | − penaltyPerKill for each victim at or below threshold HP before the killing hit |

`threshold` marks moments as `aboveThreshold` in `moments.json`.

## Tuning

1. Run `pnpm moments` on the demos you know; note where your picks land.
2. Change one weight in `scoring.json`, add a `_changes` line saying why
   (which moment moved, and in which demo), re-run. Parsing is cached, so a
   re-run takes seconds.
3. Typical levers: a clutch that ranks above a cleaner multikill → lower
   `clutch.perEnemy` or raise `lowHp.penaltyPerKill`; spread-out multikills
   splitting into singles → raise `clusterGapSeconds`; pistol rounds too
   high → lower `weaponMultiplier.pistol`.

Clip boundaries (`src/clip/index.ts`), not weights: start = first
engagement (POV shot or damage dealt/taken) within 5 s before the first
kill, minus 2 s; end = last kill + 2.5 s, or for a clutch 1 s after what
resolved it (the POV's plant/defuse within 25 s of the last kill, else a
round end within 5 s of it, else the last kill); never past round end + 1 s;
overlapping moments in a round merge; nothing is cut short, however long
(post fast-forwards the stretches without action: `docs/modules.md`,
Fast-forward).

## What the current weights pick (2026-10-15)

Top five per demo, from `pnpm moments`:

**de_inferno, October (`1-8e8743a8…`)** — the render test demo. Peder's two
earlier hand-picks are #2 and #3.

| # | Round | Score | Moment | Ticks |
|---|---|---|---|---|
| 1 | R16 | 78.0 | 2k M4A1-S, 1v2 clutch won, ends on his defuse | 101411–103117 |
| 2 | R8 | 61.0 | 3k AK-47 (hand-picked in M0) | 52692–54302 |
| 3 | R1 | 48.4 | 2k Glock, all HS (hand-picked in M0) | 5733–6103 |
| 4 | R1 | 23.5 | Glock kill, 1v2 clutch lost | 7652–7984 |
| 5 | R13 | 22.5 | USP-S kill, HS | 80078–80366 |

Open question for Peder: #1's two victims were at 4 and 10 HP (teammates
had hit them), costing it 12 points; it still outranks the 3k because the
won 1v2 is worth 50. If that feels wrong, raise `lowHp.penaltyPerKill` or
lower `clutch.perEnemy`.

**de_cache, May (`1-0c14eb44…`)**: #1 R13 4k Glock 1v3 clutch won (176.6;
hand-picked in M0.3), #2 R12 2k AK-47 (34.0), #3 R12 AK-47 wallbang (28.0),
#4 R10 2k M4A1-S (26.0), #5 R13 Glock kill (22.5).

**de_cache, May (`1-898d9c8a…`)**: #1 R24 4k AK-47 all HS (110.5), #2 R15 2k
M4A1-S (28.0), #3/#4 R6 AWP kills through smoke (25.0), #5 R7 Tec-9 (22.5).

**de_anubis, May (`1-e6aac266…`)**: #1 R13 5k USP-S (147.5), #2 R7 Tec-9
kill in a won 1v2 (66.5), #3 R16 2k MP9 all HS (50.3), #4 R6 2k AWP (35.0),
#5 R5 2k AWP (29.0).

**de_anubis, October (`1-4f41ff3c…`)**: no multikill above 2k; #1/#2 R2 and
R12 2k AK-47 (34.0), #3 R11 2k in a lost 1v3 (31.5), #4 R5 2k (28.0), #5 R19
2k (26.0). Six overtime rounds are excluded (`includeOvertime` false).

## Not scored yet

Deferred in `PLAN.md`: flick angle, trades, saved-a-teammate. Not possible
as clips: a clutch won without a POV kill (the render's timing measure needs
POV shots).
