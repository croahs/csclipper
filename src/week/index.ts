// Best of the week (PLAN.md §6): the top highlights of one ISO week joined into one video at
// library/montage/<yyyy>-W<ww>.mp4, an opening card, a title line over each clip, crossfades, and
// optional music under the game audio. Derived output like a share file: found by its name and the
// key in its own metadata, never written to library/index.json; the source clips are only read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIBRARY_DIR, loadMontage } from "../config.ts";
import { readRegistry } from "../ingest/index.ts";
import { readIndex, type ClipEntry } from "../library/index.ts";
import { clipDate, matchDateOf, readMatchDates } from "../library/match-date.ts";
import { decodeProblems, ff, probe } from "../post/ffmpeg.ts";

export const MONTAGE_DIR = path.join(LIBRARY_DIR, "montage");
/** Bumped when the picture or sound recipe changes, so an older montage is made again. */
const RECIPE = 1;
export const CARD_S = 2;
export const FADE_S = 0.25;
const TITLE_S = 3;
const MUSIC_FADE_S = 3;
const MAX_DURATION_OFF_S = 1;
const MB = 1024 * 1024;
// The reel overlay's font (src/post/index.ts, OVERLAY_FONT); without it the text is left out.
const OVERLAY_FONT = "C:/Windows/Fonts/seguisb.ttf";
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"]);

/** Thrown when there is nothing to make (no such week, fewer than 2 clips); CLI exit 2. */
export class WeekRefusal extends Error {}

// --- ISO weeks (pure; local time, Monday to Sunday) -----------------------------------------

export type IsoWeek = { year: number; week: number };
const DAY = 86_400_000;

/** The ISO week a local date falls in (the week belongs to the year that holds its Thursday). */
export function isoWeekOf(d: Date): IsoWeek {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  return { year, week: Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7) };
}
/** 52 or 53: a year has week 53 when 28 December (always in its last week) is in one. */
export const weeksInYear = (year: number) => isoWeekOf(new Date(year, 11, 28)).week;
export const weekLabel = (w: IsoWeek) => `${w.year}-W${String(w.week).padStart(2, "0")}`;
export const sameWeek = (a: IsoWeek, b: IsoWeek) => a.year === b.year && a.week === b.week;

export function parseIsoWeek(s: string): IsoWeek {
  const m = s.match(/^(\d{4})-?W(\d{1,2})$/i);
  const w = m ? { year: Number(m[1]), week: Number(m[2]) } : undefined;
  if (!w || w.week < 1 || w.week > weeksInYear(w.year)) throw new Error(`"${s}" is not an ISO week (e.g. 2026-W45${w ? `; ${w.year} has ${weeksInYear(w.year)} weeks` : ""})`);
  return w;
}

/** The week's Monday 00:00 and the next Monday 00:00, local time. */
export function weekRange(w: IsoWeek): { start: Date; end: Date } {
  const jan4 = new Date(Date.UTC(w.year, 0, 4)); // always in week 1
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY + (w.week - 1) * 7 * DAY);
  const start = new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2–8 Nov 2026", "30 Nov – 6 Dec 2026", "28 Dec 2026 – 3 Jan 2027": Monday to Sunday. */
export function rangeLabel(w: IsoWeek): string {
  const { start } = weekRange(w);
  const sun = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const d = (x: Date) => `${x.getDate()} ${MONTHS[x.getMonth()]}`;
  if (start.getFullYear() !== sun.getFullYear()) return `${d(start)} ${start.getFullYear()} – ${d(sun)} ${sun.getFullYear()}`;
  if (start.getMonth() !== sun.getMonth()) return `${d(start)} – ${d(sun)} ${sun.getFullYear()}`;
  return `${start.getDate()}–${d(sun)} ${sun.getFullYear()}`;
}

// --- selection (pure) -------------------------------------------------------------------

/** A library clip with the date the page shows it under and whether its file is there. */
export type Dated = { entry: ClipEntry; date: string; exists: boolean };
export type Skip = { no?: number; title: string; reason: string };
export type Selection = { week: IsoWeek; picked: ClipEntry[]; skipped: Skip[]; candidates: number };

const isHighlight = (e: ClipEntry) => (e.kind ?? "highlight") === "highlight";
export const scoreOf = (e: ClipEntry) => {
  const s = (e.moment as { score?: unknown } | undefined)?.score;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
};

/** The most recent week with at least one highlight, or undefined when the library has none. */
export function latestWeek(clips: Dated[]): IsoWeek | undefined {
  const dates = clips.filter((c) => isHighlight(c.entry)).map((c) => c.date).sort();
  return dates.length ? isoWeekOf(new Date(dates[dates.length - 1])) : undefined;
}

/**
 * The week's top `top` highlights by moment score, in play order: ascending score, so the best
 * plays last (ties: lower clip number first). A highlight without a score or whose file is missing
 * is skipped and named. Fewer than 2 to show is a refusal.
 */
export function selectWeek(clips: Dated[], week: IsoWeek, top: number): Selection {
  const inWeek = clips.filter((c) => isHighlight(c.entry) && sameWeek(isoWeekOf(new Date(c.date)), week));
  const skipped: Skip[] = [];
  const ok: ClipEntry[] = [];
  for (const c of inWeek) {
    if (scoreOf(c.entry) === undefined) skipped.push({ no: c.entry.no, title: c.entry.title, reason: "no score" });
    else if (!c.exists) skipped.push({ no: c.entry.no, title: c.entry.title, reason: "file missing" });
    else ok.push(c.entry);
  }
  const byNo = (a: ClipEntry, b: ClipEntry) => (a.no ?? Infinity) - (b.no ?? Infinity) || a.id.localeCompare(b.id);
  // One clip per moment: two library clips of the same demo and round (a re-render kept beside
  // its original) would play the same kills twice; the newer one (higher number) stays.
  const perMoment = new Map<string, ClipEntry>();
  for (const e of [...ok].sort(byNo)) {
    const k = `${e.demoSha256}:${e.round}`;
    const old = perMoment.get(k);
    if (old) skipped.push({ no: old.no, title: old.title, reason: `same round as clip ${e.no ?? "?"}` });
    perMoment.set(k, e);
  }
  ok.length = 0;
  ok.push(...perMoment.values());
  const best = [...ok].sort((a, b) => scoreOf(b)! - scoreOf(a)! || byNo(a, b)).slice(0, top);
  const picked = best.sort((a, b) => scoreOf(a)! - scoreOf(b)! || byNo(a, b));
  if (picked.length < 2) {
    const why = skipped.length ? `; skipped: ${skipped.map((s) => `${s.no ?? "?"} (${s.reason})`).join(", ")}` : "";
    throw new WeekRefusal(`${weekLabel(week)}: ${picked.length} highlight${picked.length === 1 ? "" : "s"} to show of ${inWeek.length} that week, a montage needs at least 2${why}`);
  }
  return { week, picked, skipped, candidates: inWeek.length };
}

/** Length of the montage: the card plus every clip, less one crossfade per joint (card→clip 1 is one). */
export const plannedSeconds = (clipSeconds: number[]) => CARD_S + clipSeconds.reduce((a, b) => a + b, 0) - clipSeconds.length * FADE_S;

// --- the key (pure) -----------------------------------------------------------------------

export type KeyInput = {
  week: IsoWeek;
  clips: { id: string; bytes: number; mtimeMs: number }[]; // in play order
  music: { bytes: number; mtimeMs: number } | null;
  musicGainDb: number;
};
/** What a montage was made from, written into its own comment tag: an unchanged week is reused. */
export function montageKey(k: KeyInput): string {
  const s = JSON.stringify({
    recipe: RECIPE, week: weekLabel(k.week),
    clips: k.clips.map((c) => [c.id, c.bytes, Math.round(c.mtimeMs)]),
    music: k.music ? [k.music.bytes, Math.round(k.music.mtimeMs), k.musicGainDb] : null,
  });
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export const weekCaption = (w: IsoWeek, n: number) => `Best of week ${w.week} · ${n} clips #CS2`;

// --- arguments (pure) -------------------------------------------------------------------

export type WeekArgs = { week?: IsoWeek; top?: number; music?: string; noMusic: boolean; dryRun: boolean; json: boolean };
export function parseWeekArgs(argv: string[]): WeekArgs {
  const usage = "usage: pnpm week [<ISO week, e.g. 2026-W45>] [--top <n>] [--music <file>] [--no-music] [--dry-run] [--json]";
  const a: WeekArgs = { noMusic: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--no-music") a.noMusic = true;
    else if (x === "--top") {
      a.top = Number(argv[++i]);
      if (!Number.isInteger(a.top) || a.top < 2) throw new Error(`--top needs a whole number >= 2; ${usage}`);
    } else if (x === "--music") {
      a.music = argv[++i];
      if (!a.music) throw new Error(`--music needs a file; ${usage}`);
    } else if (/^\d{4}-?W\d{1,2}$/i.test(x) && !a.week) a.week = parseIsoWeek(x);
    else throw new Error(`unexpected argument "${x}"; ${usage}`);
  }
  if (a.music && a.noMusic) throw new Error(`--music and --no-music together; ${usage}`);
  return a;
}

/** --music, else the first audio file by name in montage.musicDir when that folder exists, else none. */
export function pickMusic(a: Pick<WeekArgs, "music" | "noMusic">, musicDir: string | null): string | null {
  if (a.noMusic) return null;
  if (a.music) {
    const f = path.resolve(a.music);
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`--music: no such file: ${f}`);
    return f;
  }
  if (!musicDir || !existsSync(musicDir)) return null;
  const first = readdirSync(musicDir, { withFileTypes: true })
    .filter((d) => d.isFile() && AUDIO_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => d.name)
    .sort((x, y) => x.localeCompare(y, "en", { sensitivity: "base" }))[0];
  return first ? path.join(musicDir, first) : null;
}

// --- the FFmpeg graph (pure) ------------------------------------------------------------

/** A path inside a filter graph option: forward slashes, the drive colon and quotes escaped. */
const filterPath = (p: string) => `'${p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:").replaceAll("'", "'\\\\''")}'`;

export type GraphClip = { seconds: number; audio: boolean; labelFile: string };
export type GraphInput = {
  width: number; height: number; fps: number;
  clips: GraphClip[];
  cardTitleFile: string; cardRangeFile: string;
  music: { input: number; gainDb: number } | null;
  font: string | null;
};

/**
 * One filter_complex: a black card, then every clip at the first clip's size and rate (letterboxed
 * when its aspect differs, never cropped) with its title line, joined by xfade/acrossfade; the
 * music looped to length, faded out, set under the game audio and ducked by it.
 */
export function buildGraph(g: GraphInput): string {
  const { width: W, height: H, fps: R } = g;
  const total = plannedSeconds(g.clips.map((c) => c.seconds));
  const out: string[] = [];
  const aFmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const text = (file: string, size: number, x: string, y: string, extra: string) =>
    g.font ? `,drawtext=fontfile=${filterPath(g.font)}:textfile=${filterPath(file)}:expansion=none:fontsize=${size}:fontcolor=white:x=${x}:y=${y}${extra}` : "";
  // The card: the title and the date range, centred, fading in.
  const big = Math.round(H / 14), small = Math.round(H / 30);
  out.push(`color=c=black:s=${W}x${H}:r=${R}:d=${CARD_S},format=yuv420p,setsar=1`
    + text(g.cardTitleFile, big, "(w-text_w)/2", `(h/2)-${big}`, `:alpha='min(1,t/0.4)'`)
    + text(g.cardRangeFile, small, "(w-text_w)/2", `(h/2)+${Math.round(small * 0.6)}`, `:fontcolor=white@0.75:alpha='min(1,t/0.4)'`)
    + "[vc]");
  out.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${CARD_S},${aFmt}[ac]`);
  // Bottom left, above the HUD's health and armour row, faded out over the last half second.
  const size = Math.round(H / 36);
  const tx = String(Math.round(W * 0.03)), ty = String(Math.round(H * 0.86) - size);
  for (const [i, c] of g.clips.entries()) {
    const d = c.seconds.toFixed(6);
    out.push(`[${i}:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,`
      + `tpad=stop_mode=clone:stop_duration=1,trim=duration=${d},setpts=PTS-STARTPTS`
      + text(c.labelFile, size, tx, ty, `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size / 3)}:enable='lt(t,${TITLE_S})':alpha='min(1,(${TITLE_S}-t)/0.5)'`)
      + `[v${i}]`);
    out.push(c.audio
      ? `[${i}:a]${aFmt},apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${d},${aFmt}[a${i}]`);
  }
  // Crossfades: each joint overlaps the next clip by FADE_S, at the running length less the fade.
  let len = CARD_S, pv = "vc", pa = "ac";
  for (const [i, c] of g.clips.entries()) {
    const last = i === g.clips.length - 1;
    const nv = last ? "vout" : `xv${i}`, na = last && !g.music ? "aout" : `xa${i}`;
    out.push(`[${pv}][v${i}]xfade=transition=fade:duration=${FADE_S}:offset=${(len - FADE_S).toFixed(6)}[${nv}]`);
    out.push(`[${pa}][a${i}]acrossfade=d=${FADE_S}:c1=tri:c2=tri[${na}]`);
    len += c.seconds - FADE_S;
    pv = nv; pa = na;
  }
  if (g.music) {
    // Looped by -stream_loop on its input, cut to length, faded out, gainDb under the game audio,
    // and compressed further while the game audio is loud (keyed on it), so shots stay on top.
    out.push(`[${g.music.input}:a]${aFmt},atrim=duration=${total.toFixed(6)},asetpts=PTS-STARTPTS,volume=${g.music.gainDb}dB,afade=t=out:st=${(total - MUSIC_FADE_S).toFixed(6)}:d=${MUSIC_FADE_S}[mus]`);
    out.push(`[${pa}]asplit=2[game][key]`);
    out.push(`[mus][key]sidechaincompress=threshold=0.03:ratio=8:attack=10:release=350:makeup=1[duck]`);
    // The sum is not normalised, so a shot on top of a music peak could pass full scale: a limiter
    // (lookahead compensated, so nothing shifts) holds it under.
    out.push(`[game][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=-1dB:attack=5:release=100:level=0:latency=1[aout]`);
  }
  return out.join(";");
}

// --- making it --------------------------------------------------------------------------

export const montagePath = (w: IsoWeek) => path.join(MONTAGE_DIR, `${weekLabel(w)}.mp4`);
const TAG = "croclipper-week:";
const readTag = (file: string) => ff(["-i", file]).stderr.match(new RegExp(`comment\\s*:\\s*${TAG}([0-9a-f]+)`))?.[1];

/** Every library clip with the date the page shows it under (match-date.ts) and whether its file exists. */
export function datedClips(): Dated[] {
  const registry = readRegistry();
  const dates = readMatchDates();
  return Object.values(readIndex().clips).map((entry) => ({
    entry,
    date: clipDate(matchDateOf(registry[entry.demoSha256], dates), entry.createdAt),
    exists: existsSync(path.join(LIBRARY_DIR, entry.file)),
  }));
}

/** Reasons a montage file is not acceptable; [] when it is. full: also decode every frame. */
export function validateMontage(file: string, seconds: number, full = true): string[] {
  const p = probe(file);
  if (!p.video || p.unreadable) return [`montage streams: ${JSON.stringify(p)}`];
  const reasons: string[] = [];
  if (p.videoStreams !== 1 || p.audioStreams !== 1) reasons.push(`${p.videoStreams} video and ${p.audioStreams} audio streams, expected 1 and 1`);
  if (p.videoCodec !== "h264") reasons.push(`video is ${p.videoCodec}, expected h264`);
  if (p.duration === null || Math.abs(p.duration - seconds) > MAX_DURATION_OFF_S) reasons.push(`duration ${p.duration} s vs ${seconds.toFixed(2)} s planned`);
  if (full && !reasons.length) { const err = decodeProblems(file); if (err) reasons.push(`decode: ${err}`); }
  return reasons;
}

export type PlayItem = { no?: number; id: string; title: string; score: number; seconds: number };
export type WeekPlan = {
  week: string; range: string; path: string; seconds: number; width: number; height: number; fps: number;
  clips: PlayItem[]; skipped: Skip[]; music: string | null; caption: string; key: string;
};
export type WeekResult = WeekPlan & { bytes: number; reused: boolean; encodeSeconds: number };

/** The selection and everything the encode needs; reads (probes) the clips, writes nothing. */
export function planWeek(a: WeekArgs): WeekPlan & { sources: string[]; audio: boolean[] } {
  const cfg = loadMontage();
  const clips = datedClips();
  const week = a.week ?? latestWeek(clips);
  if (!week) throw new WeekRefusal("the library has no highlights");
  const sel = selectWeek(clips, week, a.top ?? cfg.top);
  const sources = sel.picked.map((e) => path.join(LIBRARY_DIR, e.file));
  const probes = sources.map((f) => probe(f));
  const items: PlayItem[] = [];
  const keep: number[] = [];
  for (const [i, p] of probes.entries()) {
    const e = sel.picked[i];
    if (!p.video || !p.duration || !p.size || !p.fps || p.unreadable) sel.skipped.push({ no: e.no, title: e.title, reason: "file cannot be read" });
    else { keep.push(i); items.push({ no: e.no, id: e.id, title: e.title, score: scoreOf(e)!, seconds: p.duration }); }
  }
  if (items.length < 2) {
    const why = sel.skipped.length ? `; skipped: ${sel.skipped.map((s) => `${s.no ?? "?"} (${s.reason})`).join(", ")}` : "";
    throw new WeekRefusal(`${weekLabel(week)}: ${items.length} highlight${items.length === 1 ? "" : "s"} to show of ${sel.candidates} that week, a montage needs at least 2${why}`);
  }
  const first = probes[keep[0]];
  const [width, height] = first.size!.split("x").map(Number);
  const music = pickMusic(a, cfg.musicDir);
  const st = (f: string) => statSync(f);
  const key = montageKey({
    week,
    clips: keep.map((i) => ({ id: sel.picked[i].id, bytes: st(sources[i]).size, mtimeMs: st(sources[i]).mtimeMs })),
    music: music ? { bytes: st(music).size, mtimeMs: st(music).mtimeMs } : null,
    musicGainDb: cfg.musicGainDb,
  });
  return {
    week: weekLabel(week), range: rangeLabel(week), path: montagePath(week),
    seconds: plannedSeconds(items.map((c) => c.seconds)), width, height, fps: first.fps!,
    clips: items, skipped: sel.skipped, music, caption: weekCaption(week, items.length), key,
    sources: keep.map((i) => sources[i]), audio: keep.map((i) => probes[i].audio),
  };
}

/** Makes (or reuses) the montage the plan describes. */
export function makeWeek(plan: ReturnType<typeof planWeek>, log: (s: string) => void = () => {}): WeekResult {
  const t0 = Date.now();
  const dest = plan.path;
  const { sources: _s, audio: _a, ...pub } = plan;
  const result = (reused: boolean): WeekResult => ({ ...pub, seconds: probe(dest).duration ?? plan.seconds, bytes: statSync(dest).size, reused, encodeSeconds: (Date.now() - t0) / 1000 });
  if (existsSync(dest) && readTag(dest) === plan.key && !validateMontage(dest, plan.seconds, false).length) return result(true);

  mkdirSync(MONTAGE_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  const work = mkdtempSync(path.join(os.tmpdir(), "croclipper-week-"));
  try {
    // Overlay text goes through files with expansion=none, so titles need no escaping.
    const write = (name: string, s: string) => { const f = path.join(work, name); writeFileSync(f, s); return f; };
    const w = parseIsoWeek(plan.week);
    const graph = buildGraph({
      width: plan.width, height: plan.height, fps: plan.fps,
      clips: plan.clips.map((c, i) => ({ seconds: c.seconds, audio: plan.audio[i], labelFile: write(`label-${i}.txt`, `#${c.no ?? "?"}  ${c.title}`) })),
      cardTitleFile: write("card-title.txt", `Best of week ${w.week} · ${w.year}`),
      cardRangeFile: write("card-range.txt", plan.range),
      music: plan.music ? { input: plan.clips.length, gainDb: loadMontage().musicGainDb } : null,
      font: existsSync(OVERLAY_FONT) ? OVERLAY_FONT : null,
    });
    const graphFile = write("graph.txt", graph);
    const inputs = plan.sources.flatMap((f) => ["-i", f]);
    const music = plan.music ? ["-stream_loop", "-1", "-i", plan.music] : [];
    log(`${plan.week}: encoding ${plan.clips.length} clips, ${plan.seconds.toFixed(1)} s at ${plan.width}x${plan.height}@${plan.fps}${plan.music ? `, music ${path.basename(plan.music)}` : ""} (x264 slow CRF 18)`);
    const r = ff(["-v", "error", "-y", ...inputs, ...music, "-/filter_complex", graphFile, "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
      "-map_metadata", "-1", "-metadata", `comment=${TAG}${plan.key}`, "-movflags", "+faststart", "-f", "mp4", tmp]);
    const reasons = r.status === 0 ? validateMontage(tmp, plan.seconds) : [`encode failed: ${r.stderr.slice(0, 500)}`];
    if (reasons.length) throw new Error(`${plan.week}: montage not made: ${reasons.join("; ")}`);
    // Windows refuses to replace a file another program has open (a player); say so plainly.
    try { renameSync(tmp, dest); } catch (err) { throw new Error(`could not write ${dest} (open in a player?): ${(err as Error).message}`); }
    return result(false);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

export const fmtMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
