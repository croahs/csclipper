# Modules

`PLAN.md` is the design; this page is what the code does not say by itself.

## Running

```
setup.ps1                      (one line for a new PC: git, Node, pnpm, clone or pull, pnpm prep; GUIDE.md)
Make clips.cmd                 (double-click: pnpm grab, then pnpm go, window stays open)
Set up matchmaking.cmd         (double-click: pnpm prep --valve, window stays open)
pnpm prep                      (first time on a PC: tools, .env; pnpm check reports only)
pnpm prep --valve              (only the three Valve matchmaking .env values: where to get them, asks for the unset ones)
pnpm check
pnpm grab [--dry-run] [--browser] [--last <n>]
pnpm grab --login
pnpm go [--dry-run] [--retry-failed] [--repost] [--settle-existing] [--no-reels]
pnpm film [--dry-run] [--retry-failed] [--repost]   (pnpm go --film: each roster player's top highlights and bloopers, Film below)
pnpm film masters [--dry-run]  (edit-grade .mov of every clip ticked Film; Masters below)
pnpm moments "<demo.dem>" [--pov <steamid64>]
pnpm bloopers "<demo.dem>" [--ids <steamid64,steamid64>] [--all]   (the demo's bloopers as a table; default players: the film roster)
pnpm clip "<demo.dem>" --top <n> [--timeout <s>] [--dry-run]
pnpm clip "<demo.dem>" <startTick> <endTick> [same options]
pnpm clip --rerender <no|id> [--lead <s>] [--timeout <s>] [--dry-run]
pnpm deaths "<demo.dem>" [--timeout <s>] [--dry-run]
pnpm victims "<demo.dem>" [--timeout <s>] [--dry-run]
pnpm library [--port <n>]
pnpm film:pick [--port <n>]    (pnpm library under the film picker's name; open /film.html)
pnpm deathmap
pnpm drop <no>...
pnpm share <no> [--max-mb <n>] [--raw-audio]
pnpm vertical <no> [--shift <percent>]
pnpm cut <no> <from> <to>      (seconds as the clip plays: 4.5 or 0:04.5)
pnpm fav <no>...               (star clips; pnpm's own star / unstar star npm packages)
pnpm unfav <no>...
pnpm pick <no>...              (pick for the film, as the film picker does: pnpm film masters makes these)
pnpm unpick <no>...
pnpm week [<yyyy-Www>] [--top <n>] [--seconds <n>] [--music <file>] [--no-music] [--dry-run] [--json]
pnpm music [--check]           (the default tracks of music.json into music/, sha256-checked)
pnpm trash --empty
pnpm tidy
pnpm unsettle <demo sha256 prefix | clip no>...
pnpm rescore [--dry-run]
```

**Reels** (`src/reel/`). `pnpm go` makes two reels for every new demo, in
the same launch as its highlights (`config.json` → `reels`, each with
`enabled`, `beforeSeconds`, `afterSeconds`; `--no-reels` skips them for
one run): **deaths**, every death of
the POV player from the killer's first person (7 s before, 4 s after; a
suicide or a world death from the POV player's own view), and **kills**,
every kill by the POV player from the victim's first person (7 s before,
2 s after; after the death the game
shows its death camera). Each take spectates that player's slot with the
same HUD, crosshair and TrueView rules as a highlight, carries a line of
text (round, weapon, the other player; Segoe UI Semibold, `drawtext` with
`expansion=none`), fades in and out, and the takes are concatenated into
one library clip (`kind` deaths or kills, title `<map> · deaths` /
`<map> · kills`, `reel.takes` in the entry). Takes that overlap are
reached by backward seeks. A reel's render key names each take's event
and slot, not its window, so a capture with a wider window serves a
narrower one (post trims). A reel is held per demo and kind; frames are
checked mid-take, never on a seam where the fades meet. `pnpm deaths` /
`pnpm victims` make one for any demo, settled or not.

**Film** (`src/queue/index.ts` `filmQueue`, `src/film/select.ts`,
`src/config.ts` `loadRoster` / `loadFilm`; PLAN.md §3 has the rules).
`pnpm film` (`pnpm go --film`) films the roster: `STEAM_ID64` plus
`.env` → `FILM_STEAM_ID64S` (SteamID64s, comma- or space-separated; the
render account is refused). A pass ranks every roster player's moments
over every registered demo still on disk, settled or not, by the film
weights (`scoring.film.json`, Film weights in `docs/scoring-notes.md`),
and selects per player the `config.json` → `film.top` (20) best of
those scoring `film.minScore` (40; absent: 0) or more (fewer or none is
fine; a held clip under it is simply out of the selection), plus
the `film.bloopersTop` (5) best of his bloopers scoring
`film.bloopers.minScore` (50) or more (few or none is fine). A clip the
library already holds counts toward the player's number and is not
rendered again (held as `prepareJob` decides it: the same clip id, or a
clip of the same round and player sharing a kill); a deleted one
(`state/deleted.json`) is passed over and the next best takes its place.
Then one launch per demo with something to render, all from that
player's first person, no reels. A film pass never settles a demo
(`state/settled.json` is not touched) and keeps no record of its own:
what the library holds is the record, so a later run with more demos
re-ranks from the caches and renders only what is newly in a top N. A
player who is not in a demo is no error. Film moments are cached apart
from the normal ones, in `moments.film.json` / `moments.film.txt` beside
`moments.json`, for every POV, so the two modes never rewrite each
other's cache; spans and clip ids do not depend on the weights, so a
moment the library holds under the normal weights is the same clip. The
library entry carries the normal score (the post worker finds the spec
by id among the normal moments, and `pnpm rescore` keeps it); the film
score lives in the cache and the dry run's table. Another player's parse
and moments are cached in `state/<sha>/pov-<povKey>/`, and so is his
absence: a player not in the demo (`PovAbsent`) gets `absent.json`
there (its key the demo hash, the POV's hash, parser version and parse
schema, no SteamID), so a later pass answers without opening the demo and a schema
or parser bump re-checks; a real parse failure is never cached as
absent. `povKey` (the
first 8 hex of the SteamID64's sha256) is the only handle on a player
outside `.env`: in clip ids, render keys, job files and the library
entry's `player: { name, key }`. The main POV's caches, ids and keys are
what they always were. The look is the main account's: HUD, settings,
look cfg and the launch identities do not change per player, and in a
demo older than `crosshairFromDemoSincePatch` the crosshair is the main
account's saved one, not the friend's (Crosshair, under M1 decisions).
`pnpm moments --pov <steamid64>` shows another player's ranked moments
(the ID from the command line only). `pnpm rescore` rescores a film
player's highlights from his own cache and skips bloopers (counted);
`pnpm week` takes only the main account's highlights. Every pass prints
per player a ranked table (rank, film score, demo, title, held with its
clip number, or would render / to render; deleted ones unranked as
passed over), then his bloopers; the end report lists the clips made
per player, bloopers apart. At the end of every pass, the dry run
included, `runBatch` writes `library/film-selection.json`
(`src/library/film-selection.ts`, temp then rename): `{ version: 1, at,
players: [{ name, me, highlights: [{ no, score, title, stretch? }],
bloopers: [{ no, score, title, type }] }] }`, roster order, rank order,
film scores, only clips the library holds (held before the run, or
published under the selected id during it), no SteamID or povKey. It is
display data for the film picker (Stars and filters below), never read
by a run: the no-record rule above still holds. Tested in
`test/film.test.ts`, `test/film-select.test.ts`,
`test/film-bloopers.test.ts` and `test/film-picker.test.ts`.

**Masters** (`src/film/masters.ts`, through `pnpm film masters`).
`pnpm film masters [--dry-run]` makes an edit-grade file of every clip
picked for the film (`library/film-picks.json`, Stars and filters
below) at `library/film/masters/<player>/<no>-<slug>.mov`, the
player folder file-safe: a friend's from the name on his newest clip,
"Me"'s from the main POV's in-demo name in the parse of his newest
clip's demo. The raw capture of a published clip is gone by design, so
a master is a new capture: one launch per demo for all its picked clips
(`runJobs`, units whose `finish` muxes the master instead of posting;
id `master-<clip id>`, a render key of its own), refused like `pnpm go`
(CS2 running, the FACEIT client) and under `.go.lock`. The command names
the clips (the picks), which is what AGENTS.md asks of a re-render; the
library clip itself is never touched. A master is the whole moment at
real speed: the clip's `[startTick, endTick]` plus
`film.masterHandleSeconds` (2) on each side, clamped like a reel take
(round start, the demo's playable ticks, short of the match end, the
clip's own span always kept); no fast-forward, fades or text. It is the
capture itself, at `film.masterCaptureCrf` (8) instead of
`render.captureCrf` (through the unit's `RenderSettings`): the captured
H.264 stream copied (no second encode) and the captured audio as 24-bit
PCM, muxed into `.mov`. A stream copy cuts only at keyframes, so the
file is the whole capture, which runs up to the controller's capture
margin (0.5 s) past the span at each end. Idempotent: a master whose
file exists with the same key (clip id, span, handles, capture settings)
in its `comment` tag, as share copies keep theirs, is skipped. A picked
reel, a clip whose demo is no longer on disk, or whose player has left
the roster is listed and skipped. The raw capture is deleted once the
master is written. `--dry-run` lists per demo what it would capture
(ticks, seconds, CRF, the file) and writes nothing. The plan, the key,
the span, the unit and the mux arguments are pure and tested in
`test/film-select.test.ts`; no master has been produced yet (no capture
was run when this was built, 2026-11-12).

**Bloopers** (`src/film/bloopers.ts`, `src/film/track.ts`,
`src/cli/bloopers.ts`). The funniest mistakes of a roster player, each
one take from his first person over its span, played whole at normal
speed. Detection is pure over the parse (rounds, deaths, hurts, fires:
the same whichever roster player's parse it is) and a track of every
player's position, view, alive state and spotted-by mask every 16 ticks
(0.25 s) from freeze end to round end, plus the smokes (each
`smokegrenade_detonate`'s point and tick to its entity's
`smokegrenade_expired`, else `SMOKE_SECONDS` 22 s on, never past its
round's end), cached as `state/<sha>/bloopers-track.json.gz` (schema 2;
a track without smokes reads as none). Knife rounds are out. One per
player, round and kind, the best; scores 0-100, comparable across kinds
(`early`: 1 up to 15 s after freeze end, 0 from 60 s):
- **teamkill**: he killed a teammate. 55, plus 20 knife / 15 grenade or
  point-blank (3 m) / 5 otherwise, plus 10 × early, 10 when the victim
  had 100 HP, 10 when the round was lost. Span 6 s before, 3 s after.
- **selfkill** (own grenade / fall): killed by his own HE, molotov or
  incendiary, or a fall (damage from no one at the death tick; the bomb
  and a disconnect are not). A fall: 80, plus 15 × HP before / 100, plus
  5 × early. Own grenade or fire: 20, plus 70 × own damage / 100, plus 5
  × early, where own damage is what his own HE, molotov and incendiary
  hits did to him that round up to the death, each hit as the health it
  took (`dmg_health` of a killing hit is not capped at the health left),
  100 at most (`detail.ownDamage`). Span 7 s before (or 1 s before the
  throw, when earlier), 2 s after.
- **selfnade** (own grenade, survived): one throw of his own HE (its hits
  on one tick) or fire (his own fire hits with no pause over 2 s) took
  50 or more health from him (`selfnade.minDamage`, counted by the same
  health walk) and did not kill him; the throw that killed him is a
  selfkill only. 20, plus 70 × damage / 100, plus 5 × early, so 50
  damage scores 55-60. Anchor: the throw's last hurt. Span from 1 s
  before the throw (7 s before the anchor when no throw is found) to 3 s
  after.
- **spray** (spray, no kill): 25 or more gun shots with no pause over
  1 s, an enemy within 700 units and 12° of his view's yaw and 20° of
  its pitch in 60 % of the samples, no kill from the first shot to 2 s
  after the last. Shots into a smoke do not count: a shot with a smoke
  up at its tick within `SMOKE_RADIUS` (155 units) of the line from his
  eyes to that enemy's chest at the nearest sample (or either standing
  in it) is
  left out (`detail.inSmoke`), and the shots left must still be 25 or
  more; they are the bullets of the title and the score. The anchor
  stays the last shot. 30, plus 25 × (shots − 25) / 20, plus 15 × closeness
  (700 down to 150 units), plus 15 × (1 − damage dealt to any enemy /
  100), plus 15 when that enemy killed him. Span from 3 s before the
  first shot to 3 s after the last (2 s after his death within 4 s), at
  most 20 s.
- **behind** (behind, no kill): 2 or more enemies within 1200 units,
  within 35° of his view, facing away (110° or more) for a tick span of
  at least 1 s, 3 or more gun shots in it or 4 s after, no kill until 6 s
  after. 25, plus 40 for 4+ enemies / 28 for 3, plus 12 when he died
  within those 6 s, plus 10 × shots / 20, plus 10 × closeness, plus up
  to 5 for a longer window. Span from 3 s before to 6 s after (2 s after
  his death), at most 25 s: a longer window keeps its last 25 s, and its
  anchor stays the window's start, so its id does not move with the cut.
Every threshold is in `BLOOPER_DEFAULTS`, overridable in `config.json` →
`film.bloopers` (`minScore` 50, `selfnade`, `spray`, `behind`). Spans are clamped
like reel takes (round start, the demo's playable ticks, short of the
match end). There is no map geometry: "in front" and "in view" are a
range and a cone, so an enemy behind a wall or on another floor counts.
A sight proxy is therefore required: for spray, damage either way, a
spotted flag either way while he is in front, or that enemy killing
him; for behind, a spotted flag, damage dealt, or dying to one of them,
else it scores 35 at most. The spotted flag (`m_bSpottedByMask` through
demoparser2) is a positive line-of-sight signal only (set for the victim
at 71 % of one demo's non-wallbang gun kills the tick before, at none
of its wallbangs); the mask holds the first 31 players, a later one
never reads as spotted. The known false positive left is an enemy
behind a wall whose proxy fires anyway: damage through the wall either
way counts as sight. In a film pass the demo's one parse and its track serve every
roster player in it; those scoring `film.bloopers.minScore` (50) or more are
kept, of one player's that overlap in ticks the higher score
(`pickBloopers`), and per player the `film.bloopersTop` (5) best across
the demos are selected (Film above). A blooper's id is `sha256("<demo sha>:blooper:<type>:<anchor
tick>:<povKey or empty>")`, 16 hex, built from the event and not the span,
so a threshold or span change never re-makes one the library holds
(held: the id in the index or in `state/deleted.json`); its render key
carries the span, so a capture of another span is never reused. The
entry: `kind: "blooper"`, `blooper: { type, score, detail }`, the
blooper's title, `player` for a friend, no `moment`. The post worker
gets `bloopers: [{ pov: povKey, clip }]`, the clip as the batch
captured it (id, span, title, score), and posts that without detecting
again: under changed thresholds a re-detected span, and with it the
render key, could miss the capture. `pnpm clip --rerender <no>` re-renders one
over its own span. `pnpm bloopers` prints the table for the roster,
`--ids`, or `--all` (every player, parsed through any of them);
parsing only. Tested in `test/bloopers.test.ts` and
`test/film-bloopers.test.ts`.

**Deleting.** `pnpm drop <no>` (not `pnpm rm`: pnpm's own `rm` removes a
dependency) moves the clip's mp4 to `library/trash/`, removes its index
entry (the number is never reused) and keeps it in `state/deleted.json`,
which counts as held: `pnpm go` never makes that moment or reel again.
`pnpm trash --empty` deletes the trash for good. **Raw captures** (HLAE's
intermediate video and audio per take under `state/render/`, about 700 MB
per clip, kept so a failed post never costs another launch) are deleted
right after the clip they belong to is published, and `pnpm go` ends with
a sweep of every capture of a clip the library holds or `state/deleted.json`
lists; `pnpm tidy` runs that sweep alone, launching nothing (for captures
from before this rule, or ones a publish could not delete). The sweep runs
under `state/.clip.lock`, which every render run holds from its resume
check to its index write: a same-id `--rerender` writes its fresh capture
while the old entry is still held, and a sweep meanwhile would eat it. A
held lock skips the sweep (`pnpm tidy` exits 2), never waits. Only files
named `video*.mp4` / `audio.wav` physically under `state/render/` (a
junction inside it does not count) are ever deleted;
`capture.json`, `console.log`, the cfgs and `render.json` stay. A capture's
recorded path is re-rooted under this checkout's `state/render/`, since the
record holds an absolute path and the folder may have moved
(`src/queue/prune.ts`). Captures of failed-for-good units and launch dirs
no clip refers to are not touched. `pnpm library` serves
`library/` at `http://127.0.0.1:8765/` (127.0.0.1 only, no dependencies,
Range requests; Host and Origin checked, so no other site can delete
through it); served that way the page has a Delete button and the Delete
key (with a confirm), opened from disk it shows the `pnpm drop <no>`
command to copy. Index writes (publish, delete) take a short lock,
`state/.index.lock`, so a delete during a run is never lost.

**Sharing** (`src/share/`, `src/cli/share.ts`; PLAN.md §6 has the rules).
`pnpm share <no>` writes `library/share/<no>-<slug>.mp4` (H.264, AAC,
faststart, under `config.json` → `share.maxMegabytes`, default 20;
`--max-mb` for one run) and prints the path, the size and a caption.
`planShare` (the two-pass ladder and the refusal) and `shareCaption`
(`src/share/caption.ts`, also inlined per clip into the page) are pure
and tested in `test/share.test.ts`. Reuse is recognised by a key in the
share file's own `comment` tag; nothing is written to `index.json`, and
the page only changes when a run or a delete rewrites it. Exit 2: the
clip is too long for the limit. `pnpm library` runs `pnpm share <no>
--json` as a child process for `POST /share/<no>` (one per clip at a
time) and opens Explorer for `POST /reveal/<no>`. Measured 2026-11-10
at 20 MB: a 31 s 1080p60 highlight went to 720p60 two-pass (18.7 MB,
38 s); a 198 s kills reel to 480p30 (19.0 MB, 95 s).

**Vertical copies** (`src/share/vertical.ts`, `src/cli/vertical.ts`;
PLAN.md §6 has the rules). `pnpm vertical <no>` writes
`library/vertical/<no>-<slug>.mp4`: the centre 9:16 column, 1080x1920
(`config.json` → `vertical`), H.264 CRF 18, AAC, faststart, and prints
the path, the size and share's caption. `--shift <percent>` moves the
column by that share of the source width, clamped; a new shift remakes
the file under the same name. `planCrop` and `verticalKey` are pure and
tested in `test/vertical.test.ts`. Reuse, exit codes (2: no such clip
or a source narrower than 9:16) and `--json` (`path`, `bytes`,
`width`, `height`, `fps`, `seconds`, `caption`, `reused`, `crop`,
`encodeSeconds`) mirror share, so the library server can run it as a
child process. Measured 2026-11-10 (1920x1080p60 sources, preset slow):
a 7.0 s highlight in 6 s (13.2 MB), a 36.4 s highlight in 31 s
(73.1 MB), a 162 s kills reel in 188 s (292 MB); about 15-17 Mbps, a
reuse in about 2 s. The viewmodel, like the radar and kill feed, sits
mostly outside the centre column. `pnpm library` runs it for `POST
/vertical/<no>` (answer `{ file, bytes, seconds, caption }`) and
reveals it for `POST /reveal/<no>/vertical`.

**Cuts** (`src/share/cut.ts`, `src/cli/cut.ts`; PLAN.md §6 has the
rules). `pnpm cut <no> <from> <to>` writes
`library/cuts/<no>-<slug>_<from>-<to>.mp4` (tenths, `_0045-0120`) and
prints the path, the size, the length and share's caption; the library
clip is untouched. `parseTime`, `parseCutArgs`, `planCut` (the
refusals and the end clamp), `cutName`, `cutKey` and `cutArgs` (the
input seek, `-t`, fades capped at a quarter of the cut) are pure and
tested in `test/cut.test.ts`. Reuse, exit codes (2: no such clip, or a
refused cut) and `--json` (`file`, `path`, `bytes`, `seconds`,
`from`, `to`, `caption`, `reused`, `encodeSeconds`) mirror share.
`pnpm library` serves `POST /cut/<no>` (JSON body `{ from, to }`,
numbers only, `planCut` against the clip's probed length before the
child runs: 400 otherwise, 404 for no clip; answer `{ file, bytes,
seconds, from, to, reused }`; keyed in flight by clip and times) and
`POST /reveal/<no>/cut/<name>` (a name `isCutName` accepts for that
clip). Measured 2026-11-10 (1920x1080p60, preset slow): 7.5 s of a
14.8 s highlight in 8 s (19.0 MB), a reuse in about 1 s. The deep-link
parser (`src/library/hash.ts`) is tested in `test/deeplink.test.ts`,
on the very text `page.ts` inlines.

**Stars and filters** (`src/library/stars.ts`, `src/library/facets.ts`,
`src/cli/star.ts`; PLAN.md §7 has the rules). `pnpm fav <no>...` /
`pnpm unfav <no>...` (not `pnpm star`: pnpm's own command) change
`library/stars.json` and rewrite the page; a number the index does not
hold refuses the whole command (exit 1, nothing written). `changeStars`
drops the stars of clips no longer in the index on every write, and the
page writer leaves them out, so `pnpm drop` does not touch the file. The
file has no lock: the server and the CLI each read-modify-write it in
microseconds, and two stars in the same instant can lose one. `pnpm
library` serves `POST /star/<no>`, `POST /unstar/<no>` (answer
`{ stars }`) and `GET /stars`. Film picks (what `pnpm film masters` makes) are kept exactly the
same way in `library/film-picks.json` (`{ version: 1, picks: [...] }`,
`changePicks`): `pnpm pick <no>...` / `pnpm unpick <no>...`, `POST
/pick/<no>`, `POST /unpick/<no>` (answer `{ picks }`), `POST /picks`
(body `{ pick?: number[], unpick?: number[] }`, at most 64 KiB counted
in bytes, all or nothing: `changePicksBulk` refuses the whole request
with 404 for a number the index does not hold, 400 for anything else
malformed, and writes the final set once; an empty body changes
nothing; anything thrown answers 500; answer `{ picks }`;
`src/library/picks-route.ts`) and `GET /picks` served; opened
from disk the row shows the command to copy. The sidebar's
"Film picks" row, under Starred, counts and filters them; `picks` is in
the inlined data only when a clip in the index is picked. `featsOf` and `weaponsOf` (the game's
names for grenade and fire kills labelled: `hegrenade` "HE grenade",
`inferno` "Fire") run in `page.ts`, which stores `feats` and `weapons`
per clip in the inlined data; the page only filters and counts, live, so
a delete in place updates the counts. Film entries add to it only where
they occur (`pageData`): a blooper's kind is its feat (Teamkill, Own
grenade / fall, Spray, no kill, Behind, no kill) and its score the
blooper score, shown and sorted by; Kind lists Bloopers once one
exists; the "Knife 2k+" feat is a moment flagged `<n> knife kills`; `playersOf` gives the Player filter when an entry has `player`:
"Me" for the rest, a friend by the name on his newest clip. A library
without either gives the data it always did. Tested in
`test/stars.test.ts`, `test/film-bloopers.test.ts` and
`test/film-select.test.ts` (picks).

**Best of the week** (`src/week/`, `src/cli/week.ts`, `src/cli/music.ts`;
PLAN.md §6 has the rules). `pnpm week [<yyyy-Www>]` writes
`library/montage/<yyyy>-W<ww>.mp4`, a fragmovie: the week's top
highlights (`config.json` → `montage.top`, 10; `--top` for one run) cut
to the shots around their kills, every shot's first kill on the beat of
the track, capped at `montage.maxSeconds` (60; `--seconds`). `--dry-run`
prints the plan (track, BPM, start offset, grid unit, and per shot the
clip, in/out in the clip, cut in/out and anchor in the video, kills)
and writes nothing; `--json` the same as one line. A clip's week comes
from `src/library/match-date.ts`, the rule `page.ts` inlines into the
page. The modules: `index.ts` (ISO weeks, selection, plan, key, render),
`edit.ts` (tick → clip seconds through `render.segments`, shots, the
layout on the grid, frames, the cap; pure), `beats.ts` (envelope, tempo,
phase, bar phase, start, drift; pure over PCM), `music.ts` (the
`music.json` manifest, sha256 check and download, track choice, decode
and the `music/<file>.beats.json` cache, validated on read: an unsound
one is a miss; `--dry-run` writes nothing, not even the cache). A
track with fewer than 8 whole bars is refused (exit 1); the last shot's
footage plays on through the hold to the bar line and the fade (a frame
is held only where a clip runs out). Tested in `test/week.test.ts`
and `test/beats.test.ts` (click tracks at 175, 138 and 100 BPM generated
as PCM, accents, a 1 % drift; no files). The render: the card and each
shot to a lossless intermediate (x264 `-qp 0` + PCM in NUT, input seek
to just before the in-frame) in a temp dir, joined by the concat demuxer
with each part's `duration` stated (without it the demuxer takes the
last frame's timestamp: one frame short per part, 0.27 s over 26
parts, measured), then one x264 slow CRF 18 encode with the music
(`atrim` from its bar line, `aloop` on a bar when too short), the
ducking and the limiter. Reuse is the share rule: the key in the file's
`comment` tag, nothing in `index.json`. Exit 2: fewer than 2 clips, or
no track (`pnpm music` fetches the defaults; `--no-music` cuts on a
fixed 0.6 s grid). Measured 2026-11-11 on 2026-W46 with the bar
grid and 0.65/0.4 s shots (1920×1080@60): Smash It (the default) 174.93
BPM from 65.86 s in the track, 52.13 s, 10 clips, 30 shots, 36 kills
(41 a minute), one merged shot (#251), 76 s to cut and encode, 124.4
MB; WOAH 52.12 s, 10 clips, 30 shots, 41 kills a minute; Slam (136
BPM, 1.765 s bars) 58.23 s, 9 clips (#254 dropped for the cap), 24
shots, 34 kills a minute, four merged shots. A second run reuses the
file in about 6 s. Loudness of the default: -14.8 LUFS integrated,
true peak -3.1 dBTP, LRA 2.6 LU; the music alone (the card) -19.3 dB
RMS, the game audio alone -23.9 dB RMS over the shots, the mix -16.0
dB RMS there. Beat grid against FFmpeg's own `lowpass=f=150` (kick
onset = half-rise of a 10 ms RMS envelope within ±60 ms) on the bar
lines the shots use: Slam median +7.2 ms, worst 22 ms (24 anchors, all
with a kick); Smash It -20.9 ms over all 30, -14.7 ms on the 16 with a
clear kick (worst 39 ms); WOAH -11.4 ms over all 30, -9.1 ms on the 9
with a clear kick (worst 36 ms). The drum and bass grids lead the kicks
by 10–20 ms, under a frame; left as is. Sync of the shots (the same
plan rendered without music, the gunshot transient above 500 Hz
nearest each anchor): 15 of 30 shots have a clear one, 14 of them
within 70 ms, median +20 ms, worst +122 ms (#228; the clips' own
timing is scheduled, up to about 50 ms off; Tick mapping below).

**Even sound** (`src/post/audio.ts`; PLAN.md §6 has the rules).
`audioFilter(mode, params)` is the one builder: `"raw"` gives `""` (no
filter added), `"even"` gives
`acompressor=threshold=-40dB:ratio=3:attack=5:release=400:makeup=20dB,alimiter=limit=-3dB:attack=5:release=100:level=0:latency=1`
from `config.json` → `audio` (`thresholdDb`, `ratio`, `attackMs`,
`releaseMs`, `makeupDb`, `limitDb`; out of FFmpeg's range is refused).
The limiter's 5 ms lookahead and 100 ms release are fixed;
`latency=1` keeps the sound in step with the picture (sample count
unchanged), `level=0` stops alimiter normalising. The ceiling is
-3 dBFS sample peak because the AAC encode adds up to about 1.5 dB on
a shot: at -1.5 dBFS the four clips reached up to 0.0 dBTP, and limiting
oversampled at 192 kHz did not help, so the overshoot is the
encoder's. The chain keeps the source's rate and channels (the masters
are 44.1 kHz stereo). `share.audio` (default `"even"`; `--raw-audio`
for one run) adds `-af <chain>` to the share encode, and the chain is
part of the share key (raw keeps the key files made before even sound
have). `post.audio` (default `"raw"`, today's graph byte for byte,
`test/audio.test.ts`) or `"even"`, which `postGraph` puts after the
concat and before the fades, in `post` and over the whole reel in
`postReel`; the entry's `render.audio` records it. Measured
2026-11-10 (FFmpeg 9.0.1; AAC 128k of the clip's sound, raw → even;
gap: RMS of the 50 ms around the loudest sample minus RMS of the
quietest non-silent 1 s, mono downmix):

| clip | integrated LUFS | LRA LU | true peak dBTP | gap dB |
| --- | --- | --- | --- | --- |
| 50, AWP 2k, 11 s | -21.4 → -18.9 | 10.9 → 5.3 | -4.6 → -2.7 | 30.2 → 15.7 |
| 3, AK 3k, 25 s | -23.1 → -20.4 | 15.9 → 7.7 | -5.7 → -1.6 | 37.3 → 18.1 |
| 11, USP-S 4k, 19 s | -26.8 → -21.5 | 6.9 → 5.1 | -8.6 → -1.3 | 37.6 → 21.2 |
| 53, kills reel, 162 s | -21.5 → -18.8 | 15.7 → 7.8 | -4.0 → -1.4 | 40.9 → 22.4 |

Tried and dropped: `dynaudnorm` (f=100, g=11) closed the gap no more than a
gentler compressor and overshot 0 dBTP (+0.7) through the same limiter;
ratio 4-6 with 100-200 ms release closed the gap 1-3 dB more but pumps
more, so ratio 3 with 400 ms release. Nobody has listened to it yet.

**Death map** (`src/deathmap/`, `src/cli/deathmap.ts`; PLAN.md §7 has
the rules). `pnpm deathmap` writes `library/deaths.html` (temp, then
rename) from the registry and the parse caches, per demo: a current
cache with positions is used; one without them is re-parsed once when
the demo is still in the store (`reparseDemo`: same key, temp then
rename; about 9 s a demo, measured 2026-11-10), else it is counted as
"no positions" and left untouched; with no current cache the demo is
parsed through `parseDemo` if it is there, else counted as not read. No
cache is deleted or invalidated. It launches nothing, writes nothing
else, and is not part of `pnpm go`; the page says per map and overall
how many matches have positions. Every parse (the blocks marked "death
map" in `src/parse/demo.ts`, optional fields within schema 8: a bump
would have made 59 of the 80 caches stale for good on 2026-11-10,
their demos gone from the store, and `pnpm rescore` skips stale ones) adds
victim and attacker X/Y/Z at every `player_death` (from the event's own
player props), the POV's facing angle at each of his deaths (the
scoring's angle, the tick before) and the match footprint (32-unit cells
of live players every 32 ticks; a cache grows by about 30 KB).
`index.ts` builds the data (pure: rows, rounds per side, reel offsets,
backdrop); `view.ts` holds the filter, the spot clustering (densest
point seeds a spot of everything within 300 units, repeat) and the
summary, and is inlined into `page.html` with its types stripped
(`node:module` `stripTypeScriptTypes`), so the page and
`test/deathmap.test.ts` run the same code. A death's reel link is
`index.html#clip=<no>&t=<s>`, `t` the take's start inside the reel (the
sum of the earlier takes' `render.windows`), left out when the windows
do not add up to the reel's `seconds` within 0.5 s; the library page
does not read that hash yet. Opened from disk; drawn on one canvas.

`pnpm prep` (PLAN.md M5; pnpm's own `setup` and `doctor` commands take the
obvious names, so `pnpm check` is the report-only form) makes a PC ready:
Steam and CS2 from the registry and `libraryfolders.vdf`, the pinned HLAE
and FFmpeg downloaded into `tools/` with their sha256 checked (the pins
and hashes are constants in `src/cli/setup.ts`; a new pin goes there and
in `docs/spikes.md`), `tools/hlae/ffmpeg/ffmpeg.ini` written when there
is none, and `.env` created from `.env.example` with `HLAE_EXE` and
`CS2_EXE` filled and the two SteamIDs asked for. A value that is set is
never changed. Both forms end with one line per requirement (Node, Steam,
CS2, the `.env` keys, HLAE, the FFmpeg HLAE captures through, the FFmpeg
post encodes with and whether it has NVENC, the POV account's saved CS2
convars, which account Steam is logged in with, cs2.exe / HLAE.exe
running, a browser for `--browser`), never an ID or a key, and exit 1
when a required one is missing.

`pnpm grab` (PLAN.md's `pnpm fetch`; pnpm's own `fetch` command takes that
name) runs the demo sources, each writing new demos into `demos/inbox/`,
then ingests the inbox; it renders nothing. Sources: **folders** copies new
demos, read-only, from watched folders (default CS2's `game/csgo/`, where
the FACEIT client's "Watch demo" and manual downloads land, its `replays/`,
where the Watch tab's downloads land, and `~/Downloads`; `config.json` →
`sources.folders.dirs` overrides; not recursive), skipping
any whose content is already in the store; **faceit** (with
`FACEIT_API_KEY`) lists new FACEIT matches and downloads their demos, by
the Downloads API (needs a scope FACEIT did not grant) or, with `--browser`
(or `config.json` → `sources.faceit.via: "browser"`), through the user's
logged-in FACEIT session in the installed Chrome or Edge, signed in once
with `pnpm grab --login` (`docs/faceit-api.md`); since 2026-10-24 that
click runs a Cloudflare bot check that fails in the automated browser, so
the source stops within 30 s of the click with every new match pending
and its room link printed, and the demo is downloaded by hand (below). `--last <n>` backfills
instead: the demos of the last n FACEIT matches through the browser
session, oldest first, one at a time with a random 4–8 s pause (`sources.faceit.pauseSeconds`) between
downloads, skipping matches already in the store (match id in a stored
file name; ingest drops content duplicates) and stopping on the first
failure with a screenshot in `state/browser-failures/`; a rerun resumes
(`state/sources/faceit-backfill.json`). A pending FACEIT match is printed
with its room link: "Download demo" there lands the file in Downloads,
where the folders source picks it up on the next run. **valve** (with
`STEAM_WEB_API_KEY`, `STEAM_MATCH_AUTH_CODE`, `STEAM_LAST_SHARE_CODE`)
walks the main account's share codes after the last one handled
(`state/sources/valve.json`; the start code itself is not fetched), at
most `sources.valve.maxMatchesPerRun` (5) per run, oldest first, and has
CS2 download each match itself (`sources/valve-fetch.ts`; the contract and
its reasons are in `docs/m6-mm-fetch.md`, the measurements in
`docs/spikes.md` M0.4): one launch per code, in order, `cs2.exe` started
directly on the render account with `-insecure … +csgo_download_match
<code>` and nothing that joins a server, under the render launch's guards
and lock (`state/.render.lock` taken before the guard and released by the
fetch launch alone, once its cleanup is verified; a lock held by a
render, `.clip.lock` / `.go.lock`, a running CS2, the FACEIT client or the
wrong Steam account makes the source blocked with every code pending, never a
failure). The game's own logon line in `console.log` must name
`RENDER_STEAM_ID64`, or the launch is killed. A code is done when that
line has named the render account, its
`replays/match730_<outcome id>_….dem` appeared or changed after the
spawn, its `.dem.info` names the code's match id, the demo is complete
and it held still 10 s (a complete demo without the logon line ends the
launch pending, nothing advanced); then the game is killed and its cleanup
verified, then the demo is copied into the inbox (the folders source's
copy-and-rename, 2 GiB limit), about 55 s per code on the author's PC
(the gate's 85 s included a 30 s watch the product does not run). It is
gone when the game says the match has expired, or
when it has been pending over 30 days (`pending[code].firstSeenAt` in the
state; Valve keeps demos about that long). Otherwise it is pending
(replays/ idle 180 s, or the 300 s cap) and the run stops there. The
checkpoint advances only over done and gone codes, in order; a code whose
demo is already stored (its padded outcome id leads a stored demo's name,
`match730_<id>_` or the old GC path's `valve-<id>_`) is passed without a
launch. Before each launch an orphan `match730_<id>_*.dem.info` (no
complete `.dem` beside it, field 1 the code's match id) is deleted: a
download killed between the two files leaves it, and while it is there
the game never downloads that match again; that is the one write under
`game/`. A launch's cleanup that cannot be verified stops `pnpm grab`
(no further source, no ingest; exit 3, the lock stays). A `.dem` anywhere
that is not complete (no valid `DEM_FileInfo` at the header's offset:
cut short or still being written) is pending in the folders source and
rejected by ingest as "incomplete demo" (`demoIncomplete` in
`src/parse/fileinfo.ts`). Pending items are
not failures; exit 1 means a source failed or ingest rejected a file, 3
a fetch launch's cleanup was not verified.

`pnpm go` is the one command: drop demos (`.dem`, or `.zip` / `.bz2` /
`.gz` / `.zst`) into `demos/inbox/`, run it, come back to clips. It
ingests the inbox, ranks every registered demo, renders the moments
`config.json` → `batch` selects (every moment scoring at least `minScore`,
40; when none in a demo does and `fallbackBest` is true, its single best)
that the library does not hold yet (settled demos, listed in
`state/settled.json`, are skipped whole: a demo is settled when a pass
over it finishes, with every selected moment rendered, held or failed
for good (not on a dry run, a repost or a `--no-reels` pass), or by
`pnpm go --settle-existing`; rule changes apply from the
next new demo, never to settled ones; `pnpm unsettle <hash prefix | clip
no>` reopens one; `pnpm rescore` only updates the scores the library
shows: each highlight's rank, score, breakdown and flags recomputed with the
current `scoring.json` from the demo's cached parse, nothing rendered or
unsettled), with one CS2 launch per demo for all
of them (chained takes, below), and rewrites
`library/index.html` (open it from disk). It refuses to start while CS2 or
the FACEIT client runs (its anti-cheat stops HLAE from creating cs2.exe, 2026-10-25;
exit the client from its tray icon; a dry run does not care) and stops the
whole batch on the first guard refusal (exit 2) or unverified
cleanup (exit 3); exit 1 means a job or demo failed (`state/failures.json`).
Run it again to resume: nothing new means no launch. `--dry-run` lists what
it would render. While a launch runs, the controller prints a `[controller]`
line for every state it reaches and, in between, a heartbeat roughly every
5 s (`<title>: waiting for the game to start, 12 s of 60`, `take 2 of 5:
capturing, 8 s of 150`; a log-based limit is only counted once the game's
console.log is live, and the line says so until then); a launch that
times out before the demo has loaded
also reports HLAE's hidden error dialog, when there is one
(`src/render/controller/hlae-dialog.ts`, e.g. `HLAE error 2002: Loader
could not create requested process. GetLastWin32Error = 5: Access is
denied. …`), in the console and in the failure reason.

`pnpm moments` parses, scores and ranks a demo's moments (no launch;
`docs/scoring-notes.md`). `pnpm clip --top n` renders the n-th ranked
moment, `pnpm clip <start> <end>` a hand-written tick range; either way no
hands after the command: guarded render → post → `library/clips/<id>.mp4`
+ `library/index.json` (a ranked clip's entry carries its `moment`: rank,
score, breakdown, kills, flags). A clip the library holds is never made
again by `pnpm go` or `pnpm clip`, whatever changed (AGENTS.md); `pnpm clip
--rerender <no|id>` is the one way: it ranks the demo afresh, renders that
moment now, and when the span rules gave the moment a new id, moves the
old clip to `library/replaced/` in the same index write that adds the new
one, which keeps the old one's number (the file moves after that write);
under the same id the old file moves to `library/replaced/<id>.<ms>.mp4`
first, since Windows will not replace a file the library page has open.
A hand-written range re-renders by
its ticks; a ranked moment takes the ranked spec with its id, else the one
sharing the most kills with it that shares none with another clip (a tie
refuses). `--lead <s>` (ranked moments only, 0 to 30 s) builds that clip's spec with an s-second lead-in
instead of `clip.leadInSeconds` (the moments cache is neither read nor
written for it); the entry records `leadOverride`. Every entry has `no`, the human clip number
("clip 17"): sequential in the order clips entered the library, stable,
never reused or renumbered (`nextNo` in `index.json` only grows; entries
from before numbering got theirs oldest first). The page shows it on each
card and finds a clip by it ("17", "clip 17", "#17") or by title text;
the content-hash id stays the file name.
Exit codes: 0 ok or already in the library, 1 failed (recorded in
`state/failures.json`), 2 refused (nothing launched), 3 cleanup not
verified (a game process may still run; `state/.render.lock` stays and is
deleted by hand after checking no cs2.exe / HLAE.exe is left).
`--dry-run` resolves the facts, id and render key without the guards or a
launch. Keep hands off the game window while it renders: a click changes
the spectated player (docs/spikes.md, M0.2 open items).

## Where things are

| Path | What |
|---|---|
| `config.json` | render settings: `hud` (`full` default = in-play HUD, `bare` = crosshair and killfeed only), output `width`×`height` (default 1920×1080, 16:9, whatever the player's own `cs2_video.txt` says), `aspect`, `fps` (60), HLAE's intermediate `captureCrf`, final `crf`, `fadeSeconds`; `ingest.keepOriginals` (default false: the file a demo arrived in is deleted once the store holds it); `montage` for `pnpm week`: `top` (10), `maxSeconds` (60, the video's cap), `music` (`smash-it.mp3`, the default track, a file name in `music/`), `musicGainDb` (-7, the music up front), `shot` (`preSeconds` 0.65 and `postSeconds` 0.4 around each kill); `post.audio` (`raw` default, `even`) and `share.audio` (`even` default, `raw`); `vertical` (`width`, `height`, `crf`) for `pnpm vertical`; `cut.crf` (18) for `pnpm cut`; `film` for `pnpm film`: `top` (20, highlights per player), `minScore` (40, a highlight's film score must reach it; absent: 0), `bloopersTop` (5), `masterHandleSeconds` (2) and `masterCaptureCrf` (8) for `pnpm film masters`, `bloopers` (`minScore` 50 and the detector thresholds; Bloopers above); the even-sound chain's `audio` parameters (`thresholdDb`, `ratio`, `attackMs`, `releaseMs`, `makeupDb`, `limitDb`; Even sound above) |
| `.env` | identities and tool paths, and the optional film roster `FILM_STEAM_ID64S` (`.env.example`; `pnpm prep` fills it; M0.2 setup in `docs/spikes.md`) |
| `src/cli/setup.ts` | `pnpm prep` / `pnpm check`: tool pins with their sha256, Steam and CS2 lookup, the requirement report |
| `docs/m6-mm-fetch.md` | the execution plan for M6 (matchmaking demos fetched through a CS2 launch, no login): phases, agents, gate, tests |
| `setup.ps1`, `GUIDE.md` | the one-line bootstrap (`irm … | iex`: winget for git and Node, corepack or pnpm's installer for pnpm, clone or fast-forward pull of a checkout of this repo, `pnpm prep`, every exit code checked, nothing installed when winget is missing) and the step-by-step guide it points to |
| `scoring.json`, `scoring.film.json` | ranking weights, and `pnpm film`'s own (same shape); tuning and current picks in `docs/scoring-notes.md` |
| `src/cli/go.ts`, `src/cli/clip.ts`, `src/cli/moments.ts` | the entries |
| `src/ingest/` | watch folder (`index.ts`, with the first-full-packet fix in `full-packet.ts`), the source contract (`sources.ts`), sources (`sources/folders.ts`, `sources/faceit.ts` with its browser path `sources/faceit-browser.ts`, `sources/valve.ts` with its CS2 fetch launch `sources/valve-fetch.ts`) |
| `test/` | `pnpm test`: FACEIT source against recorded fixtures (`test/fixtures/faceit/`), the Valve source against a fake Web API and fetcher, and the folders source on temp folders; no network, no game launch |
| `src/queue/` | the batch and its job ledger (`index.ts`); one clip job, shared by `pnpm clip` and the batch (`job.ts`) |
| `src/library/page.html`, `page.ts` | the library page template and its writer |
| `src/film/` | `bloopers.ts` the blooper detector, its settings, the overlap pick and the blooper id; `track.ts` the position/view track, its cache and the parse a blooper pass uses (`parseAnyPov`); `select.ts` the film selection (top N per player); `masters.ts` `pnpm film masters` (plan, key, span, unit, mux) |
| `state/<demo sha256>/pov-<povKey>/`, `moments.film.json`, `bloopers-track.json.gz` | a film player's parse and moments caches (or `absent.json` when he is not in the demo); every POV's film-weighted moments beside its `moments.json`; the demo's blooper track |
| `src/library/film.html`, `film-page.ts`, `film-selection.ts` | the film picker's template, its writer (called by `writeLibraryPage`), the selection snapshot |
| `library/film-picks.json`, `library/film-selection.json`, `library/film.html`, `library/film/masters/` | the clips picked for the film; the last film pass's lists (display data); the film picker; the masters, one folder per player |
| `src/library/stars.ts`, `facets.ts`, `hash.ts`, `match-date.ts` | the stars and film-picks files; the feat, weapon and player filters' derivation (blooper kinds as feats); the `#clip=<no>&t=<s>` parser (its source is inlined into the page); the one rule that dates a clip's match (page, `pnpm week`, death map) |
| `src/share/` | derived copies of a library clip, none of them in `index.json`: `index.ts` share, `vertical.ts`, `cut.ts`, `caption.ts` |
| `src/week/` | `pnpm week`, the fragmovie: `index.ts` ISO weeks, selection, plan, key and render; `edit.ts` shots and their layout on the beat grid; `beats.ts` the beat analysis; `music.ts` the manifest, downloads, track choice and the analysis cache |
| `music.json` | the default tracks for `pnpm week` (tracked): file, url, sha256, BPM, title, artist, licence, credit |
| `music/` | the tracks (`pnpm music` fetches the defaults; any audio file dropped here works) and their `<file>.beats.json` caches; gitignored, music is never committed |
| `src/deathmap/` | `pnpm deathmap`: `index.ts` data and writer, `view.ts` filter/clusters/summary shared with the page, `page.html` template → `library/deaths.html` |
| `demos/` | `inbox/` (drop here), `store/<sha256>.dem` (ingested demos, the only copy by default), `ingested/` (the archives demos arrived in, only with `config.json` → `ingest.keepOriginals`), `rejected/` (with `.reason.txt`) |
| `state/demos.json`, `state/queue.json`, `state/sources/<name>.json` | demo registry (paths relative to the repo, State paths below); job ledger; each source's progress |
| `src/parse/demo.ts` | per-demo extraction, cached in `state/<demo sha256>/parse.json` |
| `src/parse/clip-facts.ts` | what one render needs: tickrate, demo hash, map, POV slot at the clip's ticks, round |
| `src/score/index.ts` | round context (1vX), one moment per round, scoring |
| `src/clip/` | clip specs (`index.ts`: boundaries, merge, action windows, id, title); `moments.ts` writes `moments.json` / `moments.txt` |
| `src/render/controller/` | `index.ts` state machine, `guards.ts`, `processes.ts`, `launch.ts` (cleanup, emergency hooks, console.log reader; shared with the fetch launch), `hlae-dialog.ts` (HLAE's hidden error dialog read on a launch timeout), `cfg.ts` |
| `src/render/capture/hlae.ts` | HLAE launch arguments and `mirv_streams` lines |
| `src/post/` | trim and fade (`index.ts`, its graph in `postGraph`), FFmpeg probes (`ffmpeg.ts`), the even-sound chain (`audio.ts`) |
| `src/library/index.ts` | clip id, atomic publish, index and failures |
| `state/render/<id>/<attempt>/` | per-attempt work dir: generated cfgs, `capture.json`, `console.log`, `render.json`; the raw capture itself only until the clip is published (Deleting, above) |

## Decisions made in M1

- **Fast-forward.** A moment is never cut short: its span runs from the
  engagement start to its outcome event, however long. Length is handled in
  post. The spec's `windows` (`actionWindows`, `src/clip/index.ts`) run from
  2 s before to 1.5 s after each POV kill, damage dealt or taken, weapon
  fire and outcome event (the clutch's plant, defuse or round end), clamped
  to the span (a clutch's ends 1 s after its outcome). Windows
  closer than `FAST_FORWARD_GAP_S` (4 s) merge, so short pauses play as
  they are. Post (`segments`, `src/post/index.ts`) plays each window at
  normal speed and each gap between two windows at `FAST_FORWARD_SPEED`
  (8x) with the audio muted: trim/setpts per segment, fps resampling for
  the fast ones, then concat, with fades over the whole clip. The first
  window starts at the clip start and the last ends at its end, so the
  lead-in (`config.json` → `clip.leadInSeconds`, 4 s) and the tail after
  the last kill (`clip.tailSeconds`, 5.5 s; the span runs on to the clutch
  outcome + 1 s if later, past round end too, capped only by the next
  round's start, after the last round by the demo's end) always play in full. About 30 s is a
  goal, not a cap.
  A hand-written range has no windows and plays whole. The library entry's
  `render.segments` lists what was played at which speed, and `seconds` is
  the output length.
- **Tick mapping, scheduled.** The capture records `MARGIN_TICKS` (32) on
  each side of the requested ticks. The frame rate is locked (HLAE's
  "Finishing movie … [N frames" line, the demuxed frame count and the WAV
  length must agree), but where recording starts varies per launch. Post
  does not measure it: it trims by the scheduled record-start tick shifted
  by `RECORD_START_OFFSET_FRAMES` (−3.4, `src/post/index.ts`), the median of
  the seven per-capture offsets measured on this machine in M0–M3 (−0.4 to
  −3.5 frames). So a clip can land up to about 3 frames (50 ms) off either
  way. Every library entry says `timing: "scheduled"`. The finished clip is
  validated only: it decodes cleanly, has one video and one audio stream,
  the configured size, a duration within 0.5 s of the requested interval,
  and frames sampled at 10/30/50/70/90 % are not black (mean luma > 12).
  Entries made before this have no `timing` field (they were timed from
  the muzzle flash and gunshots) and stay as they are. `pnpm go --repost`
  launches nothing: it posts every selected moment that is not in the
  library and has a completed capture (e.g. jobs a post change failed),
  ignoring the attempt limit; selected moments without a capture are
  listed, and a normal `pnpm go` renders them.
- **Crosshair.** Demos recorded since CS2's 22 September 2026 update carry
  the player's crosshair; older ones do not. The gate is the demo header's
  `patch_version` against `config.json` → `crosshairFromDemoSincePatch`
  (`crosshairSource`, `src/render/controller/cfg.ts`): at or above it,
  the look cfg leaves out every `cl_crosshair*` / `crosshair` convar and
  the job sets `cl_show_observer_crosshair 2` (the demo's crosshair);
  below it, the look cfg keeps the main account's saved crosshair convars
  and the job sets `cl_show_observer_crosshair 0` (the spectator's own,
  i.e. the main account's). Empty (absent, `null`, `""`) means always the demo's. The
  value 14182 is inferred, not looked up: Valve's notes give no build
  number, and the store's demos show 14181 on 15 September and 14182 from
  23 September on (FACEIT match dates). The render key changes only where
  the picture does: for "demo" the look hash lacks the crosshair lines
  (they never showed), for "own" the inputs add `crosshair: "own"`. Each
  library entry records `crosshair: { source, demoPatch, cutoff }`;
  clips made before the policy have none and stay as they are.
- **HUD.** `full` (default) aims at the HUD as in play
  (`docs/hud-reference-inplay.webp`): `cl_draw_only_deathnotices 0`,
  `cl_radar_square_when_spectating 0` in the cfg body (round, rotating
  radar; the player's look cfg sets it true), and HLAE `mirv_panorama
  panelStyle … opacity=0` 8 ticks before recording on `SPECTATOR_PANELS`
  (`src/render/controller/cfg.ts`): `panelClassName=Frame` (the equipment
  block of all ten cards), `panelId=jsHudSpecplayer__Bg` (observed name,
  clan, weapon name) and `panelId=HudSpecplayer__Avatar` (so the bottom
  centre shows the team emblem). `panelId` hits only the first panel with an
  id; `panelClassName` matches the C++ panel class. Known leftovers, no id
  reaches them: the player names above the card avatars, the health number
  under each card, and the marker under the observed player's card. `bare`:
  crosshair and killfeed only. `--debug-cmd
  "__mirv_panorama_print_children <PanelId>"` schedules a panel dump after
  `spec_player` (output in the job's `console.log`); nothing else is
  accepted, and debug commands are part of the render key.
- **Two encodes.** HLAE writes the intermediate at `captureCrf` 12; post
  re-encodes once at crf 18 (trim and fades need a re-encode anyway).
- **Clip id** = first 16 hex of sha256(demo sha256, round, start, end).
  A moment counts as done once `index.json` holds it (Ledger, below), with
  any render key. The render key (settings, tool versions, look cfg hash,
  POV and slot) picks what an unfinished job may resume: a validated raw
  capture (`capture.json` in its work dir) with the same key is reused, so a
  failed post never costs another launch. Only `--rerender` renders a held
  clip again.
- **Ownership and kill.** The loader counts only as this controller's own
  child created in the spawn window; processes are keyed by pid + creation
  time + image. `killExact` opens a handle, re-checks that identity and kills
  through the handle, closing the check-to-kill pid-reuse race noted in
  M0.2. Cleanup (`src/render/controller/launch.ts`, shared with the fetch
  launch) kills in rounds with re-discovery (an encoder orphaned by a
  killed cs2.exe is adopted if created in its parent's lifetime), re-kills
  an owned process still found during verification (bounded), needs 10 s
  of continuous quiet (no owned process, no suspect orphan, no cs2.exe)
  within 60 s, and fails closed: a loader never identified, any owned
  process left, or any cs2.exe at all means exit 3. Residual, no Windows Job Object: a descendant that
  starts and exits between two 0.5 s polls is never seen.
- **Launch evidence.** `-condebug` rewrites `game\csgo\console.log` in the
  CS2 install each launch; the job cfg has a per-launch name
  (`croclip_<ms>`), and the log counts as this launch's only when its
  `[CommandLine]` line carries that name.
- **Captures first, posts behind.** `pnpm go` renders a demo (`runJobs`
  with `renderOnly`), then queues its captured units for a post worker
  (`src/cli/post-worker.ts`, its own process at below-normal priority:
  post is synchronous FFmpeg and would stall the controller's polling)
  and launches the next demo at once, never waiting for a post (Peder,
  2026-11-02): every launch runs back to back, so CS2 is done and closed
  early, and go says so; the posts run one at a time behind the launches,
  and the batch waits for the last one. Raw captures (about 700 MB per
  clip) wait on disk until their post has run.
  The worker only posts (every unit post-only, so a missing capture is a
  refusal, never a launch), takes no clip lock, and writes results to a
  file; `pnpm go` alone writes the ledger. Index writes are serialised by
  `state/.index.lock`. Measured on the 19-demo run of 2026-10-15 before
  this: capture 2000 s, post 1246 s (24 s per clip), post blocking the
  next launch.
- **Final encode.** `config.json` → `post.encoder`: `x265` (the setting
  since 2026-11-02, Peder) encodes H.265 with libx265 (`-preset slow -crf
  <crf> -tag:v hvc1`) on the post FFmpeg, at `render.crf` 22. Measured
  2026-11-02 on two 12 s 1080p60 captures (clip 222's demo, hard; and a
  calmer one) against the earlier NVENC CQ 22 default: 37 vs 49 MB and
  18 vs 39 MB, VMAF 98.7 / 98.8 vs 99.0 / 99.5 against the raw, about
  55 s to encode 12 s (NVENC 4 s); tuned hevc_nvenc (p7, multipass,
  lookahead, B-frames) at CQ 24 saved only 22-26 % and lost more on the
  hard segment; the RTX 3080 Ti has no AV1 encoder. `auto` uses
  h264_nvenc (`-preset p5 -tune hq -rc vbr -cq <crf + 4>`, so 22 for CRF
  18; `render.crf` means each encoder's own scale, so set it back to 18
  with `auto`, `nvenc` or `x264`) whenever a one-frame test encode works on either FFmpeg, else x264
  (`-preset slow -crf 18`); a failed NVENC encode falls back to x264 and
  logs why. The entry's `render.encoder` says which made it. Post runs
  the FFmpeg in PATH (`postFfmpeg()`, on this machine the same system
  build HLAE's capture pipe uses via `tools/hlae/ffmpeg/ffmpeg.ini`, which
  the render key names), else the pinned `tools/ffmpeg/ffmpeg.exe` that
  `pnpm prep` downloads (on a fresh PC `ffmpeg.ini` points at it too). The
  NVENC probe tries the post FFmpeg first, then the pin
  (`nvencFfmpeg()`): FFmpeg 9 opens NVENC only
  on NVIDIA driver 610+, and the pin is FFmpeg 7.1.1, which also works on
  older drivers (it did on 591.86). With driver 617.42 the system FFmpeg
  9.0.1 passes and the pin goes unused. Pin source:
  `https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip`
  (92,234,348 bytes, sha256 `04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4`;
  no checksum is published for it any more, so this one is as
  downloaded); `bin/ffmpeg.exe` extracted, sha256
  `b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997`.
  Measured 2026-10-15: on one 15 s 1080p60 capture segment, x264 CRF 18
  16.2 s, 42.4 MB, SSIM 0.9769 against the raw; NVENC CQ 22 6.9 s,
  49.3 MB, SSIM 0.9773; a crop of the same frame shows no visible
  difference. Whole post of clip 59 (system FFmpeg 9.0.1, driver
  617.42, validation included): x264 44.0 s, 105.1 MB; NVENC 20.1 s,
  126.2 MB.
- **Chained takes.** One launch renders every take of a demo
  (`runJobs`, `src/queue/job.ts`): the jobs the library does not hold and
  that have no validated capture, in tick order (`planTakes`), except that
  a take playing past the match end runs last: past the last `round_end`
  CS2 is in its end-of-match state, which no seek back undoes, so every
  later take would record the end-of-match screen (clip 186, 2026-10-31).
  Reel takes stop short of the match end when their event does; one unit
  per launch may still pass it (the first: highlights before reels); any
  other is deferred: left out of the launch without spending an attempt,
  its demo stays open, and the next `pnpm go` renders it in a launch of
  its own (the batch report lists it). The match end is the last parsed
  round's end (`matchEndTick`, `src/parse/demo.ts`) for highlights and
  reels alike. The main cfg schedules
  take 0; each take's record end runs the next take's cfg
  (`croclip_<ms>_t<i>`), which clears every scheduled command, points the
  recorder at its own ffmpeg slot (`croclip<i>`, video `video<i>.mp4`),
  seeks with `demo_gototick` (forward or back) and schedules its own
  spectate (its own slot), record and next step; the last quits. The
  state machine waits for each take's seek, start and "Finishing movie"
  in turn. A take is validated on its own: a usable take is kept even
  when another take of the launch failed; an unverified cleanup voids
  them all. Each clip's attempt dir gets its own `capture.json` pointing
  into the shared `state/render/launch-<demo>-<ms>/`. Measured on
  2026-10-15 (`docs/spikes.md`): seeks take 1–2 s either way, a rewind
  is frame-aligned, and the 2 s settle is enough.

## Decisions made in M2

- **Match rounds.** A round is a `round_end` with a winner after the last
  `begin_new_match` (FACEIT's warmup and knife restarts come before it; a
  demo without it is refused). Rounds are numbered 1…n from there; above 24
  is overtime. A knife round is the match's first round when every shot fired in it was a knife (a later round without a gunshot is a normal round),
  read on bare weapon names (`weapon_fire` names carry a `weapon_` prefix
  that deaths and hurts do not; `bareWeapon`, `isKnife`, `isGunshot` in
  `src/parse/demo.ts`). Until 2026-11-12 the prefix hid every knife round
  and counted knife swings and grenade throws as gunshots; the parse
  schema was not bumped for the fix (Death map's reason: caches whose demo
  is gone would go stale for good), so scoring re-derives the knife round
  from the fires (`isKnifeRound`) and drops a cached flick whose shot was a
  swing or a throw (`flickYaw`) on an older cache.
- **Alive state** is every player's team and alive flag at each round's
  freeze end and round end, plus the deaths in between, instead of a full
  per-tick table: that is what 1vX needs. A round where someone alive at
  freeze end neither died nor was alive on the same team at round end
  (disconnect, team change) is `rosterChanged` and gets no clutch.
- **Events** belong to the round whose start they follow, up to the next
  round's start; scoring ignores anything after the round end.
- **Parse cache key** = demo sha256 + demoparser2 version + schema version
  + POV; a mismatch re-parses. Temp file per writer, then rename.
- **Clip id** for a ranked moment = the same `clipId` over (demo sha256,
  match round, start, end); `pnpm clip --top` refuses if the render's own
  facts give another id.

## Decisions made in M3

- **Ingest.** A file in `demos/inbox/` is taken when its size, mtime and
  file id held for 2 s; writers must use a temporary name (leading dot,
  `.part`, `.tmp`, `.crdownload`) and rename when done. `.zip` goes through
  Windows' own `tar.exe` (listed first; only `.dem` members, no `..`,
  wildcard, option-like, colon or duplicate names; 20 members, 2 GiB per
  demo, 6 GiB total); `.bz2` through `seek-bzip` (the one added dependency;
  Node has no bzip2), `.gz` / `.zst` through Node's zlib, all bounded while
  unpacking. The result must start with `PBDEMS2`. A demo whose first
  `DEM_FullPacket` carries the `instancebaseline` / `AnimAssetData` tables
  (CS2 crashes re-applying it at playback start, `docs/spikes.md`) is
  replaced by a copy without them (`src/ingest/full-packet.ts`; the inbox
  file itself is never rewritten). Demos are hashed and
  moved to `demos/store/<sha256>.dem`, registered per demo; a store file
  missing from the registry is registered on the next run. The store copy
  is the demo from then on: the archive it arrived in, and a file whose
  demo the store already holds, are deleted once the registry has the
  demo (decided 2026-10-26: `ingested/` had doubled the disk use), or moved
  to `ingested/` with `config.json` → `ingest.keepOriginals: true`. A zip
  that also holds files that are not demos is kept in `ingested/` either
  way: those are never unpacked, so the zip is their only copy. Bad
  input goes to `rejected/` and is never deleted; an archive one of whose
  members was rejected goes there too, beside that member.
- **State paths.** `state/demos.json` and every `capture.json` name their
  files relative to the repo root, with forward slashes
  (`src/state-paths.ts`), so the folder can move: decided 2026-10-26, when
  49 of 55 registry entries still pointed at the folder the repo had left.
  Readers resolve; an absolute path (from before, or a file outside the
  repo) is used as it is while it exists, never swapped for a same-named
  file here; one that is gone is re-rooted: a registry entry to this
  repo's `demos/store/<its sha>.dem`, a capture's media by the components
  after the last `state/render/` in it. `pnpm go` and `pnpm grab` rewrite such registry entries once
  (`rewritten` in the ingest report: "registry: N demo path(s) rewritten");
  old `capture.json` files are not rewritten, only read that way. Still
  absolute: `library/index.json` entries (`demo`, `render.workDir`, read by
  `pnpm clip --rerender`), `state/deleted.json` (copies of them) and
  `state/failures.json`.
- **Stage keys.** parse.json (demo hash + parser + schema + POV),
  moments.json (parse key + weights + clip rules + schema; an empty list is a valid
  result, a parse error is a failure in `state/failures.json` under
  `demo:<sha256>`), the library entry and `capture.json` (render key).
- **Ledger.** `state/queue.json`, keyed by clip id + render key, so a
  settings or tool change starts a fresh attempt budget. A job is marked
  running before it may launch; a run that dies mid-job leaves it running
  and the next run retries it once (two attempts in all, then it is listed
  as given up until `--retry-failed`). A moment the library holds is done
  whatever the ledger or the render key says: the same clip id, or a clip
  of the same demo and round sharing a kill (made under other span
  rules; sharing one kill is enough on purpose, even when the new span
would add kills). A held entry whose file is missing is reported, not
re-made. Only a guard refusal gives
  the attempt back. Locks (`state/.go.lock`, `.clip.lock`, `.render.lock`)
  are released on normal exit, errors and signals: outside a launch, Ctrl-C
  ends the process through `process.exit` (`exitOnSignal`, `launch.ts`;
  Node's default is a plain kill, which fires no exit hook, and until
  2026-10-26 `pnpm go` and `pnpm clip` had no handler, so a Ctrl-C during
  parse or post stranded `.go.lock` and `.clip.lock`), and a render lock
  taken before its launch is given back the same way; during a launch the
  launch's own hook runs the cleanup first and releases `.render.lock` only
  once that is verified. A hard-killed run (task manager, a closed terminal
  tab) leaves them, to be deleted by hand after checking no cs2.exe /
  HLAE.exe is left; the refusal names the pid in the lock and whether it
  still runs, and `pnpm grab` says the same of a `.go.lock` / `.clip.lock`
  it finds, instead of "run pnpm grab after it finishes" for a dead one.
  `pnpm grab`'s `state/.grab.lock` guards no game process, so a run whose
  pid is gone (a closed terminal tab is a hard kill) is taken over by the
  next grab, which says so. The takeover is serialized by an exclusive
  `.grab.lock.takeover` file, held only while the stale lock is replaced;
  a grab hard-killed inside that moment (milliseconds, and only after an
  earlier crash) strands it, and later grabs refuse until both files are
  deleted by hand. Ctrl-C releases `.grab.lock`; during a fetch launch it
  also runs that launch's cleanup, which releases `.render.lock` once
  verified (exit 3 and the lock stays otherwise); a hard kill mid-launch
  leaves the game and `.render.lock`, handled like any other.
- **Library page.** `src/library/page.html` (committed) with the clip
  index inlined as JSON, every `<` escaped, so it works from `file://`;
  videos load by relative path. One static dark file, plain CSS and JS:
  a sidebar with Find (clip number or title), sort and the categories kind
  (highlight, deaths, kills; entry `kind`, absent = highlight), map and
  match (one per demo, dated by `state/sources/matches.json`, which
  `pnpm grab` fills from FACEIT history when there is a key; any other
  demo shows "added <day>", the day it was ingested, since a demo carries
  no match time of its own); the selected clip plays as large as the
  window allows at 16:9, with sound (browsers allow sound only after a
  click or key, so the first clip on load waits); a compact list of the
  category's clips (number, title, score, length) with the playing one
  marked; left/right or j/k step through it. Sort defaults to highest
  score; picking the deaths or kills kind switches it to newest match
  (reels carry no score), and the select still overrides it. Controls reset on every
  load, so a browser restoring old form values cannot leave it looking
  empty. "Newest clips" at the top of the sidebar clears the filters and
  sorts by date added; the playing clip is marked by a tint and a bold
  number. `src/library/page.ts` rewrites it (temp, then rename) after every
  clip a job publishes and at the end of `pnpm go`; inside a run it says
  "Run in progress: N clips so far". Under the player: the action row
  (star, the joined Share / Vertical / Trim group, delete), the trim
  bar when open, and one output line for what Share, Vertical and Save
  cut made (from disk: their commands); the player's width leaves room
  for both (`--below`, set by `fit()`). `#clip=<no>[&t=<s>]` selects a
  clip (PLAN.md §7); "Death map" shows when the data has `hasDeathMap`;
  "Film picker" links to `film.html`. The action row starts with the
  film toggle ("+ Add to film" / filled "✓ In the film", `aria-pressed`),
  and `f` toggles the playing clip (not in the search field or the
  sort; the page's other keys: arrows or j / k step, `s` stars and
  Delete deletes when served, `i` / `o` / Escape in the trim bar).
  Picked clips carry a film mark before their number in the list, whose
  header counts "N in the film"; the sidebar's "Film picks" row counts
  and filters them, all live. Served, a toggle saves at once; from disk
  the changes collect in a bottom bar as `pnpm pick` / `pnpm unpick`
  commands to copy (a clip toggled twice drops out), with a link to
  http://127.0.0.1:8765/. Both pages hold the picks through one shared
  store, `src/library/pick-store.js`: plain browser JavaScript the
  writers inline in place of `/*__PICKSTORE__*/null` (the server's
  last answer with the changes in flight replayed; `GET /picks` on
  load), run as that same text by `test/film-picker.test.ts`.
- **Film picker.** `src/library/film.html` (committed) with its data
  inlined the same way (`/*__FILM__*/{}`), written to `library/film.html`
  by `writeLibraryPage` (`src/library/film-page.ts`) after the library
  page (`libraryThenFilm`: a picker failure is one logged line and never
  stops the library page), so every command that rewrites the library
  page rewrites it. A `film-selection.json` whose shape does not check
  out (`parseFilmSelection`) counts as no snapshot. Data (`filmPageData`): per
  player of `library/film-selection.json` a group (the main account's
  headed "Me", its name beside it), Highlights then Bloopers, each card
  the index entry's file, title without the "<player> · " prefix and the
  map, map, length, and the snapshot's rank and film score (a blooper's
  kind label from `BLOOPER_FEATS`); clips the index no longer holds
  left out; then "Picked, not in the current lists": every pick in no
  list, with its library score and player. No snapshot: only that group.
  Cards load their video near the viewport (`preload="metadata"`, a
  frame 1.2 s in, past the fade); hover plays muted from the start; a
  click opens an in-page dialog with sound and controls, its own toggle
  and a link to `index.html#clip=<no>`. The footer is one toggle button
  ("+ Add to film" / filled "✓ In the film" with a FILM badge on the
  clip); Tab reaches each toggle, Space/Enter toggle, arrows move to the
  nearest card that way, P plays or pauses that card with sound. Served,
  it reads `GET /picks` on load and saves each change at once, in order
  (`/pick`, `/unpick`, `/picks` for Pick all / Clear). What it shows is
  the server's last answer with the changes still in flight replayed on
  top; a failed change drops out (a line under the bar says so), so a
  card never shows a state the server does not have. A pick with no
  card on the page (made in another tab or by `pnpm pick`) counts as
  "(+N not shown)" with a "not shown here: reload" notice and a Reload
  button; the page never reloads itself. From disk, the changes collect into a pending bar
  with the `pnpm pick` / `pnpm unpick` commands to copy. Totals count
  every card on the page, whatever the filter. Dark only, like the
  library page; one column under 720 px.
- **Stretched aspect** is wired end to end (`captureSize` sets the game
  window, post scales); it has been checked in post only, no game capture
  at 1440x1080 yet.
- **Test hook.** `pnpm go --test-exit-after <s>` ends the process that many
  seconds into the first job that may launch, to exercise the interrupted
  path; not for normal use.
