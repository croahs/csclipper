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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Refusal, STATE_DIR, loadBatch, loadIdentities, pickMoments } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import type { ClipSpec } from "../clip/index.ts";
import { ingest, readRegistry } from "../ingest/index.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { imageRunning } from "../render/controller/processes.ts";
import { recordFailure } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { prepareJob, runJob, type PreparedJob } from "./job.ts";

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
};
export type BatchReport = {
  ingested: number; demos: number; selected: number;
  rendered: string[]; skipped: string[]; failed: string[]; givenUp: string[]; emptyDemos: string[]; demoErrors: string[];
  /** --repost: selected moments without a completed capture (a normal pnpm go renders them). */
  needsRender: string[];
  stoppedBy?: "refusal" | "cleanup"; pageError?: string;
};

/** Exit code: 0 ok, 1 a job or demo failed or was given up, 2 refused, 3 cleanup not verified. */
export async function runBatch(o: BatchOptions = {}): Promise<{ report: BatchReport; code: number }> {
  // The whole batch refuses up front when CS2 runs: nothing is ingested or rendered.
  if (!o.repostOnly && imageRunning("cs2.exe")) throw new Refusal("refusing: CS2 is already running");
  const report: BatchReport = { ingested: 0, demos: 0, selected: 0, rendered: [], skipped: [], failed: [], givenUp: [], emptyDemos: [], demoErrors: [], needsRender: [] };
  const ing = await ingest();
  report.ingested = ing.added.length;
  for (const a of ing.added) console.log(`ingested ${a.originalName} → ${path.basename(a.file)}`);
  for (const r of ing.rejected) console.log(`rejected ${r.name}: ${r.reason}`);
  for (const d of ing.duplicates) console.log(`duplicate of a registered demo: ${d}`);
  for (const w of ing.waiting) console.log(`still being written, next run: ${w}`);

  const batch = loadBatch();
  const pov = loadIdentities().pov;
  const queue: { demo: string; sha256: string; spec: ClipSpec }[] = [];
  const registry = Object.values(readRegistry()).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  report.demos = registry.length;
  for (const d of registry) {
    try {
      const m = await buildMoments(d.file, pov);
      const picked = pickMoments(m.specs, batch);
      console.log(`${m.parsed.demo.map} ${d.originalName}: ${m.specs.length} moments, ${picked.length} selected${m.cached ? " (cached)" : ""}`);
      if (!picked.length) report.emptyDemos.push(d.originalName);
      for (const spec of picked) queue.push({ demo: d.file, sha256: d.sha256, spec });
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
  for (const { demo, sha256, spec } of queue) {
    let prep: PreparedJob;
    let done: boolean;
    try {
      prep = await prepareJob({ demo, spec, timeoutS: o.timeoutS, postOnly: o.repostOnly });
      done = prep.inLibrary();
    } catch (e) {
      // Nothing was launched: record it and go on with the next job.
      const reason = (e as Error).message;
      recordFailure(spec.id, { at: new Date().toISOString(), reasons: [reason], startTick: spec.startTick, endTick: spec.endTick, demo });
      report.failed.push(`${spec.title}: ${reason}`);
      code = Math.max(code, 1);
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
    const attempts = (prev?.attempts ?? 0) + 1;
    ledger[key] = { id: prep.id, renderKey: prep.renderKey, demoSha256: sha256, title: spec.title, status: "running", attempts, updatedAt: new Date().toISOString() };
    writeLedger(ledger);
    // Test hook, scoped to the first job that may launch and cleared when it ends.
    const testTimer = o.testExitAfterS !== undefined && !launchedOne
      ? setTimeout(() => { console.error(`test: ending the process ${o.testExitAfterS}s into the job (--test-exit-after)`); process.exit(130); }, o.testExitAfterS * 1000)
      : undefined;
    launchedOne = true;
    let r;
    try {
      r = await runJob(prep);
    } catch (e) {
      clearTimeout(testTimer);
      const reason = (e as Error).message;
      if (e instanceof Refusal) {
        // Refused before any launch: the attempt does not count, and the batch stops.
        ledger[key] = { ...ledger[key], status: prev?.status ?? "failed", attempts: attempts - 1, lastReasons: [reason], updatedAt: new Date().toISOString() };
        writeLedger(ledger);
        console.error(reason);
        report.stoppedBy = "refusal";
        code = 2;
        break;
      }
      // Anything else may have happened after a launch: the attempt counts.
      ledger[key] = { ...ledger[key], status: "failed", lastReasons: [reason], updatedAt: new Date().toISOString() };
      writeLedger(ledger);
      recordFailure(prep.id, { at: new Date().toISOString(), reasons: [reason], startTick: prep.startTick, endTick: prep.endTick, demo });
      report.failed.push(`${spec.title}: ${reason}`);
      code = Math.max(code, 1);
      if (cleanupUnverified()) { report.stoppedBy = "cleanup"; code = 3; break; }
      continue;
    }
    clearTimeout(testTimer);
    ledger[key] = { ...ledger[key], status: r.status === "failed" ? "failed" : "done", attempts: r.status === "skipped" ? attempts - 1 : attempts, lastReasons: r.reasons, updatedAt: new Date().toISOString() };
    writeLedger(ledger);
    if (r.status === "done") report.rendered.push(r.title);
    else if (r.status === "skipped") report.skipped.push(r.title);
    else {
      report.failed.push(`${r.title}: ${r.reasons?.join("; ")}`);
      code = Math.max(code, 1);
      // An unverified cleanup may have left a game running: stop everything.
      if (r.cleanupVerified === false || cleanupUnverified()) { report.stoppedBy = "cleanup"; code = 3; break; }
    }
  }
  if ((report.demoErrors.length || report.givenUp.length) && code === 0) code = 1;
  // The page is rewritten even after a stop; its own failure never hides the batch's exit code.
  try { writeLibraryPage(); } catch (e) { report.pageError = (e as Error).message; if (code === 0) code = 1; }
  return { report, code };
}
