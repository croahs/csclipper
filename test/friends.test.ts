// pnpm friends against a fake FACEIT Data API (no network): matches merged across the roster,
// held vs missing by match id, cancelled matches left out, paging and the end of history.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFriends, friendsReport } from "../src/ingest/friends.ts";
import type { Transport } from "../src/ingest/sources/faceit.ts";

const A = "76561190000000001", B = "76561190000000002", C = "76561190000000003"; // fake
const mid = (n: number) => `1-${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
type Item = { match_id: string; status?: string; finished_at?: number };

function fake(players: Record<string, { id: string; nickname: string; items: Item[] } | undefined>) {
  const calls: string[] = [];
  const t: Transport = {
    async getJson(url) {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === "/data/v4/players") {
        const p = players[u.searchParams.get("game_player_id")!];
        return p ? { status: 200, body: { player_id: p.id, nickname: p.nickname } } : { status: 404, body: {} };
      }
      const p = Object.values(players).find((x) => x && u.pathname === `/data/v4/players/${x.id}/history`)!;
      const off = Number(u.searchParams.get("offset")), lim = Number(u.searchParams.get("limit"));
      return { status: 200, body: { items: p.items.slice(off, off + lim) } };
    },
    async postJson() { throw new Error("not used"); },
    async download() { throw new Error("not used"); },
  };
  return { t, calls };
}

test("merges shared matches, marks held and missing, leaves cancelled out", async () => {
  const { t } = fake({
    [A]: { id: "pa", nickname: "me_nick", items: [{ match_id: mid(3), finished_at: 300 }, { match_id: mid(2), finished_at: 200, status: "cancelled" }, { match_id: mid(1), finished_at: 100 }] },
    [B]: { id: "pb", nickname: "pal", items: [{ match_id: mid(4), finished_at: 400 }, { match_id: mid(3), finished_at: 300 }] },
    [C]: undefined,
  });
  const r = await friendsReport({ apiKey: "k", roster: [A, B, C], last: 20, transport: t, haveMatch: (id) => id === mid(3) });
  assert.deepEqual(r.matches.map((m) => [m.matchId, m.players, m.have]), [[mid(4), [1], false], [mid(3), [0, 1], true], [mid(1), [0], false]]);
  assert.deepEqual(r.players.map((p) => [p.nickname, p.found, p.matches]), [["me_nick", true, 2], ["pal", true, 2], [undefined, false, 0]]);
  const text = formatFriends(r).join("\n");
  assert.match(text, /MISSING .*pal .*room\/1-00000004/);
  assert.match(text, /have .*me_nick, pal/);
  assert.match(text, /pal: 1 of 2 finished match\(es\) held/);
  assert.match(text, /roster 3: no FACEIT CS2 account/);
  assert.match(text, /2 missing in all/);
  assert.doesNotMatch(text, new RegExp(`${A}|${B}|${C}`)); // never a SteamID
  assert.doesNotMatch(formatFriends(r, { missingOnly: true }).join("\n"), /^have/m);
});

test("a missing match with a rejected file says so, a held one never", async () => {
  const { t } = fake({ [A]: { id: "pa", nickname: "me", items: [{ match_id: mid(2), finished_at: 200 }, { match_id: mid(1), finished_at: 100 }] } });
  const r = await friendsReport({ apiKey: "k", roster: [A], last: 20, transport: t, haveMatch: (id) => id === mid(2), rejected: () => "unexpected end of file" });
  assert.deepEqual(r.matches.map((m) => m.rejected), [undefined, "unexpected end of file"]);
  assert.match(formatFriends(r).join("\n"), /REJECTED .*room\/1-00000001.*unexpected end of file; download it again/);
});

test("a shared match takes the finished state, running ones sort first, --missing hides them", async () => {
  const { t } = fake({
    [A]: { id: "pa", nickname: "me", items: [{ match_id: mid(9), status: "ongoing" }, { match_id: mid(8), status: "ongoing" }, { match_id: mid(5), finished_at: 50 }, { match_id: mid(6) }] },
    [B]: { id: "pb", nickname: "pal", items: [{ match_id: mid(5), finished_at: 50 }, { match_id: mid(8), status: "finished", finished_at: 80 }] },
  });
  const r = await friendsReport({ apiKey: "k", roster: [A, B], last: 20, transport: t, haveMatch: () => false });
  assert.deepEqual(r.matches.map((m) => [m.matchId, m.status, m.finishedAt]), [[mid(9), "ongoing", undefined], [mid(8), "finished", 80], [mid(5), "finished", 50], [mid(6), "finished", undefined]]);
  const text = formatFriends(r).join("\n");
  assert.match(text, /^ongoing +running /m);
  assert.match(text, /^MISSING +no date /m);
  assert.doesNotMatch(formatFriends(r, { missingOnly: true }).join("\n"), /ongoing/);
});

test("pages history up to --last and stops at the end", async () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ match_id: mid(100 - i), finished_at: 1000 - i }));
  const { t, calls } = fake({ [A]: { id: "pa", nickname: "me", items } });
  const r = await friendsReport({ apiKey: "k", roster: [A], last: 30, transport: t, haveMatch: () => false });
  assert.equal(r.matches.length, 30);
  assert.deepEqual(calls.filter((c) => c.includes("/history")).map((c) => new URL(c).searchParams.get("limit")), ["20", "10"]);
  const all = await friendsReport({ apiKey: "k", roster: [A], last: 100, transport: fake({ [A]: { id: "pa", nickname: "me", items } }).t, haveMatch: () => false });
  assert.equal(all.matches.length, 45);
  await assert.rejects(friendsReport({ apiKey: "k", roster: [A], last: 0, transport: t, haveMatch: () => false }), /--last/);
});
