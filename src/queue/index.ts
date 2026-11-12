// The batch (PLAN.md M3): ingest → parse → score → select → render queue →
// library page, resumable end to end. Each stage keeps its own key and result:
// parse.json (demo hash + parser + schema + POV), moments.json (parse key +
// weights + clip rules + schema; an empty list is a valid result), the library entry
// (render key) and capture.json (render key, for post retries). This file
// adds the job ledger, state/queue.json, keyed by clip id + render key: a job
// is marked running before it may launch; a run that dies mid-job leaves it
// running, and the next run retries it once. (A run ended by a signal or an
// error cleans up and releases its locks (exitOnSignal, launch.ts); one hard-killed leaves
// state/.go.lock and the render locks behind, to be removed by hand after
// checking no cs2.exe / HLAE.exe is left, as for every lock here.) A clip the library already holds
// for its render key is done, whatever the ledger says. A job that failed
// twice is not retried until --retry-failed. --film runs the same loop over every roster player per
// demo (BatchOptions.film): each player's own caches, clip ids and render keys, its highlights and its
// bloopers (src/film/bloopers.ts) in the demo's one launch, no reels, and its own settle record
// (state/film.json); the normal pass is untouched by it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import path from "node:path";
import { Refusal, STATE_DIR, loadBatch, loadFilm, loadIdentities, loadReels, loadRoster, pickFilm, pickMoments, povKey, povKeyFor } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import { PovAbsent, type ParsedDemo } from "../parse/demo.ts";
import { blooperClip, detectBloopers, loadBlooperSettings, pickBloopers, type Blooper, type BlooperClip } from "../film/bloopers.ts";
import { sampleTrack } from "../film/track.ts";
import type { ClipSpec } from "../clip/index.ts";
import { ingest, readRegistry } from "../ingest/index.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { imageRunning } from "../render/controller/processes.ts";
import { faceitRefusal } from "../render/controller/guards.ts";
import { readIndex, recordFailure, writeJsonAtomic } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { highlightUnit, prepareJob, runJobs, unitHasCapture, type JobResult, type PreparedJob, type RenderUnit } from "./job.ts";
import { prepareReel } from "../reel/index.ts";
import { sweepUnderClipLock, type Pruned } from "./prune.ts";

/** Demos marked processed by pnpm go --settle-existing: sha256 → when. pnpm go skips them. */
const SETTLED = path.join(STATE_DIR, "settled.json");
const readSettled = (): Record<string, string> => (existsSync(SETTLED) ? JSON.parse(readFileSync(SETTLED, "utf8")) : {});
/** pnpm go --film's own settle record: "<demo sha256>:<povKey>" → when that player's film pass over that demo finished. */
export const FILM = path.join(STATE_DIR, "film.json");
export const readFilmState = (): Record<string, string> => (existsSync(FILM) ? JSON.parse(readFileSync(FILM, "utf8")) : {});
export const filmPair = (sha256: string, key: string) => `${sha256}:${key}`;

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
  /**
   * --film: every roster player's (loadRoster) highlights scoring config.json film.minScore or more and
   * bloopers scoring film.bloopers.minScore or more, from that player's first person, in every registered
   * demo still on disk, settled ones too; no reels. Done pairs are kept in state/film.json.
   */
  film?: boolean;
};
/** What a launch renders: a highlight, a reel, or a film pass's blooper. */
export type UnitKind = "highlight" | "deaths" | "kills" | "blooper";
export type BatchReport = {
  ingested: number; demos: number; selected: number;
  rendered: string[]; skipped: string[]; failed: string[]; givenUp: string[];
  /** Left out of a launch because another job's take already plays past the match end; the next run renders them. */
  deferred: string[]; emptyDemos: string[]; demoErrors: string[];
  /** --repost: selected moments without a completed capture (a normal pnpm go renders them). */
  needsRender: string[];
  /** Clips this run added to the library, with their numbers (the standing order's report); player: whose first person (--film). */
  made: { kind: string; no?: number; title: string; player?: { key: string; name: string } }[];
  /**
   * --film: the roster (povKey and the name a parse gave it this run), demos a player is not in, demos
   * with no roster player, pairs already done before this run, pairs this run finished, registered demos no longer on disk.
   */
  film?: { minScore: number; blooperMinScore: number; players: { key: string; name?: string }[]; absent: { demo: string; key: string }[]; noPlayer: string[]; alreadyDone: number; pairsDone: number; missingFiles: number };
  /** Demos skipped because they are settled; --settle-existing: how many it settled now. */
  settled: number; settledNow?: number;
  /** Demos this run settled because its pass over them finished (every selected moment rendered, held or failed for good). */
  autoSettled: string[];
  /** The sweep of held clips' raw captures at the end of the run (not on a dry run). */
  pruned?: Pruned & { clips: number };
  stoppedBy?: "refusal" | "cleanup"; pageError?: string;
};

/** Exit code: 0 ok, 1 a job or demo failed or was given up, 2 refused, 3 cleanup not verified. */
export async function runBatch(o: BatchOptions = {}): Promise<{ report: BatchReport; code: number }> {
  // The whole batch refuses up front: nothing is ingested or rendered.
  if (o.film && o.settleExisting) throw new Error("--film and --settle-existing together: --settle-existing settles demos for pnpm go, not film pairs");
  const refusal = batchRefusal(o);
  if (refusal) throw refusal;
  const report: BatchReport = { ingested: 0, demos: 0, selected: 0, rendered: [], skipped: [], failed: [], givenUp: [], deferred: [], emptyDemos: [], demoErrors: [], needsRender: [], made: [], settled: 0, autoSettled: [] };
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
  if (ing.rewritten) console.log(`registry: ${ing.rewritten} demo path(s) rewritten relative to the repo (state/demos.json)`);
  for (const a of ing.added) console.log(`ingested ${a.originalName} → ${path.basename(a.file)}`);
  for (const f of ing.fixed) console.log(`first full packet fixed (CS2 crashes on it as recorded): ${f}`);
  for (const r of ing.rejected) console.log(`rejected ${r.name}: ${r.reason}`);
  for (const d of ing.duplicates) console.log(`duplicate of a registered demo: ${d}`);
  for (const w of ing.waiting) console.log(`still being written, next run: ${w}`);

  const batch = loadBatch();
  const pov = loadIdentities().pov;
  // A ranked moment (spec) or a film blooper; pov: a film roster player other than STEAM_ID64 (absent:
  // the main POV); player: the name the parse gives (--film).
  const queue: ({ demo: string; sha256: string; pov?: string; player?: string } & ({ spec: ClipSpec; blooper?: undefined } | { blooper: BlooperClip; spec?: undefined }))[] = [];
  const demoFiles = new Map<string, string>(); // every demo this run handles (its reels too, even without highlights)
  const registry = Object.values(readRegistry()).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  report.demos = registry.length;
  // --film: the roster, the pairs done before this run, and per demo the pairs this run looked at
  // (present or not in the demo: settled together when the demo's pass finishes) or could not parse.
  const film = o.film ? loadFilm() : undefined;
  const bloopers = o.film ? loadBlooperSettings() : undefined;
  const roster = o.film ? loadRoster() : [];
  const filmDone = o.film ? readFilmState() : {};
  const looked = new Map<string, string[]>();
  const filmOpen = new Set<string>();
  if (film) report.film = { minScore: film.minScore, blooperMinScore: bloopers!.minScore, players: roster.map((id) => ({ key: povKey(id) })), absent: [], noPlayer: [], alreadyDone: 0, pairsDone: 0, missingFiles: 0 };
  const nameOf = (key: string) => report.film?.players.find((p) => p.key === key)?.name ?? `player ${key}`;
  for (const d of registry) {
    if (film) {
      // Every registered demo still on disk, settled or not; per roster player, unless the pair is done.
      if (!existsSync(d.file)) { report.film!.missingFiles++; continue; }
      const keys: string[] = [];
      // The roster players in this demo whose pair is open, with their picked moments; parsed: the
      // first one's parse, the bloopers' (rounds, deaths, hurts and fires do not depend on the POV).
      const here: { id: string; key: string; name: string; picked: ClipSpec[] }[] = [];
      let parsed: ParsedDemo | undefined;
      for (const id of roster) {
        const key = povKey(id);
        if (filmDone[filmPair(d.sha256, key)]) { report.film!.alreadyDone++; continue; }
        try {
          const m = await buildMoments(d.file, id, undefined, pov);
          const picked = pickFilm(m.specs, film);
          const seen = report.film!.players.find((p) => p.key === key)!;
          seen.name ??= m.parsed.identity.name;
          console.log(`${m.parsed.demo.map} ${d.originalName} · ${m.parsed.identity.name}: ${m.specs.length} moments, ${picked.length} at ${film.minScore}+${m.cached ? " (cached)" : ""}`);
          here.push({ id, key, name: m.parsed.identity.name, picked });
          parsed ??= m.parsed;
          keys.push(key);
        } catch (e) {
          // Not in this demo: no error, and the pair is settled with the demo's pass.
          if (e instanceof PovAbsent) {
            console.log(`${d.originalName} · ${nameOf(key)}: not in this demo`);
            report.film!.absent.push({ demo: d.originalName, key });
            keys.push(key);
            continue;
          }
          const reason = (e as Error).message;
          recordFailure(`demo:${d.sha256}:${key}`, { at: new Date().toISOString(), reasons: [reason], startTick: 0, endTick: 0, demo: d.file });
          report.demoErrors.push(`${d.originalName} (${nameOf(key)}): ${reason}`);
          console.error(`demo failed: ${d.originalName} (${nameOf(key)}): ${reason}`);
          filmOpen.add(d.sha256);
        }
      }
      // The bloopers of those players: the demo's track (one parser pass, cached), detected, then those at
      // film.bloopers.minScore or more, one per overlap (pickBloopers). Failing here keeps the demo open.
      let found: Blooper[] = [];
      if (parsed) {
        try {
          found = pickBloopers(detectBloopers(parsed, sampleTrack(d.file, parsed), here.map((p) => p.id), bloopers), bloopers!.minScore);
          console.log(`${d.originalName}: ${found.length} blooper(s) at ${bloopers!.minScore}+`);
        } catch (e) {
          const reason = `bloopers: ${(e as Error).message}`;
          recordFailure(`bloopers:${d.sha256}`, { at: new Date().toISOString(), reasons: [reason], startTick: 0, endTick: 0, demo: d.file });
          report.demoErrors.push(`${d.originalName}: ${reason}`);
          console.error(`demo failed: ${d.originalName}: ${reason}`);
          filmOpen.add(d.sha256);
        }
      }
      // Per player: the highlights, then the bloopers (the dry run's headings follow this order).
      for (const p of here) {
        const who = { ...(p.id !== pov ? { pov: p.id } : {}), player: p.name };
        for (const spec of p.picked) queue.push({ demo: d.file, sha256: d.sha256, spec, ...who });
        for (const b of found.filter((x) => x.steamid === p.id)) queue.push({ demo: d.file, sha256: d.sha256, blooper: blooperClip(b, d.sha256, povKeyFor(p.id, pov)), ...who });
      }
      if (!keys.length && !filmOpen.has(d.sha256)) continue; // every pair done before
      if (!here.length && keys.length === roster.length) report.film!.noPlayer.push(d.originalName);
      looked.set(d.sha256, keys);
      demoFiles.set(d.sha256, d.file);
      continue;
    }
    // Settled demos are done: their moments that were never rendered stay unrendered (Peder,
    // 2026-10-15: rule changes apply from the next new demo, not retroactively).
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
  // A film pass makes no reels, whatever config.json reels says.
  const kinds = o.noReels || film ? [] : (["deaths", "kills"] as const).filter((k) => reels[k].enabled);
  // A finished pass settles its demo: later rescoring never adds work for it (only pnpm clip --rerender
  // or pnpm unsettle do). Not on a dry run, a repost or a --no-reels pass (its reels are still owed),
  // and not while a moment still has a retry left. A film pass settles the pairs it looked at instead
  // (state/film.json) and, with film.settlesDemo, the demo for pnpm go as well.
  const settle = (sha: string) => {
    if (film) {
      if (!filmSettles(o)) return;
      const s = settleFilm(readFilmState(), readSettled(), sha, looked.get(sha) ?? [], film.settlesDemo, new Date().toISOString());
      writeFilmSettle(s);
      if (s.settled) report.autoSettled.push(sha);
      report.film!.pairsDone += s.pairs.length;
      return;
    }
    if (!settlesDemos(o)) return;
    const s = readSettled();
    if (s[sha]) return;
    s[sha] = new Date().toISOString();
    writeJsonAtomic(SETTLED, s);
    report.autoSettled.push(sha);
  };
  demos: for (const [sha256, file] of demoFiles) {
    const items = queue.filter((q) => q.sha256 === sha256);
    let open = filmOpen.has(sha256); // a moment of this demo failed in a way the next run retries (--film: or a player's parse did)
    // pov: the highlight's povKey (the post worker resolves it through the roster); player: its name (--film report).
    type Ready = { unit: RenderUnit; kind: UnitKind; key: string; prevStatus?: "running" | "done" | "failed"; attempts: number; pov?: string; player?: string };
    const ready: Ready[] = [];
    let lastPlayer: string | undefined;
    for (const { demo, spec, blooper, pov: itemPov, player } of items) {
      // A moment or a blooper: both carry id, title, span and score, and go through the same gates.
      const it = spec ?? blooper;
      let prep: PreparedJob;
      let done: boolean;
      try {
        prep = await prepareJob({ demo, ...(spec ? { spec } : { blooper }), timeoutS: o.timeoutS, postOnly: o.repostOnly, inBatch: true, ...(itemPov ? { pov: itemPov } : {}) });
        done = prep.inLibrary();
      } catch (e) {
        // Nothing was launched: record it and go on with the next job.
        const reason = (e as Error).message;
        recordFailure(it.id, { at: new Date().toISOString(), reasons: [reason], startTick: it.startTick, endTick: it.endTick, demo });
        report.failed.push(`${it.title}: ${reason}`);
        code = Math.max(code, 1);
        open = true;
        continue;
      }
      const key = `${prep.id}:${prep.renderKey}`;
      const prev = ledger[key];
      // Completed output wins over the ledger (e.g. a run died after publishing).
      if (done) {
        if (prev?.status !== "done") { ledger[key] = { ...(prev ?? { id: prep.id, renderKey: prep.renderKey, demoSha256: sha256, title: it.title, attempts: 0 }), status: "done", updatedAt: new Date().toISOString() }; writeLedger(ledger); }
        report.skipped.push(it.title);
        continue;
      }
      if (prev?.status === "running") console.log(`${it.title}: interrupted on an earlier run, retrying`);
      if (o.repostOnly && !prep.hasCapture()) { report.needsRender.push(it.title); continue; }
      // Post costs no launch, so a repost is not held back by the attempt limit.
      if (prev && prev.attempts >= MAX_ATTEMPTS && !o.retryFailed && !o.repostOnly) {
        report.givenUp.push(`${it.title} (${prev.attempts} attempts: ${prev.lastReasons?.join("; ") ?? "interrupted"})`);
        continue;
      }
      if (o.dryRun) {
        // --film: per demo and player (the main POV's titles carry no name, so each player gets a heading line).
        if (film && player !== lastPlayer) { console.log(`${registry.find((d) => d.sha256 === sha256)?.originalName ?? path.basename(file)} · ${player}:`); lastPlayer = player; }
        console.log(blooper ? `would render: blooper · ${it.title} (score ${it.score})` : film ? `would render: ${it.title} (score ${it.score})` : `would render: #${spec!.rank} ${it.title} (score ${it.score})`);
        continue;
      }
      ready.push({ unit: highlightUnit(prep), kind: blooper ? "blooper" : "highlight", key, prevStatus: prev?.status, attempts: (prev?.attempts ?? 0) + 1, pov: povKey(itemPov ?? pov), player });
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
      // Deferred (planTakes): not launched, so no attempt spent and the entry keeps its earlier status.
      if (res.status === "deferred") {
        ledger[r.key] = { ...ledger[r.key], status: r.prevStatus ?? "failed", attempts: r.attempts - 1, lastReasons: res.reasons, updatedAt: new Date().toISOString() };
        report.deferred.push(res.title);
        return;
      }
      ledger[r.key] = { ...ledger[r.key], status: res.status === "failed" ? "failed" : "done", attempts: res.status === "skipped" ? r.attempts - 1 : r.attempts, lastReasons: res.reasons, updatedAt: new Date().toISOString() };
      if (res.status === "done") {
        report.rendered.push(res.title);
        const e = readIndex().clips[res.id];
        report.made.push({ kind: e?.kind ?? "highlight", no: e?.no, title: res.title, ...(r.player && r.pov ? { player: { key: r.pov, name: r.player } } : {}) });
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
    // Posts queue behind each other, one at a time, and the launches never wait for them: every
    // capture runs back to back, so CS2 is done early, and the posts catch up afterwards (Peder, 2026-11-02).
    if (toPost.length) {
      const units = toPost.map((r) => ({ id: r.unit.id, title: r.unit.title, kind: r.kind, pov: r.pov }));
      posting = posting.then(() => postWorker(file, units)).then((done) => {
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
  // Only when the loop ran through: a refusal or an unverified cleanup says nothing about the game being closed.
  if (launchedOne && !o.dryRun && report.stoppedBy === undefined) console.log("all launches done, CS2 closed; the posts still queued finish now (the PC is free to use)");
  await posting; // the posts still queued
  // Raw captures of held clips from earlier runs (and any a publish could not remove): dead weight, swept here.
  if (!o.dryRun) {
    report.pruned = sweepUnderClipLock();
    if (!report.pruned) console.log("raw captures not swept: a clip run holds state/.clip.lock (pnpm tidy later)");
    for (const p of report.pruned?.problems ?? []) console.error(`raw capture not removed: ${p}`);
  }
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
function postWorker(demo: string, units: { id: string; title: string; kind: UnitKind; pov?: string }[]): Promise<JobResult[]> {
  const dir = path.join(STATE_DIR, "post-jobs");
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const jobFile = path.join(dir, `${stamp}.job.json`), resultFile = path.join(dir, `${stamp}.result.json`);
  // Each highlight and blooper names its POV by povKey, never by SteamID (the worker resolves it through the roster).
  const byPov = (kind: UnitKind) => units.filter((u) => u.kind === kind).map((u) => ({ id: u.id, pov: u.pov }));
  writeFileSync(jobFile, JSON.stringify({ demo, highlights: byPov("highlight"), bloopers: byPov("blooper"), reels: units.filter((u) => u.kind === "deaths" || u.kind === "kills").map((u) => u.kind) }));
  const fail = (reason: string): JobResult[] => units.map((u) => ({ status: "failed", id: u.id, title: u.title, reasons: [reason] }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "..", "cli", "post-worker.ts"), jobFile, resultFile], { stdio: "inherit", windowsHide: true });
    // Below normal priority: an x265 encode uses every core, and a capture running meanwhile must not starve.
    if (child.pid !== undefined) try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
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
/** Whether a film pass may settle: not a dry run or a repost (it owes no reels, so --no-reels changes nothing). */
export const filmSettles = (o: Pick<BatchOptions, "dryRun" | "repostOnly">) => !o.dryRun && !o.repostOnly;

/**
 * A finished film pass over one demo: every pair it looked at (keys: povKeys, present or not in the
 * demo) goes into the film record, and with settlesDemo the demo into settled.json, so a later normal
 * pnpm go skips it. Returns the new records only where they changed (undefined: nothing to write).
 */
export function settleFilm(filmState: Record<string, string>, settled: Record<string, string>, sha256: string, keys: string[], settlesDemo: boolean, now: string): { film?: Record<string, string>; settled?: Record<string, string>; pairs: string[] } {
  const pairs = [...new Set(keys.map((k) => filmPair(sha256, k)))].filter((p) => !filmState[p]);
  return {
    pairs,
    ...(pairs.length ? { film: { ...filmState, ...Object.fromEntries(pairs.map((p) => [p, now])) } } : {}),
    ...(settlesDemo && !settled[sha256] ? { settled: { ...settled, [sha256]: now } } : {}),
  };
}
/**
 * Writes a settleFilm result: settled.json first, then film.json. A process stopped between the two
 * leaves the pairs open, so the next film pass looks at the demo again (its clips are held) and
 * writes them; the other order would leave every pair done and the demo never settled for pnpm go.
 */
export function writeFilmSettle(s: { film?: Record<string, string>; settled?: Record<string, string> }, write: (file: string, data: unknown) => void = writeJsonAtomic) {
  if (s.settled) write(SETTLED, s.settled);
  if (s.film) write(FILM, s.film);
}

/**
 * pnpm unsettle: the demo a reference names: a clip number (1-5 digits) by its library entry, else a
 * sha256 prefix matching exactly one of `shas` (the settled demos, or with --film the demos in state/film.json).
 */
export function demoOfRef(ref: string, shas: string[], clips: { no?: number; demoSha256: string }[]): string | undefined {
  if (/^\d{1,5}$/.test(ref)) return clips.find((c) => c.no === Number(ref))?.demoSha256;
  const hits = [...new Set(shas)].filter((k) => k.startsWith(ref.toLowerCase()));
  return hits.length === 1 ? hits[0] : undefined;
}
/** pnpm unsettle --film: the film record without any of this demo's pairs (every player), so the next film pass looks at it again. */
export function unsettleFilm(filmState: Record<string, string>, sha256: string): { film: Record<string, string>; removed: number } {
  const film = Object.fromEntries(Object.entries(filmState).filter(([k]) => !k.startsWith(`${sha256}:`)));
  return { film, removed: Object.keys(filmState).length - Object.keys(film).length };
}
/** The demo hashes the film record holds pairs for. */
export const filmDemos = (filmState: Record<string, string>) => [...new Set(Object.keys(filmState).map((k) => k.slice(0, k.indexOf(":"))))];

/**
 * The refusal a batch gets before it ingests anything: CS2 running, or the FACEIT client's
 * anti-cheat, which would refuse every launch (guards.ts). A repost and --settle-existing launch
 * nothing and skip both; a dry run launches nothing either, but keeps the CS2 check it always had.
 */
export function batchRefusal(o: Pick<BatchOptions, "dryRun" | "repostOnly" | "settleExisting">): Refusal | undefined {
  if (o.repostOnly || o.settleExisting) return undefined;
  if (imageRunning("cs2.exe")) return new Refusal("refusing: CS2 is already running");
  return o.dryRun ? undefined : faceitRefusal();
}
/** A moment's outcome is final for settling: rendered, held, or failed with no retry left; never deferred. */
export const isFinal = (status: JobResult["status"], attempts: number) => status !== "deferred" && (status !== "failed" || attempts >= MAX_ATTEMPTS);
