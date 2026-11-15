// VR180 spike, post step: stitch the takes of spikes/vr180.ts into a side-by-side stereo 180° video.
// Throwaway; results go in docs/spikes.md.
//
// Each face is cropped to its centre 90°, the five faces of an eye are laid out as a 3x2 cubemap
// (v360's order: right, left, up / down, front, back; back is black) and turned into a
// half-equirectangular picture; the two eyes are put side by side.
//
// Usage: pnpm exec tsx spikes/vr180-post.ts <run dir> [--fov <deg>] [--frot <6 digits>] [--eye-px <n>] [--out <file>]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--fov", "--frot", "--eye-px", "--out"];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const runDir = path.resolve(args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]))[0] ?? "");
const meta = JSON.parse(readFileSync(path.join(runDir, "takes.json"), "utf8")) as { takes: { eye: -1 | 1; face: string }[]; face: number; scriptFov: number };
const video = (eye: -1 | 1, face: string) => {
  const i = meta.takes.findIndex((t) => t.eye === eye && t.face === face);
  if (i < 0) throw new Error(`no take for eye ${eye} face ${face}`);
  return path.join(runDir, "job", "hlae", `video${i}.mp4`);
};
// v360's per-face rotation for the cubemap input, in its face order (right, left, up, down, front, back).
const frot = flag("--frot") ?? "000000";
if (!/^[0-3]{6}$/.test(frot)) throw new Error("--frot is six digits 0-3 (quarter turns per face)");
const eyePx = Number(flag("--eye-px") ?? 2048); // 4096 wide side by side: the H.264 hardware decode limit
const out = path.resolve(flag("--out") ?? path.join(runDir, "cs-vr180_180x180_3dh.mp4"));

function ff(a: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed: ${r.error?.message ?? r.stderr.slice(-800)}`);
  return r.stderr;
}

// In a square window the engine reads the script's fov value as a 4:3 fov: the real one is
// 2 atan(tan(fov / 2) * 3 / 4), 91.8° for 108. Confirmed by eye on the seams (92° joins, 100° and more
// do not); the calibration take was meant to measure it, but a v360/PSNR scan over it peaked at 114°,
// which does not join, so it is not used.
const fov = flag("--fov") === undefined ? (2 * Math.atan(Math.tan((meta.scriptFov * Math.PI) / 360) * 0.75) * 180) / Math.PI : Number(flag("--fov"));
if (!(fov >= 90 && fov < 170)) throw new Error(`face fov ${fov}° is under 90°: the faces do not cover the cube`);

// The centre 90° of a face, then one common face size.
const crop = Math.floor((meta.face * Math.tan(Math.PI / 4)) / Math.tan((fov * Math.PI) / 360) / 2) * 2;
const N = Math.min(1024, Math.floor(crop / 2) * 2);
const FACES = ["right", "left", "up", "down", "front"] as const;
const inputs: string[] = [];
const parts: string[] = [];
for (const [e, eye] of ([-1, 1] as const).entries()) {
  for (const [k, face] of FACES.entries()) {
    inputs.push("-i", video(eye, face));
    parts.push(`[${e * FACES.length + k}:v]crop=${crop}:${crop},scale=${N}:${N}:flags=lanczos[e${e}f${k}]`);
  }
  // Back face: black, as long as the other inputs.
  parts.push(`[e${e}f4]split[e${e}f4a][e${e}f4b]`, `[e${e}f4b]drawbox=c=black:t=fill[e${e}back]`);
  parts.push(`[e${e}f0][e${e}f1][e${e}f2]hstack=inputs=3[e${e}top]`, `[e${e}f3][e${e}f4a][e${e}back]hstack=inputs=3[e${e}bot]`);
  parts.push(`[e${e}top][e${e}bot]vstack,v360=input=c3x2:in_frot=${frot}:output=hequirect:w=${eyePx}:h=${eyePx}:interp=lanczos[eye${e}]`);
}
parts.push("[eye0][eye1]hstack=inputs=2[v]");
const audio = path.join(runDir, "job", "hlae", "take0000", "audio.wav");
ff(["-v", "error", "-y", ...inputs, "-i", audio, "-filter_complex", parts.join(";"), "-map", "[v]", "-map", `${2 * FACES.length}:a`, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
console.log(`face fov ${fov.toFixed(2)}°, crop ${crop} of ${meta.face} px, cube face ${N} px, ${eyePx}x${eyePx} per eye`);
console.log(`wrote ${out}`);
