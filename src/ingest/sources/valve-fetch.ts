// The fetch launch (docs/m6-mm-fetch.md, "Contract: the fetch launch"; gate M0.4 in
// docs/spikes.md): CS2 itself downloads a matchmaking demo from its share code, the
// way the Watch tab does, into game/csgo/replays/. One launch per code, in order,
// each under the full cycle a render launch has: .render.lock taken, guard(ids)
// (render account logged in, never the main one, no cs2.exe or HLAE.exe running),
// cs2.exe spawned directly as this process's child (no HLAE, -insecure always),
// the owned tree killed and verified gone (launch.ts), the lock released only then.
//
// Per code: queued → downloading → done | gone | pending | failed.
//   done     the match730_<padded outcome id>_<n>_<n>.dem appeared or changed after the
//            spawn, its .dem.info's field 1 is the code's match id, the demo is complete
//            (header and DEM_FileInfo) and size and mtime held 10 s, and the game's identity
//            line named RENDER_STEAM_ID64; copied into the inbox
//   gone     "Full match info indicates that the match has expired!" after
//            "Executing deferred download match: <code>", and no file for the code
//   pending  replays/ idle for 180 s, the 300 s cap, the game exited by itself, or the demo
//            settled without the game's identity line seen in console.log
//   failed   the launch itself: spawn error, the game's account is not RENDER_STEAM_ID64,
//            cleanup not verified, an oversize demo, a failed copy
// The run stops at the first pending or failed code. The game also plays the demo it
// downloaded (that is what the Watch tab's button does); the kill ends that.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Refusal, STATE_DIR, type Identities } from "../../config.ts";
import { demoIncomplete } from "../../parse/fileinfo.ts";
import { RenderLock, guard, lockStatus } from "../../render/controller/guards.ts";
import { consoleLogPath, launchLog, onEmergency, ownedCleanup } from "../../render/controller/launch.ts";
import { OwnedTree, isRunning } from "../../render/controller/processes.ts";
import { MAX_DEMO_BYTES, copyIntoInbox } from "./folders.ts";
import { decodeShareCode } from "./valve.ts";

export type FetchOutcome = "done" | "pending" | "gone" | "failed";
export type FetchContext = { inbox: string; dryRun: boolean; log: (line: string) => void };
export type FetchResult = {
  /** One per code asked for, in order; file (in the inbox) for done. */
  results: { code: string; outcome: FetchOutcome; file?: string; reason?: string }[];
  /** Set when no launch could start for a known, external reason (a held lock, a guard refusal): every code waits. */
  blocked?: string;
  /** False when a launch's cleanup could not be verified: a cs2.exe may be left and .render.lock stays. */
  cleanupVerified: boolean;
};
export type DemoFetcher = { fetch(codes: string[], ctx: FetchContext): Promise<FetchResult> };
export type FetchOptions = { idleS?: number; capS?: number; lockFile?: string };

const POLL_MS = 500;
const STABLE_MS = 10_000; // a done .dem: size and mtime unchanged this long after every check passed
const ROOT_DEADLINE_MS = 5_000; // the spawned cs2.exe must be seen as this process's child within this
const IDLE_S = 180;
const CAP_S = 300;
const DEM_RE = /^match730_(\d{21})_\d+_\d+\.dem$/;
const INFO_RE = /^match730_(\d{21})_\d+_\d+\.dem\.info$/;
// The exact lines the gate recorded; nothing broader is ever matched.
const IDENTITY_RE = /\[SteamNetSockets\] AuthStatus \(steamid:(\d+)\):/g;
const DEFERRED = (code: string) => `Executing deferred download match: ${code}`;
const PREPARED = "MatchInfo Download prepared replays/";
const DOWNLOADED = "Match is downloaded and can be watched immediately...";
const EXPIRED = "Full match info indicates that the match has expired!";
const CORRUPT = "Download container is corrupt!";

/**
 * The launch line, exactly the contract's: nothing that joins a server, loads a map or runs a cfg.
 * The share code is validated (SHARE_CODE and the decoder's alphabet) before it goes on it.
 */
export function launchArgs(code: string, stamp: number): string[] {
  decodeShareCode(code);
  const a = ["-insecure", "-novid", "-sw", "-width", "1280", "-height", "720", "-condebug", "+echo", `croclip_fetch_${stamp}`, "+csgo_download_match", code];
  if (a[0] !== "-insecure") throw new Error("refusing: a fetch launch without -insecure");
  if (a.some((x) => x.startsWith("+") && x !== "+echo" && x !== "+csgo_download_match")) throw new Error("refusing: unexpected console command on the launch line");
  return a;
}

/** process.env without USRLOCALCSGO in any casing: the game writes to its normal replays/. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== "USRLOCALCSGO") out[k] = v;
  return out;
}

/**
 * Field 1 of a .dem.info (CDataGCCStrike15_v2_MatchInfo.matchid) as a decimal string, wherever it
 * sits. The whole message is walked by protobuf wire rules (varint, 64-bit, length-delimited,
 * 32-bit); groups, unknown wire types, field number 0, a varint over 10 bytes or a length past the
 * end throw, as does a message without field 1 as a varint.
 */
export function infoMatchId(file: string): string {
  const b = readFileSync(file);
  let p = 0;
  const varint = (): bigint => {
    let r = 0n;
    for (let i = 0; i < 10; i++) {
      if (p >= b.length) throw new Error("truncated varint");
      const x = b[p++];
      r |= BigInt(x & 127) << BigInt(7 * i);
      if (!(x & 128)) { if (r > 0xffff_ffff_ffff_ffffn) throw new Error("varint over 64 bits"); return r; }
    }
    throw new Error("varint longer than 10 bytes");
  };
  const skip = (n: bigint) => { if (n > BigInt(b.length - p)) throw new Error("field runs past the end"); p += Number(n); };
  let id: string | undefined;
  while (p < b.length) {
    const key = varint();
    const field = key >> 3n, wire = Number(key & 7n);
    if (field < 1n || field > 536_870_911n) throw new Error(`field number ${field} outside protobuf's range`);
    if (field === 1n && wire !== 0) throw new Error("field 1 is not a varint");
    if (wire === 0) { const v = varint(); if (field === 1n) id = v.toString(); }
    else if (wire === 1) skip(8n);
    else if (wire === 2) skip(varint());
    else if (wire === 5) skip(4n);
    else throw new Error(`wire type ${wire} (a group or unknown)`);
  }
  if (id === undefined) throw new Error("no field 1");
  return id;
}

/**
 * The orphan-.info repair, the one write under game/ (gate M0.4, finding 7): a download killed
 * after the .dem.info was written and before the .dem arrived leaves the .info alone, and while it
 * is there the game never downloads that match again. Deletes match730_<padded outcome id>_*.dem.info
 * when no complete .dem sits beside it and its field 1 is the code's match id; returns the names.
 */
export function repairOrphanInfo(replaysDir: string, code: { matchId: string; paddedOutcomeId: string }): string[] {
  let names: string[];
  try { names = readdirSync(replaysDir); } catch { return []; }
  const removed: string[] = [];
  for (const n of names) {
    const m = INFO_RE.exec(n);
    if (!m || m[1] !== code.paddedOutcomeId) continue;
    const dem = path.join(replaysDir, n.slice(0, -".info".length));
    if (existsSync(dem) && !demoIncomplete(dem)) continue; // a complete pair: nothing to repair
    let id: string;
    try { id = infoMatchId(path.join(replaysDir, n)); } catch { continue; } // unreadable: not ours to judge
    if (id !== code.matchId) continue;
    rmSync(path.join(replaysDir, n));
    removed.push(n);
  }
  return removed;
}

/** The name of a complete .dem in replays/ for this code (padded outcome id, .info field 1 = match id, header and DEM_FileInfo), if any. */
export function completePair(replaysDir: string, matchId: string, paddedOutcomeId: string): string | undefined {
  let names: string[];
  try { names = readdirSync(replaysDir); } catch { return undefined; }
  return names.find((n) => {
    const m = DEM_RE.exec(n);
    if (!m || m[1] !== paddedOutcomeId) return false;
    try { return infoMatchId(path.join(replaysDir, `${n}.info`)) === matchId && !demoIncomplete(path.join(replaysDir, n)); } catch { return false; }
  });
}

type FStat = { size: number; mtimeMs: number };
const same = (a: FStat, b: FStat) => a.size === b.size && a.mtimeMs === b.mtimeMs;
function walk(dir: string, rel = "", out = new Map<string, FStat>()): Map<string, FStat> {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, r, out); continue; }
    try { const st = statSync(full); out.set(r, { size: st.size, mtimeMs: st.mtimeMs }); } catch {} // vanished between readdir and stat
  }
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Launch = { outcome: FetchOutcome; file?: string; reason?: string; blocked?: string; cleanupVerified: boolean };

export function fetchLauncher(ids: Identities, opts: FetchOptions = {}): DemoFetcher {
  const lockFile = opts.lockFile ?? path.join(STATE_DIR, ".render.lock");
  const otherLocks = [".clip.lock", ".go.lock"].map((f) => path.join(path.dirname(lockFile), f));
  const idleMs = (opts.idleS ?? IDLE_S) * 1000;
  const capMs = (opts.capS ?? CAP_S) * 1000;
  const replaysDir = path.resolve(path.dirname(ids.cs2Exe), "..", "..", "csgo", "replays");
  const consoleLog = consoleLogPath(ids.cs2Exe);

  async function launch(code: string, matchId: string, padded: string, log: (l: string) => void, inbox: string): Promise<Launch> {
    const say = (m: string) => log(`valve: ${code}: ${m}`);
    // Refuse before anything is written or launched: the lock first, then the guard; the lock
    // work (the orphan-.info repair) between it and the second guard.
    const lock = new RenderLock(lockFile);
    try { lock.acquire(); } catch (e) {
      if (e instanceof Refusal) return { outcome: "pending", blocked: `${e.message.replace(/^refusing: /, "")} (a render, a clip or another fetch launch holds it; run pnpm grab after it finishes)`, cleanupVerified: true };
      throw e;
    }
    // Until the emergency hook takes the lock over (below), a signal ending the process
    // (exitOnSignal in pnpm grab) gives it back on exit.
    const releaseBeforeLaunch = () => lock.release();
    process.on("exit", releaseBeforeLaunch);
    let args: string[];
    let stamp: number;
    try {
      const held = otherLocks.find((f) => existsSync(f));
      if (held) {
        // A live holder is a render run; a dead one is a lock that run left behind (a hard kill).
        const s = lockStatus(held);
        throw new Refusal(s.alive === false
          ? `${path.basename(held)} was left by pid ${s.pid}, which is no longer running: if no cs2.exe or HLAE.exe is left, delete ${held} and run pnpm grab again`
          : `a render run holds ${path.basename(held)}${s.pid ? ` (pid ${s.pid})` : ""}; run pnpm grab after it finishes`);
      }
      guard(ids);
      for (const n of repairOrphanInfo(replaysDir, { matchId, paddedOutcomeId: padded })) say(`removed replays/${n}, an interrupted download's leftover that stops CS2 from downloading this match again`);
      // A complete pair for this code already in replays/ (an inbox copy that failed earlier, or the
      // Watch tab's own download): no launch needed, the demo is local. The game is not running
      // (guard), so nothing writes it; the same checks as after a launch, then the copy.
      const existing = completePair(replaysDir, matchId, padded);
      if (existing) {
        const full = path.join(replaysDir, existing);
        const st = statSync(full);
        if (st.size > MAX_DEMO_BYTES) throw new Error(`replays/${existing} is ${st.size} bytes, over the ${MAX_DEMO_BYTES / 1024 ** 3} GiB demo limit`);
        const copied = copyIntoInbox(full, inbox, st);
        process.off("exit", releaseBeforeLaunch);
        lock.release();
        say(`already downloaded by CS2 -> ${path.basename(copied)}`);
        return { outcome: "done", file: copied, cleanupVerified: true };
      }
      stamp = Date.now();
      args = launchArgs(code, stamp);
      // Re-check right before the launch: the account or a running CS2 may have changed.
      guard(ids);
    } catch (e) {
      process.off("exit", releaseBeforeLaunch);
      lock.release();
      if (e instanceof Refusal) return { outcome: "pending", blocked: e.message, cleanupVerified: true };
      return { outcome: "failed", reason: `before the launch: ${(e as Error).message}`, cleanupVerified: true };
    }

    let tree: OwnedTree | undefined;
    const cleanup = ownedCleanup({ tree: () => tree, lock, unrooted: "the spawned cs2.exe was never identified as this process's child, so its processes were not tracked", tag: "[fetch]" });
    // From here the lock is the cleanup's; no await between the two lines, so no signal lands between them.
    process.off("exit", releaseBeforeLaunch);
    const offEmergency = onEmergency(cleanup, "pnpm grab exit during a fetch launch");
    const marker = `croclip_fetch_${stamp}`;
    let failure: string | undefined; // the launch failed
    let pendingWhy: string | undefined;
    let gone = false;
    let done: { name: string } & FStat | undefined;
    try {
      // The baseline is what replays/ holds at the spawn: nothing that changes after it is missed.
      const baseline = walk(replaysDir);
      const spawnedAt = Date.now();
      const child = spawn(ids.cs2Exe, args, { env: childEnv(), stdio: "ignore", windowsHide: true });
      let spawnError: Error | undefined;
      child.on("error", (e) => { spawnError = e; });
      if (child.pid === undefined) throw new Error("cs2.exe did not start");
      tree = new OwnedTree(child.pid, "cs2.exe", spawnedAt);
      tree.discover();
      say("CS2 started to download it (hands off the window; it closes by itself)");
      let files = baseline;
      let lastChange = spawnedAt;
      let touched = false; // a file of this code's appeared or changed after the spawn
      let identityOk = false;
      const said = new Set<string>();
      const once = (k: string, m: string) => { if (!said.has(k)) { said.add(k); say(m); } };
      // Candidates that passed every check, with when they last changed: rebuilt each poll, so a
      // candidate that vanished, went back to its baseline state or failed a check starts over.
      let ok = new Map<string, FStat & { since: number }>();
      const check = (now: number) => {
        const cur = walk(replaysDir);
        if (cur.size !== files.size || [...cur].some(([n, st]) => !files.has(n) || !same(files.get(n)!, st))) lastChange = now;
        files = cur;
        const prevOk = ok;
        ok = new Map();
        for (const [n, st] of cur) {
          const m = DEM_RE.exec(n) ?? INFO_RE.exec(n);
          if (!m || m[1] !== padded) continue;
          const base = baseline.get(n);
          if (base && same(base, st)) continue; // there at spawn and unchanged: never done on its own
          touched = true;
          if (!n.endsWith(".dem")) continue;
          const full = path.join(replaysDir, n);
          let infoOk = false;
          try { infoOk = infoMatchId(`${full}.info`) === matchId; } catch {}
          if (!infoOk || demoIncomplete(full)) continue;
          const k = prevOk.get(n);
          if (!k || !same(k, st)) { ok.set(n, { ...st, since: now }); once(`complete:${n}`, `replays/${n} is complete; settling`); continue; }
          ok.set(n, k);
          if (now - k.since >= STABLE_MS) { done = { name: n, ...st }; break; }
        }
        // Read on every poll, done or not: an identity mismatch outranks a finished download.
        const text = launchLog(consoleLog, spawnedAt, marker);
        if (text === undefined) return;
        // The game names the account it logged on as; anything but the render account ends the launch.
        for (const id of text.matchAll(IDENTITY_RE)) {
          if (id[1] !== ids.renderAccount) { failure = "the game logged on as an account that does not match RENDER_STEAM_ID64; launch killed"; return; }
          if (!identityOk) { identityOk = true; say("the game's account matches RENDER_STEAM_ID64"); }
        }
        const at = text.indexOf(DEFERRED(code));
        if (at < 0) return;
        const after = text.slice(at);
        once("deferred", "download requested");
        if (after.includes(PREPARED)) once("prepared", "match info written");
        if (after.includes(DOWNLOADED)) once("downloaded", "the game says the match is downloaded");
        if (after.includes(CORRUPT)) once("corrupt", `CS2 says "${CORRUPT}" (an interrupted download's leftover; the next run repairs it)`);
        if (after.includes(EXPIRED) && !touched) gone = true;
      };
      while (true) {
        await sleep(POLL_MS);
        if (spawnError) { failure = `cs2.exe spawn error: ${spawnError.message}`; break; }
        const snap = tree.discover();
        const now = Date.now();
        // Without the root nothing it starts is adopted; cleanup's "no cs2.exe at all" then fails closed.
        if (!tree.rooted && now - spawnedAt > ROOT_DEADLINE_MS) { failure = "the spawned cs2.exe was never seen as this process's child"; break; }
        check(now);
        if (failure || done || gone) break;
        const games = tree.games();
        if (games.length && !games.some((g) => isRunning(g, snap))) { pendingWhy = "CS2 exited by itself before the demo was complete"; break; }
        if (now - lastChange >= idleMs) { pendingWhy = `nothing under replays/ changed for ${idleMs / 1000} s`; break; }
        if (now - spawnedAt >= capMs) { pendingWhy = `not complete within ${capMs / 1000} s`; break; }
      }
      // Reconcile once more before the kill.
      if (!failure && !done && !gone) check(Date.now());
      // A finished download counts only when the game named the render account: unread is not matched.
      if (!failure && done && !identityOk) { done = undefined; pendingWhy = "the game's account could not be read from console.log; nothing advanced"; }
    } catch (e) {
      failure = `fetch launch error: ${(e as Error).message}`;
    }
    const verified = cleanup(failure ?? (done ? "demo complete" : gone ? "match expired" : pendingWhy ?? "launch end"));
    offEmergency();
    if (!verified) return { outcome: "failed", reason: `cleanup not verified: a cs2.exe may be left and ${lockFile} stays${failure ? `; ${failure}` : ""}`, cleanupVerified: false };
    if (failure) return { outcome: "failed", reason: failure, cleanupVerified: true };
    if (gone) return { outcome: "gone", reason: "Valve says the match has expired", cleanupVerified: true };
    if (!done) return { outcome: "pending", reason: pendingWhy ?? "not complete", cleanupVerified: true };
    // The game is gone, so nothing writes the file now: re-check it, then copy it into the inbox.
    const d: { name: string } & FStat = done;
    const file = path.join(replaysDir, d.name);
    try {
      const st = statSync(file);
      if (!same(st, d) || demoIncomplete(file)) return { outcome: "pending", reason: `replays/${d.name} changed after it was complete`, cleanupVerified: true };
      if (st.size > MAX_DEMO_BYTES) return { outcome: "failed", reason: `replays/${d.name} is ${st.size} bytes, over the ${MAX_DEMO_BYTES / 1024 ** 3} GiB demo limit`, cleanupVerified: true };
      const copied = copyIntoInbox(file, inbox, st);
      say(`downloaded -> ${path.basename(copied)}`);
      return { outcome: "done", file: copied, cleanupVerified: true };
    } catch (e) {
      return { outcome: "failed", reason: `copying replays/${d.name} into the inbox: ${(e as Error).message}`, cleanupVerified: true };
    }
  }

  return {
    async fetch(codes, ctx) {
      // Every code checked and decoded before anything is locked or launched.
      const decoded = codes.map((code) => ({ code, ...decodeShareCode(code) }));
      if (ctx.dryRun) {
        for (const d of decoded) ctx.log(`valve: would launch CS2 to download match ${d.code} (one launch, at most ${capMs / 1000} s)`);
        return { results: codes.map((code) => ({ code, outcome: "pending", reason: "dry run: nothing launched" })), cleanupVerified: true };
      }
      const results: FetchResult["results"] = [];
      const rest = (from: number, reason: string) => { for (const d of decoded.slice(from)) results.push({ code: d.code, outcome: "pending", reason }); };
      for (let i = 0; i < decoded.length; i++) {
        const d = decoded[i];
        const r = await launch(d.code, d.matchId, d.paddedOutcomeId, ctx.log, ctx.inbox);
        if (r.blocked) { rest(i, r.blocked); return { results, blocked: r.blocked, cleanupVerified: true }; }
        results.push({ code: d.code, outcome: r.outcome, ...(r.file ? { file: r.file } : {}), ...(r.reason ? { reason: r.reason } : {}) });
        if (!r.cleanupVerified) { rest(i + 1, "after a launch whose cleanup was not verified"); return { results, cleanupVerified: false }; }
        if (r.outcome === "pending" || r.outcome === "failed") { rest(i + 1, "after an earlier pending match"); break; }
      }
      return { results, cleanupVerified: true };
    },
  };
}
