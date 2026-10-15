// Post: trim the raw capture to the requested ticks using the scheduled
// record-start mapping, fade in/out, encode the final clip to a temp path and
// validate it.
import { rmSync } from "node:fs";
import { captureSize, type RenderSettings } from "../config.ts";
import type { TickMapping } from "../render/controller/index.ts";
import { decodeProblems, ff, meanLuma, probe } from "./ffmpeg.ts";

/**
 * Where recording really starts, against the scheduled record-start tick, in
 * frames (negative: frame 0 already shows a later tick). A constant: the
 * median of the seven per-capture offsets measured on this machine in M0-M3
 * (-0.4 to -3.5 frames, median -3.4; docs/modules.md). So a clip can be up to
 * about 3 frames (50 ms) off either way; nothing measures it per clip.
 */
export const RECORD_START_OFFSET_FRAMES = -3.4;

export type TrimPlan = { startFrame: number; frames: number; seconds: number };

/** Frames of the raw capture that show [startTick, endTick), by the scheduled mapping. */
export function trimPlan(m: TickMapping, startTick: number, endTick: number): TrimPlan {
  const framesPerTick = m.fps / m.tickrate;
  const originTick = m.recordStartTick - RECORD_START_OFFSET_FRAMES / framesPerTick;
  const startFrame = Math.round((startTick - originTick) * framesPerTick);
  const frames = Math.round((endTick - startTick) * framesPerTick);
  if (startFrame < 0 || startFrame + frames > m.frames) throw new Error(`ticks ${startTick}-${endTick} fall outside the capture (${m.frames} frames from tick ${m.recordStartTick})`);
  return { startFrame, frames, seconds: frames / m.fps };
}

const MAX_DURATION_OFF_S = 0.5;
const BLACK_LUMA = 12; // mean luma (0-255) at or below this counts as a black frame
const SAMPLES = [0.1, 0.3, 0.5, 0.7, 0.9]; // where frames are sampled, as fractions of the clip

/**
 * Reasons a finished clip is not acceptable; [] when it is. Also used to trust
 * a cached clip. Checks: decodes cleanly, one video and one audio stream, the
 * configured size, duration within 0.5 s of `seconds`, sampled frames not black.
 */
export function validateClip(file: string, seconds: number, size: string): string[] {
  const p = probe(file);
  if (!p.video || !p.audio || p.unreadable) return [`clip streams: ${JSON.stringify(p)}`];
  const reasons: string[] = [];
  if (p.videoStreams !== 1 || p.audioStreams !== 1) reasons.push(`clip has ${p.videoStreams} video and ${p.audioStreams} audio streams, expected one each`);
  if (p.size !== size) reasons.push(`clip is ${p.size}, expected ${size}`);
  if (p.duration === null || Math.abs(p.duration - seconds) > MAX_DURATION_OFF_S) reasons.push(`clip duration ${p.duration} s vs ${seconds.toFixed(2)} s`);
  const err = decodeProblems(file);
  if (err) reasons.push(`clip decode: ${err}`);
  if (p.duration) {
    // -1 (unreadable frame) counts as black too: a clip whose frames cannot be read is not fine.
    const dark = SAMPLES.map((f) => ({ t: f * p.duration!, l: meanLuma(file, f * p.duration!) })).filter((x) => x.l <= BLACK_LUMA);
    if (dark.length) reasons.push(`black frames at ${dark.map((x) => `${x.t.toFixed(1)} s (luma ${x.l.toFixed(1)})`).join(", ")}`);
  }
  return reasons;
}

export type PostResult = { status: "ok" | "failed"; reasons: string[]; plan?: TrimPlan };

/** Writes outTmp; on any failure the temp file is removed. */
export function post(video: string, audio: string, m: TickMapping, startTick: number, endTick: number, s: RenderSettings, outTmp: string): PostResult {
  const reasons: string[] = [];
  let plan: TrimPlan | undefined;
  try {
    plan = trimPlan(m, startTick, endTick);
    const t0 = plan.startFrame / m.fps;
    const d = plan.seconds;
    const f = Math.min(s.fadeSeconds, d / 4);
    const fades = f > 0;
    // Stretched captures are scaled to the output size ignoring aspect (square pixels after).
    const cap = captureSize(s);
    const scale = cap.width !== s.width || cap.height !== s.height ? `,scale=${s.width}:${s.height}:flags=lanczos,setsar=1` : "";
    const vf = `[0:v]trim=start_frame=${plan.startFrame}:end_frame=${plan.startFrame + plan.frames},setpts=PTS-STARTPTS${scale}${fades ? `,fade=t=in:st=0:d=${f},fade=t=out:st=${(d - f).toFixed(6)}:d=${f}` : ""}[v]`;
    const af = `[1:a]atrim=start=${t0.toFixed(6)}:end=${(t0 + d).toFixed(6)},asetpts=PTS-STARTPTS${fades ? `,afade=t=in:st=0:d=${f},afade=t=out:st=${(d - f).toFixed(6)}:d=${f}` : ""}[a]`;
    const r = ff([
      "-v", "error", "-y", "-i", video, "-i", audio,
      "-filter_complex", `${vf};${af}`, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "slow", "-crf", String(s.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", outTmp,
    ]);
    if (r.status !== 0) reasons.push(`encode failed: ${r.stderr.slice(0, 300)}`);
    else reasons.push(...validateClip(outTmp, (endTick - startTick) / m.tickrate, `${s.width}x${s.height}`));
  } catch (e) {
    reasons.push(`post error: ${(e as Error).message}`);
  }
  if (reasons.length) rmSync(outTmp, { force: true });
  return { status: reasons.length ? "failed" : "ok", reasons, plan };
}
