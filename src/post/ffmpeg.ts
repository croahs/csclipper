// FFmpeg helpers shared by capture validation and post. Only ffmpeg is used
// (the essentials build on this machine has no ffprobe in PATH).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";

/**
 * Post runs the FFmpeg in PATH (the one HLAE's capture pipe uses too, tools/hlae/ffmpeg/ffmpeg.ini;
 * ffmpegVersion() names it, since it shapes the raw capture). For NVENC only, the pinned build in
 * tools/ffmpeg/ (FFmpeg 7.1.1, docs/modules.md has its URL and sha256) is the fallback when the
 * PATH one cannot open the encoder: FFmpeg 9 needs NVIDIA driver 610+, 7.1.1 works with older ones.
 */
const PINNED = path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");
export const POST_FFMPEG = "ffmpeg";

export function ff(args: string[], bin = POST_FFMPEG) {
  const r = spawnSync(bin, ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`ffmpeg did not run: ${r.error.message}`);
  return { status: r.status, stderr: r.stderr ?? "" };
}

export const ffmpegVersion = () => {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return (r.stdout ?? "").split(/\r?\n/)[0] ?? "unknown";
};

export type Probe = { duration: number | null; video: boolean; audio: boolean; videoStreams: number; audioStreams: number; unreadable: boolean; size: string | null };

export function probe(file: string): Probe {
  const r = ff(["-i", file]); // exits 1 by design (no output); the stream info is on stderr
  const d = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    video: /Stream #.*Video:/.test(r.stderr),
    audio: /Stream #.*Audio:/.test(r.stderr),
    videoStreams: (r.stderr.match(/Stream #\S+.*?: Video:/g) ?? []).length,
    audioStreams: (r.stderr.match(/Stream #\S+.*?: Audio:/g) ?? []).length,
    unreadable: /moov atom not found|Invalid data found/.test(r.stderr),
    size: r.stderr.match(/Stream #.*Video:.*?, (\d{2,5}x\d{2,5})/)?.[1] ?? null,
  };
}

/** Exact video frame count, by demuxing every packet of the first video stream. */
export function countFrames(file: string): number {
  const r = ff(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
  const all = [...r.stderr.matchAll(/frame=\s*(\d+)/g)];
  if (r.status !== 0 || !all.length) throw new Error(`could not count frames of ${file}: ${r.stderr.slice(-300)}`);
  return Number(all[all.length - 1][1]);
}

/** "" when the whole file decodes without a single error. */
export function decodeProblems(file: string): string {
  const r = ff(["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
  if (r.status !== 0) return `decode exit ${r.status}: ${r.stderr.slice(0, 300)}`;
  return r.stderr.trim().slice(0, 300);
}

/** Mean luma (0-255) of the frame at time t seconds, from a 32x18 gray thumbnail; -1 if it cannot be read. */
export function meanLuma(file: string, t: number): number {
  const r = spawnSync(POST_FFMPEG, ["-hide_banner", "-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 20 });
  const px = r.stdout as Buffer | null;
  if (r.error || r.status !== 0 || !px || px.length !== 32 * 18) return -1;
  let sum = 0;
  for (const v of px) sum += v;
  return sum / px.length;
}

let nvencBin: string | null | undefined;
/**
 * The FFmpeg whose h264_nvenc actually encodes here, or null: a one-frame test encode with the
 * PATH FFmpeg, then the pinned one, once per process. Listing the encoder is not enough (FFmpeg 9
 * lists it on any driver but fails to open it below 610).
 */
export function nvencFfmpeg(): string | null {
  if (nvencBin === undefined) {
    nvencBin = null;
    for (const bin of [POST_FFMPEG, ...(existsSync(PINNED) ? [PINNED] : [])]) {
      const r = spawnSync(bin, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30", "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"], { encoding: "utf8" });
      if (!r.error && r.status === 0) { nvencBin = bin; break; }
    }
  }
  return nvencBin;
}

/**
 * Video encoder arguments for the final clip. NVENC -cq (CRF + 4) at preset p5 matches x264 CRF 18
 * in SSIM against the raw capture (0.9773 vs 0.9769 on a 15 s segment), at 2.3x the speed and
 * about 16 % more size (docs/modules.md).
 */
export function videoArgs(encoder: "x264" | "nvenc", crf: number): string[] {
  return encoder === "nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(crf + 4), "-b:v", "0", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p"];
}

/**
 * Runs a final encode: `build(videoArgs)` gives the whole FFmpeg argument list. With "auto",
 * NVENC whenever a probe encode succeeds on either FFmpeg, and x264 if the real encode then fails
 * (session limit, driver hiccup; logged). Returns the result and the encoder that produced the file.
 */
export function encodeFinal(encoder: "auto" | "x264" | "nvenc", crf: number, build: (video: string[]) => string[]): { status: number | null; stderr: string; encoder: "x264" | "nvenc" } {
  const nv = encoder === "x264" ? null : nvencFfmpeg();
  const order: ("x264" | "nvenc")[] = encoder === "x264" ? ["x264"] : encoder === "nvenc" ? ["nvenc"] : nv ? ["nvenc", "x264"] : ["x264"];
  let last = { status: null as number | null, stderr: "", encoder: order[0] };
  for (const e of order) {
    const r = ff(build(videoArgs(e, crf)), e === "nvenc" ? nv ?? POST_FFMPEG : POST_FFMPEG);
    last = { ...r, encoder: e };
    if (r.status === 0) return last;
    if (e === "nvenc" && order.length > 1) console.error(`NVENC encode failed (${nv}), falling back to x264: ${r.stderr.trim().slice(-300)}`);
  }
  return last;
}
