// Capture mode: HLAE mirv_streams piping frames to FFmpeg, plus HLAE's WAV.
// The command sequence is the one proven in M0.2 (docs/spikes.md).
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RenderSettings } from "../../config.ts";

const fwd = (p: string) => p.replaceAll("\\", "/");

export type HlaeCapture = {
  takeDir: string;
  videoPath: string;
  setup: string[]; // cfg-body lines
  start: string; // scheduled at the record-start tick
  end: string; // scheduled at the record-end tick
};

export function hlaeCapture(workDir: string, s: RenderSettings): HlaeCapture {
  const takeDir = path.join(workDir, "hlae");
  const videoPath = path.join(takeDir, "video.mp4");
  return {
    takeDir,
    videoPath,
    setup: [
      `mirv_streams record name "${fwd(takeDir)}"`,
      "mirv_streams record startMovieWav 1",
      `mirv_streams settings add ffmpeg croclip "-c:v libx264 -preset veryfast -crf ${s.captureCrf} -pix_fmt yuv420p {QUOTE}${fwd(videoPath)}{QUOTE}"`,
      "mirv_streams record screen settings croclip",
      "mirv_streams record screen enabled 1",
      `mirv_streams record fps ${s.fps}`,
    ],
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

/** The single take folder HLAE wrote this attempt (the work dir is fresh per attempt). */
export function takeOutputs(c: HlaeCapture): { takes: string[]; wav?: string } {
  const takes = existsSync(c.takeDir) ? readdirSync(c.takeDir).filter((d) => d.startsWith("take")).sort() : [];
  return { takes, wav: takes.length === 1 ? path.join(c.takeDir, takes[0], "audio.wav") : undefined };
}

// Console evidence lines (CS2 build 14190, HLAE 2.192.8).
export const STARTED_RE = /\[Movie\] Started recording movie/;
export const FINISHED_RE = /Finishing movie: .*\[(\d+) frames @ ([\d.]+) ==/;
