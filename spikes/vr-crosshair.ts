// VR spike, post step: pack a left and a right take side by side, optionally with a crosshair
// drawn per eye at the depth of what the player aims at. Throwaway; results go in docs/spikes.md.
//
// The takes come from spikes/vr-stereo.ts --pair --no-crosshair (parallel cameras, so the point on
// the centre view's aim line sits s pixels right of centre in the left eye and s pixels left of it
// in the right eye). s is measured per frame by matching a patch around those two positions, then
// smoothed over time; no depth stream is used.
//
// Usage: pnpm exec tsx spikes/vr-crosshair.ts <left.mp4> <right.mp4> <audio.wav> <out.mp4> [--crosshair]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const withCrosshair = args.includes("--crosshair");
const [left, right, audio, out] = args.filter((a) => !a.startsWith("--"));
if (!left || !right || !audio || !out) throw new Error("usage: vr-crosshair.ts <left.mp4> <right.mp4> <audio.wav> <out.mp4> [--crosshair]");

const W = 1920, H = 1080, FPS = 60;
const BAND_W = 640, BAND_H = 48; // a strip around the screen centre, enough for the largest shift
const PATCH = 40; // half width of the matched patch
const MAX_SHIFT = 240; // pixels per eye: about 5 units away at this field of view
const fwd = (p: string) => p.replaceAll("\\", "/");

function ff(a: string[], maxBuffer = 1 << 28): Buffer {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...a], { maxBuffer });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed: ${r.error?.message ?? r.stderr.toString().slice(0, 500)}`);
  return r.stdout;
}

/** The centre strip of every frame as 8-bit gray. */
function band(file: string): Buffer[] {
  const raw = ff(["-i", file, "-vf", `crop=${BAND_W}:${BAND_H}:${(W - BAND_W) / 2}:${(H - BAND_H) / 2},format=gray`, "-f", "rawvideo", "-"]);
  const size = BAND_W * BAND_H;
  return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}

/** Per-eye shift that best lines the two eyes' patches up; a small cost on larger shifts breaks ties in flat areas. */
function shiftOf(l: Buffer, r: Buffer): number {
  const cx = BAND_W / 2;
  let best = 0, bestCost = Infinity;
  for (let s = 0; s <= MAX_SHIFT; s++) {
    let sad = 0;
    for (let y = 0; y < BAND_H; y++) {
      const row = y * BAND_W;
      for (let x = -PATCH; x < PATCH; x++) sad += Math.abs(l[row + cx + s + x] - r[row + cx - s + x]);
    }
    const cost = sad / (BAND_H * 2 * PATCH) + s * 0.02;
    if (cost < bestCost) { bestCost = cost; best = s; }
  }
  return best;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

let filter: string;
const extra: string[] = [];
if (withCrosshair) {
  const L = band(left), R = band(right);
  const n = Math.min(L.length, R.length);
  if (n < 2) throw new Error("no frames read");
  const rawShift = Array.from({ length: n }, (_, i) => shiftOf(L[i], R[i]));
  // Median over 11 frames drops single-frame mismatches (particles differ per playback), then a short mean.
  const med = rawShift.map((_, i) => median(rawShift.slice(Math.max(0, i - 5), i + 6)));
  const shift = med.map((_, i) => { const w = med.slice(Math.max(0, i - 3), i + 4); return w.reduce((a, b) => a + b, 0) / w.length; });
  const cmdFile = path.join(path.dirname(path.resolve(out)), `${path.basename(out, ".mp4")}.cmds.txt`);
  // The crosshair tile is 32x32; overlay x is its left edge.
  writeFileSync(cmdFile, shift.map((s, i) => `${(i / FPS).toFixed(4)} overlay@l x ${(W / 2 - 16 + s).toFixed(1)}, overlay@r x ${(W / 2 - 16 - s).toFixed(1)};`).join("\n") + "\n");
  writeFileSync(path.join(path.dirname(cmdFile), `${path.basename(out, ".mp4")}.shift.json`), JSON.stringify({ raw: rawShift, smoothed: shift.map((s) => Math.round(s * 10) / 10) }));
  console.log(`shift per eye: min ${Math.min(...shift).toFixed(1)}, median ${median(shift).toFixed(1)}, max ${Math.max(...shift).toFixed(1)} px over ${n} frames`);
  // A plain stand-in crosshair: four white bars with a black edge and a gap, on a transparent tile
  // (replace=1: drawbox must write the alpha too, or the bars stay invisible).
  const bar = (x: number, y: number, w: number, h: number) => `drawbox=x=${x - 1}:y=${y - 1}:w=${w + 2}:h=${h + 2}:c=black@0.9:t=fill:replace=1,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:c=white:t=fill:replace=1`;
  const tile = `color=c=black@0.0:s=32x32:r=${FPS},format=rgba,${bar(3, 15, 9, 2)},${bar(20, 15, 9, 2)},${bar(15, 3, 2, 9)},${bar(15, 20, 2, 9)},split[xl][xr]`;
  // Windows drive colons must be escaped inside a filter argument.
  const cmdArg = fwd(cmdFile).replace(":", "\\\\:");
  filter = `${tile};[0:v]sendcmd=f=${cmdArg}[l0];[l0][xl]overlay@l=x=${W / 2 - 16}:y=${H / 2 - 16}:shortest=1[l];[1:v][xr]overlay@r=x=${W / 2 - 16}:y=${H / 2 - 16}:shortest=1[r];[l][r]hstack=inputs=2[v]`;
} else {
  filter = "[0:v][1:v]hstack=inputs=2[v]";
}
ff(["-y", "-i", left, "-i", right, "-i", audio, ...extra, "-filter_complex", filter, "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
console.log(`wrote ${out}`);
