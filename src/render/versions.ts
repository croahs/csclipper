// Tool versions recorded with every render (PLAN.md: HLAE breaks on CS2 updates).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { DEMOPARSER_VERSION } from "../parse/clip-facts.ts";
import { ffmpegVersion } from "../post/ffmpeg.ts";

export function toolVersions(cs2Exe: string, hlaeExe: string) {
  let cs2 = "unknown";
  try {
    const inf = readFileSync(path.resolve(path.dirname(cs2Exe), "..", "..", "csgo", "steam.inf"), "utf8");
    const get = (k: string) => inf.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
    cs2 = `PatchVersion ${get("PatchVersion")} ClientVersion ${get("ClientVersion")}`;
  } catch {}
  let hlae = "unknown";
  try {
    hlae = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${hlaeExe.replaceAll("'", "''")}').VersionInfo.FileVersion`], { encoding: "utf8", timeout: 15_000 }).trim() || "unknown";
  } catch {}
  return { cs2, hlae, ffmpeg: ffmpegVersion(), demoparser2: DEMOPARSER_VERSION, node: process.version };
}
