// Library: library/clips/<id>.mp4 + library/index.json, and the failure record
// in state/failures.json. Every write goes to a temp path and is renamed into
// place, so a file existing is never mistaken for a finished stage.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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
  kind?: "highlight" | "deaths" | "kills"; // absent: highlight (clips made before the reels)
  leadOverride?: number;
  reel?: { takes: { round: number; tick: number; weapon: string; player: string }[] }; // a reel's takes: who killed the POV (deaths) or whom the POV killed (kills) // seconds of lead-in a re-render asked for instead of config.json → clip.leadInSeconds
  // How the clip was trimmed: "scheduled" = by the scheduled record-start mapping (src/post);
  // absent = clips made before M3's simplification, timed from muzzle flash and gunshots.
  timing?: "scheduled";
  // Where the crosshair in frame comes from (docs/modules.md, Crosshair); absent on clips made before the policy.
  crosshair?: { source: "demo" | "own"; demoPatch: number; cutoff: number | null };
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
  // Unique per writer: pnpm go and its post worker may write state files at the same time.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export const readIndex = () => readJson<Index>(INDEX, { version: 1, clips: {} });

// The index's read-modify-write (publish, delete) runs under a short lock, so a delete from the
// page during a pnpm go run cannot be lost to a publish (or the other way round). Held for
// milliseconds. It is never taken over automatically (two takers could both get in): a lock
// left by a crashed process is reported, to be deleted by hand.
const INDEX_LOCK = path.join(STATE_DIR, ".index.lock");
function withIndexLock<T>(fn: () => T): T {
  mkdirSync(path.dirname(INDEX_LOCK), { recursive: true });
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(INDEX_LOCK, "wx");
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        let age = "";
        try { age = ` (${Math.round((Date.now() - statSync(INDEX_LOCK).mtimeMs) / 1000)} s old)`; } catch {}
        throw new Error(`library index is locked${age}: ${INDEX_LOCK}; if no croclipper command is running, delete it by hand`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally {
    // Only our own lock is released.
    try { if (readFileSync(INDEX_LOCK, "utf8") === token) rmSync(INDEX_LOCK); } catch {}
  }
}

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
  withIndexLock(() => publishLocked(tmp, entry, replaces));
}
function publishLocked(tmp: string, entry: ClipEntry, replaces?: string) {
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
  // Under the index lock: publish clears failures inside it, from either process.
  withIndexLock(() => {
    const failures = readJson<Failures>(FAILURES, {});
    failures[id] = f;
    writeJsonAtomic(FAILURES, failures);
  });
}

export const ensureClipsDir = () => mkdirSync(CLIPS_DIR, { recursive: true });
export { writeJsonAtomic };

// --- deleting ------------------------------------------------------------------------
export const TRASH_DIR = path.join(LIBRARY_DIR, "trash");
const DELETED = path.join(STATE_DIR, "deleted.json");
/** Deleted clips, by id: the entry as it was. A deleted moment counts as done, so it is never made again. */
export const readDeleted = () => readJson<Record<string, ClipEntry & { deletedAt: string }>>(DELETED, {});

/**
 * Deletes the clip with this number: the mp4 moves to library/trash/, the entry leaves the
 * index (its number is never reused: nextNo only grows) and is kept in state/deleted.json,
 * which pnpm go reads as "done". Returns the deleted entry, or undefined when no clip has it.
 */
export function deleteClip(no: number): ClipEntry | undefined {
  return withIndexLock(() => deleteLocked(no));
}
function deleteLocked(no: number): ClipEntry | undefined {
  const index = readIndex();
  const entry = Object.values(index.clips).find((c) => c.no === no);
  if (!entry) return undefined;
  // The file first: if the move fails nothing else has changed, and a retry finds the entry;
  // an entry whose file is already in the trash is simply deleted on the retry.
  if (existsSync(clipPath(entry.id))) {
    mkdirSync(TRASH_DIR, { recursive: true });
    renameSync(clipPath(entry.id), path.join(TRASH_DIR, `${entry.id}.mp4`));
  }
  const deleted = readDeleted();
  deleted[entry.id] = { ...entry, deletedAt: new Date().toISOString() };
  writeJsonAtomic(DELETED, deleted);
  delete index.clips[entry.id];
  writeJsonAtomic(INDEX, index);
  return entry;
}
