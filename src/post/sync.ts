// Per-job tick origin, measured: where the POV player's isolated gunshots
// (parser weapon_fire ticks) land in a capture's audio. M0.2 showed the
// record start varies by 0-3 frames per launch, and audio follows video
// within 10 ms, so the offset the POV's gunshots agree on is the capture's origin error.
import { execFileSync } from "node:child_process";

const RATE = 8000;
const WIN = 8; // 1 ms RMS windows
const ISOLATION_S = 0.3; // in a spray the later shots have no clean onset of their own
const MATCH_S = 0.15; // an onset further than this from a shot is someone else's sound

export type OriginMeasure = {
  offsetsMs: number[]; // each supporting shot's onset − expected time
  offsetMs: number; // mean of offsetsMs; NaN when there is no clear consensus
  shots: number; // isolated POV shots considered
  reason?: string; // why there is no consensus
};

function onsets(file: string, stream: string): number[] {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", stream, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const rms: number[] = [];
  for (let i = 0; i + WIN <= pcm.length / 2; i += WIN) {
    let s = 0;
    for (let j = 0; j < WIN; j++) { const v = pcm.readInt16LE((i + j) * 2); s += v * v; }
    rms.push(Math.sqrt(s / WIN));
  }
  // Onset = a loud window well above the 10-20 ms before it, 50 ms after the last onset.
  const out: number[] = [];
  let last = -1e9;
  for (let i = 20; i < rms.length; i++) {
    let base = 0;
    for (let k = 10; k <= 20; k++) base = Math.max(base, rms[i - k]);
    if (rms[i] > 800 && rms[i] > 2.5 * base && i - last > 50) { out.push((i * WIN) / RATE); last = i; }
  }
  return out;
}

/**
 * The capture's timing error, from the POV's isolated shots inside the file.
 * Every candidate offset in ±MATCH_S is scored by how many shots have an onset
 * at shot + offset; the POV's shots agree on one offset, while other players'
 * sounds land at unrelated offsets. Two equally supported offsets more than a
 * frame apart are ambiguous and give no result rather than a guess (e.g. an
 * enemy firing a fixed few ticks after each of two POV shots).
 */
export function measureOrigin(file: string, stream: string, originTick: number, shotTicks: number[], tickrate: number, fps: number, seconds: number): OriginMeasure {
  const on = onsets(file, stream);
  const frameS = 1 / fps;
  const shots = [...shotTicks].sort((a, b) => a - b).map((t) => (t - originTick) / tickrate);
  const anchors = shots.filter((t, k) =>
    t >= MATCH_S && t <= seconds - MATCH_S
    && !(k > 0 && t - shots[k - 1] <= ISOLATION_S));
  const hits = (t: number, d: number) => on.filter((o) => Math.abs(o - (t + d)) <= frameS / 2);
  const scores: { d: number; n: number }[] = [];
  for (let ms = -MATCH_S * 1000; ms <= MATCH_S * 1000; ms++) {
    const d = ms / 1000;
    scores.push({ d, n: anchors.filter((t) => hits(t, d).length > 0).length });
  }
  const best = Math.max(0, ...scores.map((x) => x.n));
  // The best-supported offsets must form one connected run (1 ms steps) no
  // wider than a frame, and the centre is a member of it, so it carries the
  // full support; any other offset with as much support makes the result ambiguous.
  const peak = scores.filter((x) => x.n === best).map((x) => x.d);
  const centre = peak.length ? peak[Math.floor(peak.length / 2)] : 0;
  const disconnected = peak.some((d, i) => i > 0 && d - peak[i - 1] > 0.0015);
  const wide = disconnected || (peak.length > 0 && peak[peak.length - 1] - peak[0] > frameS);
  const rival = Math.max(0, ...scores.filter((x) => Math.abs(x.d - centre) > frameS).map((x) => x.n));
  // The onset nearest each supporting shot's expected time.
  const offsets = anchors.flatMap((t) => {
    const h = hits(t, centre);
    return h.length ? [Math.round((h.reduce((b, o) => (Math.abs(o - t - centre) < Math.abs(b - t - centre) ? o : b)) - t) * 1000)] : [];
  });
  const reason = best < 2 ? `only ${best} of ${anchors.length} isolated POV shot(s) found in the audio at a common offset`
    : wide || rival >= best || offsets.length !== best ? `ambiguous: offsets ${Math.round(centre * 1000)} ms and another are equally supported`
    : undefined;
  const offsetMs = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  return { offsetsMs: offsets, offsetMs: reason ? NaN : Math.round(offsetMs * 10) / 10, shots: anchors.length, ...(reason ? { reason } : {}) };
}
