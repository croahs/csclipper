// pnpm film masters [--dry-run]: an edit-grade file of every clip ticked "Film" on the library page
// (library/film-picks.json), for a DaVinci Resolve edit, at
// library/film/masters/<player, file-safe>/<no>-<slug>.mov. The raw capture of a published clip is
// gone by design (prune.ts), so a master is a new capture: one launch per demo for all its picked clips
// (runJobs, units whose finish writes the master instead of posting), at film.masterCaptureCrf instead
// of render.captureCrf (through the unit's RenderSettings). The command names the clips (the picks),
// which is what AGENTS.md asks of a re-render; the library clip itself is never touched.
// A master is the whole moment at real speed: the clip's span plus film.masterHandleSeconds each side,
// clamped like a reel take; no fast-forward, fades or text. It is the capture itself: the captured
// video stream copied (no second encode), the captured audio as PCM, muxed into .mov. A stream copy
// cuts only at keyframes, so the file is the whole capture of that span, which starts and ends up to
// the controller's capture margin (MARGIN_TICKS, 0.5 s) wider. Idempotent: a master whose file exists
// with the same key in its comment tag (as share copies keep theirs) is skipped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, loadFilm, loadIdentities, loadRoster, loadSettings, povKey, type RenderSettings } from "../config.ts";
import { readRegistry } from "../ingest/index.ts";
import { readIndex, type ClipEntry } from "../library/index.ts";
import { playersOf } from "../library/facets.ts";
import { readPicks } from "../library/stars.ts";
import { parseDemo, povDir, type ParsedDemo } from "../parse/demo.ts";
import { ff, probe } from "../post/ffmpeg.ts";
import { pruneHeldCaptures, pruneTakes } from "../queue/prune.ts";
import { prepareJob, runJobs, type JobResult, type PreparedJob, type RenderUnit, type TakeCapture } from "../queue/job.ts";
import { slug } from "../share/index.ts";
import { clampSpan } from "./bloopers.ts";

export const MASTERS_DIR = path.join(LIBRARY_DIR, "film", "masters");
export const MASTER_TAG = "croclipper-master:";

/** A folder name Windows accepts: reserved characters and controls out, no trailing dot or space; fallback when nothing is left. */
export function folderName(name: string, fallback: string): string {
  const s = name.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/[. ]+$/, "").trim();
  return !s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? fallback : s.slice(0, 60);
}

/** Where a clip's master goes: <folder>/<no>-<slug>.mov under library/film/masters/. */
export const masterPath = (folder: string, e: Pick<ClipEntry, "no" | "title">, root = MASTERS_DIR) => path.join(root, folder, `${e.no}-${slug(e.title)}.mov`);

/**
 * The master's span: the clip's [startTick, endTick] plus handleSeconds on each side, clamped like a reel
 * take (round start, the demo's playable ticks, short of the match end), anchored on the clip's end so
 * the clip's own span always stays whole. Undefined when the parse has no such round.
 */
export function masterSpan(p: ParsedDemo, clip: Pick<ClipEntry, "round" | "startTick" | "endTick">, handleSeconds: number): { startTick: number; endTick: number } | undefined {
  const r = p.rounds.find((x) => x.n === clip.round);
  if (!r) return undefined;
  const h = Math.round(handleSeconds * p.demo.tickrate);
  const s = clampSpan(p, r, clip.endTick, clip.startTick - h, clip.endTick + h);
  return s && s.startTick <= clip.startTick ? s : undefined;
}

/** What a master was made from, in its comment tag: the clip, the span, the handles and the capture settings. */
export function masterKey(o: { clipId: string; startTick: number; endTick: number; handleSeconds: number; settings: Pick<RenderSettings, "width" | "height" | "fps" | "aspect" | "hud" | "captureCrf"> }): string {
  const { width, height, fps, aspect, hud, captureCrf } = o.settings;
  return createHash("sha256").update(JSON.stringify({ v: 1, clip: o.clipId, span: [o.startTick, o.endTick], handleSeconds: o.handleSeconds, capture: { width, height, fps, aspect, hud, captureCrf } })).digest("hex").slice(0, 16);
}

/** FFmpeg's arguments for a master: the captured video stream copied, the audio as 24-bit PCM, .mov, the key in comment. */
export function masterMuxArgs(video: string, audio: string, out: string, key: string): string[] {
  return ["-v", "error", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "pcm_s24le",
    "-map_metadata", "-1", "-metadata", `comment=${MASTER_TAG}${key}`, "-f", "mov", out];
}

/** The key in a master's comment tag, if it has one. */
export const readMasterKey = (file: string) => ff(["-i", file]).stderr.match(new RegExp(`comment\\s*:\\s*${MASTER_TAG}([0-9a-f]+)`))?.[1];
const masterHeld = (file: string, key: string) => existsSync(file) && readMasterKey(file) === key;

export type MasterItem = { no: number; entry: ClipEntry; folder: string; out: string; demo?: string; pov?: string; skip?: string };

/**
 * The plan (pure): every picked clip number the index holds, grouped by its demo, or skipped with the
 * reason (a reel, its demo no longer on disk, its player no longer in the roster). demoFile: the demo's
 * path when it is on disk; resolvePov: a player key (none: the main POV) to its SteamID64, if in the roster;
 * folderOf: a player key (none: the main POV) to its folder name.
 */
export function planMasters(picks: number[], entries: ClipEntry[], o: { demoFile: (sha: string) => string | undefined; resolvePov: (key?: string) => string | undefined; folderOf: (key?: string) => string }): { byDemo: Map<string, MasterItem[]>; skipped: MasterItem[] } {
  const byDemo = new Map<string, MasterItem[]>(), skipped: MasterItem[] = [];
  for (const no of [...new Set(picks)].sort((a, b) => a - b)) {
    const entry = entries.find((e) => e.no === no);
    if (!entry) continue; // a pick of a deleted clip: dropped (the picks file drops it at its next write)
    const folder = o.folderOf(entry.player?.key);
    const item: MasterItem = { no, entry, folder, out: masterPath(folder, entry) };
    const kind = entry.kind ?? "highlight";
    const demo = o.demoFile(entry.demoSha256), pov = o.resolvePov(entry.player?.key);
    if (kind !== "highlight" && kind !== "blooper") skipped.push({ ...item, skip: "a reel has no master (highlights and bloopers only)" });
    else if (!demo) skipped.push({ ...item, skip: "its demo is no longer on disk" });
    else if (!pov) skipped.push({ ...item, skip: "its player is no longer in the roster (.env FILM_STEAM_ID64S)" });
    else byDemo.set(entry.demoSha256, [...(byDemo.get(entry.demoSha256) ?? []), { ...item, demo, pov }]);
  }
  return { byDemo, skipped };
}

/** A master as a render unit: one take over its span at the master CRF; finish muxes the capture into the .mov. */
export function masterUnit(prep: PreparedJob, item: MasterItem, key: string, captureCrf: number): RenderUnit {
  const settings = { ...prep.settings, captureCrf };
  const renderKey = createHash("sha256").update(JSON.stringify({ base: prep.renderKey, master: key })).digest("hex").slice(0, 16);
  const id = `master-${item.entry.id}`, title = `master · ${item.entry.title}`;
  return {
    id, title, demo: prep.demo, demoSha256: prep.facts.demoSha256, map: prep.facts.map, o: prep.o,
    takes: [{ startTick: prep.startTick, endTick: prep.endTick, slot: prep.facts.slot }], startTick: prep.startTick, endTick: prep.endTick, matchEndTick: prep.matchEnd,
    renderKey, settings, ids: prep.ids, look: prep.look, crosshair: prep.crosshair, debugCommands: [],
    inLibrary: () => masterHeld(item.out, key),
    finish: (takes, workDir, attempt, fail) => writeMaster(takes[0], workDir, item.out, key, attempt, { id, title }, fail),
  };
}

function writeMaster(take: TakeCapture, workDir: string, out: string, key: string, attempt: string, u: { id: string; title: string }, fail: (reasons: string[]) => JobResult): JobResult {
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${attempt}.tmp.mov`;
  const r = ff(masterMuxArgs(take.video, take.audio, tmp, key));
  const p = r.status === 0 ? probe(tmp) : undefined;
  if (r.status !== 0 || !p?.video || !p.audio || p.unreadable) {
    rmSync(tmp, { force: true });
    return fail([r.status !== 0 ? `mux failed: ${r.stderr.slice(0, 300)}` : `master streams: ${JSON.stringify(p)}`]);
  }
  renameSync(tmp, out);
  console.log(`master: ${out} (from ${workDir})`);
  // The master holds the capture now; the raw files would otherwise stay (no library entry holds this id).
  for (const m of [...pruneTakes([take]).problems, ...pruneMasterCaptures(u.id).problems]) console.error(`raw capture not removed: ${m}`);
  return { status: "done", id: u.id, title: u.title, clip: out };
}

/**
 * The raw captures recorded under a master's id, every attempt: the normal sweep knows only library ids,
 * so a run that stopped between writing the master and pruning (or an earlier failed attempt) would
 * leave them for good. Called once the master is written, and whenever one is found held.
 */
const pruneMasterCaptures = (unitId: string) => pruneHeldCaptures({ held: new Set([unitId]) });

export type MastersReport = { made: string[]; held: string[]; skipped: string[]; failed: string[]; wouldCapture: number; stoppedBy?: "refusal" | "cleanup" };

/**
 * pnpm film masters: the plan, then per demo one runJobs call for its picked clips whose master is
 * missing or stale. dryRun: lists what it would capture per demo and writes nothing (no capture, no
 * file; the parse caches it reads may be filled, as any dry run's).
 */
export async function runMasters(o: { dryRun?: boolean; timeoutS?: number }): Promise<{ report: MastersReport; code: number }> {
  const film = loadFilm();
  const ids = loadIdentities();
  const entries = Object.values(readIndex().clips);
  const registry = readRegistry();
  let roster: string[] | undefined;
  const resolvePov = (key?: string) => (!key ? ids.pov : (roster ??= loadRoster()).find((id) => povKey(id) === key));
  // Folder names: a friend's from the name on his newest clip (the page's Player label), "Me"'s from the
  // main POV's in-demo name in the parse of his newest clip's demo.
  const names = new Map(playersOf(entries).map((p) => [p.key, p.name]));
  const mine = entries.filter((e) => !e.player).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const myName = (() => { try { return mine ? (JSON.parse(readFileSync(path.join(povDir(mine.demoSha256), "parse.json"), "utf8")) as ParsedDemo).identity.name : ""; } catch { return ""; } })();
  const folderOf = (key?: string) => (key ? folderName(names.get(key) ?? "", `player-${key}`) : folderName(myName, "me"));
  const plan = planMasters(readPicks(), entries, { demoFile: (sha) => (registry[sha] && existsSync(registry[sha].file) ? registry[sha].file : undefined), resolvePov, folderOf });
  const report: MastersReport = { made: [], held: [], skipped: plan.skipped.map((s) => `clip ${s.no} (${s.entry.title}): ${s.skip}`), failed: [], wouldCapture: 0 };
  for (const s of report.skipped) console.log(`skipped: ${s}`);
  let code = 0;
  for (const [sha, items] of plan.byDemo) {
    console.log(`\n${registry[sha]?.originalName ?? sha.slice(0, 12)}: ${items.length} picked clip(s)`);
    const units: RenderUnit[] = [];
    for (const it of items) {
      const label = `clip ${it.no} (${it.entry.title})`;
      try {
        const parsed = await parseDemo(it.demo!, it.pov!, ids.pov);
        const span = masterSpan(parsed, it.entry, film.masterHandleSeconds);
        if (!span) { report.skipped.push(`${label}: its round is not in the demo's parse`); console.log(`skipped: ${label}: its round is not in the parse`); continue; }
        const settings = { ...loadSettings(), captureCrf: film.masterCaptureCrf };
        const key = masterKey({ clipId: it.entry.id, ...span, handleSeconds: film.masterHandleSeconds, settings });
        const rel = path.relative(LIBRARY_DIR, it.out);
        if (masterHeld(it.out, key)) {
          report.held.push(label);
          console.log(`held: ${label} → ${rel}`);
          if (!o.dryRun) for (const m of pruneMasterCaptures(`master-${it.entry.id}`).problems) console.error(`raw capture not removed: ${m}`);
          continue;
        }
        const secs = ((span.endTick - span.startTick) / parsed.demo.tickrate).toFixed(1);
        if (o.dryRun) { report.wouldCapture++; console.log(`would capture: ${label}, ticks ${span.startTick}-${span.endTick} (${secs} s, CRF ${film.masterCaptureCrf}) → ${rel}`); continue; }
        const prep = await prepareJob({ demo: it.demo!, startTick: span.startTick, endTick: span.endTick, timeoutS: o.timeoutS, inBatch: true, ...(it.pov !== ids.pov ? { pov: it.pov } : {}) });
        units.push(masterUnit(prep, it, key, film.masterCaptureCrf));
      } catch (e) {
        report.failed.push(`${label}: ${(e as Error).message}`);
        console.error(`FAILED ${label}: ${(e as Error).message}`);
        code = Math.max(code, 1);
      }
    }
    if (!units.length) continue;
    const results = await runJobs(units); // throws Refusal before any launch: the caller stops
    for (const r of results) {
      if (r.status === "done") report.made.push(`${r.title}: ${r.clip}`);
      else if (r.status === "skipped") report.held.push(r.title);
      else if (r.status === "deferred") report.failed.push(`${r.title}: deferred, another master of this demo already plays past the match end; run pnpm film masters again`);
      else { report.failed.push(`${r.title}: ${r.reasons?.join("; ") ?? r.status}`); code = Math.max(code, 1); }
    }
    if (results.some((r) => r.cleanupVerified === false)) { report.stoppedBy = "cleanup"; return { report, code: 3 }; }
  }
  return { report, code };
}
