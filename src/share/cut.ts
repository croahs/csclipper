// Cut: a shorter copy of a library clip, from <from> to <to> seconds as it plays, at
// library/cuts/<no>-<slug>_<from>-<to>.mp4 (times in tenths of a second, four digits or more: 4.5 s
// to 18.2 s is _0045-0182). Derived output like a share file: found by its name, never written to
// library/index.json, the source clip only read. Several cuts of one clip sit side by side.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, loadCut, loadSettings, type CutSettings } from "../config.ts";
import type { ClipEntry } from "../library/index.ts";
import { decodeProblems, ff, probe } from "../post/ffmpeg.ts";
import { shareCaption } from "./caption.ts";
import { findClip, slug } from "./index.ts";

export const CUT_DIR = path.join(LIBRARY_DIR, "cuts");
/** Bumped when the encode recipe changes, so an older cut is made again. */
export const RECIPE = 1;
const AUDIO_KBPS = 192;
/** A cut must be at least this long. */
export const MIN_CUT_S = 1;
/** `to` this far past the clip's end is clamped to the end (a player's last frame); further is refused. */
export const END_SLACK_S = 0.05;
/** Within this of both ends the cut is the whole clip: nothing to cut. */
export const WHOLE_S = 0.1;
/** The finished file's length must be within this of to - from. */
const MAX_DURATION_OFF_S = 0.1;

/** Thrown when the cut is not one to make (no such clip, times outside the clip, too short, the whole clip); CLI exit 2. */
export class CutRefusal extends Error {}

// --- times and arguments (pure) ----------------------------------------------------------

/** Seconds from "4.5", "12" or "m:ss.s" ("0:04.5", "1:02"); throws on anything else. */
export function parseTime(s: string): number {
  const t = s.trim();
  let m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(t);
  if (m && Number(m[2]) < 60) return Number(m[1]) * 60 + Number(m[2]);
  throw new Error(`"${s}" is not a time: seconds (4.5) or m:ss.s (0:04.5)`);
}

export type CutArgs = { no: number; from: number; to: number; json: boolean };
export function parseCutArgs(argv: string[]): CutArgs {
  const usage = "usage: pnpm cut <clip number> <from> <to> [--json] (seconds, 4.5 or 0:04.5)";
  const pos: string[] = [];
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--")) throw new Error(`unexpected argument "${a}"; ${usage}`);
    else pos.push(a);
  }
  if (pos.length !== 3) throw new Error(usage);
  if (!/^\d+$/.test(pos[0]) || Number(pos[0]) < 1) throw new Error(`"${pos[0]}" is not a clip number; ${usage}`);
  // A leading minus is a time before the clip: parsed here so it is refused as one, not as junk.
  const time = (s: string) => (/^-/.test(s.trim()) ? -parseTime(s.trim().slice(1)) : parseTime(s));
  return { no: Number(pos[0]), from: time(pos[1]), to: time(pos[2]), json };
}

/** Milliseconds are the precision of a cut: the key and the encode both use these. */
const ms = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The cut to make of a clip `clipSeconds` long, or a CutRefusal: from below 0, to more than
 * END_SLACK_S past the end (inside that, clamped to the end), shorter than MIN_CUT_S, or the whole
 * clip (within WHOLE_S at both ends). Times rounded to the millisecond.
 */
export function planCut(from: number, to: number, clipSeconds: number): { from: number; to: number } {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new CutRefusal("from and to must be numbers of seconds");
  if (from < 0) throw new CutRefusal(`from ${from} s is before the clip starts (0 s)`);
  if (to > clipSeconds + END_SLACK_S) throw new CutRefusal(`to ${to} s is past the clip's end (${clipSeconds.toFixed(2)} s)`);
  const f = ms(from), t = ms(Math.min(to, clipSeconds));
  if (t - f < MIN_CUT_S - 1e-9) throw new CutRefusal(`the cut is ${(t - f).toFixed(2)} s; a cut is at least ${MIN_CUT_S} s`);
  if (f <= WHOLE_S && t >= clipSeconds - WHOLE_S) throw new CutRefusal(`${f}-${t} s is the whole clip (${clipSeconds.toFixed(2)} s): nothing to cut`);
  return { from: f, to: t };
}

// --- files and the encode (pure) ---------------------------------------------------------

/** Tenths of a second, at least four digits: 4.5 → "0045", 182.04 → "1820". */
export const tenths = (s: number) => String(Math.round(s * 10)).padStart(4, "0");
/**
 * library/cuts/<no>-<slug>_<from>-<to>.mp4. Two cuts that differ by less than a tenth share a
 * name; the later one replaces the earlier (its key differs), as a new crop does for vertical.
 */
export const cutName = (e: Pick<ClipEntry, "no" | "title">, from: number, to: number) => `${e.no}-${slug(e.title)}_${tenths(from)}-${tenths(to)}.mp4`;
export const cutPath = (e: Pick<ClipEntry, "no" | "title">, from: number, to: number) => path.join(CUT_DIR, cutName(e, from, to));
/** A name cutName could have given clip e: the reveal route takes only these. */
export const isCutName = (e: Pick<ClipEntry, "no" | "title">, name: string) => {
  const prefix = `${e.no}-${slug(e.title)}_`;
  // Exactly the prefix and the two times: nothing between them, so no other file in cuts/ can match.
  return name.startsWith(prefix) && /^\d{4,}-\d{4,}\.mp4$/.test(name.slice(prefix.length));
};

export type CutKeyParts = { id: string; bytes: number; mtimeMs: number; from: number; to: number; fadeSeconds: number; settings: CutSettings; recipe?: number };
/**
 * What a cut was made from, kept in its own metadata (comment tag), so a valid file with the same
 * key is reused and any other is made again: the clip's id, its file's size and time (a re-render
 * changes them), from and to, the fade, the CRF and the recipe.
 */
export function cutKey(k: CutKeyParts): string {
  const text = `${k.recipe ?? RECIPE}:${k.id}:${k.bytes}:${Math.round(k.mtimeMs)}:${ms(k.from)}-${ms(k.to)}:fade${k.fadeSeconds}:crf${k.settings.crf}`;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
const TAG = "croclipper-cut:";
const readTag = (file: string) => ff(["-i", file]).stderr.match(new RegExp(`comment\\s*:\\s*${TAG}([0-9a-f]+)`))?.[1];

/** The fade each end gets: config.json → render.fadeSeconds, at most a quarter of the cut. */
export const cutFade = (fadeSeconds: number, seconds: number) => Math.max(0, Math.min(fadeSeconds, seconds / 4));

export type CutPlan = { source: string; dest: string; from: number; to: number; fade: number; crf: number; audio: boolean; key: string };
/**
 * The FFmpeg arguments: an input seek (-ss before -i decodes from the keyframe before `from` and
 * drops what precedes it, so the first frame is exact, never keyframe-snapped) and -t for the
 * length, then fades in and out on picture and sound; x264 slow, the source size and rate, the
 * sound raw (as the master has it; pnpm share evens it), AAC 192 kbps, faststart.
 */
export function cutArgs(p: CutPlan): string[] {
  const len = ms(p.to - p.from);
  const f = cutFade(p.fade, len);
  const out = (len - f).toFixed(6);
  const vf = f > 0 ? ["-vf", `fade=t=in:st=0:d=${f},fade=t=out:st=${out}:d=${f}`] : [];
  const audio = p.audio ? ["-map", "0:a:0", ...(f > 0 ? ["-af", `afade=t=in:st=0:d=${f},afade=t=out:st=${out}:d=${f}`] : []), "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`] : ["-an"];
  return ["-v", "error", "-y", "-ss", p.from.toFixed(3), "-t", len.toFixed(3), "-i", p.source, "-map", "0:v:0", ...vf,
    "-c:v", "libx264", "-preset", "slow", "-crf", String(p.crf), "-pix_fmt", "yuv420p", ...audio,
    "-map_metadata", "-1", "-metadata", `comment=${TAG}${p.key}`, "-movflags", "+faststart", "-f", "mp4", p.dest];
}

type Source = { size: string; fps: number; audio: boolean };
/** Reasons a cut is not acceptable; [] when it is. full: also decode every frame. */
export function validateCut(file: string, src: Source, seconds: number, full = true): string[] {
  const p = probe(file);
  if (!p.video || p.unreadable) return [`cut streams: ${JSON.stringify(p)}`];
  const reasons: string[] = [];
  if (p.videoCodec !== "h264") reasons.push(`video is ${p.videoCodec}, expected h264`);
  if (p.size !== src.size) reasons.push(`size ${p.size}, the source is ${src.size}`);
  if (p.fps !== src.fps) reasons.push(`${p.fps} fps, the source is ${src.fps}`);
  if (src.audio && !p.audio) reasons.push("no audio, the source has it");
  if (p.duration === null || Math.abs(p.duration - seconds) > MAX_DURATION_OFF_S) reasons.push(`duration ${p.duration} s vs ${seconds.toFixed(2)} s`);
  if (full && !reasons.length) { const err = decodeProblems(file); if (err) reasons.push(`decode: ${err}`); }
  return reasons;
}

export type CutResult = {
  file: string; // relative to library/, as the page links it
  path: string;
  bytes: number;
  seconds: number; // the cut file's duration
  from: number; to: number;
  caption: string;
  reused: boolean;
  encodeSeconds: number;
};

/** The clip and its playing length, or a CutRefusal; the server checks a request with this before it spawns. */
export function cutSource(no: number) {
  const e = findClip(no);
  if (!e) throw new CutRefusal(`no clip ${no}`);
  const source = path.join(LIBRARY_DIR, e.file);
  if (!existsSync(source)) throw new Error(`clip ${no}'s file is missing: ${source}`);
  const sp = probe(source);
  if (!sp.video || !sp.size || !sp.fps || !sp.duration) throw new Error(`clip ${no}'s file cannot be read: ${JSON.stringify(sp)}`);
  return { e, source, probe: sp, seconds: sp.duration };
}

/** Makes (or reuses) the cut of clip `no` from `from` to `to` seconds. Synchronous, like makeShare, so a server can run it in a child process. */
export function makeCut(no: number, from: number, to: number, log: (s: string) => void = () => {}, settings = loadCut(), fadeSeconds = loadSettings().fadeSeconds): CutResult {
  const { e, source, probe: sp, seconds } = cutSource(no);
  const cut = planCut(from, to, seconds);
  const src: Source = { size: sp.size!, fps: sp.fps!, audio: sp.audio };
  const dest = cutPath(e, cut.from, cut.to);
  const st = statSync(source);
  const key = cutKey({ id: e.id, bytes: st.size, mtimeMs: st.mtimeMs, ...cut, fadeSeconds, settings });
  const len = cut.to - cut.from;
  const caption = shareCaption(e);
  const t0 = Date.now();
  const result = (reused: boolean): CutResult => ({ file: path.relative(LIBRARY_DIR, dest).replaceAll("\\", "/"), path: dest, bytes: statSync(dest).size, seconds: probe(dest).duration ?? 0, ...cut, caption, reused, encodeSeconds: (Date.now() - t0) / 1000 });

  // Reuse: same key in the file's own tag and the checks a finished file must pass (no full
  // decode: only a validated file is ever renamed to this name).
  if (existsSync(dest) && readTag(dest) === key && !validateCut(dest, src, len, false).length) return result(true);

  mkdirSync(CUT_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  try {
    log(`clip ${no}: ${cut.from}-${cut.to} s of ${seconds.toFixed(2)} s, ${src.size}@${src.fps} (x264 CRF ${settings.crf}, fades ${cutFade(fadeSeconds, len).toFixed(2)} s)`);
    const r = ff(cutArgs({ source, dest: tmp, ...cut, fade: fadeSeconds, crf: settings.crf, audio: src.audio, key }));
    const reasons = r.status === 0 ? validateCut(tmp, src, len) : [`encode failed: ${r.stderr.slice(0, 300)}`];
    if (reasons.length) throw new Error(`clip ${no}: cut not made: ${reasons.join("; ")}`);
    // Windows refuses to replace a file another program has open (a player); say so plainly.
    try { renameSync(tmp, dest); } catch (err) { throw new Error(`could not write ${dest} (open in a player?): ${(err as Error).message}`); }
    return result(false);
  } finally {
    rmSync(tmp, { force: true });
  }
}
