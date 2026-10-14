// Replay controller: one guarded CS2 launch per job, driven by a generated cfg
// and HLAE tick scheduling, as an explicit state machine.
//
//   launched → loaded → seeked → capturing → stopped → exited → validated
//
// Evidence per state: an owned cs2.exe (launched), console.log lines
// ("Host activate: Playing Demo", "Demo Skipping finished at tick <seek>",
// "[Movie] Started recording movie" or the video file, "Finishing movie …
// [N frames"), the owned cs2.exe gone (exited), and the raw outputs checked
// (validated). "Settled" and "POV locked" have no observable evidence: the
// seek lands SETTLE_TICKS before the record start and spec_player runs 17
// ticks after the seek; frames are checked on the output instead.
//
// Exit codes the CLI derives from this: Refusal = 2 (nothing launched),
// cleanupVerified false = 3 (a game process may still be running; the lock stays).
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Identities, RenderSettings } from "../../config.ts";
import { TICKRATE } from "../../parse/clip-facts.ts";
import { countFrames, decodeProblems, probe } from "../../post/ffmpeg.ts";
import { FINISHED_RE, STARTED_RE, hlaeArgs, hlaeCapture, takeOutputs } from "../capture/hlae.ts";
import { jobCfg } from "./cfg.ts";
import { RenderLock, guard } from "./guards.ts";
import { OwnedTree, isRunning, key, killExact, type Proc } from "./processes.ts";

/** Recorded on each side of the requested ticks; post trims it off. */
export const MARGIN_TICKS = 32;
/** The seek lands this far before the record start. */
export const SETTLE_TICKS = 2 * TICKRATE;

export type RenderJob = {
  title: string;
  demo: string;
  slot: number;
  startTick: number;
  endTick: number;
  workDir: string; // fresh per attempt; must not exist
  lockFile: string;
  ids: Identities;
  settings: RenderSettings;
  lookCfg: string;
  timeoutS?: number;
};

/** As scheduled: frame k of the raw capture should show tick recordStartTick + k * tickrate / fps. Post measures the actual origin. */
export type TickMapping = { tickrate: number; fps: number; recordStartTick: number; recordEndTick: number; frames: number };

const STATES = ["launched", "loaded", "seeked", "capturing", "stopped", "exited"] as const;
type State = (typeof STATES)[number];

export type RenderResult = {
  status: "ok" | "failed";
  reasons: string[];
  cleanupVerified: boolean;
  owned: string[];
  states: Partial<Record<State | "validated", string>>;
  logLive: boolean;
  video?: string;
  audio?: string;
  mapping?: TickMapping;
  wallSeconds: number;
};

// Latched for the life of the process: once a cleanup could not be verified,
// the CLI exits 3 whatever else fails afterwards.
let unverified = false;
export const cleanupUnverified = () => unverified;

/** Reasons the raw capture is unusable; [] when it checks out against HLAE's frame count. */
export function validateCapture(video: string, wav: string | undefined, frames: number, fps: number): string[] {
  const reasons: string[] = [];
  const v = existsSync(video) ? probe(video) : undefined;
  if (!v?.video || v.unreadable) reasons.push(`raw video unreadable: ${JSON.stringify(v ?? null)}`);
  else {
    const counted = countFrames(video);
    if (counted !== frames) reasons.push(`raw video has ${counted} frames, HLAE reported ${frames}`);
    const err = decodeProblems(video);
    if (err) reasons.push(`raw video decode: ${err}`);
  }
  const a = wav && existsSync(wav) ? probe(wav) : undefined;
  if (!a?.audio || a.unreadable || a.duration === null || Math.abs(a.duration - frames / fps) > 3 / fps) reasons.push(`raw audio bad: ${JSON.stringify(a ?? null)}`);
  return reasons;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export async function render(job: RenderJob): Promise<RenderResult> {
  const { ids, settings: s } = job;
  const recordStartTick = job.startTick - MARGIN_TICKS;
  const recordEndTick = job.endTick + MARGIN_TICKS;
  const seekTick = recordStartTick - SETTLE_TICKS;
  const quitTick = recordEndTick + TICKRATE;
  const clipSeconds = (recordEndTick - recordStartTick) / TICKRATE;
  const timeoutS = job.timeoutS ?? Math.max(180, 120 + 4 * clipSeconds);

  // Refuse before anything is written or launched.
  const lock = new RenderLock(job.lockFile);
  lock.acquire();
  try { guard(ids); } catch (e) { lock.release(); throw e; }

  const t0 = Date.now();
  const stamp = String(t0);
  const cfgName = `croclip_${stamp}`; // unique per launch: proves console.log is this launch's
  const usrDir = path.join(job.workDir, "usrlocal"); // USRLOCALCSGO: the game's user config goes here
  const cap = hlaeCapture(job.workDir, s);
  let args: string[];
  try {
    if (existsSync(job.workDir)) throw new Error(`work dir already exists: ${job.workDir}`);
    mkdirSync(path.join(usrDir, "cfg"), { recursive: true });
    mkdirSync(cap.takeDir, { recursive: true });
    writeFileSync(path.join(usrDir, "cfg", "croclip_look.cfg"), job.lookCfg);
    writeFileSync(path.join(usrDir, "cfg", `${cfgName}.cfg`), jobCfg({
      title: job.title, lookCfgName: "croclip_look", captureSetup: cap.setup, recordStart: cap.start, recordEnd: cap.end,
      seekTick, slot: job.slot, recordStartTick, recordEndTick, quitTick,
    }));
    const csArgs = ["-insecure", "-novid", "-sw", "-width", String(s.width), "-height", String(s.height), "-condebug", "+exec", cfgName, "+playdemo", `"${job.demo}"`];
    args = hlaeArgs(ids.hlaeExe, ids.cs2Exe, csArgs);
    writeFileSync(path.join(job.workDir, "job.json"), JSON.stringify({ title: job.title, demo: job.demo, startTick: job.startTick, endTick: job.endTick, slot: job.slot, recordStartTick, recordEndTick, seekTick, quitTick, settings: s, hlaeExe: ids.hlaeExe, hlaeArgs: args, timeoutS }, null, 2));
    // Re-check right before launch: the account or a running CS2 may have changed.
    guard(ids);
  } catch (e) {
    lock.release();
    throw e;
  }

  // --- owned processes and cleanup -----------------------------------------------------
  let tree: OwnedTree | undefined;
  const cleanupErrors: string[] = [];
  let cleaned: boolean | undefined;
  function cleanup(reason: string): boolean {
    if (cleaned !== undefined) return cleaned;
    if (!tree) { lock.release(); return (cleaned = true); }
    // Without the loader nothing it started could be tracked: fail closed.
    if (!tree.rooted) cleanupErrors.push("the HLAE loader was never identified, so its processes were not tracked");
    // Kill rounds, loader first so it cannot start another game, re-discovering
    // after each round: a descendant can start, or be orphaned, mid-kill.
    const done = new Set<string>();
    for (let round = 0; round < 5; round++) {
      try { tree.discover(); } catch (e) { cleanupErrors.push(`could not list owned processes: ${(e as Error).message}`); break; }
      const pending = [...tree.procs.values()].filter((p) => !done.has(key(p)))
        .sort((a, b) => Number(b.name.toLowerCase() === "hlae.exe") - Number(a.name.toLowerCase() === "hlae.exe"));
      if (!pending.length) break;
      for (const p of pending) {
        done.add(key(p));
        try { if (killExact(p) === "killed") console.log(`[controller] killed ${p.name} pid ${p.pid}`); }
        catch (e) { cleanupErrors.push(`${p.name} pid ${p.pid}: ${(e as Error).message}`); }
      }
    }
    // Every owned process gone, and no cs2.exe at all: none was running at
    // launch, so any survivor is either ours or unexplained.
    // Possible orphans of a dead owned process are never killed, only waited for.
    for (let i = 0; i < 50; i++) {
      let left: Proc[] = [];
      let suspects: Proc[] = [];
      let cs2Left = false;
      try {
        const snap = tree.discover();
        left = [...tree.procs.values()].filter((o) => isRunning(o, snap));
        suspects = tree.suspects(snap);
        cs2Left = snap.some((x) => x.name.toLowerCase() === "cs2.exe");
      } catch (e) { cleanupErrors.push(`verification failed: ${(e as Error).message}`); break; }
      if (!left.length && !suspects.length && !cs2Left) break;
      if (i === 49) {
        for (const p of left) cleanupErrors.push(`${p.name} pid ${p.pid} still running`);
        for (const p of suspects) cleanupErrors.push(`${p.name} pid ${p.pid} may be an orphan of ours and is still running`);
        if (cs2Left) cleanupErrors.push("a cs2.exe is still running");
      }
      pause(200);
    }
    if (cleanupErrors.length) {
      unverified = true;
      console.error(`CLEANUP NOT VERIFIED (${reason}): ${cleanupErrors.join("; ")}. Check for cs2.exe by hand. The lock stays: ${job.lockFile}`);
      return (cleaned = false);
    }
    lock.release();
    return (cleaned = true);
  }
  const onExit = () => { if (!cleanup("controller exit")) process.exitCode = 3; };
  const onSignal = (sig: string) => { process.exit(cleanup(sig) ? 130 : 3); };
  const onUncaught = (e: Error) => { console.error(e); process.exit(cleanup(`uncaught: ${e.message}`) ? 1 : 3); };
  const signals = ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const;
  process.on("exit", onExit);
  process.on("uncaughtException", onUncaught);
  for (const sig of signals) process.on(sig, onSignal);

  // --- run the state machine -------------------------------------------------------------
  const consoleLog = path.resolve(path.dirname(ids.cs2Exe), "..", "..", "csgo", "console.log");
  const readLog = (): string | undefined => {
    try {
      if (statSync(consoleLog).mtimeMs < t0 - 1000) return undefined;
      const text = readFileSync(consoleLog, "utf8");
      return text.includes(`+exec ${cfgName} `) ? text : undefined;
    } catch { return undefined; }
  };
  const evidence: Record<State, (log: string) => boolean> = {
    launched: () => tree!.games().length > 0,
    loaded: (log) => log.includes("Host activate: Playing Demo"),
    seeked: (log) => new RegExp(`Demo Skipping finished at tick ${seekTick}\\b`).test(log),
    capturing: (log) => STARTED_RE.test(log) || existsSync(cap.videoPath),
    stopped: (log) => FINISHED_RE.test(log),
    exited: () => false, // decided from the process snapshot below
  };
  // Seconds allowed from the previous state; log-based ones only once the log is seen live.
  const limit: Record<State, number> = { launched: 60, loaded: 120, seeked: 90, capturing: 30, stopped: 30 + 4 * clipSeconds, exited: 30 };
  const states: RenderResult["states"] = {};
  const reachedAt: Partial<Record<State, number>> = {};
  const reasons: string[] = [];
  let logLive = false;
  let failure: string | undefined;

  try {
    const spawnedAt = Date.now();
    const child = spawn(ids.hlaeExe, args, { env: { ...process.env, USRLOCALCSGO: usrDir }, stdio: "ignore", windowsHide: true });
    let spawnError: Error | undefined;
    child.on("error", (e) => { spawnError = e; });
    if (child.pid === undefined) throw new Error("HLAE did not start");
    tree = new OwnedTree(child.pid, "HLAE.exe", spawnedAt);
    tree.discover();
    let prevAt = Date.now();
    const rootDeadline = Date.now() + 5000;
    while (true) {
      await sleep(500);
      if (spawnError) { failure = `HLAE spawn error: ${spawnError.message}`; break; }
      const snap = tree.discover();
      // Without the loader itself nothing it starts is ever adopted; the final
      // "no cs2.exe at all" check then fails cleanup instead of guessing.
      if (!tree.rooted && Date.now() > rootDeadline) { failure = "HLAE loader never seen as this controller's child"; break; }
      const log = readLog();
      if (log !== undefined) logLive = true;
      for (const st of STATES) {
        if (reachedAt[st] !== undefined) continue;
        if (st === "exited" || !evidence[st](log ?? "")) break;
        reachedAt[st] = prevAt = Date.now();
        states[st] = new Date(prevAt).toISOString();
        console.log(`[controller] ${st} after ${Math.round((prevAt - t0) / 1000)}s`);
      }
      const games = tree.games();
      if (games.length > 0 && !games.some((g) => isRunning(g, snap))) {
        reachedAt.exited = Date.now();
        states.exited = new Date().toISOString();
        console.log(`[controller] exited after ${Math.round((Date.now() - t0) / 1000)}s`);
        break;
      }
      const next = STATES.find((st) => reachedAt[st] === undefined)!;
      const logBased = next === "loaded" || next === "seeked" || next === "stopped";
      if ((!logBased || logLive) && Date.now() - prevAt > limit[next] * 1000) { failure = `timeout waiting for ${next} (${limit[next]}s)`; break; }
      if (Date.now() - t0 > timeoutS * 1000) { failure = `job timeout ${timeoutS}s waiting for ${next}`; break; }
    }
  } catch (e) {
    failure = `controller error: ${(e as Error).message}`;
  }
  const cleanupVerified = cleanup(failure ?? "job end");
  process.off("exit", onExit);
  process.off("uncaughtException", onUncaught);
  for (const sig of signals) process.off(sig, onSignal);
  const owned = tree?.list() ?? [];
  console.log(`[controller] ${cleanupVerified ? "game gone" : "CLEANUP NOT VERIFIED"} after ${Math.round((Date.now() - t0) / 1000)}s; owned: ${owned.join(",") || "none"}`);

  // --- validate the raw capture against the final console log --------------------------
  try { copyFileSync(consoleLog, path.join(job.workDir, "console.log")); } catch {}
  const finalLog = readLog() ?? "";
  if (!cleanupVerified) reasons.push("cleanup not verified");
  if (failure) reasons.push(failure);
  for (const st of STATES) if (st !== "launched" && st !== "exited" && !evidence[st](finalLog)) reasons.push(`no evidence for ${st} in console.log`);
  const { takes, wav } = takeOutputs(cap);
  if (takes.length !== 1) reasons.push(`expected one take folder, found ${takes.length}`);
  const finished = finalLog.match(FINISHED_RE);
  const expectedFrames = ((recordEndTick - recordStartTick) * s.fps) / TICKRATE;
  let mapping: TickMapping | undefined;
  if (!reasons.length) {
    try {
      const frames = Number(finished![1]);
      if (Number(finished![2]) !== s.fps) reasons.push(`HLAE recorded at ${finished![2]} fps, expected ${s.fps}`);
      if (Math.abs(frames - expectedFrames) > 3) reasons.push(`HLAE finished ${frames} frames, expected ${expectedFrames.toFixed(1)}`);
      reasons.push(...validateCapture(cap.videoPath, wav, frames, s.fps));
      mapping = { tickrate: TICKRATE, fps: s.fps, recordStartTick, recordEndTick, frames };
    } catch (e) { reasons.push(`validation error: ${(e as Error).message}`); }
  }
  if (!reasons.length) states.validated = new Date().toISOString();
  const result: RenderResult = {
    status: reasons.length ? "failed" : "ok",
    reasons, cleanupVerified, owned, states, logLive,
    video: cap.videoPath, audio: wav, mapping,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
  };
  try { writeFileSync(path.join(job.workDir, "render.json"), JSON.stringify(result, null, 2)); }
  catch (e) { console.error(`could not write render.json: ${(e as Error).message}`); }
  return result;
}
