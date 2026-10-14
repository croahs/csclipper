// Repo paths, render settings (config.json) and identities (.env).
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const STATE_DIR = path.join(ROOT, "state");
export const LIBRARY_DIR = path.join(ROOT, "library");
export const STEAMID64_BASE = 76561197960265728n;

/** Thrown when a safety check says no; nothing has been launched. CLI exit 2. */
export class Refusal extends Error {}

export type RenderSettings = {
  // The output file is always width x height (16:9 by default). "native"
  // captures at that size; "stretched" captures 4:3 at the same height and
  // post scales it to the output ignoring aspect, as a stretched monitor shows it.
  aspect: "native" | "stretched";
  width: number;
  height: number;
  fps: number;
  captureCrf: number; // HLAE's intermediate encode; post re-encodes at crf
  crf: number;
  fadeSeconds: number;
};

export function loadSettings(file = path.join(ROOT, "config.json")): RenderSettings {
  const r = JSON.parse(readFileSync(file, "utf8")).render as RenderSettings;
  for (const k of ["width", "height", "fps", "captureCrf", "crf", "fadeSeconds"] as const) {
    if (typeof r?.[k] !== "number" || !(r[k] >= 0)) throw new Error(`config.json render.${k} must be a number >= 0`);
  }
  if (r.width % 2 || r.height % 2) throw new Error("config.json render width/height must be even (yuv420p)");
  if (r.aspect !== "native" && r.aspect !== "stretched") throw new Error('config.json render.aspect must be "native" or "stretched"');
  return r;
}

/** The game window size the capture runs at, derived from the aspect setting. */
export function captureSize(s: RenderSettings): { width: number; height: number } {
  if (s.aspect === "native") return { width: s.width, height: s.height };
  return { width: Math.round((s.height * 4) / 3 / 2) * 2, height: s.height };
}

export type Identities = {
  pov: string; // STEAM_ID64: the player whose clips these are
  renderAccount: string; // RENDER_STEAM_ID64: the only Steam account allowed to render
  hlaeExe: string;
  cs2Exe: string;
};

// The env file is the only source for the safety identities; a shell variable
// that disagrees with it is refused, never silently preferred.
export function loadIdentities(envFile = path.join(ROOT, ".env")): Identities {
  if (!existsSync(envFile)) throw new Refusal(`refusing: env file ${envFile} missing`);
  const fileEnv = parseEnv(readFileSync(envFile, "utf8"));
  const value = (k: string) => {
    const v = fileEnv[k]?.trim();
    if (!v) throw new Refusal(`refusing: ${k} missing in ${envFile}`);
    const inherited = process.env[k]?.trim();
    if (inherited && inherited !== v) throw new Refusal(`refusing: ${k} in the environment differs from ${envFile}`);
    return v;
  };
  const steamId = (k: string) => {
    const v = value(k);
    if (!/^\d{17}$/.test(v) || BigInt(v) <= STEAMID64_BASE) throw new Refusal(`refusing: ${k} is not a SteamID64`);
    return v;
  };
  return { pov: steamId("STEAM_ID64"), renderAccount: steamId("RENDER_STEAM_ID64"), hlaeExe: value("HLAE_EXE"), cs2Exe: value("CS2_EXE") };
}

export const accountId = (steamId64: string) => (BigInt(steamId64) - STEAMID64_BASE).toString();
