// Vertical: a 9:16 copy of a library clip for Reels, TikTok and Shorts, at
// library/vertical/<no>-<slug>.mp4. The centre column of the 16:9 picture (the crosshair is the
// frame's centre, so the action stays in view; the radar and the kill feed fall outside), scaled
// up to config.json → vertical. Derived output like a share file: found by its name, never written
// to library/index.json, the source clip only read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, loadVertical, type VerticalSettings } from "../config.ts";
import type { ClipEntry } from "../library/index.ts";
import { decodeProblems, ff, probe } from "../post/ffmpeg.ts";
import { shareCaption } from "./caption.ts";
import { findClip, shareName } from "./index.ts";

export const VERTICAL_DIR = path.join(LIBRARY_DIR, "vertical");
/** Bumped when the encode recipe changes, so an older vertical file is made again. */
export const RECIPE = 1;
/** The AAC bitrate share's constant-quality encode uses. */
const AUDIO_KBPS = 128;
const MAX_DURATION_OFF_S = 0.5;

/** Thrown when the clip cannot be made vertical (no such clip, a source already narrower than 9:16); CLI exit 2. */
export class VerticalRefusal extends Error {}

// --- the crop (pure) ----------------------------------------------------------------------

export type Crop = { width: number; height: number; x: number; y: number };

/** The nearest even number at or below n: yuv420p crops and sizes are exact only on even numbers. */
const evenDown = (n: number) => Math.floor(n / 2) * 2;
/** The nearest even number to n. */
const evenNear = (n: number) => Math.round(n / 2) * 2;

/**
 * The 9:16 column of a sourceW x sourceH frame: full height (even), width the nearest even number
 * to 9/16 of it (1080 → 607.5 → 608), centred, moved by shift percent of the source width
 * (negative left, positive right) and clamped to the frame. x is even, so the crop is exact in
 * yuv420p. Throws VerticalRefusal for a source already narrower than 9:16.
 */
export function planCrop(sourceW: number, sourceH: number, shiftPercent = 0): Crop {
  if (!(sourceW > 0 && sourceH > 0)) throw new Error(`bad source size ${sourceW}x${sourceH}`);
  // The true aspect decides, before any rounding: 405x720 is exactly 9:16 and fits, 720x1281 is narrower.
  if (sourceW * 16 < sourceH * 9) throw new VerticalRefusal(`the source is ${sourceW}x${sourceH}, already narrower than 9:16; a 9:16 column does not fit in it`);
  const height = evenDown(sourceH);
  const width = Math.min(evenNear((height * 9) / 16), evenDown(sourceW));
  const maxX = evenDown(sourceW - width);
  const centre = (sourceW - width) / 2 + (shiftPercent / 100) * sourceW;
  const x = Math.min(maxX, Math.max(0, evenNear(centre)));
  return { width, height, x, y: evenDown((sourceH - height) / 2) };
}

/** The FFmpeg filter: crop, then lanczos up to the output size, square pixels. */
export const verticalFilter = (c: Crop, s: Pick<VerticalSettings, "width" | "height">) =>
  `crop=${c.width}:${c.height}:${c.x}:${c.y},scale=${s.width}:${s.height}:flags=lanczos,setsar=1`;

// --- arguments (pure) ------------------------------------------------------------------

export type VerticalArgs = { no: number; shift: number; json: boolean };
export function parseVerticalArgs(argv: string[]): VerticalArgs {
  const usage = "usage: pnpm vertical <clip number> [--shift <percent>]";
  let no: number | undefined, shift = 0, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--shift") {
      const v = argv[++i];
      shift = Number(v);
      if (v === undefined || v.trim() === "" || !Number.isFinite(shift)) throw new Error(`--shift needs a percent of the frame width (negative: left); ${usage}`);
    } else if (/^\d+$/.test(a) && no === undefined && Number(a) >= 1) no = Number(a);
    else throw new Error(`unexpected argument "${a}"; ${usage}`);
  }
  if (no === undefined) throw new Error(usage);
  return { no, shift, json };
}

// --- files -------------------------------------------------------------------------------

/** Same name as the clip's share file, in library/vertical/: one vertical file per clip, the latest crop wins. */
export const verticalPath = (e: Pick<ClipEntry, "no" | "title">) => path.join(VERTICAL_DIR, shareName(e));

export type KeyParts = { id: string; bytes: number; mtimeMs: number; crop: Crop; settings: VerticalSettings; recipe?: number };
/**
 * What a vertical file was made from, kept in its own metadata (comment tag), so a valid file with
 * the same key is reused and any other is made again: the clip's id, its file's size and time (a
 * re-render changes them), the crop (so --shift), the output size and CRF, and the recipe.
 */
export function verticalKey(k: KeyParts): string {
  const { crop: c, settings: s } = k;
  const text = `${k.recipe ?? RECIPE}:${k.id}:${k.bytes}:${Math.round(k.mtimeMs)}:${c.width}x${c.height}+${c.x}+${c.y}:${s.width}x${s.height}:${s.crf}`;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
const TAG = "croclipper-vertical:";
const readTag = (file: string) => ff(["-i", file]).stderr.match(new RegExp(`comment\\s*:\\s*${TAG}([0-9a-f]+)`))?.[1];

type Source = { seconds: number; audio: boolean };
/** Reasons a vertical file is not acceptable; [] when it is. full: also decode every frame. */
export function validateVertical(file: string, src: Source, s: VerticalSettings, full = true): string[] {
  const p = probe(file);
  if (!p.video || p.unreadable) return [`vertical streams: ${JSON.stringify(p)}`];
  const reasons: string[] = [];
  if (p.videoCodec !== "h264") reasons.push(`video is ${p.videoCodec}, expected h264`);
  if (p.size !== `${s.width}x${s.height}`) reasons.push(`size ${p.size}, expected ${s.width}x${s.height}`);
  if (src.audio && !p.audio) reasons.push("no audio, the source has it");
  if (p.duration === null || Math.abs(p.duration - src.seconds) > MAX_DURATION_OFF_S) reasons.push(`duration ${p.duration} s vs ${src.seconds.toFixed(2)} s`);
  if (full && !reasons.length) { const err = decodeProblems(file); if (err) reasons.push(`decode: ${err}`); }
  return reasons;
}

export type VerticalResult = {
  file: string; // relative to library/, as the page links it
  path: string;
  bytes: number;
  width: number; height: number; fps: number;
  seconds: number; // the vertical file's duration
  caption: string;
  reused: boolean;
  shift: number;
  crop: Crop;
  encodeSeconds: number;
};

/** Makes (or reuses) the vertical file for clip `no`. Synchronous, like makeShare, so a server can run it in a child process. */
export function makeVertical(no: number, shift = 0, log: (s: string) => void = () => {}, settings = loadVertical()): VerticalResult {
  const e = findClip(no);
  if (!e) throw new VerticalRefusal(`no clip ${no}`);
  const source = path.join(LIBRARY_DIR, e.file);
  if (!existsSync(source)) throw new Error(`clip ${no}'s file is missing: ${source}`);
  const sp = probe(source);
  const [sw, sh] = (sp.size ?? "").split("x").map(Number);
  if (!sp.video || !sw || !sh || !sp.fps || !sp.duration) throw new Error(`clip ${no}'s file cannot be read: ${JSON.stringify(sp)}`);
  const src: Source = { seconds: sp.duration, audio: sp.audio };
  const crop = planCrop(sw, sh, shift);
  const dest = verticalPath(e);
  const st = statSync(source);
  const key = verticalKey({ id: e.id, bytes: st.size, mtimeMs: st.mtimeMs, crop, settings });
  const caption = shareCaption(e);
  const t0 = Date.now();
  const result = (reused: boolean): VerticalResult => {
    const p = probe(dest);
    const [width, height] = (p.size ?? "0x0").split("x").map(Number);
    return { file: path.relative(LIBRARY_DIR, dest).replaceAll("\\", "/"), path: dest, bytes: statSync(dest).size, width, height, fps: p.fps ?? 0, seconds: p.duration ?? 0, caption, reused, shift, crop, encodeSeconds: (Date.now() - t0) / 1000 };
  };

  // Reuse: same key in the file's own tag and the checks a finished file must pass (no full
  // decode: only a validated file is ever renamed to this name).
  if (existsSync(dest) && readTag(dest) === key && !validateVertical(dest, src, settings, false).length) return result(true);

  mkdirSync(VERTICAL_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  try {
    log(`clip ${no}: ${sw}x${sh} → crop ${crop.width}x${crop.height} at x=${crop.x} → ${settings.width}x${settings.height}@${sp.fps} (x264 CRF ${settings.crf})`);
    const audio = src.audio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`] : ["-an"];
    const r = ff(["-v", "error", "-y", "-i", source, "-map", "0:v:0", "-vf", verticalFilter(crop, settings), "-c:v", "libx264", "-preset", "slow", "-crf", String(settings.crf), "-pix_fmt", "yuv420p", ...audio,
      "-map_metadata", "-1", "-metadata", `comment=${TAG}${key}`, "-movflags", "+faststart", "-f", "mp4", tmp]);
    const reasons = r.status === 0 ? validateVertical(tmp, src, settings) : [`encode failed: ${r.stderr.slice(0, 300)}`];
    if (reasons.length) throw new Error(`clip ${no}: vertical file not made: ${reasons.join("; ")}`);
    // Windows refuses to replace a file another program has open (a player); say so plainly.
    try { renameSync(tmp, dest); } catch (err) { throw new Error(`could not write ${dest} (open in a player?): ${(err as Error).message}`); }
    return result(false);
  } finally {
    rmSync(tmp, { force: true });
  }
}
