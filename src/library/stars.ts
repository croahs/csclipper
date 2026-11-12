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
 * Adds or removes marks. known: the clip numbers the index holds. Any number it does not hold refuses
 * the whole change (nothing written, returned as unknown). Marks of clips no longer in the index are
 * dropped on the way.
 */
function changeMarks(add: boolean, nos: number[], known: Set<number>, file: string, field: Field): { marks: number[]; unknown: number[] } {
  const unknown = nos.filter((n) => !known.has(n));
  const current = readMarks(file, field);
  if (unknown.length) return { marks: current, unknown };
  const set = new Set(current.filter((n) => known.has(n)));
  for (const n of nos) add ? set.add(n) : set.delete(n);
  const marks = clean([...set]);
  writeMarks(marks, file, field);
  return { marks, unknown: [] };
}

/** The starred clip numbers in a stars file's text: sorted, unique; anything unreadable is none. */
export const parseStars = (text: string | undefined) => parseMarks(text, "stars");
export const readStars = (file = STARS) => readMarks(file, "stars");
export const writeStars = (nos: number[], file = STARS) => writeMarks(nos, file, "stars");
export function changeStars(op: "star" | "unstar", nos: number[], known: Set<number>, file = STARS): { stars: number[]; unknown: number[] } {
  const r = changeMarks(op === "star", nos, known, file, "stars");
  return { stars: r.marks, unknown: r.unknown };
}

/** The film picks in a picks file's text, read and written exactly as stars are. */
export const parsePicks = (text: string | undefined) => parseMarks(text, "picks");
export const readPicks = (file = PICKS) => readMarks(file, "picks");
export function changePicks(op: "pick" | "unpick", nos: number[], known: Set<number>, file = PICKS): { picks: number[]; unknown: number[] } {
  const r = changeMarks(op === "pick", nos, known, file, "picks");
  return { picks: r.marks, unknown: r.unknown };
}
