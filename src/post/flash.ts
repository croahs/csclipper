// Per-job tick origin from the video itself: the POV player's muzzle flash.
// Each POV shot brightens the lower-right quarter of the frame (the
// viewmodel). Candidate frame offsets inside the origin bound (sync.ts) are
// scored by the summed brightness rise at every anchor shot; anchors have no
// other POV shot near enough to be confused with them (anchorShots). The best
// adjacent pair of offsets locates the flashes (a flash builds over two
// frames); a strong offset two or more frames from its top is a rival and
// makes the result ambiguous. Each shot's flash is then the first frame
// rising at least MIN_RISE; a flash appears on the first frame at or after
// its shot, so a shot at fractional frame f flashing on frame F is off by
// F − f − 0.5 (±0.5). The result is the median over shots.
import { execFileSync } from "node:child_process";
import { ORIGIN_MAX_FRAMES, ORIGIN_MIN_FRAMES, anchorShots } from "./sync.ts";

const W = 48;
const H = 27;
const MIN_RISE = 2; // mean-luma rise (0-255) that counts as a flash at one shot

export type FlashMeasure = { offsetFrames: number; perShot: number[]; scores: Record<number, number>; shots: number; reason?: string };

/** `originTick` is the tick frame 0 should show; anchors keep their whole window `edgeS` clear of either end (fades). */
export function measureFlash(file: string, originTick: number, shotTicks: number[], tickrate: number, fps: number, edgeS = 0): FlashMeasure {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", `crop=iw/2:ih/2:iw/2:ih/2,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const n = raw.length / (W * H);
  const lum: number[] = [];
  for (let f = 0; f < n; f++) {
    let c = 0;
    for (let i = 0; i < W * H; i++) c += raw[f * W * H + i];
    lum.push(c / (W * H));
  }
  const rise = (f: number) => (f > 0 && f < n ? Math.max(0, lum[f] - lum[f - 1]) : 0);
  const shotS = [...shotTicks].sort((a, b) => a - b).map((t) => (t - originTick) / tickrate);
  const shots = anchorShots(shotS, fps, n / fps, edgeS).map((t) => t * fps);
  const lo = Math.floor(ORIGIN_MIN_FRAMES);
  const hi = Math.ceil(ORIGIN_MAX_FRAMES);
  const scores: Record<number, number> = {};
  for (let d = lo; d <= hi; d++) scores[d] = Math.round(shots.reduce((a, f) => a + rise(Math.ceil(f) + d), 0) * 10) / 10;
  const ds = Object.keys(scores).map(Number).sort((a, b) => a - b);
  const pairs = ds.filter((d) => d + 1 <= hi).map((d) => ({ d, s: scores[d] + scores[d + 1] })).sort((a, b) => b.s - a.s);
  const best = pairs[0];
  const top = best ? (scores[best.d] >= scores[best.d + 1] ? best.d : best.d + 1) : 0;
  const rival = best ? ds.find((d) => Math.abs(d - top) >= 2 && d !== best.d && d !== best.d + 1 && scores[d] * 1.5 > scores[top]) : undefined;
  const perShot: number[] = [];
  if (best) for (const f of shots) {
    for (let F = Math.ceil(f) + best.d - 1; F <= Math.ceil(f) + best.d + 2; F++) {
      if (rise(F) >= MIN_RISE) { perShot.push(Math.round((F - f - 0.5) * 100) / 100); break; }
    }
  }
  const sorted = [...perShot].sort((a, b) => a - b);
  const med = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : NaN;
  const reason = shots.length < 2 ? `only ${shots.length} usable POV shot(s) in the video`
    : !best || perShot.length < 2 ? `muzzle flash seen at fewer than two shots (${perShot.length})`
    : rival !== undefined ? `ambiguous: frame offsets ${top} and ${rival} similarly supported`
    : undefined;
  return { offsetFrames: reason ? NaN : Math.round(med * 100) / 100, perShot, scores, shots: shots.length, ...(reason ? { reason } : {}) };
}
