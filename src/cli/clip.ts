// pnpm clip <demo.dem> <startTick> <endTick> [--timeout <s>] [--force] [--dry-run] [--debug-cmd <cmd>]...
// One clip from a hand-written spec: guarded render → post → library.
// Exit codes: 0 ok (or already in the library), 1 failed, 2 refused (nothing
// launched), 3 cleanup not verified (a game process may still run; the lock stays).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, Refusal, captureSize, loadIdentities, loadSettings } from "../config.ts";
import { clipFacts } from "../parse/clip-facts.ts";
import { MARGIN_TICKS, SETTLE_TICKS, cleanupUnverified, render, validateCapture, type TickMapping } from "../render/controller/index.ts";
import { SPECTATOR_PANELS, lookCfg } from "../render/controller/cfg.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { toolVersions } from "../render/versions.ts";
import { measureMapping, post, validateClip } from "../post/index.ts";
import { clipId, clipPath, clipTmpPath, ensureClipsDir, publish, readIndex, recordFailure, writeJsonAtomic } from "../library/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--timeout" && args[i - 1] !== "--debug-cmd");
// --debug-cmd <cmd> (repeatable): a quote-free console command scheduled after spec_player, e.g. a panel dump.
// Only diagnostics are allowed: anything else could leave playback or change the schedule.
const DEBUG_CMD = /^__mirv_panorama_print_children [A-Za-z][A-Za-z0-9_-]*$/;
const debugCommands = args.flatMap((a, i) => (a === "--debug-cmd" && args[i + 1] ? [args[i + 1]] : []));
const [demoArg, startArg, endArg] = positional;
const usage = "usage: pnpm clip <demo.dem> <startTick> <endTick> [--timeout <s>] [--force] [--dry-run] [--debug-cmd <cmd>]...";

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

async function main(): Promise<number> {
  if (!demoArg) { console.error(usage); return 1; }
  const demo = path.resolve(demoArg);
  const startTick = Number(startArg);
  const endTick = Number(endArg);
  if (!existsSync(demo)) throw new Error(`demo not found: ${demo}`);
  if (!Number.isInteger(startTick) || !Number.isInteger(endTick) || endTick <= startTick) throw new Error(`bad tick range\n${usage}`);
  const timeoutS = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
  if (timeoutS !== undefined && !(timeoutS > 0)) throw new Error("--timeout must be a positive number of seconds");

  const bad = debugCommands.find((c) => !DEBUG_CMD.test(c));
  if (bad !== undefined) throw new Error(`--debug-cmd allows only "__mirv_panorama_print_children <PanelId>", got: ${bad}`);
  const settings = loadSettings();
  const ids = loadIdentities();
  const facts = await clipFacts(demo, ids.pov, startTick, endTick);
  const id = clipId(facts.demoSha256, facts.round, startTick, endTick);
  const title = `${facts.map} · R${facts.round} · ticks ${startTick}-${endTick}`;
  const look = lookCfg(ids.cs2Exe, ids.pov);
  const versions = toolVersions(ids.cs2Exe, ids.hlaeExe);
  const { node: _node, ...outputVersions } = versions;
  const renderInputs = { settings, versions: outputVersions, slot: facts.slot, lookCfgSha256: createHash("sha256").update(look).digest("hex"), marginTicks: MARGIN_TICKS, settleTicks: SETTLE_TICKS, spectatorPanels: SPECTATOR_PANELS, debugCommands };
  // The POV id is part of the key but never stored in the library.
  const renderKey = createHash("sha256").update(JSON.stringify({ ...renderInputs, pov: ids.pov })).digest("hex").slice(0, 16);
  console.log(`clip ${id}: ${title} (slot ${facts.slot}, ${facts.shotTicks.length} POV shots, render key ${renderKey})`);
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ id, title, facts, renderInputs }, null, 2));
    return 0;
  }

  // One clip run at a time, from the resume check to the index write.
  const clipLock = new RenderLock(path.join(STATE_DIR, ".clip.lock"));
  clipLock.acquire();
  // Signals end the process from inside the controller (after its cleanup), skipping finally.
  const releaseClipLock = () => clipLock.release();
  process.on("exit", releaseClipLock);
  try {
    // Resume: an index entry with the same render key and a file that still
    // validates means the clip is done. A file alone proves nothing.
    const existing = readIndex().clips[id];
    if (existing && existing.renderKey === renderKey && !args.includes("--force") && existsSync(clipPath(id))) {
      const problems = validateClip(clipPath(id), existing.frames, settings.fps, `${settings.width}x${settings.height}`);
      if (!problems.length) { console.log(`already in the library: ${clipPath(id)}`); return 0; }
      console.log(`library clip no longer valid, re-making it: ${problems.join("; ")}`);
    }

    const attempt = String(Date.now());
    let workDir = path.join(STATE_DIR, "render", id, attempt);
    const fail = (reasons: string[], code: number) => {
      try { recordFailure(id, { at: new Date().toISOString(), reasons, workDir, startTick, endTick, demo }); }
      catch (e) { console.error(`could not record the failure: ${(e as Error).message}`); }
      console.error(`FAILED: ${reasons.join("; ")}\nwork dir: ${workDir}`);
      return code;
    };

    let capture = args.includes("--force") ? undefined : completedCapture(id, renderKey, `${captureSize(settings).width}x${captureSize(settings).height}`);
    if (capture) {
      workDir = capture.workDir;
      console.log(`render stage already done in ${workDir}; resuming at post`);
    } else {
      const r = await render({ title, demo, slot: facts.slot, startTick, endTick, workDir, lockFile: path.join(STATE_DIR, ".render.lock"), ids, settings, lookCfg: look, debugCommands, timeoutS });
      if (r.status !== "ok" || !r.mapping || !r.audio || !r.video) return fail(r.reasons, r.cleanupVerified ? 1 : 3);
      capture = { renderKey, mapping: r.mapping, video: r.video, audio: r.audio, workDir };
      writeJsonAtomic(path.join(workDir, "capture.json"), { renderKey, mapping: r.mapping, video: r.video, audio: r.audio });
      console.log(`render ok in ${r.wallSeconds}s`);
    }

    const m = measureMapping(capture.mapping, capture.video, capture.audio, facts.shotTicks);
    if (typeof m === "string") return fail([m], 1);
    console.log(`tick origin: frame 0 shows tick ${m.originTick.toFixed(2)} (scheduled ${m.recordStartTick}; ${m.timing.offsetFrames} frames by ${m.timing.source}; flash ${m.timing.video.offsetFrames}, audio ${(m.timing.audio.offsetMs * m.fps / 1000).toFixed(2)})`);
    ensureClipsDir();
    const tmp = clipTmpPath(id, attempt);
    const p = post(capture.video, capture.audio, m, startTick, endTick, facts.shotTicks, settings, tmp);
    if (p.status !== "ok") return fail(p.reasons, 1);

    publish(tmp, {
      id, file: `clips/${id}.mp4`, title, map: facts.map, demo, demoSha256: facts.demoSha256, round: facts.round,
      startTick, endTick, seconds: p.plan!.seconds, frames: p.plan!.frames, createdAt: new Date().toISOString(),
      renderKey, render: { ...renderInputs, node: versions.node, mapping: { ...capture.mapping, originTick: m.originTick, offsetFrames: m.timing.offsetFrames, source: m.timing.source }, trim: p.plan, landedOffsetFrames: p.landed!.offsetFrames, workDir },
    });
    console.log(`ok: ${clipPath(id)} (${p.plan!.frames} frames, ${p.plan!.seconds.toFixed(3)} s; requested ticks land ${p.landed!.offsetFrames} frames off by ${p.landed!.source})`);
    return 0;
  } finally {
    clipLock.release();
    process.off("exit", releaseClipLock);
  }
}

main().then(
  (code) => { process.exitCode = cleanupUnverified() ? 3 : code; },
  (e) => {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  },
);
