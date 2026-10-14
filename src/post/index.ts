// Post: measure the capture's tick origin, trim the raw capture to exactly the
// requested ticks, fade in/out, encode the final clip to a temp path and
// validate it, including where the requested ticks actually landed.
import { rmSync } from "node:fs";
import { captureSize, type RenderSettings } from "../config.ts";
import type { TickMapping } from "../render/controller/index.ts";
import { countFrames, decodeProblems, ff, probe } from "./ffmpeg.ts";
import { measureOrigin, type OriginMeasure } from "./sync.ts";
import { measureFlash, type FlashMeasure } from "./flash.ts";

/** Measured: frame k of the raw capture shows tick originTick + k * tickrate / fps. */
export type MeasuredMapping = TickMapping & { originTick: number; timing: Timing };

/** Final clips must show the requested ticks within this many frames. */
export const MAX_FRAMES_OFF = 2;
// An origin error larger than this is not a record-start jitter (M0.2: 0-3 frames) but a broken capture.
const MAX_ORIGIN_FRAMES = 10;
// Video and audio anchors must agree this closely when both are measurable.
const MAX_DISAGREE_FRAMES = 1.5;

export type Timing = { offsetFrames: number; source: "video" | "audio"; video: FlashMeasure; audio: OriginMeasure; reason?: string };

/**
 * Where a file's frame 0 really is, in frames against `originTick` (negative:
 * the content is early). The muzzle flash (video, the stream that is trimmed)
 * decides; the gunshot onsets (audio) cross-check it, or decide alone when the
 * flash is not measurable.
 */
export function timing(video: string, audio: string, originTick: number, shotTicks: number[], tickrate: number, fps: number, seconds: number, edgeS = 0): Timing {
  const v = measureFlash(video, originTick, shotTicks, tickrate, fps, edgeS);
  const a = measureOrigin(audio, "0:a:0", originTick, shotTicks, tickrate, fps, seconds, edgeS);
  const aFrames = (a.offsetMs * fps) / 1000;
  const base = { video: v, audio: a };
  if (!v.reason && !a.reason && Math.abs(v.offsetFrames - aFrames) > MAX_DISAGREE_FRAMES) {
    return { ...base, offsetFrames: NaN, source: "video", reason: `muzzle flash (${v.offsetFrames} frames) and gunshot audio (${aFrames.toFixed(2)} frames) disagree` };
  }
  if (!v.reason) return { ...base, offsetFrames: v.offsetFrames, source: "video" };
  if (!a.reason) return { ...base, offsetFrames: Math.round(aFrames * 100) / 100, source: "audio" };
  return { ...base, offsetFrames: NaN, source: "video", reason: `video: ${v.reason}; audio: ${a.reason}` };
}

export function measureMapping(m: TickMapping, video: string, wav: string, shotTicks: number[]): MeasuredMapping | string {
  const t = timing(video, wav, m.recordStartTick, shotTicks, m.tickrate, m.fps, m.frames / m.fps);
  if (t.reason) return `tick origin not measurable: ${t.reason}`;
  if (Math.abs(t.offsetFrames) > MAX_ORIGIN_FRAMES) return `tick origin off by ${t.offsetFrames} frames, more than ${MAX_ORIGIN_FRAMES}`;
  // Content seen early means frame 0 already shows a later tick.
  return { ...m, originTick: m.recordStartTick - (t.offsetFrames * m.tickrate) / m.fps, timing: t };
}

export type TrimPlan = { startFrame: number; frames: number; seconds: number };

/** Frames of the raw capture that show [startTick, endTick). */
export function trimPlan(m: MeasuredMapping, startTick: number, endTick: number): TrimPlan {
  const framesPerTick = m.fps / m.tickrate;
  const startFrame = Math.round((startTick - m.originTick) * framesPerTick);
  const frames = Math.round((endTick - startTick) * framesPerTick);
  if (startFrame < 0 || startFrame + frames > m.frames) throw new Error(`ticks ${startTick}-${endTick} fall outside the capture (${m.frames} frames from tick ${m.originTick.toFixed(2)})`);
  return { startFrame, frames, seconds: frames / m.fps };
}

/** Reasons a finished clip is not acceptable; [] when it is. Also used to trust a cached clip. */
export function validateClip(file: string, frames: number, fps: number, size: string): string[] {
  const reasons: string[] = [];
  const p = probe(file);
  if (!p.video || !p.audio || p.unreadable) return [`clip streams: ${JSON.stringify(p)}`];
  if (p.size !== size) reasons.push(`clip is ${p.size}, expected ${size}`);
  const counted = countFrames(file);
  if (counted !== frames) reasons.push(`clip has ${counted} frames, expected ${frames}`);
  if (p.duration === null || Math.abs(p.duration - frames / fps) > 2 / fps) reasons.push(`clip duration ${p.duration} vs ${(frames / fps).toFixed(3)}`);
  const err = decodeProblems(file);
  if (err) reasons.push(`clip decode: ${err}`);
  return reasons;
}

export type PostResult = { status: "ok" | "failed"; reasons: string[]; plan?: TrimPlan; landed?: Timing };

/** Writes outTmp; on any failure the temp file is removed. */
export function post(video: string, audio: string, m: MeasuredMapping, startTick: number, endTick: number, shotTicks: number[], s: RenderSettings, outTmp: string): PostResult {
  const reasons: string[] = [];
  let plan: TrimPlan | undefined;
  let landed: Timing | undefined;
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
    else {
      reasons.push(...validateClip(outTmp, plan.frames, m.fps, `${s.width}x${s.height}`));
      // Where the requested ticks landed in the final file, by the same anchors
      // (a check of trim, scale and encode); shots inside the fades are skipped.
      landed = timing(outTmp, outTmp, startTick, shotTicks, m.tickrate, m.fps, d, f);
      if (landed.reason) reasons.push(`final clip timing not measurable: ${landed.reason}`);
      else if (Math.abs(landed.offsetFrames) > MAX_FRAMES_OFF) reasons.push(`final clip is ${landed.offsetFrames} frames off the requested ticks`);
    }
  } catch (e) {
    reasons.push(`post error: ${(e as Error).message}`);
  }
  if (reasons.length) rmSync(outTmp, { force: true });
  return { status: reasons.length ? "failed" : "ok", reasons, plan, landed };
}
