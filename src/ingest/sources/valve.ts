// Valve matchmaking source (PLAN.md §1, M4, M6): the main account's matches newer
// than the last share code handled, each demo fetched into demos/inbox/.
// Two steps: the Steam Web API walks share codes forward (main account's
// match-history auth code), then a fetcher downloads each match: CS2 launched on
// the render account with +csgo_download_match, one guarded launch per code
// (valve-fetch.ts; docs/m6-mm-fetch.md, "Contract: the fetch launch").
//
// Order: codes come oldest first, at most maxMatchesPerRun per run; the
// checkpoint (state.lastShareCode) advances only over codes whose demo is in the
// inbox (or already stored) and codes that are gone (Valve says the match has
// expired, or the code has been pending over 30 days), and the run stops at the
// first pending or failed code, so nothing else is ever skipped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ShareCode } from "globaloffensive-sharecode";
import type { Source, SourceContext, SourceResult } from "../sources.ts";
import type { DemoFetcher, FetchResult } from "./valve-fetch.ts";

export const NEXT_CODE_API = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1";
export const NO_KEYS = "STEAM_WEB_API_KEY, STEAM_MATCH_AUTH_CODE and STEAM_LAST_SHARE_CODE are not all set in .env: nothing fetched. With them, pnpm grab walks the main account's matchmaking share codes and downloads each demo through a short CS2 launch on the render account.";
export const SHARE_CODE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;
// globaloffensive-sharecode's alphabet: SHARE_CODE allows [A-Za-z0-9], and the decoder silently
// mis-decodes characters outside this.
const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
const MAX_PER_RUN = 50;
// Valve keeps demos about 30 days: a code pending that long is gone whatever the reason.
const PENDING_GONE_AFTER_MS = 30 * 24 * 3600 * 1000;

/**
 * A share code checked (SHARE_CODE, then the decoder's alphabet) and decoded. Ids stay decimal
 * strings: they exceed Number's safe range. paddedOutcomeId is the <A> of the Watch tab's
 * match730_<A>_<B>_<C>.dem (and of the old GC path's valve-<A>_<B>.dem.bz2).
 */
export function decodeShareCode(code: string): { matchId: string; outcomeId: string; paddedOutcomeId: string } {
  if (!SHARE_CODE.test(code)) throw new Error(`not a share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx): ${code}`);
  const bad = [...code.slice(5).replaceAll("-", "")].filter((ch) => !SHARE_CODE_ALPHABET.includes(ch));
  if (bad.length) throw new Error(`${code} has characters no share code uses: ${[...new Set(bad)].join("")}`);
  const d = new ShareCode(code).decode() as { matchId: unknown; outcomeId: unknown } | false;
  if (!d || typeof d.matchId !== "string" || typeof d.outcomeId !== "string" || !/^\d{1,21}$/.test(d.matchId) || !/^\d{1,21}$/.test(d.outcomeId)) throw new Error(`${code} does not decode`);
  return { matchId: d.matchId, outcomeId: d.outcomeId, paddedOutcomeId: d.outcomeId.padStart(21, "0") };
}

/** The Steam Web API, injectable so tests run without network. */
export type ValveTransport = {
  getJson(url: string): Promise<{ status: number; body: unknown }>;
};

export const valveHttp: ValveTransport = {
  async getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  },
};

export type ValveState = {
  lastShareCode?: string; steamIdHash?: string; updatedAt?: string;
  /** Codes reported pending, with when that first happened; cleared when a code is done or gone. */
  pending?: Record<string, { firstSeenAt: string }>;
};
export type ValveOptions = {
  apiKey?: string; authCode?: string; startShareCode?: string; steamId64: string; maxMatchesPerRun: number;
  fetcher: DemoFetcher; transport?: ValveTransport; now?: () => number;
  /** Whether the store already holds this match's demo, by its 21-digit padded outcome id. */
  haveDemo?: (paddedOutcomeId: string) => boolean;
};

export function valveSource(o: ValveOptions): Source {
  const t = o.transport ?? valveHttp;
  const now = o.now ?? (() => Date.now());
  return {
    name: "valve",
    async fetch(ctx: SourceContext): Promise<SourceResult> {
      const result: SourceResult = { fetched: [], pending: [] };
      if (!o.apiKey || !o.authCode) { result.skipped = NO_KEYS; return result; }
      if (!Number.isSafeInteger(o.maxMatchesPerRun) || o.maxMatchesPerRun < 1 || o.maxMatchesPerRun > MAX_PER_RUN) {
        throw new Error(`config.json sources.valve.maxMatchesPerRun must be an integer from 1 to ${MAX_PER_RUN}`);
      }
      const state: ValveState = existsSync(ctx.stateFile) ? JSON.parse(readFileSync(ctx.stateFile, "utf8")) : {};
      const save = () => {
        if (ctx.dryRun) return;
        mkdirSync(path.dirname(ctx.stateFile), { recursive: true });
        const tmp = `${ctx.stateFile}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
        renameSync(tmp, ctx.stateFile);
      };
      // The checkpoint belongs to one STEAM_ID64 (stored as a hash; the id stays in .env).
      const idHash = createHash("sha256").update(o.steamId64).digest("hex").slice(0, 16);
      if (state.steamIdHash && state.steamIdHash !== idHash) throw new Error(`${ctx.stateFile} belongs to another STEAM_ID64; delete it to start over for this one`);
      // First run: STEAM_LAST_SHARE_CODE is the starting point; matches after it are new, it is not fetched itself.
      if (!state.lastShareCode) {
        if (!o.startShareCode) { result.skipped = NO_KEYS; return result; }
        if (!SHARE_CODE.test(o.startShareCode)) throw new Error("STEAM_LAST_SHARE_CODE is not a share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)");
        state.lastShareCode = o.startShareCode;
        state.steamIdHash = idHash;
        save();
      }

      // 1. The codes after the checkpoint, oldest first. 202 / "n/a" is the end of history.
      const todo: string[] = [];
      let known = state.lastShareCode;
      while (todo.length < o.maxMatchesPerRun) {
        const q = new URLSearchParams({ key: o.apiKey, steamid: o.steamId64, steamidkey: o.authCode, knowncode: known });
        const r = await t.getJson(`${NEXT_CODE_API}?${q}`);
        if (r.status === 403) throw new Error("Steam Web API: HTTP 403 (STEAM_WEB_API_KEY or STEAM_MATCH_AUTH_CODE rejected)");
        if (r.status === 412) throw new Error(`Steam Web API: HTTP 412 (share code ${known} is not one of STEAM_ID64's matches); fix lastShareCode in ${ctx.stateFile}`);
        if (r.status === 429) throw new Error("Steam Web API: HTTP 429 (rate limited); try again later");
        if (r.status !== 200 && r.status !== 202) throw new Error(`Steam Web API: HTTP ${r.status}`);
        const next = (r.body as { result?: { nextcode?: unknown } } | undefined)?.result?.nextcode;
        if (next === "n/a" || r.status === 202) break;
        if (typeof next !== "string" || !SHARE_CODE.test(next)) throw new Error('Steam Web API: field "result.nextcode" missing or not a share code');
        todo.push(next);
        known = next;
      }
      ctx.log(`valve: ${todo.length} new match(es)${todo.length === o.maxMatchesPerRun ? " (the per-run limit; more may follow next run)" : ""}`);
      if (!todo.length) return result;

      // 2. Codes that need no launch: the demo is already stored, or the code has been pending
      // over 30 days (gone). The rest go to the fetcher, one launch each, in order.
      const pending = (state.pending ??= {});
      type Outcome = FetchResult["results"][number];
      const outcomes = new Map<string, Outcome>();
      for (const code of todo) {
        if (o.haveDemo?.(decodeShareCode(code).paddedOutcomeId)) { outcomes.set(code, { code, outcome: "done", reason: "already in the store" }); continue; }
        const first = pending[code] ? Date.parse(pending[code].firstSeenAt) : NaN;
        if (now() - first > PENDING_GONE_AFTER_MS) outcomes.set(code, { code, outcome: "gone", reason: `pending since ${pending[code].firstSeenAt}, longer than Valve keeps demos` });
      }
      const toFetch = todo.filter((c) => !outcomes.has(c));
      if (toFetch.length) {
        const fr = await o.fetcher.fetch(toFetch, { inbox: ctx.inbox, dryRun: ctx.dryRun, log: ctx.log });
        // A held lock, a running CS2, the wrong Steam account: every code waits, nothing failed.
        if (fr.blocked) result.blocked = fr.blocked;
        for (const r of fr.results) if (toFetch.includes(r.code) && !outcomes.has(r.code)) outcomes.set(r.code, r);
        if (!fr.cleanupVerified) { result.cleanupUnverified = true; result.failed = true; }
      }

      // 3. The checkpoint moves over done and gone codes in order and stops at the first other one.
      for (const c of todo) { const f = outcomes.get(c)?.file; if (f) result.fetched.push(f); }
      for (let i = 0; i < todo.length; i++) {
        const code = todo[i];
        const r = outcomes.get(code) ?? { code, outcome: "pending", reason: result.blocked ?? "not attempted" };
        if (r.outcome === "done" || r.outcome === "gone") {
          ctx.log(r.outcome === "done" ? `valve: match ${code}${r.file ? ` -> ${path.basename(r.file)}` : `: ${r.reason ?? "done"}`}` : `valve: match ${code} is gone (${r.reason ?? "expired at Valve"}); skipped`);
          state.lastShareCode = code;
          delete pending[code];
          save();
          continue;
        }
        if (r.outcome === "failed") { result.failed = true; ctx.log(`valve: match ${code} FAILED: ${r.reason ?? "launch failed"}`); }
        const firstSeenAt = new Date(now()).toISOString();
        for (const c of todo.slice(i)) {
          const rc = outcomes.get(c);
          result.pending.push({ item: c, reason: c === code ? (r.reason ?? r.outcome) : (result.blocked && rc?.outcome !== "done" && rc?.outcome !== "gone" ? result.blocked : "after an earlier pending match") });
          // The 30-day clock starts the first time a code waits (a stored or gone one behind it does not).
          if (rc?.outcome !== "done" && rc?.outcome !== "gone") pending[c] ??= { firstSeenAt };
        }
        save();
        break;
      }
      return result;
    },
  };
}
