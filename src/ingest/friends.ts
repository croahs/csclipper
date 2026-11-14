// pnpm friends: which recent FACEIT matches of the roster (STEAM_ID64 and FILM_STEAM_ID64S) the
// store holds and which it lacks. Read-only: it lists match history through the Data API and
// compares match ids with the stored demos' file names (FACEIT names a demo <match id>-1-1.dem…,
// the FACEIT sources faceit-<match id>…), the same test pnpm grab uses. Nothing is downloaded or
// written. Valve matchmaking is not covered: a friend's matches need that friend's match auth code.
import { API, MATCH_ID, TERMINAL, check, obj, str, type Transport } from "./sources/faceit.ts";
import { ROOM_URL } from "./sources/faceit-browser.ts";

const PAGE = 20;
export const MAX_LAST = 100;

export type FriendMatch = {
  matchId: string;
  finishedAt?: number;
  /** finished (a demo may exist), or the match's other state (ongoing, cancelled…). */
  status: string;
  /** Roster positions (0 = STEAM_ID64) who played it, roster order. */
  players: number[];
  have: boolean;
  /** Not held, but a file of it was rejected by ingest (demos/rejected/): its reason. */
  rejected?: string;
};
export type FriendPlayer = { nickname?: string; /** absent: FACEIT has no CS2 player for that SteamID. */ found: boolean; matches: number };
export type FriendsReport = { players: FriendPlayer[]; matches: FriendMatch[] };

/**
 * Each roster player's last `last` FACEIT CS2 matches, merged by match id (a match several of them
 * played appears once), newest first. Cancelled and aborted matches never get a demo and are left out.
 */
export async function friendsReport(o: { apiKey: string; roster: string[]; last: number; transport: Transport; haveMatch: (id: string) => boolean; rejected?: (id: string) => string | undefined }): Promise<FriendsReport> {
  if (!Number.isSafeInteger(o.last) || o.last < 1 || o.last > MAX_LAST) throw new Error(`--last must be an integer from 1 to ${MAX_LAST}`);
  const t = o.transport;
  const players: FriendPlayer[] = [];
  const byId = new Map<string, FriendMatch>();
  for (const [i, steamId] of o.roster.entries()) {
    const r = await t.getJson(`${API}/players?game=cs2&game_player_id=${encodeURIComponent(steamId)}`, o.apiKey);
    if (r.status === 404) { players.push({ found: false, matches: 0 }); continue; }
    const p = obj(check(r.status, r.body, "player lookup"), "player lookup");
    const playerId = str(p, "player_id", "player lookup");
    const nickname = typeof p.nickname === "string" && p.nickname ? p.nickname : undefined;
    let count = 0;
    for (let offset = 0; offset < o.last; offset += PAGE) {
      const limit = Math.min(PAGE, o.last - offset);
      const h = await t.getJson(`${API}/players/${encodeURIComponent(playerId)}/history?game=cs2&offset=${offset}&limit=${limit}`, o.apiKey);
      const body = obj(check(h.status, h.body, "match history"), "match history");
      if (!Array.isArray(body.items)) throw new Error('FACEIT match history: field "items" missing or not an array');
      for (const x of body.items) {
        const it = obj(x, "match history item");
        const matchId = str(it, "match_id", "match history item");
        if (!MATCH_ID.test(matchId)) throw new Error(`FACEIT match history: match id with an unexpected form: ${JSON.stringify(matchId.slice(0, 80))}`);
        const status = typeof it.status === "string" ? it.status.toLowerCase() : "finished";
        if (TERMINAL.has(status)) continue;
        count++;
        const m = byId.get(matchId);
        const finishedAt = typeof it.finished_at === "number" ? it.finished_at : undefined;
        if (m) {
          if (!m.players.includes(i)) m.players.push(i);
          // Another player's history may be newer: a finished state and its time win over a running one.
          if (status === "finished") m.status = status;
          m.finishedAt ??= finishedAt;
          continue;
        }
        const have = o.haveMatch(matchId);
        byId.set(matchId, { matchId, finishedAt, status, players: [i], have, rejected: have ? undefined : o.rejected?.(matchId) });
      }
      if (body.items.length < limit) break; // the end of history
    }
    players.push({ nickname, found: true, matches: count });
  }
  // Running matches on top, then finished ones newest first, a finished one without a time last.
  const rank = (m: FriendMatch) => (m.status !== "finished" ? 0 : m.finishedAt !== undefined ? 1 : 2);
  const matches = [...byId.values()].sort((a, b) => rank(a) - rank(b) || (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return { players, matches };
}

/** The report as text lines. A player is named by FACEIT nickname, else by roster position (never the SteamID). */
export function formatFriends(r: FriendsReport, opts: { missingOnly?: boolean } = {}): string[] {
  const name = (i: number) => r.players[i]?.nickname ?? (i === 0 ? "me" : `roster ${i + 1}`);
  // Local time, yyyy-mm-dd hh:mm.
  const two = (n: number) => String(n).padStart(2, "0");
  const date = (m: FriendMatch) => { const s = m.finishedAt; if (!s) return (m.status === "finished" ? "no date" : "running").padEnd(16); const d = new Date(s * 1000); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
  const out: string[] = [];
  for (const m of r.matches) {
    if (opts.missingOnly && (m.have || m.status !== "finished")) continue;
    const mark = m.have ? "have    " : m.status !== "finished" ? m.status.padEnd(8).slice(0, 8) : m.rejected ? "REJECTED" : "MISSING ";
    const why = m.rejected ? `  (ingest: ${m.rejected}; download it again)` : "";
    out.push(`${mark}  ${date(m)}  ${m.players.map(name).join(", ")}${m.have ? "" : `  ${ROOM_URL(m.matchId)}${why}`}`);
  }
  if (!out.length) out.push(opts.missingOnly ? "nothing missing" : "no FACEIT matches found");
  out.push("");
  for (const [i, p] of r.players.entries()) {
    if (!p.found) { out.push(`${name(i)}: no FACEIT CS2 account`); continue; }
    const mine = r.matches.filter((m) => m.players.includes(i) && m.status === "finished");
    out.push(`${name(i)}: ${mine.filter((m) => m.have).length} of ${mine.length} finished match(es) held`);
  }
  const missing = r.matches.filter((m) => !m.have && m.status === "finished").length;
  out.push(`${missing} missing in all. A missing demo: open its room, "Watch demo" / "Download demo", then pnpm grab picks it up from the folders.`);
  return out;
}
