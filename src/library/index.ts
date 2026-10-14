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
  renderKey: string; // hash of everything below that affects the output
  render: Record<string, unknown>; // settings and tool versions
};

type Index = { version: 1; clips: Record<string, ClipEntry> };
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

/**
 * Drop the old index entry, rename the validated temp clip into place, then
 * record the new entry. A crash between steps leaves a file with no entry,
 * which is re-rendered, never a file with another render's entry.
 */
export function publish(tmp: string, entry: ClipEntry) {
  const index = readIndex();
  if (index.clips[entry.id]) { delete index.clips[entry.id]; writeJsonAtomic(INDEX, index); }
  renameSync(tmp, clipPath(entry.id));
  index.clips[entry.id] = entry;
  writeJsonAtomic(INDEX, index);
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
