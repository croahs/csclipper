// Valve matchmaking source (PLAN.md §1, M4): the main account's matches newer
// than the last share code handled, each demo downloaded into demos/inbox/.
// Two steps: the Steam Web API walks share codes forward (main account's
// match-history auth code), then the Game Coordinator, through the alt's Steam
// login (valve-gc.ts), resolves each code to a replay URL on Valve's servers.
//
// Order: codes come oldest first, at most maxMatchesPerRun per run; the
// checkpoint (state.lastShareCode) advances after each completed download and
// the run stops at the first failure or at a demo not ready yet, so nothing is
// skipped except demos Valve no longer has (older than ~30 days, or gone).
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Source, SourceContext, SourceResult } from "../sources.ts";

export const NEXT_CODE_API = "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1";
export const NO_KEYS = "STEAM_WEB_API_KEY, STEAM_MATCH_AUTH_CODE and STEAM_LAST_SHARE_CODE are not all set in .env: nothing fetched. With them, pnpm grab walks the main account's matchmaking share codes and downloads the demos through the alt's Steam login (pnpm grab --steam-login once).";
export const SHARE_CODE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;
const MAX_DEMO_BYTES = 2 * 1024 ** 3;
const MAX_PER_RUN = 50;
const DEMO_STEM = /^[0-9_]{10,80}$/; // replay file names are <match id>_<reservation id>
// A demo that is missing this long after the match never shows up (Valve keeps them ~30 days).
const NOT_READY_FOR_S = 2 * 3600;
const KEPT_FOR_S = 30 * 24 * 3600;

/** Steam Web API and replay downloads, injectable so tests run without network. */
export type ValveTransport = {
  getJson(url: string): Promise<{ status: number; body: unknown }>;
  /** Stream url into dest; throw past maxBytes; an error with status 404 when the file is gone. */
  download(url: string, dest: string, maxBytes: number): Promise<void>;
};

export const valveHttp: ValveTransport = {
  async getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  },
  // No redirects (the URL was checked against Valve's replay hosts, a redirect target is not), and the
  // body must be exactly the declared length: a cut-short bzip2 would otherwise pass the checkpoint.
  async download(url, dest, maxBytes) {
    const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (!(declared > 0)) throw new Error("download has no Content-Length; cannot tell a complete demo from a cut-short one");
    if (declared > maxBytes) throw new Error(`download is ${declared} bytes, over the limit`);
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) { seen += chunk.length; cb(seen > declared ? new Error("download longer than its Content-Length") : null, chunk); },
    });
    await pipeline(Readable.fromWeb(r.body as WebReadableStream), limit, createWriteStream(dest));
    if (seen !== declared) throw new Error(`download cut short: ${seen} of ${declared} bytes`);
  },
};

/** One Game Coordinator session on the alt, opened only when there is something to resolve. */
export type GcSession = {
  /** The replay URL and match time (unix s) for a share code; url undefined when the GC has none. */
  resolve(shareCode: string): Promise<{ url?: string; matchTime?: number }>;
  close(): Promise<void>;
};
/** Opens the session, or says why it cannot (no saved login, CS2 running): blocked, not failed. */
export type GcOpener = (log: (l: string) => void) => Promise<GcSession | { blocked: string }>;

export type ValveState = { lastShareCode?: string; steamIdHash?: string; updatedAt?: string };
export type ValveOptions = {
  apiKey?: string; authCode?: string; startShareCode?: string; steamId64: string; maxMatchesPerRun: number;
  openGc: GcOpener; transport?: ValveTransport; now?: () => number;
  /** Whether the store already holds this demo (by replay file stem, also in the Watch tab's match730_<stem>.dem). */
  haveDemo?: (stem: string) => boolean;
};

/** The replay's file stem, from a URL on Valve's replay servers only (http://replay<n>.valve.net/730/<stem>.dem.bz2). */
export function replayStem(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`GC replay URL is not a URL: ${JSON.stringify(url.slice(0, 120))}`); }
  if (!/^https?:$/.test(u.protocol) || !/^replay\d+\.valve\.net$/.test(u.hostname)) throw new Error(`GC replay URL is not on Valve's replay servers: ${u.hostname}`);
  const m = u.pathname.match(/^\/730\/([^/]+)\.dem\.bz2$/);
  if (!m || !DEMO_STEM.test(m[1])) throw new Error(`GC replay URL has an unexpected path: ${JSON.stringify(u.pathname.slice(0, 120))}`);
  return m[1];
}

function bz2Magic(file: string): boolean {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(3); readSync(fd, b, 0, 3, 0); return b.toString("latin1") === "BZh"; } finally { closeSync(fd); }
}

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
      if (ctx.dryRun) { for (const c of todo) ctx.log(`valve: would download match ${c}`); return result; }

      // 2-3. Each code resolved through the GC and downloaded; the checkpoint moves only over handled codes.
      const gc = await o.openGc(ctx.log);
      if ("blocked" in gc) {
        result.blocked = gc.blocked;
        for (const c of todo) result.pending.push({ item: c, reason: "waiting for a Game Coordinator session" });
        return result;
      }
      const advance = (code: string) => { state.lastShareCode = code; save(); };
      try {
        for (let i = 0; i < todo.length; i++) {
          const code = todo[i];
          const leftPending = (reason: string) => { for (const c of todo.slice(i)) result.pending.push({ item: c, reason: c === code ? reason : "after an earlier pending match" }); };
          let part: string | undefined;
          try {
            const { url, matchTime } = await gc.resolve(code);
            const age = matchTime ? now() / 1000 - matchTime : undefined;
            if (!url) {
              if (age !== undefined && age > NOT_READY_FOR_S) { ctx.log(`valve: match ${code} has no demo at Valve; skipped`); advance(code); continue; }
              leftPending("the GC has no demo for it yet"); break;
            }
            if (age !== undefined && age > KEPT_FOR_S) { ctx.log(`valve: match ${code} is older than Valve keeps demos; skipped`); advance(code); continue; }
            const stem = replayStem(url);
            if (o.haveDemo?.(stem)) { ctx.log(`valve: match ${code} is already in the store`); advance(code); continue; }
            const name = `valve-${stem}.dem.bz2`;
            part = path.join(ctx.inbox, `${name}.part`);
            mkdirSync(ctx.inbox, { recursive: true });
            try {
              await t.download(url, part, MAX_DEMO_BYTES);
            } catch (e) {
              // Gone at Valve: a demo is not uploaded the moment the match ends, so only one known to be old is given up on.
              if (/HTTP 404/.test((e as Error).message) && age !== undefined && age > NOT_READY_FOR_S) {
                ctx.log(`valve: match ${code}: demo no longer at Valve; skipped`); rmSync(part, { force: true }); part = undefined; advance(code); continue;
              }
              if (/HTTP 404/.test((e as Error).message)) { rmSync(part, { force: true }); part = undefined; leftPending("demo not uploaded yet"); break; }
              throw e;
            }
            if (!bz2Magic(part)) throw new Error("downloaded file is not bzip2");
            const dest = path.join(ctx.inbox, name);
            if (existsSync(dest)) throw new Error(`${dest} already exists in the inbox`);
            renameSync(part, dest);
            part = undefined;
            result.fetched.push(dest);
            ctx.log(`valve: fetched match ${code} -> ${name}`);
            advance(code);
          } catch (e) {
            if (part) rmSync(part, { force: true });
            ctx.log(`valve: match ${code} FAILED: ${(e as Error).message}`);
            leftPending((e as Error).message);
            result.failed = true;
            break;
          }
        }
      } finally {
        await gc.close();
      }
      return result;
    },
  };
}
