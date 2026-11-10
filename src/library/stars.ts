// Stars: the clips Peder marked as favourites, by clip number, in library/stars.json
// ({ version: 1, stars: [<no>, ...] }). Its own file, so starring never writes index.json and
// cannot collide with a clip run. A missing or garbled file reads as no stars. A star whose clip
// was deleted is ignored by the page and dropped at the next write (clip numbers are never reused).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";

export const STARS = path.join(LIBRARY_DIR, "stars.json");

const clean = (nos: unknown[]) => [...new Set(nos.filter((n): n is number => Number.isInteger(n) && (n as number) > 0))].sort((a, b) => a - b);

/** The starred clip numbers in a stars file's text: sorted, unique; anything unreadable is none. */
export function parseStars(text: string | undefined): number[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as { version?: unknown; stars?: unknown };
    return v && v.version === 1 && Array.isArray(v.stars) ? clean(v.stars) : [];
  } catch { return []; }
}

export function readStars(file = STARS): number[] {
  try { return existsSync(file) ? parseStars(readFileSync(file, "utf8")) : []; } catch { return []; }
}

export function writeStars(nos: number[], file = STARS) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, stars: clean(nos) }) + "\n");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // gone after the rename; left only when the write or the rename failed
  }
}

/**
 * Stars or unstars clips. known: the clip numbers the index holds. Any number it does not hold
 * refuses the whole change (nothing written, returned as unknown). Stars of clips no longer in
 * the index are dropped on the way.
 */
export function changeStars(op: "star" | "unstar", nos: number[], known: Set<number>, file = STARS): { stars: number[]; unknown: number[] } {
  const unknown = nos.filter((n) => !known.has(n));
  const current = readStars(file);
  if (unknown.length) return { stars: current, unknown };
  const set = new Set(current.filter((n) => known.has(n)));
  for (const n of nos) op === "star" ? set.add(n) : set.delete(n);
  const stars = clean([...set]);
  writeStars(stars, file);
  return { stars, unknown: [] };
}
