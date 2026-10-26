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
  // "full": the in-play HUD with the spectator-only panels blanked; "bare": crosshair and killfeed only.
  hud: "full" | "bare";
  width: number;
  height: number;
  fps: number;
  captureCrf: number; // HLAE's intermediate encode; post re-encodes at crf
  crf: number;
  fadeSeconds: number;
};

/** Which moments the batch renders per demo: every one scoring minScore or more; none → the best one if fallbackBest. */
export type BatchSettings = { minScore: number; fallbackBest: boolean };
export function loadBatch(file = path.join(ROOT, "config.json")): BatchSettings {
  const b = JSON.parse(readFileSync(file, "utf8")).batch as BatchSettings;
  if (typeof b?.minScore !== "number" || typeof b.fallbackBest !== "boolean") throw new Error("config.json batch needs minScore (number) and fallbackBest (true/false)");
  return { minScore: b.minScore, fallbackBest: b.fallbackBest };
}

/** The batch's pick from a demo's ranked specs (best first). */
export function pickMoments<T extends { score: number }>(ranked: T[], b: BatchSettings): T[] {
  const over = ranked.filter((s) => s.score >= b.minScore);
  return over.length || !b.fallbackBest ? over : ranked.slice(0, 1);
}

/**
 * Demos at or after this game build (header patch_version) show the player's own crosshair from
 * the demo; older ones need it exec'd (docs/modules.md, Crosshair). Empty (absent, null or "")
 * means always the demo's crosshair.
 */
export function loadCrosshairCutoff(file = path.join(ROOT, "config.json")): number | undefined {
  const v = JSON.parse(readFileSync(file, "utf8")).crosshairFromDemoSincePatch as unknown;
  if (v === undefined || v === null || v === "") return undefined;
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("config.json crosshairFromDemoSincePatch must be a build number (integer) or empty");
  return v as number;
}

/**
 * The reels pnpm go makes for every new demo (AGENTS.md, The standing order) and each take's
 * window around the event: seconds before and after the kill.
 */
export type ReelSetting = { enabled: boolean; beforeSeconds: number; afterSeconds: number };
export type ReelSettings = { deaths: ReelSetting; kills: ReelSetting };
export function loadReels(file = path.join(ROOT, "config.json")): ReelSettings {
  const r = JSON.parse(readFileSync(file, "utf8")).reels ?? {};
  const one = (k: "deaths" | "kills"): ReelSetting => {
    const x = r[k] ?? {};
    if (typeof x.enabled !== "boolean" || !(x.beforeSeconds > 0) || !(x.afterSeconds > 0)) throw new Error(`config.json reels.${k} needs enabled (true/false), beforeSeconds and afterSeconds (> 0)`);
    return { enabled: x.enabled, beforeSeconds: x.beforeSeconds, afterSeconds: x.afterSeconds };
  };
  return { deaths: one("deaths"), kills: one("kills") };
}

/**
 * Ingest: whether the file a demo arrived in (an archive, or a duplicate of a stored demo) is kept
 * in demos/ingested/ once the store holds its content. Default false: it is deleted (the store
 * copy is the demo from then on).
 */
export type IngestSettings = { keepOriginals: boolean };
export function loadIngest(file = path.join(ROOT, "config.json")): IngestSettings {
  const i = JSON.parse(readFileSync(file, "utf8")).ingest ?? {};
  if (i.keepOriginals !== undefined && typeof i.keepOriginals !== "boolean") throw new Error("config.json ingest.keepOriginals must be true or false");
  return { keepOriginals: i.keepOriginals === true };
}

/** The final encode: "auto" = NVENC when FFmpeg has it (x264 if that encode fails), or always "x264" / "nvenc". */
export type Encoder = "auto" | "x264" | "nvenc";
export function loadEncoder(file = path.join(ROOT, "config.json")): Encoder {
  const e = JSON.parse(readFileSync(file, "utf8")).post?.encoder ?? "auto";
  if (e !== "auto" && e !== "x264" && e !== "nvenc") throw new Error('config.json post.encoder must be "auto", "x264" or "nvenc"');
  return e;
}

/** Clip span rules (PLAN.md §4): lead-in before the engagement start, tail after the last kill. */
export type ClipRules = { leadInSeconds: number; tailSeconds: number };
export function loadClipRules(file = path.join(ROOT, "config.json")): ClipRules {
  const c = JSON.parse(readFileSync(file, "utf8")).clip as ClipRules;
  for (const k of ["leadInSeconds", "tailSeconds"] as const) if (typeof c?.[k] !== "number" || !(c[k] >= 0)) throw new Error(`config.json clip.${k} must be a number >= 0`);
  return { leadInSeconds: c.leadInSeconds, tailSeconds: c.tailSeconds };
}

export function loadSettings(file = path.join(ROOT, "config.json")): RenderSettings {
  const r = JSON.parse(readFileSync(file, "utf8")).render as RenderSettings;
  for (const k of ["width", "height", "fps", "captureCrf", "crf", "fadeSeconds"] as const) {
    if (typeof r?.[k] !== "number" || !(r[k] >= 0)) throw new Error(`config.json render.${k} must be a number >= 0`);
  }
  if (r.width % 2 || r.height % 2) throw new Error("config.json render width/height must be even (yuv420p)");
  if (r.hud !== "full" && r.hud !== "bare") throw new Error('config.json render.hud must be "full" or "bare"');
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
