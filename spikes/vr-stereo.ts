// VR spike: can one launch record a left and a right eye of the same first-person moment?
// Throwaway; results go in docs/spikes.md. The launch is the guarded controller's own render(),
// unchanged: this file only adds lines to the look cfg (a mirv-script and two FFmpeg settings)
// and asks for four takes of the same ticks (two with --pair).
//
//   take 0  left eye   (the view shifted half an eye distance to the left, every frame)
//   take 1  right eye
//   take 2  left eye again: against take 0 it measures whether two playbacks give the same frames
//   take 3  centre, plus two extra streams (eyeL, eyeR) whose beforeCommands flip the eye inside
//           one engine frame: both eyes from one playback, if the view hook runs per stream pass
//
// --pair: only takes 0 and 1 (left, right), no extra streams. --no-crosshair: the game draws no crosshair
// (one is added in post at the depth of what is aimed at: spikes/vr-crosshair.ts).
//
// Usage: pnpm exec tsx spikes/vr-stereo.ts <demo.dem> <startTick> <endTick> [--half <units>] [--pair] [--no-crosshair] [--dry-run]
// Exit codes: 0 ok, 1 failed, 2 refused (nothing launched), 3 cleanup not verified.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR } from "../src/config.ts";
import { prepareJob } from "../src/queue/job.ts";
import { MARGIN_TICKS, cleanupUnverified, render } from "../src/render/controller/index.ts";
import { exitOnSignal } from "../src/render/controller/launch.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--half");
const dryRun = args.includes("--dry-run");
const pair = args.includes("--pair");
const noCrosshair = args.includes("--no-crosshair");
// Scheduled once, after the first take's spec_player; the convars hold for the later takes.
const CROSSHAIR_OFF = ["cl_show_observer_crosshair 0", "crosshair 0", "cl_crosshairusealpha 1", "cl_crosshairalpha 0"];
const demo = path.resolve(positional[0] ?? "");
const startTick = Number(positional[1]);
const endTick = Number(positional[2]);
// Half the eye distance in game units: 6.4 cm between the eyes, 1 unit = 1.905 cm.
const half = Number(flag("--half") ?? 1.7);
if (!Number.isFinite(half) || half <= 0 || half > 10) throw new Error("--half must be between 0 and 10 units");

const fwd = (p: string) => p.replaceAll("\\", "/");
const outDir = path.join(ROOT, "spikes", "out", `vr-stereo-${Date.now()}`);
const workDir = path.join(outDir, "job"); // render() wants a work dir that does not exist yet
const scriptPath = path.join(outDir, "stereo.js");
const eyeVideo = (eye: "L" | "R") => path.join(workDir, "hlae", `eye${eye}.mp4`);
for (const p of [scriptPath, eyeVideo("L"), eyeVideo("R")]) if (/["\s;]/.test(p)) throw new Error(`path cannot go in a cfg line: ${p}`);

/** The mirv-script (HLAE's JS engine): shifts the game's own view sideways along its right vector. */
function stereoScript(recordStartTick: number): string {
  return `"use strict";
{
    const id = 'croclip_vr_stereo';
    const HALF = ${half};
    const REC = ${recordStartTick};
    // The eye of takes 0..2 (-1 left, 1 right); take 3 follows croclip_eye, set by the streams.
    const TAKE_EYE = ${JSON.stringify(pair ? [-1, 1] : [-1, 1, -1])};
    const STREAMS_TAKE = ${pair ? -1 : 3};
    let eye = 0;
    let take = 0;
    let armed = false; // true once this take has reached its record start
    let needStreams = false;
    if (globalThis[id] !== undefined) {
        globalThis[id].unregister();
        delete globalThis[id];
    }
    const command = new AdvancedfxConCommand((args) => {
        if (2 <= args.argC()) {
            const a = args.argV(1).toUpperCase();
            eye = a === 'L' ? -1 : a === 'R' ? 1 : 0;
        }
    });
    globalThis[id] = command;
    command.register('croclip_eye', 'croclipper VR spike: L, R or C');
    mirv.events.cViewRenderSetupView.on(id, (e) => {
        const tick = mirv.getDemoTick();
        if (typeof tick === 'number' && tick > 0) {
            if (!armed && tick >= REC + 8) armed = true;
            // A seek back to before the record start: the next take has begun.
            if (armed && tick < REC - 16) {
                armed = false;
                take++;
                if (take === STREAMS_TAKE) needStreams = true;
                mirv.message('croclip_vr: take ' + take + ' at tick ' + tick + '\\n');
            }
        }
        const s = take < TAKE_EYE.length ? TAKE_EYE[take] : take === STREAMS_TAKE ? eye : 0;
        if (s === 0) return;
        const yaw = (e.currentView.rY * Math.PI) / 180.0;
        // Source's right vector for roll 0: (sin yaw, -cos yaw, 0).
        return {
            x: e.currentView.x + s * HALF * Math.sin(yaw),
            y: e.currentView.y - s * HALF * Math.cos(yaw)
        };
    });
    mirv.events.clientFrameStageNotify.on(id, (e) => {
        if (!needStreams) return;
        needStreams = false;
        for (const n of ['L', 'R']) {
            mirv.exec('mirv_streams add normal eye' + n);
            mirv.exec('mirv_streams edit eye' + n + ' settings vr' + n);
            mirv.exec('mirv_streams edit eye' + n + ' beforeCommands add croclip_eye ' + n);
            mirv.exec('mirv_streams edit eye' + n + ' afterCommands add croclip_eye C');
        }
        mirv.message('croclip_vr: streams eyeL and eyeR added\\n');
    });
    mirv.message('croclip_vr: loaded, half eye distance ' + HALF + ' units\\n');
}
`;
}

const off = exitOnSignal("vr-stereo");
try {
  const p = await prepareJob({ demo, startTick, endTick });
  const recordStartTick = p.startTick - MARGIN_TICKS;
  const script = stereoScript(recordStartTick);
  const lookExtra = [
    "// VR spike (spikes/vr-stereo.ts)",
    `mirv_script_load "${fwd(scriptPath)}"`,
    ...(["L", "R"] as const).map((e) => `mirv_streams settings add ffmpeg vr${e} "-c:v libx264 -preset veryfast -crf ${p.settings.captureCrf} -pix_fmt yuv420p {QUOTE}${fwd(eyeVideo(e))}{QUOTE}"`),
    "",
  ].join("\n");
  const take = { startTick: p.startTick, endTick: p.endTick, slot: p.facts.slot };
  console.log(`vr-stereo: ${p.title} (slot ${p.facts.slot}), ${pair ? 2 : 4} takes of ticks ${p.startTick}-${p.endTick}, half eye distance ${half} units`);
  console.log(`out: ${outDir}`);
  if (dryRun) {
    console.log(lookExtra);
    console.log(script);
    process.exit(0);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(scriptPath, script);
  const r = await render({
    title: "vr-stereo spike", demo: p.demo, takes: pair ? [take, take] : [take, take, take, take], workDir,
    lockFile: path.join(STATE_DIR, ".render.lock"), ids: p.ids, settings: p.settings,
    lookCfg: p.look + lookExtra, crosshair: p.crosshair, debugCommands: noCrosshair ? CROSSHAIR_OFF : [],
  });
  console.log(JSON.stringify({ status: r.status, reasons: r.reasons, cleanupVerified: r.cleanupVerified, wallSeconds: r.wallSeconds, takes: r.takes.map((t) => ({ video: t.video, audio: t.audio, frames: t.mapping?.frames, reasons: t.reasons })), eyeL: eyeVideo("L"), eyeR: eyeVideo("R") }, null, 2));
  process.exitCode = !r.cleanupVerified || cleanupUnverified() ? 3 : r.status === "ok" ? 0 : 1;
} catch (e) {
  console.error(String((e as Error).message));
  process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
} finally {
  off.off();
}
