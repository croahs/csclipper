// VR180 spike: a stereo 180° view of a first-person moment from cube faces, one launch.
// Throwaway; results go in docs/spikes.md. The launch is the guarded controller's own render(),
// unchanged, as in spikes/vr-stereo.ts: this file adds one line to the look cfg (a mirv-script) and
// asks for eleven takes of the same ticks in a square window.
//
// Each eye sits half an eye distance to the side of the player's own view, like the two lenses of
// a VR180 camera, and is recorded five times: front, right, left, up, down, the cube oriented with
// the player's view (pitch included). One more take looks 45° to the right from the left eye: the
// engine's real field of view is measured from it in post (spikes/vr180-post.ts), since what the
// script's fov value means in a square window is not known. Faces are rendered wider than 90° under
// either reading and cropped to 90° afterwards.
//
// No HUD and no viewmodel: both are drawn relative to the view, so every face would carry them.
//
// Usage: pnpm exec tsx spikes/vr180.ts <demo.dem> <startTick> <endTick> [--half <units>] [--face <px>] [--dry-run]
// Exit codes: 0 ok, 1 failed, 2 refused (nothing launched), 3 cleanup not verified.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR } from "../src/config.ts";
import { prepareJob } from "../src/queue/job.ts";
import { MARGIN_TICKS, cleanupUnverified, render } from "../src/render/controller/index.ts";
import { exitOnSignal } from "../src/render/controller/launch.ts";

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--half", "--face"];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const dryRun = args.includes("--dry-run");
const demo = path.resolve(positional[0] ?? "");
const startTick = Number(positional[1]);
const endTick = Number(positional[2]);
// Half the eye distance in game units: 6.4 cm between the eyes, 1 unit = 1.905 cm.
const half = Number(flag("--half") ?? 1.7);
if (!Number.isFinite(half) || half <= 0 || half > 10) throw new Error("--half must be between 0 and 10 units");
// The square game window; it must fit the desktop (the controller checks the size it got).
const face = Number(flag("--face") ?? 1080);
if (!Number.isInteger(face) || face < 256 || face % 2) throw new Error("--face must be an even number of pixels");
// The fov value the script returns: 91.8° real if the engine reads it as a 4:3 fov in a square
// window, 108° if it reads it as the real one. At least 90° either way.
const SCRIPT_FOV = 108;

/** The takes in order: eye (-1 left, 1 right) and the face it looks at. */
const TAKES: { eye: -1 | 1; face: "front" | "calib" | "right" | "left" | "up" | "down" }[] = [
  { eye: -1, face: "front" }, { eye: -1, face: "calib" }, { eye: -1, face: "right" }, { eye: -1, face: "left" }, { eye: -1, face: "up" }, { eye: -1, face: "down" },
  { eye: 1, face: "front" }, { eye: 1, face: "right" }, { eye: 1, face: "left" }, { eye: 1, face: "up" }, { eye: 1, face: "down" },
];

const fwd = (p: string) => p.replaceAll("\\", "/");
const outDir = path.join(ROOT, "spikes", "out", `vr180-${Date.now()}`);
const workDir = path.join(outDir, "job"); // render() wants a work dir that does not exist yet
const scriptPath = path.join(outDir, "vr180.js");
if (/["\s;]/.test(scriptPath)) throw new Error(`path cannot go in a cfg line: ${scriptPath}`);

/** The mirv-script (HLAE's JS engine): per take, the game's own view shifted to one eye and turned to one cube face. */
function vr180Script(recordStartTick: number): string {
  return `"use strict";
{
    const id = 'croclip_vr180';
    const HALF = ${half};
    const REC = ${recordStartTick};
    const FOV = ${SCRIPT_FOV};
    const TAKES = ${JSON.stringify(TAKES)};
    const D = Math.PI / 180.0;
    let take = 0;
    let armed = false; // true once this take has reached its record start
    let logged = false;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const neg = (a) => [-a[0], -a[1], -a[2]];
    mirv.events.cViewRenderSetupView.on(id, (e) => {
        const tick = mirv.getDemoTick();
        if (typeof tick === 'number' && tick > 0) {
            if (!armed && tick >= REC + 8) armed = true;
            // A seek back to before the record start: the next take has begun.
            if (armed && tick < REC - 16) {
                armed = false;
                take++;
                mirv.message('croclip_vr180: take ' + take + ' at tick ' + tick + '\\n');
            }
        }
        const v = e.currentView;
        if (!logged) {
            logged = true;
            mirv.message('croclip_vr180: game fov ' + v.fov + ', view ' + e.width + 'x' + e.height + '\\n');
        }
        if (take >= TAKES.length) return;
        const t = TAKES[take];
        // The player's own basis, roll 0 (Source's AngleVectors).
        const sp = Math.sin(v.rX * D), cp = Math.cos(v.rX * D), sy = Math.sin(v.rY * D), cy = Math.cos(v.rY * D);
        const F = [cp * cy, cp * sy, -sp];
        const R = [sy, -cy, 0];
        const U = [sp * cy, sp * sy, cp];
        const S = Math.SQRT1_2;
        // Where this face looks, and which way is up in its picture.
        const f = t.face === 'front' ? F : t.face === 'right' ? R : t.face === 'left' ? neg(R) : t.face === 'up' ? U : t.face === 'down' ? neg(U)
            : [(F[0] + R[0]) * S, (F[1] + R[1]) * S, (F[2] + R[2]) * S];
        const u = t.face === 'up' ? neg(F) : t.face === 'down' ? F : U;
        // Back to Source angles: pitch and yaw from the forward vector, roll from where up lands.
        const pitch = -Math.asin(Math.max(-1, Math.min(1, f[2])));
        const yaw = Math.atan2(f[1], f[0]);
        const sp2 = Math.sin(pitch), cp2 = Math.cos(pitch), sy2 = Math.sin(yaw), cy2 = Math.cos(yaw);
        const roll = Math.atan2(dot(u, [sy2, -cy2, 0]), dot(u, [sp2 * cy2, sp2 * sy2, cp2]));
        return {
            x: v.x + t.eye * HALF * R[0],
            y: v.y + t.eye * HALF * R[1],
            z: v.z,
            rX: pitch / D,
            rY: yaw / D,
            rZ: roll / D,
            fov: FOV
        };
    });
    mirv.message('croclip_vr180: loaded, ' + TAKES.length + ' takes, half eye distance ' + HALF + ' units, fov ' + FOV + '\\n');
}
`;
}

{
  const off = exitOnSignal("vr180");
  try {
    const p = await prepareJob({ demo, startTick, endTick });
    const script = vr180Script(p.startTick - MARGIN_TICKS);
    const lookExtra = ["// VR180 spike (spikes/vr180.ts)", `mirv_script_load "${fwd(scriptPath)}"`, ""].join("\n");
    const take = { startTick: p.startTick, endTick: p.endTick, slot: p.facts.slot };
    // Scheduled once, after the first take's spec_player; the convars hold for the later takes.
    const debugCommands = ["cl_drawhud 0", "r_drawviewmodel 0"];
    const settings = { ...p.settings, width: face, height: face, aspect: "native" as const, hud: "bare" as const };
    console.log(`vr180: ${p.title} (slot ${p.facts.slot}), ${TAKES.length} takes of ticks ${p.startTick}-${p.endTick}, ${face}x${face}, half eye distance ${half} units`);
    console.log(`out: ${outDir}`);
    if (dryRun) {
      console.log(lookExtra);
      console.log(script);
      process.exit(0);
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(scriptPath, script);
    writeFileSync(path.join(outDir, "takes.json"), JSON.stringify({ takes: TAKES, face, half, scriptFov: SCRIPT_FOV, startTick: p.startTick, endTick: p.endTick }, null, 2));
    const r = await render({
      title: "vr180 spike", demo: p.demo, takes: TAKES.map(() => take), workDir,
      lockFile: path.join(STATE_DIR, ".render.lock"), ids: p.ids, settings,
      lookCfg: p.look + lookExtra, crosshair: p.crosshair, debugCommands,
    });
    console.log(JSON.stringify({ status: r.status, reasons: r.reasons, cleanupVerified: r.cleanupVerified, wallSeconds: r.wallSeconds, takes: r.takes.map((t, i) => ({ ...TAKES[i], video: t.video, frames: t.mapping?.frames, reasons: t.reasons })) }, null, 2));
    process.exitCode = !r.cleanupVerified || cleanupUnverified() ? 3 : r.status === "ok" && r.takes.every((t) => !t.reasons.length) ? 0 : 1;
  } catch (e) {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  } finally {
    off.off();
  }
}
