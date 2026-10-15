// Post: trim the raw capture to the requested ticks using the scheduled
// record-start mapping, play the action windows at normal speed and
// fast-forward the stretches between them (muted), fade in/out, encode the
// final clip to a temp path and validate it.
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
  // Both ends through the same mapping, so adjacent intervals share their boundary frame exactly.
  const framesPerTick = m.fps / m.tickrate;
  const originTick = m.recordStartTick - RECORD_START_OFFSET_FRAMES / framesPerTick;
  const frameAt = (tick: number) => Math.round((tick - originTick) * framesPerTick);
  const startFrame = frameAt(startTick);
  const frames = frameAt(endTick) - startFrame;
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

/** Gaps between action windows play this many times faster, muted. */
export const FAST_FORWARD_SPEED = 8;

/** A stretch of the clip: ticks [startTick, endTick) at `speed`, its frames in the raw capture, its length in the output. */
export type Segment = TrimPlan & { startTick: number; endTick: number; speed: number; outSeconds: number };

/**
 * The clip as segments: each window at normal speed, each stretch between two windows
 * fast-forwarded. No windows (a hand-written range): the whole interval at normal speed.
 * Before the first and after the last window is cut.
 */
export function segments(m: TickMapping, startTick: number, endTick: number, windows?: { startTick: number; endTick: number }[]): Segment[] {
  const ws = windows?.length ? windows : [{ startTick, endTick }];
  const spans: { a: number; b: number; speed: number }[] = [];
  for (const [i, w] of ws.entries()) {
    if (w.startTick < startTick || w.endTick > endTick || w.endTick <= w.startTick || (i > 0 && w.startTick < ws[i - 1].endTick)) throw new Error(`action window ${w.startTick}-${w.endTick} out of order or outside ${startTick}-${endTick}`);
    if (i > 0) spans.push({ a: ws[i - 1].endTick, b: w.startTick, speed: FAST_FORWARD_SPEED });
    spans.push({ a: w.startTick, b: w.endTick, speed: 1 });
  }
  return spans.filter((x) => x.b > x.a).map((x) => {
    const plan = trimPlan(m, x.a, x.b);
    return { ...plan, startTick: x.a, endTick: x.b, speed: x.speed, outSeconds: plan.seconds / x.speed };
  });
}

export type PostResult = { status: "ok" | "failed"; reasons: string[]; plan?: TrimPlan; segments?: Segment[] };

/** Writes outTmp; on any failure the temp file is removed. windows: the spec's action windows, if any. */
export function post(video: string, audio: string, m: TickMapping, startTick: number, endTick: number, s: RenderSettings, outTmp: string, windows?: { startTick: number; endTick: number }[]): PostResult {
  const reasons: string[] = [];
  let plan: TrimPlan | undefined;
  let segs: Segment[] | undefined;
  try {
    segs = segments(m, startTick, endTick, windows);
    const d = segs.reduce((n, x) => n + x.outSeconds, 0);
    plan = { startFrame: segs[0].startFrame, frames: Math.round(d * m.fps), seconds: d };
    const f = Math.min(s.fadeSeconds, d / 4);
    const fades = f > 0;
    // Stretched captures are scaled to the output size ignoring aspect (square pixels after).
    const cap = captureSize(s);
    const scale = cap.width !== s.width || cap.height !== s.height ? `,scale=${s.width}:${s.height}:flags=lanczos,setsar=1` : "";
    const k = segs.length;
    const graph: string[] = [];
    graph.push(k > 1 ? `[0:v]split=${k}${segs.map((_, i) => `[vs${i}]`).join("")}` : "[0:v]null[vs0]");
    graph.push(k > 1 ? `[1:a]asplit=${k}${segs.map((_, i) => `[as${i}]`).join("")}` : "[1:a]anull[as0]");
    for (const [i, x] of segs.entries()) {
      const t0 = x.startFrame / m.fps;
      // Fast-forward: every frame sped up, then resampled to the clip's frame rate; the audio is that
      // stretch's own length cut to the sped-up length and muted, so the streams stay in step.
      const speed = x.speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${x.speed},fps=${m.fps}`;
      graph.push(`[vs${i}]trim=start_frame=${x.startFrame}:end_frame=${x.startFrame + x.frames},${speed}[v${i}]`);
      graph.push(`[as${i}]atrim=start=${t0.toFixed(6)}:end=${(t0 + x.outSeconds).toFixed(6)},asetpts=PTS-STARTPTS${x.speed === 1 ? "" : ",volume=0"}[a${i}]`);
    }
    graph.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${k}:v=1:a=1[vc][ac]`);
    graph.push(`[vc]null${scale}${fades ? `,fade=t=in:st=0:d=${f},fade=t=out:st=${(d - f).toFixed(6)}:d=${f}` : ""}[v]`);
    graph.push(`[ac]anull${fades ? `,afade=t=in:st=0:d=${f},afade=t=out:st=${(d - f).toFixed(6)}:d=${f}` : ""}[a]`);
    const r = ff([
      "-v", "error", "-y", "-i", video, "-i", audio,
      "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "slow", "-crf", String(s.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", outTmp,
    ]);
    if (r.status !== 0) reasons.push(`encode failed: ${r.stderr.slice(0, 300)}`);
    else reasons.push(...validateClip(outTmp, d, `${s.width}x${s.height}`));
  } catch (e) {
    reasons.push(`post error: ${(e as Error).message}`);
  }
  if (reasons.length) rmSync(outTmp, { force: true });
  return { status: reasons.length ? "failed" : "ok", reasons, plan, segments: segs };
}
