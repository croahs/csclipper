// FACEIT source (PLAN.md §1, M4): the player's recent CS2 matches newer than
// the last one fetched, each match's demo downloaded into demos/inbox/. API
// shapes relied on are listed in docs/faceit-api.md; every field read here is
// checked, so a changed shape fails with a message naming the field.
//
// Order: matches newer than the checkpoint (state.lastMatchId) are taken
// oldest first, at most maxMatchesPerRun; the checkpoint advances after each
// completed, checked download, a first run fixes its starting point before
// downloading, and the run stops at the first failure, so nothing is skipped.
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Source, SourceContext, SourceResult } from "../sources.ts";

export const API = "https://open.faceit.com/data/v4";
export const DOWNLOAD_API = "https://open.faceit.com/download/v2/demos/download";
// The Downloads API is a separate scope FACEIT grants per application; a plain Data API key gets 403 err_f0.
export const NO_DOWNLOAD_SCOPE = "FACEIT_API_KEY lacks the Downloads API scope, so demos cannot be downloaded yet. Apply at https://fce.gg/downloads-api-application (docs.faceit.com/getting-started/Guides/download-api). The matches stay pending; nothing is skipped.";
const MAX_DEMO_BYTES = 2 * 1024 ** 3;
const HISTORY_PAGE = 20;
const MAX_PER_RUN = 50;
const MATCH_ID = /^[A-Za-z0-9-]{1,64}$/; // FACEIT match ids look like 1-<uuid>
const TERMINAL = new Set(["cancelled", "canceled", "aborted"]); // match states that never produce a demo
const START = "(start)"; // checkpoint before the oldest match: all of history is new
export const NO_KEY = "FACEIT_API_KEY is not set in .env: nothing fetched. With a key, pnpm grab looks up the player for STEAM_ID64, lists CS2 matches newer than the last one fetched, and downloads their demos into demos/inbox/.";
const MAX_HISTORY_PAGES = 10; // how far back (200 matches) a run looks for the last fetched match

/** Network access, injectable so tests run on recorded fixtures. */
export type Transport = {
  getJson(url: string, key: string): Promise<{ status: number; body: unknown }>;
  postJson(url: string, key: string, payload: unknown): Promise<{ status: number; body: unknown }>;
  /** Stream url into dest; throw past maxBytes. */
  download(url: string, dest: string, maxBytes: number): Promise<void>;
};

const TIMEOUT_MS = 30_000;
export const httpTransport: Transport = {
  async getJson(url, key) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  },
  async postJson(url, key, payload) {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  },
  async download(url, dest, maxBytes) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error(`download is ${declared} bytes, over the limit`);
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) { seen += chunk.length; cb(seen > maxBytes ? new Error("download over the size limit") : null, chunk); },
    });
    await pipeline(Readable.fromWeb(r.body as WebReadableStream), limit, createWriteStream(dest));
  },
};

export type FaceitState = { playerId?: string; steamIdHash?: string; lastMatchId?: string; lastFinishedAt?: number; updatedAt?: string };
export type FaceitOptions = { apiKey?: string; steamId64: string; maxMatchesPerRun: number; transport?: Transport; now?: () => number };
// A match still without a demo this long after it finished never gets one (cancelled, not recorded): skip it.
const NO_DEMO_GIVE_UP_S = 24 * 3600;

// --- the response fields this file relies on (docs/faceit-api.md) ----------------------
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`FACEIT ${what}: expected an object`);
  return v as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string, what: string): string => {
  if (typeof o[k] !== "string" || !o[k]) throw new Error(`FACEIT ${what}: field "${k}" missing or not a string`);
  return o[k] as string;
};
type HistoryItem = { matchId: string; finishedAt?: number; status?: string };

/** The first error code in a FACEIT error body ({"errors":[{"code":…}]}), if any. */
function errorCode(body: unknown): string | undefined {
  const errs = body && typeof body === "object" ? (body as { errors?: unknown }).errors : undefined;
  return Array.isArray(errs) && errs[0] && typeof errs[0] === "object" ? String((errs[0] as { code?: unknown }).code ?? "") || undefined : undefined;
}

function check(status: number, body: unknown, what: string) {
  if (status === 401 || status === 403) throw new Error(`FACEIT ${what}: HTTP ${status} (API key rejected or lacks access)`);
  if (status !== 200) throw new Error(`FACEIT ${what}: HTTP ${status}`);
  return body;
}

/** The demo file name in the inbox, keeping the compression extension of the URL. */
export function demoFileName(matchId: string, url: string): string {
  if (!MATCH_ID.test(matchId)) throw new Error(`FACEIT match id has an unexpected form: ${JSON.stringify(matchId.slice(0, 80))}`);
  const p = new URL(url).pathname.toLowerCase();
  const ext = [".dem.gz", ".dem.zst", ".dem.bz2", ".dem", ".zip", ".gz", ".zst", ".bz2"].find((e) => p.endsWith(e)) ?? ".dem.gz";
  return `faceit-${matchId}${ext}`;
}

/**
 * The first 8 bytes of the demo inside a downloaded file, decompressing as its
 * name says. .gz / .zst are decompressed to the end; .bz2 / .zip only have
 * their container magic checked here, and ingest validates them fully (a
 * rejected file lands in demos/rejected/ with the match id in its name; set
 * lastMatchId back to re-fetch it). A bare .dem cut short is not detectable here.
 */
async function demoHeader(file: string): Promise<string> {
  const lower = file.toLowerCase();
  const magic = (n: number) => { const fd = openSync(file, "r"); try { const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); return b; } finally { closeSync(fd); } };
  if (/\.dem(\.part)?$/.test(lower)) return magic(8).toString("latin1");
  // .bz2 and .zip cannot be peeked cheaply here; their own magic must be right, ingest checks the rest.
  if (/\.bz2(\.part)?$/.test(lower)) return magic(3).toString("latin1") === "BZh" ? "PBDEMS2\0" : "not bzip2";
  if (/\.zip(\.part)?$/.test(lower)) return magic(4).toString("latin1") === "PK\x03\x04" ? "PBDEMS2\0" : "not zip";
  // Decompressed to the end (nothing kept), so a truncated or corrupt stream fails here, not in ingest.
  const unzip = /\.zst(\.part)?$/.test(lower) ? zlib.createZstdDecompress() : zlib.createGunzip();
  return new Promise((resolve) => {
    const src = createReadStream(file);
    let head = Buffer.alloc(0);
    let total = 0;
    let settled = false;
    const done = (v: string) => { if (settled) return; settled = true; src.destroy(); unzip.destroy(); resolve(v); };
    unzip.on("data", (c: Buffer) => {
      if (head.length < 8) head = Buffer.concat([head, c.subarray(0, 8 - head.length)]);
      total += c.length;
      if (total > MAX_DEMO_BYTES) done("larger than the demo size limit");
    });
    unzip.on("error", () => done("unreadable"));
    unzip.on("end", () => done(head.toString("latin1")));
    src.on("error", () => done("unreadable"));
    src.pipe(unzip);
  });
}

export function faceitSource(o: FaceitOptions): Source {
  const t = o.transport ?? httpTransport;
  return {
    name: "faceit",
    async fetch(ctx: SourceContext): Promise<SourceResult> {
      const result: SourceResult = { fetched: [], pending: [] };
      if (!o.apiKey) {
        result.skipped = NO_KEY;
        return result;
      }
      if (!Number.isSafeInteger(o.maxMatchesPerRun) || o.maxMatchesPerRun < 1 || o.maxMatchesPerRun > MAX_PER_RUN) {
        throw new Error(`config.json sources.faceit.maxMatchesPerRun must be an integer from 1 to ${MAX_PER_RUN}`);
      }
      const key = o.apiKey;
      const state: FaceitState = existsSync(ctx.stateFile) ? JSON.parse(readFileSync(ctx.stateFile, "utf8")) : {};
      const save = () => {
        if (ctx.dryRun) return;
        mkdirSync(path.dirname(ctx.stateFile), { recursive: true });
        const tmp = `${ctx.stateFile}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
        renameSync(tmp, ctx.stateFile);
      };

      // 1. FACEIT player id for the SteamID64, cached with a hash of that id (the id itself stays in .env).
      const idHash = createHash("sha256").update(o.steamId64).digest("hex").slice(0, 16);
      if (state.playerId && state.steamIdHash && state.steamIdHash !== idHash) {
        throw new Error(`${ctx.stateFile} belongs to another STEAM_ID64; delete it to start over for this one`);
      }
      if (!state.playerId || !state.steamIdHash) {
        const r = await t.getJson(`${API}/players?game=cs2&game_player_id=${encodeURIComponent(o.steamId64)}`, key);
        if (r.status === 404) throw new Error("FACEIT has no CS2 player for STEAM_ID64");
        const playerId = str(obj(check(r.status, r.body, "player lookup"), "player lookup"), "player_id", "player lookup");
        // State without the hash (written before it existed) keeps its progress if it is this player's.
        if (state.playerId && state.playerId !== playerId) throw new Error(`${ctx.stateFile} belongs to another FACEIT player; delete it to start over`);
        state.playerId = playerId;
        state.steamIdHash = idHash;
        save();
      }

      // 2. Matches newer than the checkpoint; history is newest first. The
      // checkpoint is the last match handled, or START (all of history is new).
      // It must be found: if not, nothing is fetched, rather than skipping matches.
      const fresh: HistoryItem[] = [];
      const firstRun = !state.lastMatchId;
      let found = false;
      let olderNeighbour: string | undefined; // first run: the match just past the selection
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const offset = page * HISTORY_PAGE;
        const r = await t.getJson(`${API}/players/${encodeURIComponent(state.playerId)}/history?game=cs2&offset=${offset}&limit=${HISTORY_PAGE}`, key);
        const body = obj(check(r.status, r.body, "match history"), "match history");
        if (!Array.isArray(body.items)) throw new Error('FACEIT match history: field "items" missing or not an array');
        const items = body.items.map((x) => {
          const it = obj(x, "match history item");
          const matchId = str(it, "match_id", "match history item");
          if (!MATCH_ID.test(matchId)) throw new Error(`FACEIT match history: match id with an unexpected form: ${JSON.stringify(matchId.slice(0, 80))}`);
          return { matchId, finishedAt: typeof it.finished_at === "number" ? it.finished_at : undefined, status: typeof it.status === "string" ? it.status : undefined };
        });
        for (const it of items) {
          if (firstRun && fresh.length >= o.maxMatchesPerRun) { olderNeighbour = it.matchId; found = true; break; }
          if (it.matchId === state.lastMatchId) { found = true; break; }
          fresh.push(it);
        }
        if (found) break;
        if (items.length < HISTORY_PAGE) { found = firstRun || state.lastMatchId === START; break; } // the end of history
      }
      if (!found) {
        throw new Error(state.lastMatchId
          ? `the last fetched match is not among the newest ${MAX_HISTORY_PAGES * HISTORY_PAGE} in FACEIT history; nothing fetched. Set lastMatchId in ${ctx.stateFile} to where to continue from`
          : "FACEIT match history did not end where expected");
      }
      if (firstRun) {
        // Fix the starting boundary before any download, so a failed first match is retried, never dropped.
        state.lastMatchId = olderNeighbour ?? START;
        save();
      }
      // Oldest first, at most maxMatchesPerRun per run: the checkpoint moves forward
      // only over handled matches, and the next run continues where this one stopped.
      const todo = [...fresh].reverse().slice(0, o.maxMatchesPerRun);
      ctx.log(`faceit: ${fresh.length} new match(es)${fresh.length > todo.length ? `, taking the oldest ${todo.length} this run` : ""}`);

      for (const m of todo) {
        // A cancelled or aborted match never gets a demo: skipped. Any other
        // unfinished state is waited on, never stepped over.
        if (m.status && TERMINAL.has(m.status.toLowerCase())) {
          ctx.log(`faceit: match ${m.matchId} is ${m.status}; skipped`);
          if (!ctx.dryRun) { state.lastMatchId = m.matchId; save(); }
          continue;
        }
        if (m.status && m.status.toLowerCase() !== "finished") {
          result.pending.push({ item: m.matchId, reason: `match status "${m.status}", not finished yet` });
          break;
        }
        try {
          // 3. The match's demo resource URL.
          const mr = await t.getJson(`${API}/matches/${encodeURIComponent(m.matchId)}`, key);
          const match = obj(check(mr.status, mr.body, `match ${m.matchId}`), `match ${m.matchId}`);
          const urls = match.demo_url;
          // Missing, null or an empty list means not uploaded; anything else must be a list of URLs.
          if (urls !== undefined && urls !== null && (!Array.isArray(urls) || urls.some((u) => typeof u !== "string" || !u))) {
            throw new Error(`FACEIT match ${m.matchId}: field "demo_url" is not a list of URLs`);
          }
          if (!urls || !(urls as string[]).length) {
            // Missing or empty: not uploaded yet, or never will be.
            const age = m.finishedAt ? (o.now ?? Date.now)() / 1000 - m.finishedAt : 0;
            if (age > NO_DEMO_GIVE_UP_S) {
              ctx.log(`faceit: match ${m.matchId} has no demo ${Math.round(age / 3600)} h after it finished; skipped`);
              if (!ctx.dryRun) { state.lastMatchId = m.matchId; save(); }
              continue;
            }
            result.pending.push({ item: m.matchId, reason: "no demo_url yet (demo not uploaded)" });
            break;
          }
          // 4. A signed download URL for it (FACEIT Downloads API).
          const dr = await t.postJson(DOWNLOAD_API, key, { resource_url: (urls as string[])[0] });
          if (dr.status === 403 && errorCode(dr.body) === "err_f0") {
            // No Downloads API scope: this and every later new match wait, the checkpoint stays.
            result.blocked = NO_DOWNLOAD_SCOPE;
            const rest = [...fresh].reverse();
            for (const x of rest.slice(rest.findIndex((y) => y.matchId === m.matchId))) result.pending.push({ item: x.matchId, reason: "waiting for the Downloads API scope" });
            break;
          }
          const dl = obj(check(dr.status, dr.body, "demo download"), "demo download");
          const signed = str(obj(dl.payload, "demo download payload"), "download_url", "demo download payload");
          const name = demoFileName(m.matchId, signed);
          if (ctx.dryRun) { ctx.log(`faceit: would download match ${m.matchId} → ${name}`); continue; }
          // 5. Download under a temporary name; check it holds a CS2 demo; rename; then advance.
          const part = path.join(ctx.inbox, `.${name}.part`);
          try {
            await t.download(signed, part, MAX_DEMO_BYTES);
            const header = await demoHeader(part);
            if (header !== "PBDEMS2\0") throw new Error(`downloaded file is not a CS2 demo (${name})`);
          } catch (e) {
            rmSync(part, { force: true });
            throw e;
          }
          const final = path.join(ctx.inbox, name);
          renameSync(part, final);
          result.fetched.push(final);
          state.lastMatchId = m.matchId;
          if (m.finishedAt) state.lastFinishedAt = m.finishedAt;
          save();
          ctx.log(`faceit: downloaded match ${m.matchId} → ${name}`);
        } catch (e) {
          result.pending.push({ item: m.matchId, reason: (e as Error).message });
          break; // stop here: later matches wait, so none is skipped
        }
      }
      return result;
    },
  };
}
