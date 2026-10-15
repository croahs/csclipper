// Library: library/clips/<id>.mp4 + library/index.json, and the failure record
// in state/failures.json. Every write goes to a temp path and is renamed into
// place, so a file existing is never mistaken for a finished stage.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, STATE_DIR } from "../config.ts";

export const CLIPS_DIR = path.join(LIBRARY_DIR, "clips");
const INDEX = path.join(LIBRARY_DIR, "index.json");
const FAILURES = path.join(STATE_DIR, "failures.json");

/** PLAN.md: stable hash of (demo hash, round, start_tick, end_tick). */
export const clipId = (demoSha256: string, round: number, startTick: number, endTick: number) =>
  createHash("sha256").update(`${demoSha256}:${round}:${startTick}:${endTick}`).digest("hex").slice(0, 16);

export const clipPath = (id: string) => path.join(CLIPS_DIR, `${id}.mp4`);
/** Per attempt, so two runs can never write or remove each other's temp file. */
export const clipTmpPath = (id: string, attempt: string) => path.join(CLIPS_DIR, `${id}.${attempt}.tmp.mp4`);

export type ClipEntry = {
  id: string;
  // The human clip number ("clip 17"): sequential in the order clips entered the library, stable,
  // never reused or renumbered. Assigned when the entry is written; the id stays the file name.
  no?: number;
  file: string; // relative to library/
  title: string;
  map?: string;
  demo: string;
  demoSha256: string;
  round: number;
  startTick: number;
  endTick: number;
  seconds: number;
  frames: number;
  createdAt: string;
  moment?: Record<string, unknown>; // rank, score and signals when the clip came from pnpm moments
  // How the clip was trimmed: "scheduled" = by the scheduled record-start mapping (src/post);
  // absent = clips made before M3's simplification, timed from muzzle flash and gunshots.
  timing?: "scheduled";
  renderKey: string; // hash of the render inputs below; resumes and skips work, never invalidates a finished clip
  render: Record<string, unknown>; // settings and tool versions
};

type Index = { version: 1; nextNo?: number; clips: Record<string, ClipEntry> };
type Failures = Record<string, { at: string; reasons: string[]; workDir?: string; startTick: number; endTick: number; demo: string }>;

function readJson<T>(file: string, empty: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : empty;
}
function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export const readIndex = () => readJson<Index>(INDEX, { version: 1, clips: {} });

/** Numbers entries that have none (made before numbering), oldest first. nextNo only grows. Runs in publish, under the clip lock. */
function assignNumbers(index: Index): boolean {
  let next = Math.max(index.nextNo ?? 1, ...Object.values(index.clips).map((c) => (c.no ?? 0) + 1));
  const missing = Object.values(index.clips).filter((c) => c.no === undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const c of missing) c.no = next++;
  const changed = missing.length > 0 || index.nextNo !== next;
  index.nextNo = next;
  return changed;
}

/**
 * Drop the old index entry, rename the validated temp clip into place, then
 * record the new entry. A crash between steps leaves a file with no entry,
 * never a file with another render's entry; a rename that fails (e.g. the old
 * file is open in a player) puts the old entry back. `replaces`: a clip of the
 * same moment under another id (pnpm clip --rerender), retired in the same
 * index write, its number taken over.
 */
export function publish(tmp: string, entry: ClipEntry, replaces?: string) {
  const index = readIndex();
  assignNumbers(index);
  const old = index.clips[entry.id];
  // A clip made again keeps its number, under the same id or as the clip it replaces.
  const no = old?.no ?? (replaces ? index.clips[replaces]?.no : undefined);
  if (old) { delete index.clips[entry.id]; writeJsonAtomic(INDEX, index); }
  try {
    renameSync(tmp, clipPath(entry.id));
  } catch (e) {
    if (old) { index.clips[entry.id] = old; writeJsonAtomic(INDEX, index); }
    throw e;
  }
  index.clips[entry.id] = { ...entry, no };
  const retired = !!replaces && replaces !== entry.id && !!index.clips[replaces];
  if (retired) delete index.clips[replaces!];
  assignNumbers(index);
  writeJsonAtomic(INDEX, index);
  // After the index write: a move that fails leaves a file without an entry, never an entry without a file.
  if (retired && existsSync(clipPath(replaces!))) {
    const dir = path.join(path.dirname(CLIPS_DIR), "replaced");
    mkdirSync(dir, { recursive: true });
    renameSync(clipPath(replaces!), path.join(dir, `${replaces}.mp4`));
  }
  const failures = readJson<Failures>(FAILURES, {});
  if (failures[entry.id]) { delete failures[entry.id]; writeJsonAtomic(FAILURES, failures); }
}

/** Failures are kept apart from the library; the latest attempt per id wins. */
export function recordFailure(id: string, f: Failures[string]) {
  const failures = readJson<Failures>(FAILURES, {});
  failures[id] = f;
  writeJsonAtomic(FAILURES, failures);
}

export const ensureClipsDir = () => mkdirSync(CLIPS_DIR, { recursive: true });
export { writeJsonAtomic };
