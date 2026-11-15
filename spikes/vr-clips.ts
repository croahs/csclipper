// VR copies of library highlights: stereo 3D for a flat screen in a headset, no crosshair.
// A production run built on the VR spike (docs/spikes.md), not a pipeline feature: the library
// clip is never touched, the copy lands in library/vr/<no>-<slug>_sbs.mp4 (left eye | right eye).
//
// Per demo one launch through the guarded controller's render(), unchanged: every clip of that
// demo is recorded twice over its own span, left eye then right eye, with a short take over the
// round's start in between that resets the HUD (a mirv-script shifts the
// game's view half an eye distance sideways). The two captures are put side by side and go
// through the library's own cut graph (postGraph) with the clip's own action windows, so the copy has the
// same cut, fast-forward, fades and sound as the clip.
//
// Usage: pnpm exec tsx spikes/vr-clips.ts <no>... [--half <units>] [--dry-run] [--repost <run dir>]
// Exit codes: 0 ok, 1 a clip failed, 2 refused (nothing launched), 3 cleanup not verified.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, ROOT, Refusal, STATE_DIR } from "../src/config.ts";
import { readIndex, type ClipEntry } from "../src/library/index.ts";
import { writeLibraryPage } from "../src/library/page.ts";
import { loadAudio } from "../src/post/audio.ts";
import { postGraph, segments, validateClip } from "../src/post/index.ts";
import { parseDemo } from "../src/parse/demo.ts";
import { prepareJob } from "../src/queue/job.ts";
import { MARGIN_TICKS, SETTLE_TICKS, cleanupUnverified, passesMatchEnd, render } from "../src/render/controller/index.ts";
import { exitOnSignal } from "../src/render/controller/launch.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = args.includes("--dry-run");
const nos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--half" && args[i - 1] !== "--repost").map(Number);
// --repost <run dir>: no launch; the clips are made from that run's captures (its job/render.json).
const repost = flag("--repost");
if (!nos.length || nos.some((n) => !Number.isInteger(n))) throw new Error("usage: vr-clips.ts <clip no>... [--half <units>] [--dry-run]");
// Half the eye distance in game units: 6.4 cm between the eyes, 1 unit = 1.905 cm.
const half = Number(flag("--half") ?? 1.7);
if (!Number.isFinite(half) || half <= 0 || half > 10) throw new Error("--half must be between 0 and 10 units");

const VR_DIR = path.join(LIBRARY_DIR, "vr");
const VR_CRF = 18;
// Scheduled once, after the first take's spec_player; the convars hold for the later takes.
const CROSSHAIR_OFF = ["cl_show_observer_crosshair 0", "crosshair 0", "cl_crosshairusealpha 1", "cl_crosshairalpha 0"];
const fwd = (p: string) => p.replaceAll("\\", "/");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const outPath = (e: ClipEntry) => path.join(VR_DIR, `${e.no}-${slug(e.title)}_sbs.mp4`);

/** The mirv-script: per take the game's own view shifted to one eye. Takes are followed by the demo tick. */
function eyeScript(takes: { rec: number; end: number; eye: -1 | 1 }[]): string {
  return `"use strict";
{
    const id = 'croclip_vr_clips';
    const HALF = ${half};
    // rec/end: the take's record start and end ticks; eye: -1 left, 1 right.
    const TAKES = ${JSON.stringify(takes)};
    let take = 0;
    // pre: waiting for the seek to land before the record start; seeked: before the record start;
    // rec: past it. A take is over once playback has passed its record end.
    let phase = 'pre';
    mirv.events.cViewRenderSetupView.on(id, (e) => {
        if (take >= TAKES.length) return;
        const tick = mirv.getDemoTick();
        if (typeof tick === 'number' && tick > 0) {
            const t = TAKES[take];
            if (phase === 'pre' && tick < t.rec - 16) phase = 'seeked';
            else if (phase === 'seeked' && tick >= t.rec + 8) phase = 'rec';
            else if (phase === 'rec' && tick > t.end + 4) {
                take++;
                phase = 'pre';
                mirv.message('croclip_vr: take ' + take + ' at tick ' + tick + '\\n');
                if (take >= TAKES.length) return;
            }
        }
        const s = TAKES[take].eye;
        const yaw = (e.currentView.rY * Math.PI) / 180.0;
        // Source's right vector for roll 0: (sin yaw, -cos yaw, 0).
        return {
            x: e.currentView.x + s * HALF * Math.sin(yaw),
            y: e.currentView.y - s * HALF * Math.cos(yaw)
        };
    });
    mirv.message('croclip_vr: loaded, ' + TAKES.length + ' takes, half eye distance ' + HALF + ' units\\n');
}
`;
}

function ffmpeg(a: string[]): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed: ${r.error?.message ?? r.stderr.slice(-500)}`);
}

const index = readIndex().clips;
const entries = nos.map((no) => {
  const e = Object.values(index).find((x) => x.no === no);
  if (!e) throw new Error(`no clip ${no} in the library`);
  if (!e.moment || e.player || (e.kind !== undefined && e.kind !== "highlight")) throw new Error(`clip ${no} is not one of the main account's highlights`);
  return e;
});
const made: string[] = [];
const failed: string[] = [];
const todo = entries.filter((e) => {
  if (existsSync(outPath(e))) { console.log(`clip ${e.no}: ${outPath(e)} exists, skipped`); return false; }
  if (!existsSync(e.demo)) { console.log(`clip ${e.no}: its demo is no longer on disk`); failed.push(`clip ${e.no}: its demo is no longer on disk`); return false; }
  return true;
});
const byDemo = new Map<string, ClipEntry[]>();
for (const e of todo) byDemo.set(e.demo, [...(byDemo.get(e.demo) ?? []), e]);

const off = exitOnSignal("vr-clips");
let stop: number | undefined; // an exit code that ends the run: 2 refused, 3 cleanup not verified
try {
  for (const [demo, clips] of byDemo) {
    if (stop !== undefined) break;
    clips.sort((a, b) => a.startTick - b.startTick);
    const preps: { e: ClipEntry; p: Awaited<ReturnType<typeof prepareJob>> }[] = [];
    for (const e of clips) {
      const p = await prepareJob({ demo, startTick: e.startTick, endTick: e.endTick });
      // Past the match end no later take of the launch records the game (docs/spikes.md): such a
      // clip cannot have its second eye in the same launch.
      if (passesMatchEnd({ endTick: e.endTick }, p.matchEnd)) { console.log(`clip ${e.no}: runs past the match end, skipped`); failed.push(`clip ${e.no}: runs past the match end`); continue; }
      preps.push({ e, p });
    }
    if (!preps.length) continue;
    const first = preps[0].p;
    const stamp = Date.now();
    if (repost && byDemo.size !== 1) throw new Error("--repost takes the clips of one demo");
    const runDir = repost ? path.resolve(repost) : path.join(ROOT, "spikes", "out", `vr-clips-${stamp}`);
    const workDir = path.join(runDir, "job"); // render() wants a work dir that does not exist yet
    const scriptPath = path.join(runDir, "eyes.js");
    if (/["\s;]/.test(scriptPath)) throw new Error(`path cannot go in a cfg line: ${scriptPath}`);
    // Per clip: left eye, a reset take, right eye. The seek back for the second eye leaves the HUD
    // as it was at the clip's end (the round-won panel up, the clock blank: clip 169, 2026-11-15),
    // so a short take first plays over the round's start, which puts the HUD back.
    const rounds = (await parseDemo(demo, first.ids.pov)).rounds;
    type Take = { role: "L" | "R" | "reset"; clip: number; eye: -1 | 1; startTick: number; endTick: number; slot: number };
    const takes: Take[] = preps.flatMap(({ e, p }) => {
      const round = rounds.filter((x) => x.startTick <= e.startTick).at(-1);
      const eyeTake = (role: "L" | "R"): Take => ({ role, clip: e.no!, eye: role === "L" ? -1 : 1, startTick: e.startTick, endTick: e.endTick, slot: p.facts.slot });
      if (!round) throw new Error(`clip ${e.no}: its round was not found in the parse`);
      // The reset take needs room for the controller's seek before it (margin + settle ticks). The
      // first round starts too early for that: its reset take sits in the freeze time instead, which
      // is not known to reset the HUD (the output is checked by eye).
      const resetStart = Math.max(round.startTick - 32, 200 + MARGIN_TICKS + SETTLE_TICKS);
      if (resetStart > round.startTick) console.log(`clip ${e.no}: round starts at tick ${round.startTick}, the reset take cannot play over it`);
      const reset: Take = { role: "reset", clip: e.no!, eye: -1, startTick: resetStart, endTick: resetStart + 64, slot: p.facts.slot };
      return [eyeTake("L"), reset, eyeTake("R")];
    });
    const script = eyeScript(takes.map((t) => ({ rec: t.startTick - MARGIN_TICKS, end: t.endTick + MARGIN_TICKS, eye: t.eye })));
    const seconds = takes.reduce((n, t) => n + (t.endTick - t.startTick) / 64, 0);
    console.log(`${path.basename(demo).slice(0, 8)}: clips ${preps.map((x) => x.e.no).join(", ")}: ${takes.length} takes, ${seconds.toFixed(0)} s to record`);
    if (dryRun) continue;
    let r: Awaited<ReturnType<typeof render>>;
    if (repost) {
      r = JSON.parse(readFileSync(path.join(runDir, "job", "render.json"), "utf8"));
      if (r.takes.length !== takes.length) throw new Error(`${runDir} holds ${r.takes.length} takes, these clips need ${takes.length}`);
    } else try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(scriptPath, script);
      r = await render({
        title: `vr clips ${preps.map((x) => x.e.no).join(",")}`, demo, takes: takes.map(({ startTick, endTick, slot }) => ({ startTick, endTick, slot })), workDir,
        lockFile: path.join(STATE_DIR, ".render.lock"), ids: first.ids, settings: first.settings,
        lookCfg: first.look + ["// VR clips (spikes/vr-clips.ts)", `mirv_script_load "${fwd(scriptPath)}"`, ""].join("\n"),
        crosshair: first.crosshair, debugCommands: CROSSHAIR_OFF,
      });
    } catch (e) {
      console.error(String((e as Error).message));
      stop = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
      if (stop === 1) { failed.push(`clips ${preps.map((x) => x.e.no).join(", ")}: ${(e as Error).message}`); stop = undefined; }
      continue;
    }
    if (!r.cleanupVerified || cleanupUnverified()) { stop = 3; break; }
    if (r.reasons.length) console.log(`launch: ${r.reasons.join("; ")}`);
    for (const [k, { e, p }] of preps.entries()) {
      const at = (role: Take["role"]) => r.takes[takes.findIndex((t) => t.clip === e.no && t.role === role)];
      const [L, R, reset] = [at("L"), at("R"), at("reset")];
      try {
        // A reset take that did not run leaves the right eye with a stale HUD, which no file check sees.
        const bad = [...(L?.reasons ?? ["no left take"]), ...(R?.reasons ?? ["no right take"]), ...(reset?.reasons ?? ["no reset take"]).map((x) => `reset take: ${x}`)];
        if (bad.length || !L.mapping || !R.mapping || !L.audio) throw new Error(`capture: ${bad.join("; ") || "no mapping"}`);
        // A frame or two more at one eye's end is the capture's own slack (the controller allows 3); both
        // start on the same scheduled tick, so the shorter one sets the length.
        if (Math.abs(L.mapping.frames - R.mapping.frames) > 3) throw new Error(`the eyes differ in length: ${L.mapping.frames} and ${R.mapping.frames} frames`);
        const mapping = { ...L.mapping, frames: Math.min(L.mapping.frames, R.mapping.frames) };
        // Side by side as one raw video, so post() cuts both eyes with the same frames.
        const sbs = path.join(runDir, `sbs-${e.no}.mp4`);
        ffmpeg(["-y", "-i", L.video, "-i", R.video, "-filter_complex", "[0:v][1:v]hstack=inputs=2:shortest=1[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(p.settings.captureCrf), "-pix_fmt", "yuv420p", sbs]);
        // The clip's own cut: its normal-speed segments are the action windows it was posted with.
        const segs = (e.render as { segments?: { startTick: number; endTick: number; speed: number }[] } | undefined)?.segments;
        const windows = segs?.filter((s) => s.speed === 1).map((s) => ({ startTick: s.startTick, endTick: s.endTick }));
        mkdirSync(VR_DIR, { recursive: true });
        const tmp = path.join(VR_DIR, `${e.no}.${stamp}.tmp.mp4`);
        // The library's own cut (segments, postGraph, the post sound), but always H.264: post() encodes
        // with config.json's encoder, and HEVC playback in SteamVR Media Player is not established.
        const settings = { ...p.settings, aspect: "native" as const, width: p.settings.width * 2 };
        const segs2 = segments(mapping, e.startTick, e.endTick, windows?.length ? windows : undefined);
        const d = segs2.reduce((n, x) => n + x.outSeconds, 0);
        try {
          ffmpeg(["-y", "-i", sbs, "-i", L.audio, "-filter_complex", postGraph(segs2, mapping.fps, settings, d, loadAudio("post").filter), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "slow", "-crf", String(VR_CRF), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", tmp]);
          const problems = validateClip(tmp, d, `${settings.width}x${settings.height}`);
          if (problems.length) throw new Error(`post: ${problems.join("; ")}`);
        } catch (err) {
          rmSync(tmp, { force: true });
          throw err;
        }
        renameSync(tmp, outPath(e));
        // The raw captures are only needed until the copy exists.
        for (const f of [sbs, L.video, R.video, reset.video]) rmSync(f, { force: true });
        made.push(`clip ${e.no}: ${outPath(e)}`);
        console.log(`clip ${e.no}: wrote ${outPath(e)}`);
      } catch (err) {
        failed.push(`clip ${e.no}: ${(err as Error).message}`);
        console.error(`clip ${e.no} failed: ${(err as Error).message}`);
      }
    }
  }
} finally {
  off.off();
}
console.log(`\nmade ${made.length}:\n${made.join("\n")}`);
if (failed.length) console.log(`\nfailed ${failed.length}:\n${failed.join("\n")}`);
// New copies show on the library page, which lists library/vr/ when it is written (src/share/vr.ts).
if (made.length) {
  try { console.log(`\nlibrary page rewritten: ${writeLibraryPage()}`); } catch (e) { console.error(`\nlibrary page not rewritten: ${(e as Error).message}`); }
}
if (stop !== undefined) console.log(stop === 3 ? "\nSTOPPED: a launch's cleanup was not verified. Check for cs2.exe by hand; state/.render.lock stays." : "\nSTOPPED: a launch was refused; nothing more was started.");
process.exitCode = stop ?? (failed.length ? 1 : 0);
