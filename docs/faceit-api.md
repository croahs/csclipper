# FACEIT API shapes relied on

`src/ingest/sources/faceit.ts` uses the four calls below and only the
fields listed. **None of this has been checked against the live API yet**
(no key on 2026-10-15): the shapes come from FACEIT's documented Data API
v4 and Downloads API as known when this was written, and the recorded
fixtures in `test/fixtures/faceit/` copy them. When the key arrives, run
`pnpm grab --dry-run` first; a mismatch fails with a message naming the
call and the field (e.g. `FACEIT match history: field "items" missing`),
so fix the field here, in the code and in the fixture together, then run
`pnpm test`.

All calls send `Authorization: Bearer <FACEIT_API_KEY>`. HTTP 401/403 is
reported as "API key rejected or lacks access".

| Step | Request | Fields read | Fixture |
|---|---|---|---|
| Player | `GET https://open.faceit.com/data/v4/players?game=cs2&game_player_id=<STEAM_ID64>` | `player_id` (string). 404 = no FACEIT CS2 account for that SteamID | `player.json` |
| History | `GET …/data/v4/players/<player_id>/history?game=cs2&offset=<n>&limit=20` | `items[]` (newest first): `match_id` (string), `status` (string, optional; only `finished` is taken), `finished_at` (unix seconds, optional) | `history.json` |
| Match | `GET …/data/v4/matches/<match_id>` | `demo_url` (array of strings; the first is used). Empty or missing = demo not uploaded yet | `match.json` |
| Download URL | `POST https://open.faceit.com/download/v2/demos/download-url` with body `{"resource_url": "<demo_url[0]>"}` | `payload.download_url` (string, a signed URL) | `download-url.json` |
| Demo | `GET <download_url>` (no auth header) | the body: a `.dem.gz` (or `.dem.zst` / `.dem.bz2` / `.dem`, taken from the URL's path) | generated in `test/faceit.test.ts` |

Known uncertainty: FACEIT has required its Downloads API (the
`download-url` step) for demo files since `demo_url` stopped being directly
downloadable; access to it may need to be requested for the key's app. If
that step returns 401/403 while the other calls work, that is the cause.

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
