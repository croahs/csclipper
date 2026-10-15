# FACEIT API shapes relied on

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
