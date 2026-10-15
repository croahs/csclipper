// Capture mode: HLAE mirv_streams piping frames to FFmpeg, plus HLAE's WAV.
// The command sequence is the one proven in M0.2 (docs/spikes.md).
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RenderSettings } from "../../config.ts";

const fwd = (p: string) => p.replaceAll("\\", "/");

export type HlaeCapture = {
  takeDir: string;
  videoPaths: string[]; // one per take
  setup: string[]; // cfg-body lines
  select: (take: number) => string; // quote-free: points the recorder at that take's video
  start: string; // scheduled at the record-start tick
  end: string; // scheduled at the record-end tick
};

/**
 * One ffmpeg settings entry per take (croclip0, croclip1, ...), each writing its own video
 * file, defined in the cfg body where quotes are allowed; switching between them is a
 * quote-free command a take's cfg can run. HLAE's WAV lands in a take folder per record start.
 */
export function hlaeCapture(workDir: string, s: RenderSettings, takes = 1): HlaeCapture {
  const takeDir = path.join(workDir, "hlae");
  const videoPaths = Array.from({ length: takes }, (_, i) => path.join(takeDir, takes === 1 ? "video.mp4" : `video${i}.mp4`));
  return {
    takeDir,
    videoPaths,
    setup: [
      `mirv_streams record name "${fwd(takeDir)}"`,
      "mirv_streams record startMovieWav 1",
      ...videoPaths.map((v, i) => `mirv_streams settings add ffmpeg croclip${i} "-c:v libx264 -preset veryfast -crf ${s.captureCrf} -pix_fmt yuv420p {QUOTE}${fwd(v)}{QUOTE}"`),
      "mirv_streams record screen enabled 1",
      `mirv_streams record fps ${s.fps}`,
    ],
    select: (i) => `mirv_streams record screen settings croclip${i}`,
    start: "mirv_streams record start",
    end: "mirv_streams record end",
  };
}

/** HLAE's loader arguments. Refuses any CS2 command line without -insecure. */
export function hlaeArgs(hlaeExe: string, cs2Exe: string, csArgs: string[]): string[] {
  if (!csArgs.includes("-insecure")) throw new Error("refusing: CS2 launch without -insecure");
  return [
    "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage",
    "-customLoader",
    "-hookDllPath", path.join(path.dirname(hlaeExe), "x64", "AfxHookSource2.dll"),
    "-programPath", cs2Exe,
    "-cmdLine", csArgs.join(" "),
  ];
}

/** The take folders HLAE wrote this attempt, in order (the work dir is fresh per attempt), and their WAVs. */
export function takeOutputs(c: HlaeCapture): { takes: string[]; wavs: string[] } {
  const takes = existsSync(c.takeDir) ? readdirSync(c.takeDir).filter((d) => d.startsWith("take")).sort() : [];
  return { takes, wavs: takes.map((t) => path.join(c.takeDir, t, "audio.wav")) };
}

// Console evidence lines (CS2 build 14190, HLAE 2.192.8).
export const STARTED_RE = /\[Movie\] Started recording movie/;
export const FINISHED_RE = /Finishing movie: .*\[(\d+) frames @ ([\d.]+) ==/;
