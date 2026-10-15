// One clip job, shared by pnpm clip and the batch: resolve facts, skip if the
// library already holds this clip for the same render key, else guarded render
// (or a validated capture from an earlier attempt) → post → library.
// Throws Refusal when a guard says no (nothing launched).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Refusal, STATE_DIR, captureSize, loadCrosshairCutoff, loadIdentities, loadSettings } from "../config.ts";
import { clipFacts } from "../parse/clip-facts.ts";
import { MARGIN_TICKS, SETTLE_TICKS, render, validateCapture, type TickMapping } from "../render/controller/index.ts";
import { SPECTATOR_PANELS, crosshairSource, lookCfg } from "../render/controller/cfg.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { toolVersions } from "../render/versions.ts";
import { post } from "../post/index.ts";
import type { ClipSpec } from "../clip/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { clipId, clipPath, clipTmpPath, ensureClipsDir, publish, readIndex, recordFailure, writeJsonAtomic, type ClipEntry } from "../library/index.ts";

export type JobInput = {
  demo: string;
  spec?: ClipSpec; // a ranked moment; else startTick/endTick by hand
  startTick?: number;
  endTick?: number;
  force?: boolean; // render now even when the library holds it (pnpm clip --rerender only)
  dryRun?: boolean;
  timeoutS?: number;
  debugCommands?: string[];
  /** Post only (pnpm go --repost): without a completed capture the job refuses; it never renders. */
  postOnly?: boolean;
  /** Part of a pnpm go run: the page rewritten after this clip says the run is still going. */
  inBatch?: boolean;
  /** pnpm clip --rerender --lead: the lead-in the spec was built with, recorded in the entry. */
  leadOverride?: number;
  /** pnpm clip --rerender: the library clip this one replaces (moved to library/replaced/ on publish). */
  replaces?: string;
};
/** done: rendered now; skipped: already in the library; failed: recorded in state/failures.json. */
export type JobResult = { status: "done" | "skipped" | "failed" | "dry"; id: string; title: string; reasons?: string[]; cleanupVerified?: boolean; clip?: string };

// Written into an attempt's work dir once its raw capture validated: the
// render stage is done for this render key, and a retry goes straight to post.
type CaptureRecord = { renderKey: string; mapping: TickMapping; video: string; audio: string };

function completedCapture(id: string, renderKey: string, size: string): (CaptureRecord & { workDir: string }) | undefined {
  const dir = path.join(STATE_DIR, "render", id);
  if (!existsSync(dir)) return undefined;
  for (const attempt of readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, attempt, "capture.json");
    if (!existsSync(file)) continue;
    let problems: string[];
    let c: CaptureRecord | undefined;
    try {
      c = JSON.parse(readFileSync(file, "utf8")) as CaptureRecord;
      if (c.renderKey !== renderKey) continue;
      problems = validateCapture(c.video, c.audio, c.mapping.frames, c.mapping.fps, size);
    } catch (e) {
      // FFmpeg missing is a tool problem, not a bad capture: stop instead of launching again.
      if ((e as Error).message.startsWith("ffmpeg did not run")) throw e;
      problems = [(e as Error).message];
    }
    if (!problems.length) return { ...c!, workDir: path.join(dir, attempt) };
    console.log(`capture ${attempt} not usable, skipping it: ${problems.join("; ")}`);
  }
  return undefined;
}

/**
 * The library entry that holds this moment: the same clip id, or (for a ranked moment) a clip
 * of the same demo and round sharing a kill, made when the span rules were different. Sharing
 * one kill is enough on purpose: a moment the library holds is never re-made by a rule change,
 * even when the new span would add kills (AGENTS.md); pnpm clip --rerender does that.
 */
export function heldEntry(clips: Record<string, ClipEntry>, id: string, demoSha256: string, round: number, spec?: ClipSpec): ClipEntry | undefined {
  if (clips[id]) return clips[id];
  if (!spec) return undefined;
  return Object.values(clips).find((e) => {
    const ticks = e.moment?.killTicks;
    return e.demoSha256 === demoSha256 && e.round === round && Array.isArray(ticks) && ticks.some((t) => spec.killTicks.includes(t as number));
  });
}

/** Everything a job decides before it may launch: facts, id, render key, library state. */
export type PreparedJob = Awaited<ReturnType<typeof prepareJob>>;

export async function prepareJob(o: JobInput) {
  const { demo, spec } = o;
  const debugCommands = o.debugCommands ?? [];
  const startTick = spec ? spec.startTick : o.startTick!;
  const endTick = spec ? spec.endTick : o.endTick!;
  if (!Number.isInteger(startTick) || !Number.isInteger(endTick) || endTick <= startTick) throw new Error("bad tick range");
  const settings = loadSettings();
  const ids = loadIdentities();
  const facts = await clipFacts(demo, ids.pov, startTick, endTick);
  // A moment carries the match round (pre-match rounds excluded) and its own title.
  const round = spec ? spec.round : facts.round;
  const id = clipId(facts.demoSha256, round, startTick, endTick);
  if (spec && id !== spec.id) throw new Error(`clip id ${id} differs from the moment's ${spec.id}`);
  const title = spec ? spec.title : `${facts.map} · R${facts.round} · ticks ${startTick}-${endTick}`;
  const cutoff = loadCrosshairCutoff();
  const crosshair = crosshairSource(facts.patch, cutoff);
  const look = lookCfg(ids.cs2Exe, ids.pov, crosshair);
  const versions = toolVersions(ids.cs2Exe, ids.hlaeExe);
  const { node: _node, ...outputVersions } = versions;
  const renderInputs = { settings, versions: outputVersions, slot: facts.slot, lookCfgSha256: createHash("sha256").update(look).digest("hex"), marginTicks: MARGIN_TICKS, settleTicks: SETTLE_TICKS, spectatorPanels: SPECTATOR_PANELS, debugCommands,
    // "demo" adds nothing: its look hash simply lacks the crosshair convars (they never showed for these
    // demos, M0.2), so the key changes only by those lines. "own" changes the picture (observer crosshair 0).
    ...(crosshair === "own" ? { crosshair } : {}) };
  // The POV id is part of the key but never stored in the library.
  const renderKey = createHash("sha256").update(JSON.stringify({ ...renderInputs, pov: ids.pov })).digest("hex").slice(0, 16);
  /** A validated raw capture for this render key exists, so the job needs post only, no launch. */
  const hasCapture = () => !!completedCapture(id, renderKey, `${captureSize(settings).width}x${captureSize(settings).height}`);
  /**
   * The library holds this moment: done, whatever its render key (AGENTS.md: a finished clip is never
   * re-rendered because the cfg, settings or method changed; only pnpm clip --rerender <no|id> does that).
   * The entry is written only after the clip validated and was renamed into place.
   */
  const inLibrary = () => {
    const held = heldEntry(readIndex().clips, id, facts.demoSha256, round, spec);
    if (!held) return false;
    if (held.id !== id) console.log(`the library holds this moment as clip ${held.no ?? held.id} (other span); kept as done`);
    if (!existsSync(clipPath(held.id))) console.log(`library entry ${held.id} has no file; kept as done (pnpm clip --rerender ${held.id} re-makes it)`);
    return true;
  };
  return { o, demo, spec, debugCommands, startTick, endTick, settings, ids, facts, round, id, title, look, crosshair, cutoff, versions, renderInputs, renderKey, inLibrary, hasCapture };
}

export async function clipJob(o: JobInput): Promise<JobResult> {
  const p = await prepareJob(o);
  console.log(`clip ${p.id}: ${p.title} (slot ${p.facts.slot}, build ${p.facts.patch}: ${p.crosshair === "demo" ? "the demo's crosshair" : "his saved crosshair"}, render key ${p.renderKey})`);
  if (o.dryRun) {
    console.log(JSON.stringify({ id: p.id, title: p.title, facts: p.facts, renderInputs: p.renderInputs }, null, 2));
    return { status: "dry", id: p.id, title: p.title };
  }
  return runJob(p);
}

/** One clip: runJobs with a single job. */
export async function runJob(prep: PreparedJob): Promise<JobResult> {
  return (await runJobs([prep]))[0];
}

/**
 * Jobs of ONE demo, with one launch for all of them (chained takes, PLAN.md §5): each
 * job the library does not hold and that has no validated capture becomes a take, in
 * tick order so the game only seeks forward; then every job with a capture is posted
 * and published as before. Results come back in the order of `preps`.
 */
export async function runJobs(preps: PreparedJob[]): Promise<JobResult[]> {
  if (!preps.length) return [];
  if (preps.some((p) => p.facts.demoSha256 !== preps[0].facts.demoSha256)) throw new Error("runJobs: jobs of more than one demo");
  // One clip run at a time, from the resume check to the index write.
  const clipLock = new RenderLock(path.join(STATE_DIR, ".clip.lock"));
  clipLock.acquire();
  // Signals end the process from inside the controller (after its cleanup), skipping finally.
  const releaseClipLock = () => clipLock.release();
  process.on("exit", releaseClipLock);
  try {
    const attempt = String(Date.now());
    const results = new Map<string, JobResult>();
    const captures = new Map<string, CaptureRecord & { workDir: string }>();
    const fail = (p: PreparedJob, reasons: string[], workDir: string, cleanupVerified = true): JobResult => {
      try { recordFailure(p.id, { at: new Date().toISOString(), reasons, workDir, startTick: p.startTick, endTick: p.endTick, demo: p.demo }); }
      catch (e) { console.error(`could not record the failure: ${(e as Error).message}`); }
      console.error(`FAILED ${p.title}: ${reasons.join("; ")}\nwork dir: ${workDir}`);
      return { status: "failed", id: p.id, title: p.title, reasons, cleanupVerified };
    };

    const toRender: PreparedJob[] = [];
    for (const p of preps) {
      // Resume: the clip is done when the library holds it (any render key); force (--rerender) makes it again.
      if (!p.o.force && p.inLibrary()) { console.log(`already in the library: ${p.title}`); results.set(p.id, { status: "skipped", id: p.id, title: p.title, clip: clipPath(p.id) }); continue; }
      const c = p.o.force ? undefined : completedCapture(p.id, p.renderKey, `${captureSize(p.settings).width}x${captureSize(p.settings).height}`);
      if (c) { console.log(`${p.title}: render stage already done in ${c.workDir}; resuming at post`); captures.set(p.id, c); }
      else toRender.push(p);
    }

    if (toRender.length) {
      // The last word on --repost's no-launch promise, at the launch boundary itself.
      if (toRender.some((p) => p.o.postOnly)) throw new Refusal("post only: no completed capture for a job; nothing launched");
      const order = [...toRender].sort((x, y) => x.startTick - y.startTick);
      const first = order[0];
      const launchDir = order.length === 1 ? path.join(STATE_DIR, "render", first.id, attempt) : path.join(STATE_DIR, "render", `launch-${first.facts.demoSha256.slice(0, 12)}-${attempt}`);
      const r = await render({
        title: order.length === 1 ? first.title : `${first.facts.map} · ${order.length} takes`,
        demo: first.demo, takes: order.map((p) => ({ startTick: p.startTick, endTick: p.endTick, slot: p.facts.slot })),
        workDir: launchDir, lockFile: path.join(STATE_DIR, ".render.lock"), ids: first.ids, settings: first.settings,
        lookCfg: first.look, crosshair: first.crosshair, debugCommands: order.length === 1 ? first.debugCommands : [],
        timeoutS: first.o.timeoutS,
      });
      console.log(`render ${r.status} in ${r.wallSeconds}s (${order.length} take(s))`);
      for (const [i, p] of order.entries()) {
        const t = r.takes[i];
        // A take with a usable capture is kept even when another take of the launch failed.
        if (!r.cleanupVerified || !t || t.reasons.length || !t.mapping || !t.audio) {
          results.set(p.id, fail(p, [...r.reasons, ...(t?.reasons ?? ["no take result"])], launchDir, r.cleanupVerified));
          continue;
        }
        // Each clip's own attempt dir records its capture, pointing into the shared launch dir.
        const workDir = order.length === 1 ? launchDir : path.join(STATE_DIR, "render", p.id, attempt);
        const record: CaptureRecord = { renderKey: p.renderKey, mapping: t.mapping, video: t.video, audio: t.audio };
        writeJsonAtomic(path.join(workDir, "capture.json"), record);
        captures.set(p.id, { ...record, workDir });
      }
    }

    for (const p of preps) {
      if (results.has(p.id)) continue;
      const c = captures.get(p.id)!;
      // A post that throws fails its own clip only; the others keep their results.
      try { results.set(p.id, postAndPublish(p, c, attempt, (reasons) => fail(p, reasons, c.workDir))); }
      catch (e) { results.set(p.id, fail(p, [`post error: ${(e as Error).message}`], c.workDir)); }
    }
    return preps.map((p) => results.get(p.id)!);
  } finally {
    clipLock.release();
    process.off("exit", releaseClipLock);
  }
}

function postAndPublish(prep: PreparedJob, capture: CaptureRecord & { workDir: string }, attempt: string, fail: (reasons: string[]) => JobResult): JobResult {
  const { o, demo, spec, startTick, endTick, settings, facts, round, id, title, crosshair, cutoff, versions, renderInputs, renderKey } = prep;
  ensureClipsDir();
  const tmp = clipTmpPath(id, attempt);
  const p = post(capture.video, capture.audio, capture.mapping, startTick, endTick, settings, tmp, spec?.windows);
  if (p.status !== "ok") return fail(p.reasons);
  publish(tmp, {
    id, file: `clips/${id}.mp4`, title, map: facts.map, demo, demoSha256: facts.demoSha256, round,
    ...(spec ? { moment: { rank: spec.rank, score: spec.score, breakdown: spec.breakdown, kills: spec.kills, killTicks: spec.killTicks, weapons: spec.weapons, flags: spec.flags, ...(spec.clutch ? { clutch: { vs: spec.clutch.vs, won: spec.clutch.won } } : {}) } } : {}),
    startTick, endTick, seconds: p.plan!.seconds, frames: p.plan!.frames, createdAt: new Date().toISOString(),
    renderKey, render: { ...renderInputs, node: versions.node, mapping: capture.mapping, trim: p.plan, segments: p.segments!.map(({ startTick, endTick, speed, outSeconds }) => ({ startTick, endTick, speed, outSeconds })), workDir: capture.workDir },
    kind: "highlight", timing: "scheduled",
    crosshair: { source: crosshair, demoPatch: facts.patch, cutoff: cutoff ?? null },
    ...(o.leadOverride !== undefined ? { leadOverride: o.leadOverride } : {}),
  }, o.replaces);
  // The page shows each clip as it lands; inside a pnpm go run it says the run is still going.
  try { writeLibraryPage({ running: !!o.inBatch }); } catch (e) { console.error(`library page not rewritten: ${(e as Error).message}`); }
  const ff = p.segments!.filter((x) => x.speed !== 1);
  console.log(`ok: ${clipPath(id)} (${p.plan!.seconds.toFixed(1)} s from ${((endTick - startTick) / capture.mapping.tickrate).toFixed(1)} s of play${ff.length ? `, ${ff.length} stretch(es) fast-forwarded` : ""}; trimmed by the scheduled record start)`);
  return { status: "done", id, title, clip: clipPath(id) };
}
