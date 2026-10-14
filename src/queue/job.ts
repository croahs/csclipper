// One clip job, shared by pnpm clip and the batch: resolve facts, skip if the
// library already holds this clip for the same render key, else guarded render
// (or a validated capture from an earlier attempt) → post → library.
// Throws Refusal when a guard says no (nothing launched).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, captureSize, loadIdentities, loadSettings } from "../config.ts";
import { clipFacts } from "../parse/clip-facts.ts";
import { MARGIN_TICKS, SETTLE_TICKS, render, validateCapture, type TickMapping } from "../render/controller/index.ts";
import { SPECTATOR_PANELS, lookCfg } from "../render/controller/cfg.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { toolVersions } from "../render/versions.ts";
import { measureMapping, post, validateClip } from "../post/index.ts";
import type { ClipSpec } from "../clip/index.ts";
import { clipId, clipPath, clipTmpPath, ensureClipsDir, publish, readIndex, recordFailure, writeJsonAtomic } from "../library/index.ts";

export type JobInput = {
  demo: string;
  spec?: ClipSpec; // a ranked moment; else startTick/endTick by hand
  startTick?: number;
  endTick?: number;
  force?: boolean;
  dryRun?: boolean;
  timeoutS?: number;
  debugCommands?: string[];
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
  const look = lookCfg(ids.cs2Exe, ids.pov);
  const versions = toolVersions(ids.cs2Exe, ids.hlaeExe);
  const { node: _node, ...outputVersions } = versions;
  const renderInputs = { settings, versions: outputVersions, slot: facts.slot, lookCfgSha256: createHash("sha256").update(look).digest("hex"), marginTicks: MARGIN_TICKS, settleTicks: SETTLE_TICKS, spectatorPanels: SPECTATOR_PANELS, debugCommands };
  // The POV id is part of the key but never stored in the library.
  const renderKey = createHash("sha256").update(JSON.stringify({ ...renderInputs, pov: ids.pov })).digest("hex").slice(0, 16);
  /** The library already holds this clip for this render key, and the file still validates. A file alone proves nothing. */
  const inLibrary = () => {
    const existing = readIndex().clips[id];
    if (!existing || existing.renderKey !== renderKey || !existsSync(clipPath(id))) return false;
    const problems = validateClip(clipPath(id), existing.frames, settings.fps, `${settings.width}x${settings.height}`);
    if (problems.length) console.log(`library clip no longer valid, re-making it: ${problems.join("; ")}`);
    return !problems.length;
  };
  return { o, demo, spec, debugCommands, startTick, endTick, settings, ids, facts, round, id, title, look, versions, renderInputs, renderKey, inLibrary };
}

export async function clipJob(o: JobInput): Promise<JobResult> {
  const p = await prepareJob(o);
  console.log(`clip ${p.id}: ${p.title} (slot ${p.facts.slot}, ${p.facts.shotTicks.length} POV shots, render key ${p.renderKey})`);
  if (o.dryRun) {
    console.log(JSON.stringify({ id: p.id, title: p.title, facts: p.facts, renderInputs: p.renderInputs }, null, 2));
    return { status: "dry", id: p.id, title: p.title };
  }
  return runJob(p);
}

export async function runJob(prep: PreparedJob): Promise<JobResult> {
  const { o, demo, spec, debugCommands, startTick, endTick, settings, ids, facts, round, id, title, look, versions, renderInputs, renderKey } = prep;
  // One clip run at a time, from the resume check to the index write.
  const clipLock = new RenderLock(path.join(STATE_DIR, ".clip.lock"));
  clipLock.acquire();
  // Signals end the process from inside the controller (after its cleanup), skipping finally.
  const releaseClipLock = () => clipLock.release();
  process.on("exit", releaseClipLock);
  try {
    // Resume: the clip is done when the library holds it for this render key.
    if (!o.force && prep.inLibrary()) { console.log(`already in the library: ${clipPath(id)}`); return { status: "skipped", id, title, clip: clipPath(id) }; }

    const attempt = String(Date.now());
    let workDir = path.join(STATE_DIR, "render", id, attempt);
    const fail = (reasons: string[], cleanupVerified = true): JobResult => {
      try { recordFailure(id, { at: new Date().toISOString(), reasons, workDir, startTick, endTick, demo }); }
      catch (e) { console.error(`could not record the failure: ${(e as Error).message}`); }
      console.error(`FAILED: ${reasons.join("; ")}\nwork dir: ${workDir}`);
      return { status: "failed", id, title, reasons, cleanupVerified };
    };

    let capture = o.force ? undefined : completedCapture(id, renderKey, `${captureSize(settings).width}x${captureSize(settings).height}`);
    if (capture) {
      workDir = capture.workDir;
      console.log(`render stage already done in ${workDir}; resuming at post`);
    } else {
      const r = await render({ title, demo, slot: facts.slot, startTick, endTick, workDir, lockFile: path.join(STATE_DIR, ".render.lock"), ids, settings, lookCfg: look, debugCommands, timeoutS: o.timeoutS });
      if (r.status !== "ok" || !r.mapping || !r.audio || !r.video) return fail(r.reasons, r.cleanupVerified);
      capture = { renderKey, mapping: r.mapping, video: r.video, audio: r.audio, workDir };
      writeJsonAtomic(path.join(workDir, "capture.json"), { renderKey, mapping: r.mapping, video: r.video, audio: r.audio });
      console.log(`render ok in ${r.wallSeconds}s`);
    }

    const m = measureMapping(capture.mapping, capture.video, capture.audio, facts.shotTicks);
    if (typeof m === "string") return fail([m]);
    console.log(`tick origin: frame 0 shows tick ${m.originTick.toFixed(2)} (scheduled ${m.recordStartTick}; ${m.timing.offsetFrames} frames by ${m.timing.source}; flash ${m.timing.video.offsetFrames}, audio ${(m.timing.audio.offsetMs * m.fps / 1000).toFixed(2)})`);
    ensureClipsDir();
    const tmp = clipTmpPath(id, attempt);
    const p = post(capture.video, capture.audio, m, startTick, endTick, facts.shotTicks, settings, tmp);
    if (p.status !== "ok") return fail(p.reasons);

    publish(tmp, {
      id, file: `clips/${id}.mp4`, title, map: facts.map, demo, demoSha256: facts.demoSha256, round,
      ...(spec ? { moment: { rank: spec.rank, score: spec.score, breakdown: spec.breakdown, kills: spec.kills, killTicks: spec.killTicks, weapons: spec.weapons, flags: spec.flags, ...(spec.clutch ? { clutch: { vs: spec.clutch.vs, won: spec.clutch.won } } : {}) } } : {}),
      startTick, endTick, seconds: p.plan!.seconds, frames: p.plan!.frames, createdAt: new Date().toISOString(),
      renderKey, render: { ...renderInputs, node: versions.node, mapping: { ...capture.mapping, originTick: m.originTick, offsetFrames: m.timing.offsetFrames, source: m.timing.source }, trim: p.plan, landedOffsetFrames: p.landed!.offsetFrames, workDir },
    });
    console.log(`ok: ${clipPath(id)} (${p.plan!.frames} frames, ${p.plan!.seconds.toFixed(3)} s; requested ticks land ${p.landed!.offsetFrames} frames off by ${p.landed!.source})`);
    return { status: "done", id, title, clip: clipPath(id) };
  } finally {
    clipLock.release();
    process.off("exit", releaseClipLock);
  }
}
