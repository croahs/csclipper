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

A moment is one round: all of the POV player's kills in it, however far
apart (Peder, 2026-10-15), so a 5k is always one clip and the stretches
between kills are fast-forwarded in post. Quick succession is scored, not
used to split: see `tight` below. The clutch state (1vX: the POV the last
one alive on the team with enemies alive) is a property of the round.
Knife rounds and pre-match rounds never count;
overtime only with `includeOvertime`. Teamkills, suicides and kills after
the round end do not count. A moment needs at least one POV kill.

`score` = sum of these parts (each part is in `moments.json` → `breakdown`):

| Part | From `scoring.json` | Meaning |
|---|---|---|
| kills | `killBase[n]` × `weaponMultiplier[class]` | 1k…5k, times the class most of its kills used (pistol, deagle, scout, smg, shotgun, rifle, awp, knife) |
| speed | `speed` | on the tightest run (below): (referenceSeconds − its average seconds between kills) × pointsPerSecondFaster, 0…max |
| tight | `tightness` | the most kills inside any `windowSeconds` (6 s) window (ties: the fastest): `perKillInWindow` for each beyond the first; plus `allWithinBonus` when all kills fall within `allWithinSeconds`. A 3k in 4 s gets about 30 more than a 3k over 40 s, and both stay one clip |
| clutch | `clutch` | vs × perEnemy, + wonBonus when won; × lostFactor when lost |
| flags | `flags` | per kill: headshot, wallbang, through smoke, while blind |
| light | `light` | small bonuses, capped together at `maxPerMoment` (8: well below the 20+ base points between kill counts, though with weapon multipliers a capped round can pass one with a kill more by a few points, e.g. a spread knife 2k with an airborne kill over a spread AWP 3k): per kill a no-scope, an airborne kill (`attackerinair`), a one-bullet kill (POV gun `weapon_fire` count since the previous kill, or 5 s before the first, is 1), and a flick on a gun kill (the largest POV yaw turn from 100–200 ms before the kill shot, his last gunshot within 1 s, to the shot, wrapped; none without a gunshot; above `flick.minDegrees` 25°, `pointsPer10Degrees` up to `maxPerKill`) |
| roundWon | `roundWon` | the POV's team won the round |
| lowHp | `lowHp` | − penaltyPerKill for each victim at or below threshold HP before the killing hit |

Known confounders of the flick signal: recoil (a spray pulls the view, though
mostly in pitch) and strafing while turning both add yaw that is not a
flick; the threshold and the small cap keep their effect minor.

`threshold` marks moments as `aboveThreshold` in `moments.json`.

## Tuning

1. Run `pnpm moments` on the demos you know; note where your picks land.
2. Change one weight in `scoring.json`, add a `_changes` line saying why
   (which moment moved, and in which demo), re-run. Parsing is cached, so a
   re-run takes seconds.
3. Typical levers: a clutch that ranks above a cleaner multikill → lower
   `clutch.perEnemy` or raise `lowHp.penaltyPerKill`; spread-out rounds
   ranking too close to tight ones → raise `tightness.perKillInWindow`;
   pistol rounds too high → lower `weaponMultiplier.pistol`.

Clip boundaries (`src/clip/index.ts`), not weights: start = first
engagement (POV shot or damage dealt/taken) within 5 s before the first
kill, minus the lead-in; end = last kill + the tail, or for a clutch 1 s
after what resolved it (the POV's plant/defuse within 25 s of the last
kill, else a round end within 5 s of it, else the last kill) when that is
later; never past round end + 1 s. Lead-in (4 s) and tail (5.5 s) are in
`config.json` → `clip` and part of the moments cache key;
overlapping moments in a round merge; nothing is cut short, however long
(post fast-forwards the stretches without action: `docs/modules.md`,
Fast-forward).

## What the current weights pick (2026-10-15, one moment per round)

Top three per demo, from `pnpm moments` after the per-round rule and the
tightness and light signals:

- **de_inferno, October (`1-8e8743a8…`)**, the render test demo: #1 R1 3k
  Glock in a lost 1v2 (104.7; the two hand-picked R1 kills and a third now
  form one round), #2 R16 2k M4A1-S, 1v2 won (78.0; its victims were at 4
  and 10 HP, −12), #3 R8 3k AK-47 (61.0; kills 11.5 s and 9 s apart, so no
  tightness bonus).
- **de_cache, May (`1-0c14eb44…`)**: #1 R13 5k Glock, 1v3 won (241.4; was
  a 4k before the round became one moment), #2 R12 3k AK-47 (81.0), #3 R11
  2k M4A1-S (34.0).
- **de_cache, May (`1-898d9c8a…`)**: #1 R24 4k AK-47 (152.5, tight 42),
  #2 R6 3k AWP (69.5), #3 R7 2k Tec-9 (41.5).
- **de_anubis, May (`1-e6aac266…`)**: #1 R13 5k USP-S (192.4), #2 R7 3k
  Tec-9, 1v2 won (118.8; library clip 10 has 2 of those kills), #3 R16 2k
  MP9 (68.3).
- **de_anubis, October (`e3dc4b4e…`)**: still no multikill above 2k; #1–#3
  R2, R5, R19 2k AK-47 (52.0, 46.0, 44.0). Six overtime rounds are
  excluded (`includeOvertime` false).

The tightness bonus lifts most 2ks by 18 (two kills within 6 s and within
10 s), so 116 moments across the 29 stored demos score 40 or more (63
before). `batch.minScore` was set on the old scale.

## Not scored yet

Deferred in `PLAN.md`: trades, saved-a-teammate. Not possible
as clips: a clutch won without a POV kill (the render's timing measure needs
POV shots).
