// Share: a copy of a library clip that plays inline anywhere (H.264, AAC, faststart) and fits an
// upload limit, at library/share/<no>-<slug>.mp4. Derived output, found by its name: nothing here
// writes library/index.json or index.html, and the source clip is only read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIBRARY_DIR, ROOT } from "../config.ts";
import { readIndex, type ClipEntry } from "../library/index.ts";
import { decodeProblems, ff, probe } from "../post/ffmpeg.ts";
import { shareCaption } from "./caption.ts";

export const SHARE_DIR = path.join(LIBRARY_DIR, "share");
export const MB = 1024 * 1024;
/** Aim this far under the limit: two-pass lands within a few percent, and the container adds about 1 %. */
export const TARGET_FRACTION = 0.94;
/** Bumped when the encode recipe changes, so an older share file is made again. */
const RECIPE = 1;
const CRF = 20;
const MAX_DURATION_OFF_S = 0.5;

/** Thrown when the clip cannot be shared at this limit (too long); CLI exit 2. */
export class ShareRefusal extends Error {}

/** config.json → share.maxMegabytes (default 20: Discord's free upload limit). */
export function loadShareLimitMb(file = path.join(ROOT, "config.json")): number {
  const v = JSON.parse(readFileSync(file, "utf8")).share?.maxMegabytes ?? 20;
  if (typeof v !== "number" || !(v > 0)) throw new Error("config.json share.maxMegabytes must be a number > 0");
  return v;
}

// --- the plan (pure) -------------------------------------------------------------------

/**
 * The ladder a two-pass share steps down, best first. minVideoKbps is where H.264 starts to
 * starve at that size and rate on CS2 footage (fast motion, fine HUD text): a rung is used only
 * when the budget gives it at least that. The bottom rung's 500 kbps (about 0.04 bits per pixel
 * per frame) is the floor; below it the clip is refused rather than sent as mush.
 */
export type Rung = { height: number; fps: number; minVideoKbps: number; audioKbps: number };
export const LADDER: Rung[] = [
  { height: 1080, fps: 60, minVideoKbps: 5000, audioKbps: 128 },
  { height: 720, fps: 60, minVideoKbps: 2500, audioKbps: 128 },
  { height: 720, fps: 30, minVideoKbps: 1400, audioKbps: 96 },
  { height: 480, fps: 30, minVideoKbps: 500, audioKbps: 96 },
];

export type ShareSource = { width: number; height: number; fps: number; seconds: number; audio: boolean };
export type SharePlan =
  | { ok: true; width: number; height: number; fps: number; videoKbps: number; audioKbps: number }
  | { ok: false; reason: string; neededMb: number };

/** The nearest even number at or below n: yuv420p needs even sizes, and rounding down never upscales. */
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The two-pass encode for a clip that a constant-quality encode did not fit under maxBytes: the
 * first rung whose bitrate budget is at least its floor. Never upscales: a rung above the source
 * is capped at the source's height and frame rate, its floor scaled down with the pixel rate.
 */
export function planShare(src: ShareSource, maxBytes: number): SharePlan {
  const totalKbps = (maxBytes * TARGET_FRACTION * 8) / src.seconds / 1000;
  let last: { floor: number; audio: number } | undefined;
  // Every rung is tried, also when a small source caps two of them to the same size and rate:
  // they still differ in audio bitrate and floor, and the later one can fit where the earlier did not.
  for (const r of LADDER) {
    // yuv420p needs even sizes; rounding down never upscales.
    const height = even(Math.min(r.height, src.height));
    const fps = Math.min(r.fps, src.fps);
    const floor = r.minVideoKbps * (height / r.height) ** 2 * (fps / r.fps);
    const audioKbps = src.audio ? r.audioKbps : 0;
    const videoKbps = Math.floor(totalKbps - audioKbps);
    last = { floor, audio: audioKbps };
    if (videoKbps >= floor) {
      const width = even((src.width * height) / src.height);
      return { ok: true, width, height, fps, videoKbps, audioKbps };
    }
  }
  // The smallest whole limit that planShare itself accepts (the video budget is floored to whole kbps).
  let neededMb = Math.ceil(((Math.ceil(last!.floor) + last!.audio) * 1000 * src.seconds) / 8 / TARGET_FRACTION / MB);
  for (let i = 0; i < 8 && !planShare(src, neededMb * MB).ok; i++) neededMb++;
  return { ok: false, neededMb, reason: `the clip is too long for ${+(maxBytes / MB).toFixed(1)} MB (${src.seconds.toFixed(0)} s would play at under ${Math.round(last!.floor)} kbps even at the smallest size); a limit of ${neededMb} MB would work` };
}

// --- arguments (pure) ------------------------------------------------------------------

export type ShareArgs = { no: number; maxMb?: number; json: boolean };
export function parseShareArgs(argv: string[]): ShareArgs {
  const usage = "usage: pnpm share <clip number> [--max-mb <n>]";
  let no: number | undefined, maxMb: number | undefined, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--max-mb") {
      maxMb = Number(argv[++i]);
      if (!(maxMb > 0)) throw new Error(`--max-mb needs a number of megabytes > 0; ${usage}`);
    } else if (/^\d+$/.test(a) && no === undefined && Number(a) >= 1) no = Number(a);
    else throw new Error(`unexpected argument "${a}"; ${usage}`);
  }
  if (no === undefined) throw new Error(usage);
  return { no, maxMb, json };
}

// --- files -------------------------------------------------------------------------------

export const slug = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "clip";
export const shareName = (e: Pick<ClipEntry, "no" | "title">) => `${e.no}-${slug(e.title)}.mp4`;
export const sharePath = (e: Pick<ClipEntry, "no" | "title">) => path.join(SHARE_DIR, shareName(e));
export const findClip = (no: number) => Object.values(readIndex().clips).find((c) => c.no === no);

/**
 * What a share file was made from, written into its own metadata (comment tag), so a valid file
 * with the same key is reused: the clip's id, its file's size and time (a re-render changes them),
 * the limit and the recipe. Kept in the file itself, so no record can disagree with it.
 */
export function shareKey(e: ClipEntry, source: string, maxBytes: number): string {
  const st = statSync(source);
  return createHash("sha256").update(`${RECIPE}:${e.id}:${st.size}:${Math.round(st.mtimeMs)}:${maxBytes}`).digest("hex").slice(0, 16);
}
const TAG = "croclipper-share:";
const readTag = (file: string) => ff(["-i", file]).stderr.match(new RegExp(`comment\\s*:\\s*${TAG}([0-9a-f]+)`))?.[1];

/** Reasons a share file is not acceptable; [] when it is. full: also decode every frame. */
export function validateShare(file: string, src: ShareSource, maxBytes: number, full = true): string[] {
  const p = probe(file);
  if (!p.video || p.unreadable) return [`share streams: ${JSON.stringify(p)}`];
  const reasons: string[] = [];
  if (p.videoCodec !== "h264") reasons.push(`video is ${p.videoCodec}, expected h264`);
  if (src.audio && !p.audio) reasons.push("no audio, the source has it");
  if (p.duration === null || Math.abs(p.duration - src.seconds) > MAX_DURATION_OFF_S) reasons.push(`duration ${p.duration} s vs ${src.seconds.toFixed(2)} s`);
  const bytes = statSync(file).size;
  if (bytes > maxBytes) reasons.push(`${(bytes / MB).toFixed(2)} MB, over the ${(maxBytes / MB).toFixed(1)} MB limit`);
  if (full && !reasons.length) { const err = decodeProblems(file); if (err) reasons.push(`decode: ${err}`); }
  return reasons;
}

export type ShareResult = {
  file: string; // relative to library/, as the page links it
  path: string;
  bytes: number;
  caption: string;
  reused: boolean;
  mode: "crf" | "two-pass" | "reused";
  width: number; height: number; fps: number;
  encodeSeconds: number;
};

/** Makes (or reuses) the share file for clip `no` under maxMb megabytes. Synchronous: the server runs it in a child process. */
export function makeShare(no: number, maxMb: number, log: (s: string) => void = () => {}): ShareResult {
  const e = findClip(no);
  if (!e) throw new ShareRefusal(`no clip ${no}`);
  const source = path.join(LIBRARY_DIR, e.file);
  if (!existsSync(source)) throw new Error(`clip ${no}'s file is missing: ${source}`);
  const maxBytes = Math.floor(maxMb * MB);
  const sp = probe(source);
  const [sw, sh] = (sp.size ?? "").split("x").map(Number);
  if (!sp.video || !sw || !sh || !sp.fps || !sp.duration) throw new Error(`clip ${no}'s file cannot be read: ${JSON.stringify(sp)}`);
  const src: ShareSource = { width: sw, height: sh, fps: sp.fps, seconds: sp.duration, audio: sp.audio };
  const dest = sharePath(e);
  const key = shareKey(e, source, maxBytes);
  const caption = shareCaption(e);
  const result = (mode: ShareResult["mode"], t0: number): ShareResult => {
    const p = probe(dest);
    const [width, height] = (p.size ?? "0x0").split("x").map(Number);
    return { file: path.relative(LIBRARY_DIR, dest).replaceAll("\\", "/"), path: dest, bytes: statSync(dest).size, caption, reused: mode === "reused", mode, width, height, fps: p.fps ?? 0, encodeSeconds: (Date.now() - t0) / 1000 };
  };
  const t0 = Date.now();

  // Reuse: same key in the file's own tag and the checks a finished file must pass (no full
  // decode: only a validated file is ever renamed to this name).
  if (existsSync(dest) && readTag(dest) === key && !validateShare(dest, src, maxBytes, false).length) return result("reused", t0);

  mkdirSync(SHARE_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  const work = mkdtempSync(path.join(os.tmpdir(), "croclipper-share-"));
  const audio = (kbps: number) => (src.audio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${kbps}k`] : ["-an"]);
  const common = ["-map_metadata", "-1", "-metadata", `comment=${TAG}${key}`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"];
  try {
    // 1. Constant quality at the source size and rate; -fs stops it at the limit, so a clip that
    // does not fit costs only the part encoded before it got there (it then fails the duration check).
    log(`clip ${no}: constant-quality encode (x264 CRF ${CRF}, ${src.width}x${src.height}@${src.fps})`);
    const evenSize = src.width % 2 || src.height % 2 ? ["-vf", `scale=${even(src.width)}:${even(src.height)}`] : [];
    let r = ff(["-v", "error", "-y", "-i", source, "-map", "0:v:0", ...evenSize, "-c:v", "libx264", "-preset", "slow", "-crf", String(CRF), ...audio(128), "-fs", String(maxBytes), ...common, tmp]);
    let mode: ShareResult["mode"] = "crf";
    let reasons = r.status === 0 ? validateShare(tmp, src, maxBytes) : [`encode failed: ${r.stderr.slice(0, 300)}`];
    if (reasons.length) {
      // 2. Two-pass at the computed bitrate, on the ladder; one retry a little lower if it overshoots.
      const first = planShare(src, maxBytes);
      if (!first.ok) throw new ShareRefusal(`clip ${no}: ${first.reason}`);
      mode = "two-pass";
      let plan = first;
      for (let attempt = 0; attempt < 2; attempt++) {
        const kbps = plan.videoKbps;
        log(`clip ${no}: two-pass encode at ${plan.width}x${plan.height}@${plan.fps}, ${kbps} kbps video + ${plan.audioKbps} kbps audio`);
        const filters = [plan.height !== src.height || plan.width !== src.width ? `scale=${plan.width}:${plan.height}:flags=lanczos` : "", plan.fps < src.fps ? `fps=${plan.fps}` : ""].filter(Boolean);
        const vf = filters.length ? ["-vf", filters.join(",")] : [];
        const v = ["-map", "0:v:0", ...vf, "-c:v", "libx264", "-preset", "slow", "-b:v", `${kbps}k`, "-passlogfile", path.join(work, "pass")];
        r = ff(["-v", "error", "-y", "-i", source, ...v, "-pass", "1", "-an", "-f", "null", "-"]);
        if (r.status === 0) r = ff(["-v", "error", "-y", "-i", source, ...v, "-pass", "2", ...audio(plan.audioKbps), ...common, tmp]);
        reasons = r.status === 0 ? validateShare(tmp, src, maxBytes) : [`encode failed: ${r.stderr.slice(0, 300)}`];
        const over = existsSync(tmp) ? statSync(tmp).size / maxBytes : 0;
        if (!reasons.length || r.status !== 0 || over <= 1) break;
        // Overshot: plan again against a budget that much smaller, so the floors still hold (a step
        // down the ladder, or a refusal at the bottom, never a starved encode).
        const again = planShare(src, Math.floor((maxBytes / over) * 0.95));
        if (!again.ok) throw new ShareRefusal(`clip ${no}: the encode came out over the limit, and going lower would starve the picture; a limit of ${again.neededMb + 1} MB would work`);
        plan = again;
      }
    }
    if (reasons.length) throw new Error(`clip ${no}: share file not made: ${reasons.join("; ")}`);
    // Windows refuses to replace a file another program has open (a player); say so plainly.
    try { renameSync(tmp, dest); } catch (err) { throw new Error(`could not write ${dest} (open in a player?): ${(err as Error).message}`); }
    return result(mode, t0);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
