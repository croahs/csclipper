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
| tight | `tightness` | each kill beyond the second inside the best `windowSeconds` (6 s) window (ties: the fastest) earns `perKillBeyondTwo`; a 2k's pace is already in `speed`. A 3k in 4 s gets about 19 more than a 3k over 40 s, and both stay one clip |
| spread | `spread` | direction spread: the yaw he turned between consecutive kills of the tightest run (his view the tick before each kill), summed; above `minDegrees` 60 it earns `points` 4 plus `pointsPer45Degrees` 2 per 45° more, at most `max` 10: kills through several directions |
| clutch | `clutch` | by the enemies alive at its start (`byEnemies`: 1v1 10, 1v2 30, 1v3 50, 1v4 70, 1v5 90), times the share of them he killed in it (at least half), times `lostFactor` 0.3 when lost: a 1v1 won with one kill is small (Peder, 2026-10-15) |
| flags | `flags` | per kill: headshot, wallbang, through smoke, while blind |
| style | `style` | per-kill multipliers on that kill's share of the kill base, stacking on the kill: a one-bullet kill (POV gun `weapon_fire` count since the previous kill, or 5 s before the first, is 1) 1.5, a flick (the largest POV yaw turn from 100–200 ms before the kill gunshot to the shot, wrapped, over `flickMinDegrees` 15°) 1.5, or a big flick (`bigFlickMinDegrees` 45° or more) `bigFlick` 2.5 instead, a no-scope 1.4, an airborne kill (`attackerinair`) 1.3, and facing: the victim's view within `facingMaxDegrees` 60° of the line to him the tick before the kill 1.1, otherwise (from behind) 0.9; an unknown angle counts 1. `style` in the breakdown is what they add: the kill part times (average factor − 1). Two one-tap flicks in a 2k score about double a plain 2k; a single kill with every style stays below a strong 3k (about 41 with a normal flick, 68 with a big one, against about 74 for a quick 3k; a spread-out 3k at 55 can be passed by a big-flick 1k); a kill with none counts 1. Facing applies to almost every kill (797 of 900 face him), so a plain kill now gains about 10 % and one from behind loses 10 %; with the outcome multiplier replacing the flat +8 the calibration anchor moved (a plain won 2k from about 38 to about 36, a plain lost 2k from 30 to about 30) and is not re-tuned: Peder's call |
| outcome | `roundOutcome` | the round's whole score (after economy) times `won` 1.1 or `lost` 0.9: a light weight for the round's result; a won clutch is valued in `clutch` on its own |
| lowHp | `lowHp` | − penaltyPerKill for each victim at or below threshold HP before the killing hit whom others (teammates, the world) damaged at least as much as he did before the kill (his own spraydown is never "low HP"), at most `maxPerMoment` 8 |
| economy | `economy` | the kill points (kills and style) times 1 + `perLnRatio` × ln(enemy buy / his team's buy) − 1, within `min`..`max` (0.7..1.4); the buys are the teams' summed `current_equip_value` of alive players at freeze end (`rounds[].equip`). An eco won against a full buy gets ×1.4 on its kill points, a farmed eco ×0.7; pistol rounds (`pistolRounds`, 1 and 13) and unknown buys count 1. Applied to the kill points only, before `outcome` |

Measured on the 29 stored demos (2026-10-15): of 531 gun kills, the yaw turn into the kill shot has median 1.3°, p99 15°, max 35°; 2 pass 25°, 8 pass 15°, so the threshold is 15° (Peder, 2026-10-15); none reaches the 45° big-flick tier yet. Known confounders of the flick signal: recoil (a spray pulls the view, though
mostly in pitch) and strafing while turning both add yaw that is not a
flick; the 15° threshold keeps most of them out, and a flick multiplies only its own kill's share.

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
later; never past the next round's start (the tail runs on past round end; after the last round, the demo's end). Lead-in (4 s) and tail (7.5 s) are in
`config.json` → `clip` and part of the moments cache key;
overlapping moments in a round merge; nothing is cut short, however long
(post fast-forwards the stretches without action: `docs/modules.md`,
Fast-forward).

## What the current weights pick (2026-10-15, one moment per round)

Top three per demo, from `pnpm moments` after the per-round rule and the
tightness signal (the light signals were later replaced by style multipliers):

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

**Calibration anchor (Peder, 2026-10-15).** `batch.minScore` stays 40, and
the scale is held to it: the moments that scored about 40 in the
46-moment batch of 2026-10-15 (plain 2ks such as clip 25, de_ancient R9 at
40.8, and clip 48, de_dust2 R17 at 44.8) must score about 40 again. A first
per-round version gave every 2k a flat +18 for "tightness" and lifted 116
moments over 40; tightness now pays only from the third kill in the 6 s
window, and those 2ks score exactly what they did. Moments that gained
kills under the per-round rule rise for that reason (e.g. clip 41, a 2k
that is a 3k round, 40 to 67). With it, 98 moments across the 29 stored
demos clear 40.

## Not scored yet

Deferred in `PLAN.md`: trades, saved-a-teammate. Not possible
as clips: a clutch won without a POV kill (the render's timing measure needs
POV shots).
