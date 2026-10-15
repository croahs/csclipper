// Replay controller: one guarded CS2 launch per job, driven by generated cfgs
// and HLAE tick scheduling, as an explicit state machine. A job is one or more
// takes of the same demo (chained takes, PLAN.md §5), each with its own seek,
// spectated slot and output:
//
//   launched → loaded → (seeked → capturing → stopped) per take → exited → validated
//
// Evidence per state: an owned cs2.exe (launched), console.log lines
// ("Host activate: Playing Demo", "Demo Skipping finished at tick <seek>",
// "[Movie] Started recording movie" or the take's video file, "Finishing movie …
// [N frames", counted per take), the owned cs2.exe gone (exited), and the raw
// outputs checked per take (validated). "Settled" and "POV locked" have no
// observable evidence: the seek lands SETTLE_TICKS before the record start and
// spec_player runs 17 ticks after the seek; frames are checked on the output instead.
//
// Exit codes the CLI derives from this: Refusal = 2 (nothing launched),
// cleanupVerified false = 3 (a game process may still be running; the lock stays).
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { captureSize, type Identities, type RenderSettings } from "../../config.ts";
import { TICKRATE } from "../../parse/clip-facts.ts";
import { countFrames, decodeProblems, probe } from "../../post/ffmpeg.ts";
import { FINISHED_RE, STARTED_RE, hlaeArgs, hlaeCapture, takeOutputs } from "../capture/hlae.ts";
import { jobCfgs, type CrosshairSource } from "./cfg.ts";
import { RenderLock, guard } from "./guards.ts";
import { OwnedTree, isRunning, key, killExact, type Proc } from "./processes.ts";

/** Recorded on each side of the requested ticks; post trims it off. */
export const MARGIN_TICKS = 32;
/** The seek lands this far before the record start. */
export const SETTLE_TICKS = 2 * TICKRATE;

/** One take: the requested ticks and the spectator slot to watch them from. */
export type TakeSpec = { startTick: number; endTick: number; slot: number };

export type RenderJob = {
  title: string;
  demo: string;
  takes: TakeSpec[]; // in render order (chosen to keep backward seeks few)
  workDir: string; // fresh per attempt; must not exist
  lockFile: string;
  ids: Identities;
  settings: RenderSettings;
  lookCfg: string;
  crosshair: CrosshairSource;
  debugCommands?: string[];
  timeoutS?: number;
};

/** As scheduled: frame k of the raw capture should show tick recordStartTick + k * tickrate / fps. Post measures the actual origin. */
export type TickMapping = { tickrate: number; fps: number; recordStartTick: number; recordEndTick: number; frames: number };

/** One take's raw outputs, checked against HLAE's frame count; reasons [] when usable. */
export type TakeResult = { video: string; audio?: string; mapping?: TickMapping; reasons: string[] };

export type RenderResult = {
  status: "ok" | "failed"; // failed: something in the launch went wrong; each take still says whether its own capture is usable
  reasons: string[];
  cleanupVerified: boolean;
  owned: string[];
  states: Record<string, string>; // state (per take: "seeked#1" …) → time reached
  logLive: boolean;
  takes: TakeResult[];
  wallSeconds: number;
};

// Latched for the life of the process: once a cleanup could not be verified,
// the CLI exits 3 whatever else fails afterwards.
let unverified = false;
export const cleanupUnverified = () => unverified;

/** Reasons the raw capture is unusable; [] when it checks out against HLAE's frame count. */
export function validateCapture(video: string, wav: string | undefined, frames: number, fps: number, size: string): string[] {
  const reasons: string[] = [];
  const v = existsSync(video) ? probe(video) : undefined;
  if (!v?.video || v.unreadable) reasons.push(`raw video unreadable: ${JSON.stringify(v ?? null)}`);
  else {
    // CS2 may not get the window size it was asked for (e.g. larger than the desktop).
    if (v.size !== size) reasons.push(`raw video is ${v.size}, the game was asked for ${size}`);
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
  if (!job.takes.length) throw new Error("a render job needs at least one take");
  const plan = job.takes.map((t) => {
    const recordStartTick = t.startTick - MARGIN_TICKS;
    const recordEndTick = t.endTick + MARGIN_TICKS;
    return { ...t, recordStartTick, recordEndTick, seekTick: recordStartTick - SETTLE_TICKS, seconds: (recordEndTick - recordStartTick) / TICKRATE };
  });
  const clipSeconds = plan.reduce((n, t) => n + t.seconds, 0);
  const timeoutS = job.timeoutS ?? Math.max(180, 120 + plan.length * 60 + 4 * clipSeconds);

  // Refuse before anything is written or launched.
  const lock = new RenderLock(job.lockFile);
  lock.acquire();
  try { guard(ids); } catch (e) { lock.release(); throw e; }

  const t0 = Date.now();
  const stamp = String(t0);
  const cfgName = `croclip_${stamp}`; // unique per launch: proves console.log is this launch's
  const usrDir = path.join(job.workDir, "usrlocal"); // USRLOCALCSGO: the game's user config goes here
  const cap = hlaeCapture(job.workDir, s, plan.length);
  let args: string[];
  try {
    if (existsSync(job.workDir)) throw new Error(`work dir already exists: ${job.workDir}`);
    mkdirSync(path.join(usrDir, "cfg"), { recursive: true });
    mkdirSync(cap.takeDir, { recursive: true });
    writeFileSync(path.join(usrDir, "cfg", "croclip_look.cfg"), job.lookCfg);
    const cfgs = jobCfgs({
      title: job.title, hud: s.hud, debugCommands: job.debugCommands ?? [], lookCfgName: "croclip_look", crosshair: job.crosshair, captureSetup: cap.setup, recordStart: cap.start, recordEnd: cap.end,
      takes: plan.map((t, i) => ({ seekTick: t.seekTick, slot: t.slot, recordStartTick: t.recordStartTick, recordEndTick: t.recordEndTick, select: cap.select(i) })),
      takeCfgName: (i) => `${cfgName}_t${i}`,
    });
    writeFileSync(path.join(usrDir, "cfg", `${cfgName}.cfg`), cfgs.main);
    for (const t of cfgs.takes) writeFileSync(path.join(usrDir, "cfg", `${t.name}.cfg`), t.body);
    const size = captureSize(s);
    const csArgs = ["-insecure", "-novid", "-sw", "-width", String(size.width), "-height", String(size.height), "-condebug", "+exec", cfgName, "+playdemo", `"${job.demo}"`];
    args = hlaeArgs(ids.hlaeExe, ids.cs2Exe, csArgs);
    writeFileSync(path.join(job.workDir, "job.json"), JSON.stringify({ title: job.title, demo: job.demo, takes: plan, crosshair: job.crosshair, settings: s, hlaeExe: ids.hlaeExe, hlaeArgs: args, timeoutS }, null, 2));
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
  const count = (log: string, re: RegExp) => (log.match(new RegExp(re.source, "g")) ?? []).length;
  // A seek tick may repeat (the same take twice): take i's seek is reached when the log
  // has as many "finished at tick" lines for it as takes 0..i seek there.
  const seekCount = (i: number) => plan.slice(0, i + 1).filter((t) => t.seekTick === plan[i].seekTick).length;
  type Step = { name: string; logBased: boolean; limitS: number; reached: (log: string) => boolean };
  const steps: Step[] = [
    { name: "launched", logBased: false, limitS: 60, reached: () => tree!.games().length > 0 },
    { name: "loaded", logBased: true, limitS: 120, reached: (log) => log.includes("Host activate: Playing Demo") },
    ...plan.flatMap((t, i): Step[] => {
      const tag = plan.length > 1 ? `#${i}` : "";
      return [
        { name: `seeked${tag}`, logBased: true, limitS: 90, reached: (log) => count(log, new RegExp(`Demo Skipping finished at tick ${t.seekTick}\\b`)) >= seekCount(i) },
        { name: `capturing${tag}`, logBased: false, limitS: 30, reached: (log) => count(log, STARTED_RE) >= i + 1 || existsSync(cap.videoPaths[i]) },
        { name: `stopped${tag}`, logBased: true, limitS: 30 + 4 * t.seconds, reached: (log) => count(log, FINISHED_RE) >= i + 1 },
      ];
    }),
  ];
  const states: RenderResult["states"] = {};
  let next = 0; // the first step not reached yet
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
      while (next < steps.length && steps[next].reached(log ?? "")) {
        prevAt = Date.now();
        states[steps[next].name] = new Date(prevAt).toISOString();
        console.log(`[controller] ${steps[next].name} after ${Math.round((prevAt - t0) / 1000)}s`);
        next++;
      }
      const games = tree.games();
      if (games.length > 0 && !games.some((g) => isRunning(g, snap))) {
        states.exited = new Date().toISOString();
        console.log(`[controller] exited after ${Math.round((Date.now() - t0) / 1000)}s`);
        break;
      }
      const waiting = next < steps.length ? steps[next] : { name: "exited", logBased: false, limitS: 30 };
      if ((!waiting.logBased || logLive) && Date.now() - prevAt > waiting.limitS * 1000) { failure = `timeout waiting for ${waiting.name} (${waiting.limitS}s)`; break; }
      if (Date.now() - t0 > timeoutS * 1000) { failure = `job timeout ${timeoutS}s waiting for ${waiting.name}`; break; }
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
  if (!finalLog.includes("Host activate: Playing Demo")) reasons.push("no evidence for loaded in console.log");
  // Per take: its own "Finishing movie" line (in order), take folder, WAV and video.
  const { takes: folders, wavs } = takeOutputs(cap);
  if (folders.length !== plan.length) reasons.push(`expected ${plan.length} take folder(s), found ${folders.length}`);
  const finishes = [...finalLog.matchAll(new RegExp(FINISHED_RE.source, "g"))];
  const size = captureSize(s);
  const takes: TakeResult[] = plan.map((t, i) => {
    // Takes record in order, so take i's folder is the i-th even when the chain stopped early.
    const r: TakeResult = { video: cap.videoPaths[i], audio: wavs[i], reasons: [] };
    // A take that finished is judged on its own outputs even when a later take failed; only an
    // unverified cleanup (a game may still be writing) voids them all.
    if (!cleanupVerified) { r.reasons.push("cleanup not verified"); return r; }
    const f = finishes[i];
    if (!f) { r.reasons.push(`no "Finishing movie" line for take ${i}`); return r; }
    if (count(finalLog, new RegExp(`Demo Skipping finished at tick ${t.seekTick}\\b`)) < seekCount(i)) r.reasons.push(`no evidence for take ${i}'s seek to ${t.seekTick}`);
    try {
      const frames = Number(f[1]);
      const expected = ((t.recordEndTick - t.recordStartTick) * s.fps) / TICKRATE;
      if (Number(f[2]) !== s.fps) r.reasons.push(`HLAE recorded take ${i} at ${f[2]} fps, expected ${s.fps}`);
      if (Math.abs(frames - expected) > 3) r.reasons.push(`HLAE finished ${frames} frames for take ${i}, expected ${expected.toFixed(1)}`);
      r.reasons.push(...validateCapture(r.video, r.audio, frames, s.fps, `${size.width}x${size.height}`));
      r.mapping = { tickrate: TICKRATE, fps: s.fps, recordStartTick: t.recordStartTick, recordEndTick: t.recordEndTick, frames };
    } catch (e) { r.reasons.push(`validation error: ${(e as Error).message}`); }
    return r;
  });
  if (!reasons.length && takes.every((t) => !t.reasons.length)) states.validated = new Date().toISOString();
  const result: RenderResult = {
    status: reasons.length ? "failed" : "ok",
    reasons, cleanupVerified, owned, states, logLive, takes,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
  };
  try { writeFileSync(path.join(job.workDir, "render.json"), JSON.stringify(result, null, 2)); }
  catch (e) { console.error(`could not write render.json: ${(e as Error).message}`); }
  return result;
}
