// The batch (PLAN.md M3): ingest → parse → score → select → render queue →
// library page, resumable end to end. Each stage keeps its own key and result:
// parse.json (demo hash + parser + schema + POV), moments.json (parse key +
// weights + clip rules + schema; an empty list is a valid result), the library entry
// (render key) and capture.json (render key, for post retries). This file
// adds the job ledger, state/queue.json, keyed by clip id + render key: a job
// is marked running before it may launch; a run that dies mid-job leaves it
// running, and the next run retries it once. (A run ended by a signal or an
// error cleans up and releases its locks; one hard-killed leaves
// state/.go.lock and the render locks behind, to be removed by hand after
// checking no cs2.exe / HLAE.exe is left, as for every lock here.) A clip the library already holds
// for its render key is done, whatever the ledger says. A job that failed
// twice is not retried until --retry-failed.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Refusal, STATE_DIR, loadBatch, loadIdentities, loadReels, pickMoments } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import type { ClipSpec } from "../clip/index.ts";
import { ingest, readRegistry } from "../ingest/index.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { imageRunning } from "../render/controller/processes.ts";
import { readIndex, recordFailure, writeJsonAtomic } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { highlightUnit, prepareJob, runJobs, unitHasCapture, type JobResult, type PreparedJob, type RenderUnit } from "./job.ts";
import { prepareReel } from "../reel/index.ts";

/** Demos marked processed by pnpm go --settle-existing: sha256 → when. pnpm go skips them. */
const SETTLED = path.join(STATE_DIR, "settled.json");
const readSettled = (): Record<string, string> => (existsSync(SETTLED) ? JSON.parse(readFileSync(SETTLED, "utf8")) : {});

const LEDGER = path.join(STATE_DIR, "queue.json");
const MAX_ATTEMPTS = 2; // the first try and one retry

type Entry = { id: string; renderKey: string; demoSha256: string; title: string; status: "running" | "done" | "failed"; attempts: number; lastReasons?: string[]; updatedAt: string };
type Ledger = Record<string, Entry>;
const readLedger = (): Ledger => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {});
function writeLedger(l: Ledger) {
  const tmp = `${LEDGER}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n");
  renameSync(tmp, LEDGER);
}

export type BatchOptions = {
  retryFailed?: boolean; dryRun?: boolean; timeoutS?: number;
  /** Post only: jobs with a completed capture are (re)posted, nothing is rendered or launched. */
  repostOnly?: boolean;
  /** Test hook: end the process this many seconds into the first launched job (an interrupted run). */
  testExitAfterS?: number;
  /** --settle-existing: mark every registered demo as processed (state/settled.json) and render nothing. */
  settleExisting?: boolean;
  /** --no-reels: highlights only for this run, whatever config.json reels says. */
  noReels?: boolean;
};
export type BatchReport = {
  ingested: number; demos: number; selected: number;
  rendered: string[]; skipped: string[]; failed: string[]; givenUp: string[]; emptyDemos: string[]; demoErrors: string[];
  /** --repost: selected moments without a completed capture (a normal pnpm go renders them). */
  needsRender: string[];
  /** Clips this run added to the library, with their numbers (the standing order's report). */
  made: { kind: string; no?: number; title: string }[];
  /** Demos skipped because they are settled; --settle-existing: how many it settled now. */
  settled: number; settledNow?: number;
  /** Demos this run settled because its pass over them finished (every selected moment rendered, held or failed for good). */
  autoSettled: string[];
  stoppedBy?: "refusal" | "cleanup"; pageError?: string;
};

/** Exit code: 0 ok, 1 a job or demo failed or was given up, 2 refused, 3 cleanup not verified. */
export async function runBatch(o: BatchOptions = {}): Promise<{ report: BatchReport; code: number }> {
  // The whole batch refuses up front when CS2 runs: nothing is ingested or rendered.
  if (!o.repostOnly && !o.settleExisting && imageRunning("cs2.exe")) throw new Refusal("refusing: CS2 is already running");
  const report: BatchReport = { ingested: 0, demos: 0, selected: 0, rendered: [], skipped: [], failed: [], givenUp: [], emptyDemos: [], demoErrors: [], needsRender: [], made: [], settled: 0, autoSettled: [] };
  // --settle-existing: before ingest, so a demo still in the inbox is never settled unprocessed.
  const settled = readSettled();
  if (o.settleExisting) {
    const now = new Date().toISOString();
    let added = 0;
    for (const d of Object.values(readRegistry())) if (!settled[d.sha256]) { settled[d.sha256] = now; added++; }
    if (!o.dryRun) writeJsonAtomic(SETTLED, settled);
    report.settledNow = added;
    report.settled = Object.keys(settled).length;
    return { report, code: 0 };
  }
  const ing = await ingest();
  report.ingested = ing.added.length;
  for (const a of ing.added) console.log(`ingested ${a.originalName} → ${path.basename(a.file)}`);
  for (const r of ing.rejected) console.log(`rejected ${r.name}: ${r.reason}`);
  for (const d of ing.duplicates) console.log(`duplicate of a registered demo: ${d}`);
  for (const w of ing.waiting) console.log(`still being written, next run: ${w}`);

  const batch = loadBatch();
  const pov = loadIdentities().pov;
  const queue: { demo: string; sha256: string; spec: ClipSpec }[] = [];
  const demoFiles = new Map<string, string>(); // every demo this run handles (its reels too, even without highlights)
  const registry = Object.values(readRegistry()).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  report.demos = registry.length;
  // Settled demos are done: their moments that were never rendered stay unrendered (Peder,
  // 2026-10-15: rule changes apply from the next new demo, not retroactively).
  for (const d of registry) {
    // A repost only posts existing captures and never adds a render, so it looks at settled demos too.
    if (settled[d.sha256] && !o.repostOnly) { report.settled++; continue; }
    try {
      const m = await buildMoments(d.file, pov);
      const picked = pickMoments(m.specs, batch);
      console.log(`${m.parsed.demo.map} ${d.originalName}: ${m.specs.length} moments, ${picked.length} selected${m.cached ? " (cached)" : ""}`);
      if (!picked.length) report.emptyDemos.push(d.originalName);
      for (const spec of picked) queue.push({ demo: d.file, sha256: d.sha256, spec });
      demoFiles.set(d.sha256, d.file);
    } catch (e) {
      // A demo that cannot be parsed is a failure, recorded apart from empty results.
      const reason = (e as Error).message;
      recordFailure(`demo:${d.sha256}`, { at: new Date().toISOString(), reasons: [reason], startTick: 0, endTick: 0, demo: d.file });
      report.demoErrors.push(`${d.originalName}: ${reason}`);
      console.error(`demo failed: ${d.originalName}: ${reason}`);
    }
  }
  report.selected = queue.length;

  let code = 0;
  let launchedOne = false;
  const ledger = readLedger();
  // One launch per demo (chained takes): its jobs are gated one by one, then rendered together.
  const reels = loadReels();
  let posting: Promise<void> = Promise.resolve();
  const kinds = o.noReels ? [] : (["deaths", "kills"] as const).filter((k) => reels[k].enabled);
  // A finished pass settles its demo: later rescoring never adds work for it (only pnpm clip --rerender
  // or pnpm unsettle do). Not on a dry run, a repost or a --no-reels pass (its reels are still owed),
  // and not while a moment still has a retry left.
  const settle = (sha: string) => {
    if (!settlesDemos(o)) return;
    const s = readSettled();
    if (s[sha]) return;
    s[sha] = new Date().toISOString();
    writeJsonAtomic(SETTLED, s);
    report.autoSettled.push(sha);
  };
  demos: for (const [sha256, file] of demoFiles) {
    const items = queue.filter((q) => q.sha256 === sha256);
    let open = false; // a moment of this demo failed in a way the next run retries
    type Ready = { unit: RenderUnit; kind: "highlight" | "deaths" | "kills"; key: string; prevStatus?: "running" | "done" | "failed"; attempts: number };
    const ready: Ready[] = [];
    for (const { demo, spec } of items) {
      let prep: PreparedJob;
      let done: boolean;
      try {
        prep = await prepareJob({ demo, spec, timeoutS: o.timeoutS, postOnly: o.repostOnly, inBatch: true });
        done = prep.inLibrary();
      } catch (e) {
        // Nothing was launched: record it and go on with the next job.
        const reason = (e as Error).message;
        recordFailure(spec.id, { at: new Date().toISOString(), reasons: [reason], startTick: spec.startTick, endTick: spec.endTick, demo });
        report.failed.push(`${spec.title}: ${reason}`);
        code = Math.max(code, 1);
        open = true;
        continue;
      }
      const key = `${prep.id}:${prep.renderKey}`;
      const prev = ledger[key];
      // Completed output wins over the ledger (e.g. a run died after publishing).
      if (done) {
        if (prev?.status !== "done") { ledger[key] = { ...(prev ?? { id: prep.id, renderKey: prep.renderKey, demoSha256: sha256, title: spec.title, attempts: 0 }), status: "done", updatedAt: new Date().toISOString() }; writeLedger(ledger); }
        report.skipped.push(spec.title);
        continue;
      }
      if (prev?.status === "running") console.log(`${spec.title}: interrupted on an earlier run, retrying`);
      if (o.repostOnly && !prep.hasCapture()) { report.needsRender.push(spec.title); continue; }
      // Post costs no launch, so a repost is not held back by the attempt limit.
      if (prev && prev.attempts >= MAX_ATTEMPTS && !o.retryFailed && !o.repostOnly) {
        report.givenUp.push(`${spec.title} (${prev.attempts} attempts: ${prev.lastReasons?.join("; ") ?? "interrupted"})`);
        continue;
      }
      if (o.dryRun) { console.log(`would render: #${spec.rank} ${spec.title} (score ${spec.score})`); continue; }
      ready.push({ unit: highlightUnit(prep), kind: "highlight", key, prevStatus: prev?.status, attempts: (prev?.attempts ?? 0) + 1 });
    }
    // The demo's reels (config.json reels), gated like its highlights and rendered in the same launch.
    for (const kind of kinds) {
      let unit: RenderUnit | undefined;
      try {
        unit = await prepareReel(file, kind, { timeoutS: o.timeoutS, postOnly: o.repostOnly, inBatch: true });
      } catch (e) {
        const reason = (e as Error).message;
        recordFailure(`${kind}:${sha256}`, { at: new Date().toISOString(), reasons: [reason], startTick: 0, endTick: 0, demo: file });
        report.failed.push(`${kind} reel of ${path.basename(file)}: ${reason}`);
        code = Math.max(code, 1);
        open = true;
        continue;
      }
      if (!unit) continue;
      const key = `${unit.id}:${unit.renderKey}`;
      const prev = ledger[key];
      if (unit.inLibrary()) {
        if (prev?.status !== "done") { ledger[key] = { ...(prev ?? { id: unit.id, renderKey: unit.renderKey, demoSha256: sha256, title: unit.title, attempts: 0 }), status: "done", updatedAt: new Date().toISOString() }; writeLedger(ledger); }
        report.skipped.push(unit.title);
        continue;
      }
      if (o.repostOnly && !unitHasCapture(unit)) { report.needsRender.push(unit.title); continue; }
      if (prev && prev.attempts >= MAX_ATTEMPTS && !o.retryFailed && !o.repostOnly) {
        report.givenUp.push(`${unit.title} (${prev.attempts} attempts: ${prev.lastReasons?.join("; ") ?? "interrupted"})`);
        continue;
      }
      if (o.dryRun) { console.log(`would render: ${unit.title} (${unit.takes.length} takes)`); continue; }
      ready.push({ unit, kind, key, prevStatus: prev?.status, attempts: (prev?.attempts ?? 0) + 1 });
    }
    if (!ready.length) { if (!open) settle(sha256); continue; }
    for (const r of ready) ledger[r.key] = { id: r.unit.id, renderKey: r.unit.renderKey, demoSha256: sha256, title: r.unit.title, status: "running", attempts: r.attempts, updatedAt: new Date().toISOString() };
    writeLedger(ledger);
    // Test hook, scoped to the first launch and cleared when it ends.
    const testTimer = o.testExitAfterS !== undefined && !launchedOne
      ? setTimeout(() => { console.error(`test: ending the process ${o.testExitAfterS}s into the job (--test-exit-after)`); process.exit(130); }, o.testExitAfterS * 1000)
      : undefined;
    launchedOne = true;
    let results: JobResult[];
    try {
      // Render only: the post of this demo goes to the post worker, overlapping the next launch.
      results = await runJobs(ready.map((r) => r.unit), { renderOnly: true });
    } catch (e) {
      clearTimeout(testTimer);
      const reason = (e as Error).message;
      if (e instanceof Refusal) {
        // Refused before any launch: the attempts do not count, and the batch stops.
        for (const r of ready) ledger[r.key] = { ...ledger[r.key], status: r.prevStatus ?? "failed", attempts: r.attempts - 1, lastReasons: [reason], updatedAt: new Date().toISOString() };
        writeLedger(ledger);
        console.error(reason);
        report.stoppedBy = "refusal";
        code = 2;
        break;
      }
      // Anything else may have happened after a launch: the attempts count.
      for (const r of ready) {
        ledger[r.key] = { ...ledger[r.key], status: "failed", lastReasons: [reason], updatedAt: new Date().toISOString() };
        recordFailure(r.unit.id, { at: new Date().toISOString(), reasons: [reason], startTick: r.unit.startTick, endTick: r.unit.endTick, demo: r.unit.demo });
        report.failed.push(`${r.unit.title}: ${reason}`);
      }
      writeLedger(ledger);
      code = Math.max(code, 1);
      if (!open && ready.every((r) => isFinal("failed", r.attempts))) settle(sha256);
      if (cleanupUnverified()) { report.stoppedBy = "cleanup"; code = 3; break; }
      continue;
    }
    clearTimeout(testTimer);
    const record = (r: Ready, res: JobResult) => {
      ledger[r.key] = { ...ledger[r.key], status: res.status === "failed" ? "failed" : "done", attempts: res.status === "skipped" ? r.attempts - 1 : r.attempts, lastReasons: res.reasons, updatedAt: new Date().toISOString() };
      if (res.status === "done") {
        report.rendered.push(res.title);
        const e = readIndex().clips[res.id];
        report.made.push({ kind: e?.kind ?? "highlight", no: e?.no, title: res.title });
      }
      else if (res.status === "skipped") report.skipped.push(res.title);
      else { report.failed.push(`${res.title}: ${res.reasons?.join("; ")}`); code = Math.max(code, 1); }
    };
    // Final: rendered, held, or failed with no retry left.
    const final = (r: Ready, res: JobResult) => isFinal(res.status, r.attempts);
    const toPost: Ready[] = [];
    let allFinal = !open;
    for (const [i, res] of results.entries()) {
      if (res.status === "captured") toPost.push(ready[i]);
      else { record(ready[i], res); if (!final(ready[i], res)) allFinal = false; }
    }
    writeLedger(ledger);
    if (!toPost.length && allFinal) settle(sha256);
    // One post at a time: wait for the previous demo's, then start this one's and go on launching.
    if (toPost.length) {
      await posting;
      posting = postWorker(file, toPost.map((r) => ({ id: r.unit.id, title: r.unit.title, kind: r.kind }))).then((done) => {
        let finalHere = allFinal;
        for (const r of toPost) {
          const res = done.find((d) => d.id === r.unit.id) ?? { status: "failed" as const, id: r.unit.id, title: r.unit.title, reasons: ["no result from the post worker"] };
          record(r, res);
          if (!final(r, res)) finalHere = false;
        }
        writeLedger(ledger);
        if (finalHere) settle(sha256);
      }).catch((e) => {
        // Never an unhandled rejection: it would end the process in the middle of the next launch.
        for (const r of toPost) report.failed.push(`${r.unit.title}: recording the post result failed: ${(e as Error).message}`);
        code = Math.max(code, 1);
      });
    }
    // An unverified cleanup may have left a game running: stop everything.
    if (results.some((x) => x.cleanupVerified === false) || cleanupUnverified()) { report.stoppedBy = "cleanup"; code = 3; break demos; }
  }
  await posting; // the last demo's post
  if ((report.demoErrors.length || report.givenUp.length) && code === 0) code = 1;
  // The page is rewritten even after a stop; its own failure never hides the batch's exit code.
  try { writeLibraryPage(); } catch (e) { report.pageError = (e as Error).message; if (code === 0) code = 1; }
  return { report, code };
}

/**
 * Posts one demo's captured units in a separate process (src/cli/post-worker.ts), so this
 * process stays free to drive the next launch. Resolves with the worker's results; a worker
 * that dies yields failures, never a stuck batch.
 */
function postWorker(demo: string, units: { id: string; title: string; kind: "highlight" | "deaths" | "kills" }[]): Promise<JobResult[]> {
  const dir = path.join(STATE_DIR, "post-jobs");
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const jobFile = path.join(dir, `${stamp}.job.json`), resultFile = path.join(dir, `${stamp}.result.json`);
  writeFileSync(jobFile, JSON.stringify({ demo, highlights: units.filter((u) => u.kind === "highlight").map((u) => u.id), reels: units.filter((u) => u.kind !== "highlight").map((u) => u.kind) }));
  const fail = (reason: string): JobResult[] => units.map((u) => ({ status: "failed", id: u.id, title: u.title, reasons: [reason] }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "..", "cli", "post-worker.ts"), jobFile, resultFile], { stdio: "inherit", windowsHide: true });
    child.on("error", (e) => resolve(fail(`post worker did not start: ${e.message}`)));
    child.on("exit", (code) => {
      try { resolve(JSON.parse(readFileSync(resultFile, "utf8")) as JobResult[]); }
      catch { resolve(fail(`post worker exited ${code} without results`)); }
      for (const f of [jobFile, resultFile]) try { rmSync(f, { force: true }); } catch {}
    });
  });
}

/** Whether a pass of this kind may settle demos: not a dry run, a repost or a --no-reels pass (its reels are owed). */
export const settlesDemos = (o: Pick<BatchOptions, "dryRun" | "repostOnly" | "noReels">) => !o.dryRun && !o.repostOnly && !o.noReels;
/** A moment's outcome is final for settling: rendered, held, or failed with no retry left. */
export const isFinal = (status: JobResult["status"], attempts: number) => status !== "failed" || attempts >= MAX_ATTEMPTS;
