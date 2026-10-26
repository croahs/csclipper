// One clip job, shared by pnpm clip and the batch: resolve facts, skip if the
// library already holds this clip for the same render key, else guarded render
// (or a validated capture from an earlier attempt) → post → library.
// Throws Refusal when a guard says no (nothing launched).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Refusal, STATE_DIR, captureSize, loadCrosshairCutoff, loadIdentities, loadSettings, type Identities, type RenderSettings } from "../config.ts";
import { clipFacts } from "../parse/clip-facts.ts";
import { MARGIN_TICKS, SETTLE_TICKS, render, validateCapture, type TakeSpec, type TickMapping } from "../render/controller/index.ts";
import { SPECTATOR_PANELS, crosshairSource, lookCfg, type CrosshairSource } from "../render/controller/cfg.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { toolVersions } from "../render/versions.ts";
import { post } from "../post/index.ts";
import type { ClipSpec } from "../clip/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { clipId, clipPath, clipTmpPath, ensureClipsDir, publish, readDeleted, readIndex, recordFailure, writeJsonAtomic, type ClipEntry } from "../library/index.ts";
import { pruneTakes } from "./prune.ts";

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
/** captured: rendered and its capture recorded, post still to come (runJobs renderOnly). */
export type JobResult = { status: "done" | "skipped" | "failed" | "dry" | "captured"; id: string; title: string; reasons?: string[]; cleanupVerified?: boolean; clip?: string };

// Written into an attempt's work dir once its raw capture validated: the
// render stage is done for this render key, and a retry goes straight to post.
// One take per entry of `takes` (a highlight has one, a reel many); records
// written before reels hold a single take's fields at the top level.
export type TakeCapture = { mapping: TickMapping; video: string; audio: string };
type CaptureRecord = { renderKey: string; takes: TakeCapture[] };

function completedCapture(id: string, renderKey: string, size: string, takes: number): (CaptureRecord & { workDir: string }) | undefined {
  const dir = path.join(STATE_DIR, "render", id);
  if (!existsSync(dir)) return undefined;
  for (const attempt of readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, attempt, "capture.json");
    if (!existsSync(file)) continue;
    let problems: string[];
    let c: CaptureRecord | undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      c = { renderKey: raw.renderKey, takes: Array.isArray(raw.takes) ? raw.takes : [{ mapping: raw.mapping, video: raw.video, audio: raw.audio }] };
      if (c.renderKey !== renderKey) continue;
      problems = c.takes.length !== takes ? [`capture has ${c.takes.length} take(s), expected ${takes}`]
        : c.takes.flatMap((t) => validateCapture(t.video, t.audio, t.mapping.frames, t.mapping.fps, size));
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
 * What runJobs renders and finishes: a highlight (one take, prepareJob) or a reel (many takes,
 * src/reel). All units of one runJobs call belong to one demo and share its look and settings.
 */
export type RenderUnit = {
  id: string; title: string; demo: string; demoSha256: string; map: string;
  o: JobInput;
  takes: TakeSpec[];
  startTick: number; endTick: number; // for failure records: the span the unit covers
  renderKey: string;
  settings: RenderSettings; ids: Identities; look: string; crosshair: CrosshairSource; debugCommands: string[];
  inLibrary: () => boolean;
  /** Post and publish from the unit's validated takes; `fail` records a failure and returns its result. */
  finish: (takes: TakeCapture[], workDir: string, attempt: string, fail: (reasons: string[]) => JobResult) => JobResult;
};

/** A validated capture for this render key exists, so the unit needs post only, no launch. */
export const unitHasCapture = (u: RenderUnit) => !!completedCapture(u.id, u.renderKey, `${captureSize(u.settings).width}x${captureSize(u.settings).height}`, u.takes.length);

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
  const hasCapture = () => !!completedCapture(id, renderKey, `${captureSize(settings).width}x${captureSize(settings).height}`, 1);
  /**
   * The library holds this moment: done, whatever its render key (AGENTS.md: a finished clip is never
   * re-rendered because the cfg, settings or method changed; only pnpm clip --rerender <no|id> does that).
   * The entry is written only after the clip validated and was renamed into place.
   */
  const inLibrary = () => {
    // A deleted moment counts as held: deleting a clip means "never make it again".
    const held = heldEntry({ ...readDeleted(), ...readIndex().clips }, id, facts.demoSha256, round, spec);
    if (!held) return false;
    if (readDeleted()[held.id]) { console.log(`clip ${held.no ?? held.id} was deleted; not made again`); return true; }
    if (held.id !== id) console.log(`the library holds this moment as clip ${held.no ?? held.id} (other span); kept as done`);
    if (!existsSync(clipPath(held.id))) console.log(`library entry ${held.id} has no file; kept as done (pnpm clip --rerender ${held.id} re-makes it)`);
    return true;
  };
  return { o, demo, spec, debugCommands, startTick, endTick, settings, ids, facts, round, id, title, look, crosshair, cutoff, versions, renderInputs, renderKey, inLibrary, hasCapture };
}

export async function clipJob(o: JobInput): Promise<JobResult> {
  const p = await prepareJob(o);
  console.log(`clip ${p.id}: ${p.title} (slot ${p.facts.slot}, build ${p.facts.patch}: ${p.crosshair === "demo" ? "the demo's crosshair" : "your saved crosshair"}, render key ${p.renderKey})`);
  if (o.dryRun) {
    console.log(JSON.stringify({ id: p.id, title: p.title, facts: p.facts, renderInputs: p.renderInputs }, null, 2));
    return { status: "dry", id: p.id, title: p.title };
  }
  return runJob(p);
}

/** A highlight job as a render unit: one take, posted with the moment's action windows. */
export function highlightUnit(p: PreparedJob): RenderUnit {
  return {
    id: p.id, title: p.title, demo: p.demo, demoSha256: p.facts.demoSha256, map: p.facts.map, o: p.o,
    takes: [{ startTick: p.startTick, endTick: p.endTick, slot: p.facts.slot }], startTick: p.startTick, endTick: p.endTick,
    renderKey: p.renderKey, settings: p.settings, ids: p.ids, look: p.look, crosshair: p.crosshair, debugCommands: p.debugCommands,
    inLibrary: p.inLibrary,
    finish: (takes, workDir, attempt, fail) => postAndPublish(p, { renderKey: p.renderKey, ...takes[0], workDir }, attempt, fail),
  };
}

/** One clip: runJobs with a single job. */
export async function runJob(prep: PreparedJob): Promise<JobResult> {
  return (await runJobs([highlightUnit(prep)]))[0];
}

/**
 * Units of ONE demo, with one launch for all of them (chained takes, PLAN.md §5): every
 * take of every unit the library does not hold and that has no validated capture is
 * rendered in tick order (fewest backward seeks); then every unit with all its takes
 * captured is finished (posted and published). Results come back in the order of `units`.
 */
/**
 * renderOnly: stop once the captures are recorded (units come back "captured"); the post
 * worker finishes them (pnpm go overlaps that with the next demo's launch). noClipLock: the
 * post worker's mode, post only, alongside a pnpm go that holds the clip lock for its launches;
 * publishing is still serialised by the index lock.
 */
export type RunOptions = { renderOnly?: boolean; noClipLock?: boolean };

export async function runJobs(units: RenderUnit[], ro: RunOptions = {}): Promise<JobResult[]> {
  if (!units.length) return [];
  if (units.some((u) => u.demoSha256 !== units[0].demoSha256)) throw new Error("runJobs: units of more than one demo");
  if (ro.noClipLock && units.some((u) => !u.o.postOnly)) throw new Error("runJobs: without the clip lock only post-only units");
  // One clip run at a time, from the resume check to the index write.
  const clipLock = ro.noClipLock ? undefined : new RenderLock(path.join(STATE_DIR, ".clip.lock"));
  clipLock?.acquire();
  // Signals end the process from inside the controller (after its cleanup), skipping finally.
  const releaseClipLock = () => clipLock?.release();
  process.on("exit", releaseClipLock);
  try {
    const attempt = String(Date.now());
    const results = new Map<string, JobResult>();
    const captures = new Map<string, { takes: TakeCapture[]; workDir: string }>();
    const fail = (u: RenderUnit, reasons: string[], workDir: string, cleanupVerified = true): JobResult => {
      try { recordFailure(u.id, { at: new Date().toISOString(), reasons, workDir, startTick: u.startTick, endTick: u.endTick, demo: u.demo }); }
      catch (e) { console.error(`could not record the failure: ${(e as Error).message}`); }
      console.error(`FAILED ${u.title}: ${reasons.join("; ")}\nwork dir: ${workDir}`);
      return { status: "failed", id: u.id, title: u.title, reasons, cleanupVerified };
    };

    const toRender: RenderUnit[] = [];
    for (const u of units) {
      // Resume: done when the library holds it (any render key); force (--rerender) makes it again.
      if (!u.o.force && u.inLibrary()) { console.log(`already in the library: ${u.title}`); results.set(u.id, { status: "skipped", id: u.id, title: u.title, clip: clipPath(u.id) }); continue; }
      const c = u.o.force ? undefined : completedCapture(u.id, u.renderKey, `${captureSize(u.settings).width}x${captureSize(u.settings).height}`, u.takes.length);
      if (c) { console.log(`${u.title}: render stage already done in ${c.workDir}; resuming at post`); captures.set(u.id, c); }
      else toRender.push(u);
    }

    if (toRender.length) {
      // The last word on --repost's no-launch promise, at the launch boundary itself.
      if (toRender.some((u) => u.o.postOnly)) throw new Refusal("post only: no completed capture for a job; nothing launched");
      const plan = toRender.flatMap((u) => u.takes.map((t, k) => ({ u, k, t }))).sort((x, y) => x.t.startTick - y.t.startTick);
      const first = toRender[0];
      const single = toRender.length === 1 && first.takes.length === 1;
      const launchDir = single ? path.join(STATE_DIR, "render", first.id, attempt) : path.join(STATE_DIR, "render", `launch-${first.demoSha256.slice(0, 12)}-${attempt}`);
      const r = await render({
        title: single ? first.title : `${first.map} · ${plan.length} takes`,
        demo: first.demo, takes: plan.map((x) => x.t),
        workDir: launchDir, lockFile: path.join(STATE_DIR, ".render.lock"), ids: first.ids, settings: first.settings,
        lookCfg: first.look, crosshair: first.crosshair, debugCommands: single ? first.debugCommands : [],
        timeoutS: first.o.timeoutS,
      });
      console.log(`render ${r.status} in ${r.wallSeconds}s (${plan.length} take(s))`);
      for (const u of toRender) {
        const mine = plan.map((x, i) => ({ ...x, res: r.takes[i] })).filter((x) => x.u === u).sort((x, y) => x.k - y.k);
        // A unit needs every one of its takes; a usable take is kept even when another unit's take failed.
        const bad = mine.filter((x) => !x.res || x.res.reasons.length || !x.res.mapping || !x.res.audio);
        if (!r.cleanupVerified || bad.length) {
          results.set(u.id, fail(u, [...r.reasons, ...bad.flatMap((x) => x.res?.reasons.map((m) => `take ${x.k}: ${m}`) ?? [`take ${x.k}: no result`])], launchDir, r.cleanupVerified));
          continue;
        }
        // Each unit's own attempt dir records its capture, pointing into the shared launch dir.
        const workDir = single ? launchDir : path.join(STATE_DIR, "render", u.id, attempt);
        const record: CaptureRecord = { renderKey: u.renderKey, takes: mine.map((x) => ({ mapping: x.res!.mapping!, video: x.res!.video, audio: x.res!.audio! })) };
        writeJsonAtomic(path.join(workDir, "capture.json"), record);
        captures.set(u.id, { takes: record.takes, workDir });
      }
    }

    for (const u of units) {
      if (results.has(u.id)) continue;
      if (ro.renderOnly) { results.set(u.id, { status: "captured", id: u.id, title: u.title }); continue; }
      const c = captures.get(u.id)!;
      // A finish that throws fails its own unit only; the others keep their results.
      try { results.set(u.id, u.finish(c.takes, c.workDir, attempt, (reasons) => fail(u, reasons, c.workDir))); }
      catch (e) { results.set(u.id, fail(u, [`post error: ${(e as Error).message}`], c.workDir)); }
    }
    return units.map((u) => results.get(u.id)!);
  } finally {
    clipLock?.release();
    process.off("exit", releaseClipLock);
  }
}

function postAndPublish(prep: PreparedJob, capture: TakeCapture & { renderKey: string; workDir: string }, attempt: string, fail: (reasons: string[]) => JobResult): JobResult {
  const { o, demo, spec, startTick, endTick, settings, facts, round, id, title, crosshair, cutoff, versions, renderInputs, renderKey } = prep;
  ensureClipsDir();
  const tmp = clipTmpPath(id, attempt);
  const p = post(capture.video, capture.audio, capture.mapping, startTick, endTick, settings, tmp, spec?.windows);
  if (p.status !== "ok") return fail(p.reasons);
  publish(tmp, {
    id, file: `clips/${id}.mp4`, title, map: facts.map, demo, demoSha256: facts.demoSha256, round,
    ...(spec ? { moment: { rank: spec.rank, score: spec.score, breakdown: spec.breakdown, kills: spec.kills, killTicks: spec.killTicks, weapons: spec.weapons, flags: spec.flags, ...(spec.clutch ? { clutch: { vs: spec.clutch.vs, won: spec.clutch.won } } : {}) } } : {}),
    startTick, endTick, seconds: p.plan!.seconds, frames: p.plan!.frames, createdAt: new Date().toISOString(),
    renderKey, render: { ...renderInputs, node: versions.node, mapping: capture.mapping, trim: p.plan, segments: p.segments!.map(({ startTick, endTick, speed, outSeconds }) => ({ startTick, endTick, speed, outSeconds })), encoder: p.encoder, workDir: capture.workDir },
    kind: "highlight", timing: "scheduled",
    crosshair: { source: crosshair, demoPatch: facts.patch, cutoff: cutoff ?? null },
    ...(o.leadOverride !== undefined ? { leadOverride: o.leadOverride } : {}),
  }, o.replaces);
  // The page shows each clip as it lands; inside a pnpm go run it says the run is still going.
  try { writeLibraryPage({ running: !!o.inBatch }); } catch (e) { console.error(`library page not rewritten: ${(e as Error).message}`); }
  const ff = p.segments!.filter((x) => x.speed !== 1);
  console.log(`ok: ${clipPath(id)} (${p.plan!.seconds.toFixed(1)} s from ${((endTick - startTick) / capture.mapping.tickrate).toFixed(1)} s of play${ff.length ? `, ${ff.length} stretch(es) fast-forwarded` : ""}; trimmed by the scheduled record start)`);
  // The library holds the clip now, so its raw capture has served its purpose (prune.ts).
  for (const m of pruneTakes([capture]).problems) console.error(`raw capture not removed: ${m}`);
  return { status: "done", id, title, clip: clipPath(id) };
}
