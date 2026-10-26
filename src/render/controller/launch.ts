// What every guarded CS2 launch shares, whoever started it: the render controller
// (index.ts, through HLAE) and the matchmaking fetch launch (ingest/sources/valve-fetch.ts,
// cs2.exe directly). The fail-closed cleanup of the owned tree, the emergency hooks that run
// it on a signal or a crash, and the console.log reader that only accepts this launch's log.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RenderLock } from "./guards.ts";
import { isRunning, key, killExact, type OwnedTree, type Proc } from "./processes.ts";

const POLL_MS = 500;
const QUIET_MS = 10_000; // verification: continuous quiet required after the first empty snapshot
const VERIFY_LIMIT_MS = 60_000; // verification: give up after this long
const KILL_ROUNDS = 5;
const EXTRA_KILL_ROUNDS = 5; // owned survivors found during verification are re-killed at most this often

// Latched for the life of the process: once a cleanup could not be verified, the
// CLI exits 3 whatever else fails afterwards, and the lock stays.
let unverified = false;
export const cleanupUnverified = () => unverified;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export type CleanupSpec = {
  /** The owned tree; undefined when nothing was spawned (then only the lock is released). */
  tree: () => OwnedTree | undefined;
  lock: RenderLock;
  /** The error when the root was never identified (nothing it started could be tracked). */
  unrooted: string;
  /** An image killed first in each round, so it cannot start another game (the HLAE loader). */
  killFirst?: string;
  tag: string; // log prefix, e.g. "[controller]"
};

/**
 * cleanup(reason) → verified, latched (a second call returns the first result, so a signal
 * during cleanup does not start another). Synchronous: it runs from exit and signal handlers.
 * Kill rounds over the owned tree, re-discovering after each; then verification: no owned
 * process, no suspect orphan and no cs2.exe at all (the guard proved none ran at launch, so any
 * is ours or unexplained), continuously for QUIET_MS. Owned survivors found during verification
 * go back into the kill rounds (bounded); suspects and unowned cs2.exe are never killed, only
 * waited for. Verified → the lock is released; not verified → the latch is set and the lock stays.
 */
export function ownedCleanup(spec: CleanupSpec): (reason: string) => boolean {
  let cleaned: boolean | undefined;
  return (reason: string): boolean => {
    if (cleaned !== undefined) return cleaned;
    const tree = spec.tree();
    if (!tree) { spec.lock.release(); return (cleaned = true); }
    cleaned = false; // latched first: a signal during cleanup does not start a second one
    const errors: string[] = [];
    if (!tree.rooted) errors.push(spec.unrooted);
    const kill = (p: Proc) => {
      try { if (killExact(p) === "killed") console.log(`${spec.tag} killed ${p.name} pid ${p.pid}`); }
      catch (e) { errors.push(`${p.name} pid ${p.pid}: ${(e as Error).message}`); }
    };
    // Kill rounds, re-discovering after each: a descendant can start, or be orphaned, mid-kill.
    const first = spec.killFirst?.toLowerCase();
    const done = new Set<string>();
    for (let round = 0; round < KILL_ROUNDS; round++) {
      try { tree.discover(); } catch (e) { errors.push(`could not list owned processes: ${(e as Error).message}`); break; }
      const pending = [...tree.procs.values()].filter((p) => !done.has(key(p)))
        .sort((a, b) => Number(b.name.toLowerCase() === first) - Number(a.name.toLowerCase() === first));
      if (!pending.length) break;
      for (const p of pending) { done.add(key(p)); kill(p); }
    }
    let quietSince: number | undefined;
    let extra = 0;
    const deadline = Date.now() + VERIFY_LIMIT_MS;
    for (;;) {
      let snap: Proc[];
      try { snap = tree.discover(); } catch (e) { errors.push(`verification failed: ${(e as Error).message}`); break; }
      const now = Date.now();
      const left = [...tree.procs.values()].filter((o) => isRunning(o, snap));
      const suspects = tree.suspects(snap);
      const cs2 = snap.filter((x) => x.name.toLowerCase() === "cs2.exe");
      if (!left.length && !suspects.length && !cs2.length) {
        quietSince ??= now;
        if (now - quietSince >= QUIET_MS) break;
      } else quietSince = undefined;
      // The limit is checked before every re-kill round and every wait; a kill or a snapshot that
      // blocks can carry one iteration past it, so it is soft by one such call.
      if (now > deadline) {
        for (const p of left) errors.push(`${p.name} pid ${p.pid} still running`);
        for (const p of suspects) errors.push(`${p.name} pid ${p.pid} may be an orphan of ours and is still running`);
        if (cs2.length) errors.push(`a cs2.exe is still running (pid ${cs2.map((p) => p.pid).join(", ")})`);
        if (!left.length && !suspects.length && !cs2.length) errors.push(`no ${QUIET_MS / 1000} s of quiet within ${VERIFY_LIMIT_MS / 1000} s`);
        break;
      }
      if (left.length && extra < EXTRA_KILL_ROUNDS) { extra++; for (const p of left) kill(p); continue; }
      pause(POLL_MS);
    }
    if (errors.length) {
      unverified = true;
      console.error(`CLEANUP NOT VERIFIED (${reason}): ${errors.join("; ")}. Check for cs2.exe by hand. The lock stays: ${spec.lock.file}`);
      return (cleaned = false);
    }
    spec.lock.release();
    return (cleaned = true);
  };
}

const SIGNALS = ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const;
let emergencies = 0;
/** Whether a launch's emergency hook is installed right now: it ends the process itself on a signal. */
export const emergencyActive = () => emergencies > 0;

/**
 * While a launch runs, a normal exit, a signal or an uncaught exception runs cleanup first and
 * then picks the exit code (3 when it could not be verified). Returns the uninstaller.
 */
export function onEmergency(cleanup: (reason: string) => boolean, exitReason: string): () => void {
  const onExit = () => { if (!cleanup(exitReason)) process.exitCode = 3; };
  const onSignal = (sig: string) => { process.exit(cleanup(sig) ? 130 : 3); };
  const onUncaught = (e: Error) => { console.error(e); process.exit(cleanup(`uncaught: ${e.message}`) ? 1 : 3); };
  emergencies++;
  process.on("exit", onExit);
  process.on("uncaughtException", onUncaught);
  for (const sig of SIGNALS) process.on(sig, onSignal);
  return () => {
    emergencies--;
    process.off("exit", onExit);
    process.off("uncaughtException", onUncaught);
    for (const sig of SIGNALS) process.off(sig, onSignal);
  };
}

/**
 * A command's own signal handling, for the stretches outside a launch (ingest, parse, post,
 * the guards before a launch): Node's default for a signal is a plain kill, which fires no
 * exit hook, so the locks the exit hooks release (.go.lock, .clip.lock, a render lock taken
 * before its launch) stayed behind (2026-10-26). This ends the process instead, 130 (3 when an
 * earlier cleanup is unverified), so they are released. During a launch its emergency hook ends
 * the process itself, after the cleanup, so this one steps aside. Returns the uninstaller; the
 * handler is exposed for tests, since Windows delivers no signal to a child process.
 */
export function exitOnSignal(label: string): { off: () => void; onSignal: (sig: string) => void } {
  const onSignal = (sig: string) => {
    if (emergencyActive()) return;
    console.error(`${label} stopped (${sig}); locks released`);
    process.exit(cleanupUnverified() ? 3 : 130);
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);
  return { off: () => { for (const sig of SIGNALS) process.off(sig, onSignal); }, onSignal };
}

/** game/csgo/console.log, which -condebug makes the launch's evidence (CS2 truncates it per launch). */
export const consoleLogPath = (cs2Exe: string) => path.resolve(path.dirname(cs2Exe), "..", "..", "csgo", "console.log");

/**
 * console.log's text when it is this launch's: modified after sinceMs (1 s slack) and holding
 * the launch's own marker, which CS2 echoes in its [CommandLine] line; undefined otherwise.
 */
export function launchLog(file: string, sinceMs: number, marker: string): string | undefined {
  try {
    // The 1 s slack is the controller's (its sinceMs is taken just before HLAE starts); the fetcher
    // passes its own spawn time. The marker, not the time, is what identifies the log.
    if (statSync(file).mtimeMs < sinceMs - 1000) return undefined;
    const text = readFileSync(file, "utf8");
    return text.includes(marker) ? text : undefined;
  } catch { return undefined; }
}

