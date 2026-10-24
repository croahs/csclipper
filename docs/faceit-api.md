# FACEIT: API shapes and the browser path relied on

`src/ingest/sources/faceit.ts` uses the calls below and only the fields
listed. Checked against the live API on 2026-10-15 with Peder's key: the
player and history calls work as listed; the download endpoint is the one
below and answers 403 `err_f0` ("no valid scope provided") for a key without
the Downloads API scope. Not yet seen live: the match call's `demo_url`, the
download response, and a demo body. The recorded fixtures in
`test/fixtures/faceit/` copy these shapes; a mismatch fails with a message
naming the call and the field (e.g. `FACEIT match history: field "items"
missing`), so fix the field here, in the code and in the fixture together,
then run `pnpm test`.

All calls send `Authorization: Bearer <FACEIT_API_KEY>`. HTTP 401/403 is
reported as "API key rejected or lacks access", except on the download
endpoint (below).

| Step | Request | Fields read | Fixture | Live |
|---|---|---|---|---|
| Player | `GET https://open.faceit.com/data/v4/players?game=cs2&game_player_id=<STEAM_ID64>` | `player_id` (string). 404 = no FACEIT CS2 account for that SteamID | `player.json` | yes |
| History | `GET https://open.faceit.com/data/v4/players/<player_id>/history?game=cs2&offset=<n>&limit=20` | `items[]` (newest first): `match_id` (string), `status` (string, optional; `finished` is taken, `cancelled` / `aborted` skipped, anything else waited on), `finished_at` (unix seconds, optional) | `history.json` | yes |
| Match | `GET https://open.faceit.com/data/v4/matches/<match_id>` | `demo_url` (array of strings; the first is used). Missing, `null` or empty = demo not uploaded yet | `match.json` | not yet |
| Download | `POST https://open.faceit.com/download/v2/demos/download` with body `{"resource_url": "<demo_url[0]>"}` | `payload.download_url` (string, a signed URL) | `download-url.json` | 403 `err_f0` without the scope |
| Demo | `GET <download_url>` (no auth header) | the body: a `.dem.gz` (or `.dem.zst` / `.dem.bz2` / `.dem`, taken from the URL's path) | generated in `test/faceit.test.ts` | not yet |

**The Downloads API is a separate scope.** FACEIT grants it per application
(docs.faceit.com/getting-started/Guides/download-api; apply at
https://fce.gg/downloads-api-application); a plain Data API key cannot
download demos. Without it, the download endpoint answers 403 with
`{"errors":[{"code":"err_f0","message":"no valid scope provided"}]}`, and
`pnpm grab` prints one line saying so, lists every new match as pending,
leaves the checkpoint where it is and exits 0. Once the scope is granted,
the next `pnpm grab` fetches them. Until then the folders source (CS2's
`game/csgo/`, where the FACEIT client's "Watch demo" saves demos, and
`~/Downloads`) is the way in.

## The browser path (blocked since 2026-10-24)

FACEIT declined the Downloads API for non-commercial use, so demos came
through the user's own logged-in FACEIT session instead, doing the click the user
would make in the match room. The match list still comes from the Data API
above (only `FACEIT_API_KEY`'s player and history calls are needed).

**Blocked.** Since 2026-10-24 the "Watch demo" click runs a Cloudflare
Turnstile check that fails in the Playwright-driven browser: the click
lands (the button is found and clicked), no `download-url` request is
ever made, and the page logs a FACEIT error with `[Cloudflare Turnstile]
Error: 600010`, repeating every 10 s, so no download starts (probe of
2026-10-25 with the logged-in profile; two earlier runs timed out after
5 min; the console line does not show in every run, so it is not relied
on alone). Nothing here answers a bot check (PLAN.md M5): the source
stops at that console line, or 30 s after the click without a download,
as blocked (not failed, no screenshot) with every new match pending and
the room link printed (`BOT_CHECK`), and the demo is downloaded by hand in the
user's own browser, where the click still works, into Downloads for the
folders source. The rest of this section describes the path as built, in
case FACEIT drops the check.

- `pnpm grab --login` starts the installed Google Chrome (else Microsoft
  Edge) as a plain process, not automated, with
  `--user-data-dir=state/browser-profile` on https://www.faceit.com/en. The user
  signs in there (cookie dialog, any human check: the user's own clicks)
  and closes the window; the command waits for that. No credentials are
  handled or stored by croclipper; the session lives in that profile
  (gitignored with all of `state/`). A Playwright-launched browser does not
  get past FACEIT's Cloudflare check on the login page, which is why login
  is a plain launch.
- `pnpm grab --browser` (or `config.json` → `sources.faceit.via:
  "browser"`) opens that profile with Playwright (`channel` chrome, else
  msedge; started minimized, or headless with `sources.faceit.headless`) and,
  one match at a time with a 4 s pause, opens
  `https://www.faceit.com/en/cs2/room/<match_id>` and clicks the demo button.
- Locators relied on (checked live 2026-10-15): the room's button with role
  `button` and name **"Watch demo"**; the header's button named
  **"Profile"** as the logged-in signal. Clicking "Watch demo" makes the page
  call `POST https://www.faceit.com/api/download/v2/demos/download-url`
  (FACEIT's own site API) and start a browser download named
  `<match_id>-1-1.dem.zst` from FACEIT's demo storage. If FACEIT renames the
  button, change the locator in `src/ingest/sources/faceit-browser.ts` and
  here.
- Stops, without retrying: a human-verification page ("verifying you are
  human" / "just a moment") or a logged-out page makes every new match
  pending with a message to run `pnpm grab --login` again; nothing ever
  answers a verification. No download within 30 s of the click is the bot
  check (above) and blocks the same way. Any other failure (a download
  that is not this match's demo, a save error) stops the run with the page
  URL and a screenshot in `state/browser-failures/`.
- Limits: the size cap (2 GiB) is checked when the download is complete
  (Playwright exposes no byte stream before that), with a 20-minute deadline
  on the whole transfer. A file whose contents are not a CS2 demo is
  reported by the shared check without a page screenshot (the page plays no
  part in that check).
- The download is saved as `demos/inbox/.faceit-<match_id>.dem.zst.part`,
  checked to be a CS2 demo (decompressed to the end), renamed, and only then
  does the checkpoint advance, exactly as for the API path.
- First live run (2026-10-15): the 5 pending matches downloaded
  (230-394 MB each), no verification shown; 4 ingested, 1 already in the
  store from a Downloads copy. Last working run: before 2026-10-24.

## Behaviour the code adds on top

- `state/sources/faceit.json` holds the player id, a hash of the SteamID64
  it was resolved for (state for another id or player is refused), and the checkpoint
  `lastMatchId`: the last match handled, or `(start)`.
- A first run takes the newest `config.json` →
  `sources.faceit.maxMatchesPerRun` (1-50, default 5) and saves the match
  just older than those as the checkpoint before downloading anything.
- History is paged (20 per page, up to 10 pages) until the checkpoint is
  found. If it is not found, nothing is fetched and the checkpoint stays:
  set `lastMatchId` by hand to where to continue from.
- New matches are fetched oldest first, at most `maxMatchesPerRun` per run.
  The checkpoint advances after each download that is complete and holds a
  CS2 demo (checked by decompressing its first bytes); the first failure
  stops the run, so nothing is skipped over. A missing, `null` or empty
  `demo_url` means "not uploaded yet" and waits, except 24 h after the match
  finished, when the match is skipped; any other shape is an error. A match
  whose `status` is `cancelled` / `aborted` is skipped; any other status
  that is not `finished` stops the run until it is. `.gz` / `.zst`
  downloads are decompressed to the end before the checkpoint moves; `.bz2` /
  `.zip` get a container check and full validation in ingest (a rejected one
  lands in `demos/rejected/` with the match id in its name: set
  `lastMatchId` back to the match before it to fetch it again).
- Match ids must look like FACEIT's (`[A-Za-z0-9-]`, at most 64 chars).
- Each demo is written as `demos/inbox/.faceit-<match id>.<ext>.part`
  (ignored by ingest), size-capped at 2 GiB while streaming, then renamed
  to `faceit-<match id>.<ext>`. One `pnpm grab` at a time
  (`state/.grab.lock`).
