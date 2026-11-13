// Clip-number marks Peder sets on the library page, each in its own file under library/, so marking
// never writes index.json and cannot collide with a clip run:
//   stars:      library/stars.json      ({ version: 1, stars: [<no>, ...] }), the favourites;
//   film picks: library/film-picks.json ({ version: 1, picks: [<no>, ...] }), the clips ticked "Film",
//               which pnpm film masters makes edit-grade files of.
// A missing or garbled file reads as none. A mark whose clip was deleted is ignored by the page and
// dropped at the next write (clip numbers are never reused).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";

export const STARS = path.join(LIBRARY_DIR, "stars.json");
export const PICKS = path.join(LIBRARY_DIR, "film-picks.json");
type Field = "stars" | "picks";

const clean = (nos: unknown[]) => [...new Set(nos.filter((n): n is number => Number.isInteger(n) && (n as number) > 0))].sort((a, b) => a - b);

function parseMarks(text: string | undefined, field: Field): number[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as { version?: unknown } & Record<string, unknown>;
    return v && v.version === 1 && Array.isArray(v[field]) ? clean(v[field] as unknown[]) : [];
  } catch { return []; }
}
const readMarks = (file: string, field: Field) => { try { return existsSync(file) ? parseMarks(readFileSync(file, "utf8"), field) : []; } catch { return []; } };
type Writer = (nos: number[], file: string, field: Field) => void;
function writeMarks(nos: number[], file: string, field: Field) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, [field]: clean(nos) }) + "\n");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // gone after the rename; left only when the write or the rename failed
  }
}
/**
 * Adds and removes marks in one write (the adds first, then the removes). known: the clip numbers the
 * index holds. Any number it does not hold refuses the whole change (nothing written, returned as
 * unknown). Marks of clips no longer in the index are dropped on the way.
 */
function changeMarks(add: number[], remove: number[], known: Set<number>, file: string, field: Field, write: Writer = writeMarks): { marks: number[]; unknown: number[] } {
  const unknown = [...add, ...remove].filter((n) => !known.has(n));
  const current = readMarks(file, field);
  if (unknown.length) return { marks: current, unknown };
  const set = new Set(current.filter((n) => known.has(n)));
  for (const n of add) set.add(n);
  for (const n of remove) set.delete(n);
  const marks = clean([...set]);
  write(marks, file, field);
  return { marks, unknown: [] };
}

/** The starred clip numbers in a stars file's text: sorted, unique; anything unreadable is none. */
export const parseStars = (text: string | undefined) => parseMarks(text, "stars");
export const readStars = (file = STARS) => readMarks(file, "stars");
export const writeStars = (nos: number[], file = STARS) => writeMarks(nos, file, "stars");
export function changeStars(op: "star" | "unstar", nos: number[], known: Set<number>, file = STARS): { stars: number[]; unknown: number[] } {
  const r = op === "star" ? changeMarks(nos, [], known, file, "stars") : changeMarks([], nos, known, file, "stars");
  return { stars: r.marks, unknown: r.unknown };
}

/** The film picks in a picks file's text, read and written exactly as stars are. */
export const parsePicks = (text: string | undefined) => parseMarks(text, "picks");
export const readPicks = (file = PICKS) => readMarks(file, "picks");
export function changePicks(op: "pick" | "unpick", nos: number[], known: Set<number>, file = PICKS): { picks: number[]; unknown: number[] } {
  const r = op === "pick" ? changeMarks(nos, [], known, file, "picks") : changeMarks([], nos, known, file, "picks");
  return { picks: r.marks, unknown: r.unknown };
}

/**
 * The film picker's bulk change (POST /picks): body { pick?: number[], unpick?: number[] }, each a clip
 * number the index holds. Anything else, or any number the index does not hold, refuses the whole
 * request (nothing written). The final set (the picks added, then the unpicks removed) is written once,
 * atomically; an empty body writes nothing and answers the current picks. write: the file writer
 * (injectable so a test can count the writes).
 */
export function changePicksBulk(body: unknown, known: Set<number>, file = PICKS, write: Writer = writeMarks): { picks: number[] } | { status: 400 | 404; error: string } {
  const b = body as { pick?: unknown; unpick?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: 'the body must be JSON: {"pick": [<no>...], "unpick": [<no>...]}' };
  const lists: Record<"pick" | "unpick", number[]> = { pick: [], unpick: [] };
  for (const k of ["pick", "unpick"] as const) {
    const v = b[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && n > 0)) return { status: 400, error: `${k} must be a list of clip numbers` };
    lists[k] = v as number[];
  }
  const unknown = [...lists.pick, ...lists.unpick].filter((n) => !known.has(n));
  if (unknown.length) return { status: 404, error: `no clip ${[...new Set(unknown)].join(", ")}` };
  if (!lists.pick.length && !lists.unpick.length) return { picks: readPicks(file).filter((n) => known.has(n)) };
  return { picks: changeMarks(lists.pick, lists.unpick, known, file, "picks", write).marks };
}
