// Best of the week (PLAN.md §6): the fragmovie. The week's top highlights cut down to the shots
// around their kills, placed on the music's beat grid so every shot's first kill lands on an
// anchor, at library/montage/<yyyy>-W<ww>.mp4. Derived output like a share file: found by its name
// and the key in its own metadata, never written to library/index.json; the source clips are only read.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIBRARY_DIR, loadMontage, type MontageSettings } from "../config.ts";
import { readRegistry } from "../ingest/index.ts";
import { readIndex, type ClipEntry } from "../library/index.ts";
import { clipDate, matchDateOf, readMatchDates } from "../library/match-date.ts";
import { decodeProblems, ff, probe } from "../post/ffmpeg.ts";
import { planTrack, unitBeats, type MusicPlan } from "./beats.ts";
import { buildShots, fastRanges, fitCap, killVideoTime, tickSeconds, toFrames, type ClipCut, type FramePlan, type Grid, type Segment, type ShotRules } from "./edit.ts";
import { loadManifest, manifestEntry, pickTrack, trackAnalysis } from "./music.ts";

export const MONTAGE_DIR = path.join(LIBRARY_DIR, "montage");
/** Bumped when the picture or sound recipe changes, so an older montage is made again. 2: the fragmovie. */
const RECIPE = 2;
/** --no-music: the same cut on a fixed grid. */
export const NO_MUSIC_GRID: Grid = { unit: 0.6, bar: 2.4 };
const LABEL_S = 1.2;
const CLICK_FADE_S = 0.02;
const MAX_DURATION_OFF_S = 0.25;
const AUDIO_RATE = 48000;
const MB = 1024 * 1024;
// The reel overlay's font (src/post/index.ts, OVERLAY_FONT); without it the text is left out.
const OVERLAY_FONT = "C:/Windows/Fonts/seguisb.ttf";

/** Thrown when there is nothing to make (no such week, fewer than 2 clips, no track); CLI exit 2. */
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

// The main account's highlights only: a film player's (entry.player) and bloopers never go in the montage.
const isHighlight = (e: ClipEntry) => (e.kind ?? "highlight") === "highlight" && !e.player;
export const scoreOf = (e: ClipEntry) => {
  const s = (e.moment as { score?: unknown } | undefined)?.score;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
};

/** The most recent week with at least one highlight, or undefined when the library has none. */
export function latestWeek(clips: Dated[]): IsoWeek | undefined {
  const dates = clips.filter((c) => isHighlight(c.entry)).map((c) => c.date).sort();
  return dates.length ? isoWeekOf(new Date(dates[dates.length - 1])) : undefined;
}

/** The kill ticks and the time map a clip needs to be cut into shots, or undefined (old entries). */
export function cutInfo(e: ClipEntry): { killTicks: number[]; segments: Segment[] } | undefined {
  const k = (e.moment as { killTicks?: unknown } | undefined)?.killTicks;
  const s = (e.render as { segments?: unknown } | undefined)?.segments;
  const ok = Array.isArray(k) && k.length > 0 && k.every((x) => typeof x === "number")
    && Array.isArray(s) && s.length > 0 && s.every((x) => typeof x?.startTick === "number" && typeof x?.endTick === "number" && typeof x?.speed === "number" && typeof x?.outSeconds === "number");
  return ok ? { killTicks: k as number[], segments: s as Segment[] } : undefined;
}

const refuseFew = (week: IsoWeek, n: number, of: number, skipped: Skip[]) => {
  const why = skipped.length ? `; skipped: ${skipped.map((s) => `${s.no ?? "?"} (${s.reason})`).join(", ")}` : "";
  return new WeekRefusal(`${weekLabel(week)}: ${n} highlight${n === 1 ? "" : "s"} to show of ${of} that week, a montage needs at least 2${why}`);
};

/**
 * The week's top `top` highlights by moment score, in play order: ascending score, so the best
 * plays last (ties: lower clip number first). A highlight without a score, whose file is missing,
 * or that cannot be cut into shots (no kill ticks or time map: entries made before those were
 * recorded) is skipped and named. Fewer than 2 to show is a refusal.
 */
export function selectWeek(clips: Dated[], week: IsoWeek, top: number): Selection {
  const inWeek = clips.filter((c) => isHighlight(c.entry) && sameWeek(isoWeekOf(new Date(c.date)), week));
  const skipped: Skip[] = [];
  const ok: ClipEntry[] = [];
  for (const c of inWeek) {
    if (scoreOf(c.entry) === undefined) skipped.push({ no: c.entry.no, title: c.entry.title, reason: "no score" });
    else if (!cutInfo(c.entry)) skipped.push({ no: c.entry.no, title: c.entry.title, reason: "no kill ticks or time map (made before they were recorded)" });
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
  const best = [...perMoment.values()].sort((a, b) => scoreOf(b)! - scoreOf(a)! || byNo(a, b)).slice(0, top);
  const picked = best.sort((a, b) => scoreOf(a)! - scoreOf(b)! || byNo(a, b));
  if (picked.length < 2) throw refuseFew(week, picked.length, inWeek.length, skipped);
  return { week, picked, skipped, candidates: inWeek.length };
}

/** A clip's shots (clip seconds) from its kill ticks and time map. */
export function clipShots(e: ClipEntry, clipSeconds: number, rules: ShotRules) {
  const c = cutInfo(e)!;
  return buildShots(c.killTicks.map((t) => tickSeconds(c.segments, t)), clipSeconds, fastRanges(c.segments), rules);
}

/** "#257 · 4k USP-S": the number and the title less its map and round. */
export function shotLabel(e: Pick<ClipEntry, "no" | "title">): string {
  const parts = e.title.split(" · ");
  const rest = parts.length > 2 && /^R\d+$/.test(parts[1]) ? parts.slice(2) : parts.slice(-1);
  return `#${e.no ?? "?"} · ${rest.join(" · ")}`;
}

// --- the key (pure) -----------------------------------------------------------------------

export type KeyInput = {
  week: IsoWeek;
  clips: { id: string; bytes: number; mtimeMs: number }[]; // in play order
  shot: ShotRules;
  maxSeconds: number;
  track: { bytes: number; mtimeMs: number; bpm: number; phase: number; start: number } | null;
  musicGainDb: number;
};
/** What a montage was made from, written into its own comment tag: an unchanged week is reused. */
export function montageKey(k: KeyInput): string {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  const s = JSON.stringify({
    recipe: RECIPE, week: weekLabel(k.week),
    clips: k.clips.map((c) => [c.id, c.bytes, Math.round(c.mtimeMs)]),
    shot: [k.shot.preSeconds, k.shot.postSeconds], max: k.maxSeconds,
    track: k.track ? [k.track.bytes, Math.round(k.track.mtimeMs), r(k.track.bpm), r(k.track.phase), r(k.track.start), k.musicGainDb] : null,
  });
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export const weekCaption = (w: IsoWeek, n: number, credit: string | null) => `Best of week ${w.week} · ${n} clips #CS2${credit ? `\n${credit}` : ""}`;

// --- arguments (pure) -------------------------------------------------------------------

export type WeekArgs = { week?: IsoWeek; top?: number; seconds?: number; music?: string; noMusic: boolean; dryRun: boolean; json: boolean };
export function parseWeekArgs(argv: string[]): WeekArgs {
  const usage = "usage: pnpm week [<ISO week, e.g. 2026-W45>] [--top <n>] [--seconds <n>] [--music <file>] [--no-music] [--dry-run] [--json]";
  const a: WeekArgs = { noMusic: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--no-music") a.noMusic = true;
    else if (x === "--top") {
      a.top = Number(argv[++i]);
      if (!Number.isInteger(a.top) || a.top < 2) throw new Error(`--top needs a whole number >= 2; ${usage}`);
    } else if (x === "--seconds") {
      a.seconds = Number(argv[++i]);
      if (!(a.seconds >= 10)) throw new Error(`--seconds needs a number >= 10; ${usage}`);
    } else if (x === "--music") {
      a.music = argv[++i];
      if (!a.music) throw new Error(`--music needs a file; ${usage}`);
    } else if (/^\d{4}-?W\d{1,2}$/i.test(x) && !a.week) a.week = parseIsoWeek(x);
    else throw new Error(`unexpected argument "${x}"; ${usage}`);
  }
  if (a.music && a.noMusic) throw new Error(`--music and --no-music together; ${usage}`);
  return a;
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

export type PlayItem = { no?: number; id: string; title: string; score: number; shots: number };
export type PlanShot = {
  no?: number;
  /** Seconds in the clip file played, [in, out). */
  in: number; out: number;
  /** Seconds in the video: the cut into this shot, the cut out of it, and the anchor its first kill sits on. */
  at: number; end: number; anchor: number;
  /** The kills it shows, as video seconds. */
  kills: number[];
  label: string | null;
  /** Seconds the last frame of footage is held (the clip ended or a fast-forward stretch began), and how many shots of the same clip were merged into this one. */
  hold: number; merged: number;
};
export type TrackInfo = {
  file: string; bpm: number; phase: number; start: number; unitBeats: number; unitSeconds: number; barSeconds: number;
  loopSeconds: number | null; refit: boolean; refitRejected: boolean; driftMs: MusicPlan["driftMs"]; credit: string | null; analysisCached: boolean;
};
export type WeekPlan = {
  week: string; range: string; path: string; seconds: number; width: number; height: number; fps: number;
  maxSeconds: number; overCap: boolean; card: number; closeAt: number;
  clips: PlayItem[]; dropped: PlayItem[]; skipped: Skip[]; shots: PlanShot[];
  track: TrackInfo | null; musicGainDb: number; credit: string | null; caption: string; key: string;
};
export type WeekResult = WeekPlan & { bytes: number; reused: boolean; encodeSeconds: number };
type Internal = { sources: string[]; audio: boolean[]; frames: FramePlan; labels: (string | null)[]; trackPath: string | null };

/** The selection, the cut and everything the encode needs; reads (probes, analyses) only. */
export function planWeek(a: WeekArgs, cfg: MontageSettings = loadMontage()): WeekPlan & { internal: Internal } {
  const clips = datedClips();
  const week = a.week ?? latestWeek(clips);
  if (!week) throw new WeekRefusal("the library has no highlights");
  const sel = selectWeek(clips, week, a.top ?? cfg.top);
  const rules = cfg.shot, maxSeconds = a.seconds ?? cfg.maxSeconds;

  // The clips that can be read, with their shots.
  type Usable = { e: ClipEntry; file: string; audio: boolean; cut: ClipCut; size: string; fps: number };
  const usable: Usable[] = [];
  for (const e of sel.picked) {
    const file = path.join(LIBRARY_DIR, e.file), p = probe(file);
    if (!p.video || !p.duration || !p.size || !p.fps || p.unreadable) { sel.skipped.push({ no: e.no, title: e.title, reason: "file cannot be read" }); continue; }
    const shots = clipShots(e, p.duration, rules);
    usable.push({ e, file, audio: p.audio, cut: { clip: usable.length, shots }, size: p.size, fps: p.fps });
  }
  if (usable.length < 2) throw refuseFew(week, usable.length, sel.candidates, sel.skipped);
  const [width, height] = usable[0].size.split("x").map(Number);
  const fps = usable[0].fps;

  // The track and its grid. The length depends on the grid and the grid's fit on the length, so
  // the cut is laid out on the whole-file grid, the track planned for that length, and the cut
  // laid out again on the grid used (the lengths differ by a frame or two at most).
  const tracks = loadManifest();
  let trackPath: string | null = null, track: TrackInfo | null = null;
  let grid = NO_MUSIC_GRID;
  let fit = fitCap(usable.map((u) => u.cut), grid, maxSeconds);
  if (!a.noMusic) {
    trackPath = pickTrack(a.music, cfg.music);
    if (!trackPath) throw new WeekRefusal("no music track: music/ is empty. pnpm music downloads the default tracks (or use --music <file>, or --no-music)");
    const entry = manifestEntry(trackPath, tracks);
    // A dry run analyses in memory only: it writes nothing, not even the beats cache.
    const { analysis, env, cached } = trackAnalysis(trackPath, entry?.bpm ?? null, !a.dryRun);
    const gridOf = (bpm: number) => { const beat = 60 / bpm, n = unitBeats(beat); return { grid: { unit: n * beat, bar: 4 * beat }, n }; };
    fit = fitCap(usable.map((u) => u.cut), gridOf(analysis.bpm).grid, maxSeconds);
    let mp = planTrack(env, analysis, fit.timeline.total);
    for (let i = 0; i < 3; i++) {
      fit = fitCap(usable.map((u) => u.cut), gridOf(mp.bpm).grid, maxSeconds);
      if (fit.timeline.total <= mp.bars * 4 * mp.beatSeconds + 1e-6) break;
      mp = planTrack(env, analysis, fit.timeline.total);
    }
    const g = gridOf(mp.bpm);
    grid = g.grid;
    track = {
      file: trackPath, bpm: mp.bpm, phase: mp.phase, start: mp.start, unitBeats: g.n, unitSeconds: grid.unit, barSeconds: grid.bar,
      loopSeconds: mp.loopSeconds, refit: mp.refit, refitRejected: mp.refitRejected, driftMs: mp.driftMs, credit: entry?.credit ?? null, analysisCached: cached,
    };
  }
  const tl = fit.timeline;
  const frames = toFrames(tl, fps);
  const keptIdx = new Set(fit.kept.map((c) => c.clip));
  const item = (u: Usable): PlayItem => ({ no: u.e.no, id: u.e.id, title: u.e.title, score: scoreOf(u.e)!, shots: u.cut.shots.length });
  const seen = new Set<number>();
  const labels = frames.shots.map((s) => (seen.has(s.clip) ? null : (seen.add(s.clip), shotLabel(usable[s.clip].e))));
  const shots: PlanShot[] = frames.shots.map((s, i) => ({
    no: usable[s.clip].e.no,
    in: s.inFrame / fps, out: (s.inFrame + s.frames - s.holdFrames) / fps,
    at: s.cutFrame / fps, end: (s.cutFrame + s.frames) / fps, anchor: s.anchor,
    kills: s.kills.map((k) => killVideoTime(s, k, fps)),
    label: labels[i], hold: s.holdFrames / fps, merged: s.merged,
  }));
  const kept = usable.filter((u) => keptIdx.has(u.cut.clip));
  const st = (f: string) => statSync(f);
  const credit = track ? track.credit : null;
  const key = montageKey({
    week,
    clips: kept.map((u) => ({ id: u.e.id, bytes: st(u.file).size, mtimeMs: st(u.file).mtimeMs })),
    shot: rules, maxSeconds,
    track: track && trackPath ? { bytes: st(trackPath).size, mtimeMs: st(trackPath).mtimeMs, bpm: track.bpm, phase: track.phase, start: track.start } : null,
    musicGainDb: cfg.musicGainDb,
  });
  return {
    week: weekLabel(week), range: rangeLabel(week), path: montagePath(week), seconds: frames.total, width, height, fps,
    maxSeconds, overCap: fit.over, card: frames.cardFrames / fps, closeAt: tl.closeAt,
    clips: kept.map(item), dropped: usable.filter((u) => !keptIdx.has(u.cut.clip)).map(item), skipped: sel.skipped, shots,
    track, musicGainDb: cfg.musicGainDb, credit, caption: weekCaption(week, kept.length, credit), key,
    internal: { sources: usable.map((u) => u.file), audio: usable.map((u) => u.audio), frames, labels, trackPath },
  };
}

/** A path inside a filter graph option: forward slashes, the drive colon and quotes escaped. */
const filterPath = (p: string) => `'${p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:").replaceAll("'", "'\\\\''")}'`;
const A_FMT = `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
/** Intermediates: lossless H.264 and PCM in NUT (exact time bases, so the concat adds no rounding). */
const LOSSLESS = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-f", "nut"];

export type MakeOptions = {
  /** Write here instead of the montage path (no reuse check); the verification renders use it. */
  dest?: string;
  /** Leave the music out (game audio only), same cut: the sync check measures the shots' own sound. */
  withoutMusic?: boolean;
};

/** Makes (or reuses) the montage the plan describes. */
export function makeWeek(plan: ReturnType<typeof planWeek>, log: (s: string) => void = () => {}, opt: MakeOptions = {}): WeekResult {
  const t0 = Date.now();
  const dest = opt.dest ?? plan.path;
  const { internal: x, ...pub } = plan;
  const result = (reused: boolean): WeekResult => ({ ...pub, path: dest, seconds: probe(dest).duration ?? plan.seconds, bytes: statSync(dest).size, reused, encodeSeconds: (Date.now() - t0) / 1000 });
  if (!opt.dest && existsSync(dest) && readTag(dest) === plan.key && !validateMontage(dest, plan.seconds, false).length) return result(true);

  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  const work = mkdtempSync(path.join(os.tmpdir(), "croclipper-week-"));
  try {
    const { width: W, height: H, fps: R } = plan;
    const F = x.frames;
    const samples = (frames: number) => Math.round((frames / R) * AUDIO_RATE);
    // Overlay text goes through files with expansion=none, so titles need no escaping.
    const write = (name: string, s: string) => { const f = path.join(work, name); writeFileSync(f, s); return f; };
    const font = existsSync(OVERLAY_FONT) ? OVERLAY_FONT : null;
    const text = (file: string, size: number, xx: string, y: string, extra: string) =>
      font ? `,drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(file)}:expansion=none:fontsize=${size}:fontcolor=white:x=${xx}:y=${y}${extra}` : "";
    const run = (what: string, args: string[]) => {
      const r = ff(["-v", "error", "-y", ...args]);
      if (r.status !== 0) throw new Error(`${plan.week}: ${what} failed: ${r.stderr.slice(0, 600)}`);
    };
    const parts: { file: string; frames: number }[] = [];

    // The card: one bar on black, the title and the week's dates, silent.
    const w = parseIsoWeek(plan.week);
    const big = Math.round(H / 12), small = Math.round(H / 28);
    const card = path.join(work, "card.nut");
    run("the title card", ["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${R}`, "-f", "lavfi", "-i", `anullsrc=r=${AUDIO_RATE}:cl=stereo`,
      "-filter_complex", `[0:v]format=yuv420p,setsar=1`
        + text(write("card-title.txt", `Best of week ${w.week}`), big, "(w-text_w)/2", `(h/2)-${big}`, `:alpha='min(1,t/0.15)'`)
        + text(write("card-range.txt", plan.range), small, "(w-text_w)/2", `(h/2)+${Math.round(small * 0.7)}`, `:fontcolor=white@0.8:alpha='min(1,t/0.15)'`)
        + `,trim=end_frame=${F.cardFrames}[v];[1:a]${A_FMT},atrim=end_sample=${samples(F.cardFrames)}[a]`,
      "-map", "[v]", "-map", "[a]", "-frames:v", String(F.cardFrames), ...LOSSLESS, card]);
    parts.push({ file: card, frames: F.cardFrames });

    // Each shot: from its in-frame for its frames, at the first clip's size and rate (letterboxed,
    // never cropped), the label on a clip's first shot, the game audio with 20 ms fades at both ends.
    const size = Math.round(H / 32);
    const tx = String(Math.round(W * 0.03)), ty = String(Math.round(H * 0.86) - size);
    log(`${plan.week}: cutting ${F.shots.length} shots from ${plan.clips.length} clips`);
    for (const [i, s] of F.shots.entries()) {
      const out = path.join(work, `shot-${String(i).padStart(3, "0")}.nut`);
      const src = x.sources[s.clip];
      // Input seek just before the in-frame: FFmpeg decodes from the keyframe before it and drops
      // every frame (and audio sample) before the seek point, so the first frame out is inFrame.
      const seek = s.inFrame > 0 ? ["-ss", ((s.inFrame - 0.001) / R).toFixed(6)] : [];
      const last = i === F.shots.length - 1;
      // The game audio ends with the footage (a held frame is silent) and before the closing fade.
      const foot = (s.frames - s.holdFrames) / R;
      const gameEnd = Math.max(CLICK_FADE_S, last ? Math.min(foot, F.closeAt - s.cutFrame / R) : foot);
      const label = x.labels[i];
      const vf = `[0:v]fps=${R},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,`
        + `trim=end_frame=${s.frames - s.holdFrames},tpad=stop_mode=clone:stop_duration=${(s.holdFrames / R + 1).toFixed(3)},trim=end_frame=${s.frames},setpts=PTS-STARTPTS`
        + (label ? text(write(`label-${i}.txt`, label), size, tx, ty, `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size / 3)}:enable='lt(t,${LABEL_S})'`) : "")
        + "[v]";
      const audioIn = x.audio[s.clip] ? "[0:a]" : "[1:a]";
      const af = `${audioIn}${A_FMT},asetpts=PTS-STARTPTS,afade=t=in:d=${CLICK_FADE_S},afade=t=out:st=${(gameEnd - CLICK_FADE_S).toFixed(6)}:d=${CLICK_FADE_S},apad,atrim=end_sample=${samples(s.frames)}[a]`;
      run(`shot ${i + 1}`, [...seek, "-i", src, ...(x.audio[s.clip] ? [] : ["-f", "lavfi", "-i", `anullsrc=r=${AUDIO_RATE}:cl=stereo`]),
        "-filter_complex", `${vf};${af}`, "-map", "[v]", "-map", "[a]", "-frames:v", String(s.frames), ...LOSSLESS, out]);
      parts.push({ file: out, frames: s.frames });
    }
    // Each part's duration stated exactly: the demuxer would otherwise take the last frame's
    // timestamp (one frame short per part, measured: 0.27 s over 26 parts).
    const list = write("parts.txt", parts.map((p) => `file '${p.file.replaceAll("\\", "/")}'\nduration ${(p.frames / R).toFixed(9)}`).join("\n") + "\n");

    // The final encode: the parts joined, the picture faded over the last bar, the music from its
    // bar line at gainDb, lightly ducked by the game audio, then the limiter.
    const total = F.total, close = F.closeAt, fadeLen = total - close;
    const music = !opt.withoutMusic && plan.track && x.trackPath ? plan.track : null;
    const graph = [`[0:v]fade=t=out:st=${close.toFixed(6)}:d=${fadeLen.toFixed(6)}[vout]`];
    if (music) {
      const cut = music.loopSeconds
        ? `atrim=start=${music.start.toFixed(6)}:end=${(music.start + music.loopSeconds).toFixed(6)},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${Math.round(music.loopSeconds * AUDIO_RATE)},atrim=duration=${total.toFixed(6)}`
        : `atrim=start=${music.start.toFixed(6)}:duration=${total.toFixed(6)},asetpts=PTS-STARTPTS`;
      graph.push(`[1:a]${A_FMT},${cut},volume=${plan.musicGainDb}dB,afade=t=out:st=${close.toFixed(6)}:d=${fadeLen.toFixed(6)}[mus]`);
      graph.push(`[0:a]${A_FMT},asplit=2[game][key]`);
      // Light ducking: about 3 dB off the music under a gunshot, back within a quarter second.
      graph.push(`[mus][key]sidechaincompress=threshold=0.1:ratio=2.5:attack=5:release=250:makeup=1[duck]`);
      graph.push(`[game][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=-1dB:attack=5:release=100:level=0:latency=1[aout]`);
    } else graph.push(`[0:a]${A_FMT},alimiter=limit=-1dB:attack=5:release=100:level=0:latency=1[aout]`);
    log(`${plan.week}: encoding ${total.toFixed(1)} s at ${W}x${H}@${R}${music ? `, music ${path.basename(music.file)} from ${music.start.toFixed(2)} s` : ", no music"} (x264 slow CRF 18)`);
    run("the encode", ["-f", "concat", "-safe", "0", "-i", list, ...(music ? ["-i", music.file] : []),
      "-/filter_complex", write("graph.txt", graph.join(";")), "-map", "[vout]", "-map", "[aout]", "-frames:v", String(F.totalFrames),
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
      "-map_metadata", "-1", "-metadata", `comment=${TAG}${plan.key}`, "-movflags", "+faststart", "-f", "mp4", tmp]);
    const reasons = validateMontage(tmp, plan.seconds);
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
