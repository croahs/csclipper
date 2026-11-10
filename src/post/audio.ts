// "Even" sound: the one FFmpeg audio filter chain that tames gunshot peaks and lifts quiet
// detail (footsteps), built from config.json → audio. Post (post.audio) and share (share.audio)
// both take it from here; nobody writes the chain by hand. Measurements: docs/modules.md, Even sound.
import path from "node:path";
import { loadAudioMode, loadEvenAudio, ROOT, type AudioMode, type EvenAudio } from "../config.ts";

// FFmpeg's own ranges for these options (acompressor, alimiter), in EvenAudio's units (src/config.ts).
const RANGES: Record<keyof EvenAudio, [number, number]> = {
  thresholdDb: [-60, 0], // threshold 0.000976563..1
  ratio: [1, 20],
  attackMs: [0.01, 2000],
  releaseMs: [0.01, 9000],
  makeupDb: [0, 36], // makeup 1..64
  limitDb: [-24, 0], // limit 0.0625..1
};
// The limiter's own timing is fixed: a 5 ms lookahead (FFmpeg's default) catches a shot's onset,
// and 100 ms release recovers between shots without audible pumping. latency=1 compensates the
// lookahead so the sound stays in step with the picture; level=0 keeps alimiter from normalising.
const LIMITER = "attack=5:release=100:level=0:latency=1";

/** The audio filter for a mode: "" for raw (nothing added), the chain for even. Throws on parameters out of range (config.json → audio). */
export function audioFilter(mode: AudioMode, p: EvenAudio): string {
  if (mode === "raw") return "";
  if (mode !== "even") throw new Error(`audio mode must be "raw" or "even", not ${JSON.stringify(mode)}`);
  for (const [k, [lo, hi]] of Object.entries(RANGES) as [keyof EvenAudio, [number, number]][]) {
    const v = p?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`config.json audio.${k} must be a number from ${lo} to ${hi}`);
  }
  return `acompressor=threshold=${p.thresholdDb}dB:ratio=${p.ratio}:attack=${p.attackMs}:release=${p.releaseMs}:makeup=${p.makeupDb}dB,alimiter=limit=${p.limitDb}dB:${LIMITER}`;
}

/** The mode and its filter for a section, as post and share use them. */
export function loadAudio(section: "post" | "share", file = path.join(ROOT, "config.json")): { mode: AudioMode; filter: string } {
  const mode = loadAudioMode(section, file);
  return { mode, filter: mode === "raw" ? "" : audioFilter(mode, loadEvenAudio(file)) };
}
