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
`state/<sha>/moments.txt` and the full specs to `moments.json` (`pnpm film`'s
film-weighted ones go to `moments.film.json` / `.txt` beside them). No game
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
| speed | `pace` | on the fastest run (the consecutive kills that earn the most pace points): `speedMax` 24 × the pace factor (1 − average seconds between its kills / `flatSeconds` 8)^`curve` 1.5, so every second slides it down (1 s 19.6, 2 s 15.6, 3 s 11.9, 4 s 8.5, 5 s 5.5, 6 s 3.0, 7 s 1.1) and it is 0 from 8 s (Peder, 2026-11-02) |
| tight | `pace` | each kill past the second in that run earns `perKillBeyondTwo` 35 × the same factor; a 2k's pace is in `speed` only. A 3k in 4 s gets about 35 more than a 3k over 40 s (lost round), and both stay one clip |
| spread | `spread` | direction spread: the yaw he turned between consecutive kills of the fastest run (his view the tick before each kill), summed; above `minDegrees` 60 it earns `points` 4 plus `pointsPer45Degrees` 2 per 45° more, at most `max` 10: kills through several directions |
| clutch | `clutch` | by the enemies alive at its start (`byEnemies`: 1v1 10, 1v2 30, 1v3 50, 1v4 70, 1v5 90), times the share of them he killed in it (at least half), times `lostFactor` 0.3 when lost: a 1v1 won with one kill is small (Peder, 2026-10-15) |
| flags | `flags` | per kill: headshot, wallbang, through smoke, while blind |
| collat | `collat` | a collateral: gun kills on the same tick are one shot (a shotgun blast killing two counts too); each past the first earns `perExtraKill` 30. Rare: 1 in 1388 kills on the 74 stored demos (2026-11-02) |
| style | `style` | per-kill multipliers on that kill's share of the kill base, stacking on the kill: a one-bullet kill (POV gun `weapon_fire` count, on bare names so a knife swing or a grenade throw is none, since the previous kill, or 5 s before the first, is 1) 1.5, a flick (the largest POV yaw turn from 100–200 ms before the kill gunshot to the shot, wrapped, over `flickMinDegrees` 15°) 1.5, or a big flick (`bigFlickMinDegrees` 45° or more) `bigFlick` 2.5 instead, a no-scope 1.4, an airborne kill (`attackerinair`) 1.3, and facing: the victim's view within `facingMaxDegrees` 60° of the line to him the tick before the kill 1.1, otherwise (from behind) 0.9; an unknown angle counts 1. `style` in the breakdown is what they add: the kill part times (average factor − 1). Two one-tap flicks in a 2k score about double a plain 2k; a single kill with every style stays below a strong 3k (about 41 with a normal flick, 68 with a big one, against about 74 for a quick 3k; a spread-out 3k at 55 can be passed by a big-flick 1k); a kill with none counts 1. Facing applies to almost every kill (797 of 900 face him), so a plain kill now gains about 10 % and one from behind loses 10 %; with the outcome multiplier replacing the flat +8 the calibration anchor moved (a plain won 2k from about 38 to about 36, a plain lost 2k from 30 to about 30) and is not re-tuned: Peder's call |
| knife | `knife` | a knife multi-kill: two or more knife kills by him in the round (never a knife round), `multi` 40 for the second and each one after it; outside economy, inside outcome; flag `2 knife kills` (Knife fixes below) |
| trade | `teamplay` | `trade` 2 per kill of an enemy who killed a teammate at most `tradeWindowSeconds` 4 before, same round; flag `trade` / `n trades` |
| save | `teamplay` | `save` 3 per kill of an enemy who hurt a teammate (not him) within `saveWindowSeconds` 2 before it, that teammate alive at the kill and still `saveSurviveSeconds` 3 after it or at round end, whichever is first; `saveLowHp` 4 instead when the enemy's last such hit left the teammate at or below `saveLowHpThreshold` 40; a kill that is both counts as the save; flag `save` / `n saves`. Both are outside economy and inside outcome, and neither applies in a `rosterChanged` round |
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
   `pnpm rescore` then puts the new scores on the clips the library
   already holds (display only; nothing is rendered again).
3. Typical levers: a clutch that ranks above a cleaner multikill → lower
   `clutch.perEnemy` or raise `lowHp.penaltyPerKill`; spread-out rounds
   ranking too close to tight ones → raise `pace.speedMax` / `pace.perKillBeyondTwo`, or lower `pace.curve` for more weight on slower runs;
   pistol rounds too high → lower `weaponMultiplier.pistol`.

Clip boundaries (`src/clip/index.ts`), not weights: start = first
engagement (POV shot or damage dealt/taken) within 5 s before the first
kill, minus the lead-in; end = last kill + the tail, or for a clutch 1 s
after what resolved it (the POV's plant/defuse within 25 s of the last
kill, else a round end within 5 s of it, else the last kill) when that is
later; never past the next round's start (the tail runs on past round end; after the last round, the demo's end). Lead-in (4 s) and tail (5.5 s) are in
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
moments over 40; tightness then paid only from the third kill in a 6 s
window, and those 2ks scored exactly what they did. Since the sliding pace
curve (2026-11-02) a quick 2k gains up to about 20 for pace, so the anchor
moves: clip 25 33 → 46, clip 48 42 → 55; 258 of 835 moments on the 74
stored demos clear 40 (239 before). Moments that gained
kills under the per-round rule rise for that reason (e.g. clip 41, a 2k
that is a 3k round, 40 to 67). With it, 98 moments across the 29 stored
demos clear 40.

## Trades and saves (2026-11-10)

Definitions and weights are in the table above (`trade`, `save`). Both read
the existing parse (`deaths`, and `hurts` with attacker, victim and health
after the hit, present for every player: 20602 enemy hits on his teammates
across the 80 cached demos, all with a health value), so the parse schema did
not change. The moments schema went 6 → 7 (flags), and the weights are in the
moments cache key, so `pnpm moments` rebuilds; `pnpm rescore` updates score,
breakdown and flags of library clips. Settled demos get no new work
(`pnpm go` skips them before scoring).

Weights: started at trade 3, save 4, low save 6, then lowered to 2 / 3 / 4
so each stays well under half a plain rifle kill (10). A flat bonus, not a
multiplier: a trade or save is about what the victim did to a teammate, not
how hard the kill was. Outside economy (an eco round does not make a trade
better), inside outcome (×1.1 / ×0.9 like every part).

Evidence on the 80 cached parses (1421 POV kills, 904 moments): 207 kills are
trades (14.6 %), 73 saves (5.1 %; 23 with the teammate at 40 HP or less).
255 moments gain, at most +8.8; no demo's #1 changes; moments at 40 or more
283 → 292 (at 3 / 4 / 6: 298, at most +13.2). On four demos run with
`pnpm moments` (de_dust2 `0adbd29a`, de_mirage `8de223c5`, de_cache
`a893e749`, de_anubis `b547d5c3`) every top 5 keeps its order; the largest
gains are de_cache R7 3k with a low save 85.6 → 90.0 and de_anubis R7 2k
with two trades 43.7 → 47.3; the only rank moves are below the top 5.

Hand-picks: 86 > 42, 86 > 85 and 13 > 84 hold (84 56.8 → 58.6, a trade);
13 > 105 still fails and widens (72.5 vs 75.1 → 78.4: 105 is a 2k whose
save is a low one; 13 has neither), and clip 13 slips from rank 4 to 5 in
its demo behind R4, a 3k with a trade (72.4 → 74.6). Clip 90 is no longer in
the library, so 63 > 90 and 29 > 90 could not be checked; a 1-kill moment
gains at most 4.4 (one low save, won), against gaps of 33 and 55.

## Knife fixes (2026-11-12)

`weapon_fire` names carry a `weapon_` prefix (`weapon_knife_ursus`,
`weapon_hegrenade`) that deaths and hurts do not, and the gunshot and knife
tests compared the raw name, so on every cache a knife swing or a grenade
throw counted as a bullet (a one-bullet kill with a swing before it was
lost) and could be taken as the flick's kill shot, and no knife round was
ever detected. Every weapon test now goes through the bare name
(`bareWeapon`, `isGunshot`, `isKnife` in `src/parse/demo.ts`): a knife
swing or a grenade throw touches no score. Clip spans and action windows
are not scores and were left as they are, so a knife swing or a throw
still counts as an engagement signal and an action (it can stretch a span
or keep a stretch at normal speed). The parse schema stayed 8 (the death
map's reason in `docs/modules.md`); on an older cache scoring re-derives
the knife round from the fires (`isKnifeRound`) and drops a flick whose
shot tick holds only a swing or a throw (`flickYaw`). Moments schema 7 → 8.

Effect under the unchanged weights on the 9 cached demos of 2026-11-12
(183 moments, every cached POV): 3 move, all up, at most +10.7, all
one-bullet kills a swing or a throw had spoiled (de_anubis R7 2k Tec-9
47.3 → 58.0, de_inferno R9 2k AK-47 60.4 → 68.6, de_ancient R6 2k AWP 25.4
→ 31.0); no flick and no knife round changed there, and `pnpm go`'s picks
(40 or more, else the best) are the same on all 9 demos.

**Knife multi-kill** (`knife.multi`, both files). Two or more knife kills
by him in one round that is not a knife round earn `multi` for the second
and each further one (flag `<n> knife kills`, the page's "Knife 2k+"
feat), outside economy, inside outcome: 40 in `scoring.json` (a plain won
two-knife round scores 97 with the kills 10 s apart, 118 within a second;
the bonus alone reaches the batch's 40), 200 in `scoring.film.json` (248
and 294: at the top of every player's list on file, whose best is 266.6). None of the 21 stored demos has one (3 single knife kills in all,
any player), so nothing on file moves.

## Film weights (`scoring.film.json`, 2026-11-12)

`pnpm film` ranks with its own weights, same shape as `scoring.json`, for a
fragmovie shown to an audience (Peder: tempo far more, a clutch must be
exceptional to count). Against `scoring.json`: pace `flatSeconds` 8 → 6,
`speedMax` 24 → 60, `perKillBeyondTwo` 35 → 70; clutch `byEnemies` 1v1 0,
1v2 5, 1v3 25, 1v4 60, 1v5 90 and `lostFactor` 0; `teamplay` trade, save
and low save 0 (invisible on screen); `roundOutcome` 1.0 both ways;
economy `perLnRatio` 0.2 → 0.1; style one-bullet 1.6, flick 1.6, big
flick 2.8, no-scope 1.6, airborne 1.4; collat 40; flags headshot 3,
wallbang, through smoke and while blind 10; `knife.multi` 200. Film
moments are cached in `moments.film.json` beside `moments.json`.

Main POV over the 9 demos, top 10, `scoring.json` → `scoring.film.json`:

| # | scoring.json | scoring.film.json |
|---|---|---|
| 1 | de_dust2 R1 4k USP-S 218.4 | de_dust2 R1 4k USP-S 266.6 |
| 2 | de_cache R13 4k USP-S 196.9 | de_cache R13 4k USP-S 228.7 |
| 3 | de_mirage R17 4k, 1v2 won 183.0 | de_dust2 R19 3k AWP, collat 172.3 |
| 4 | de_dust2 R11 4k M4A1-S 153.7 | de_mirage R17 4k, 1v2 won 170.0 |
| 5 | de_dust2 R5 4k AK-47, 1v2 won 145.1 | de_ancient R14 3k Tec-9, 1v2 lost 161.7 |
| 6 | de_anubis R4 3k AK-47, 1v3 won 133.5 | de_inferno R19 3k M4A1-S (1.8 s) 159.6 |
| 7 | de_ancient R14 3k Tec-9, 1v2 lost 133.3 | de_ancient R10 3k M4A1-S 145.3 |
| 8 | de_mirage R11 4k M4A1-S 129.7 | de_dust2 R11 4k M4A1-S 142.5 |
| 9 | de_dust2 R19 3k AWP, collat 127.8 | de_dust2 R7 2k AK-47 (0.1 s) 125.9 |
| 10 | de_cache R6 3k Tec-9 123.1 | de_cache R15 4k AUG 119.8 |

Fast multi-kills move up (the AWP collat 9 → 3, the 1.8 s 3k 12 → 6, the
0.1 s 2k 15 → 9), rounds carried by an ordinary clutch move down
(de_dust2 R5 4k 1v2 5 → 13, de_anubis R4 3k 1v3 6 → 15), and a slow 4k
still beats a slow 2k on its kills. The starting point the order gave was
kept: on these demos it already does what Peder asked, and 9 demos are
too few to tune finer without fitting to them.

## Not scored yet

Not possible as clips: a clutch won without a POV kill (the render's timing
measure needs POV shots).
