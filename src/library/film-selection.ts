// library/film-selection.json: what pnpm film last selected, per roster player, for the film picker
// page (library/film.html) to show. Display data only: no run reads it back, and a film pass keeps no
// record of its own that later runs depend on (what the library holds is the record). Written at the
// end of every pnpm film pass, the dry run included (it renders nothing but knows the held clips), so
// the list can be refreshed without a launch. Only clips the library holds (a clip number), in roster
// order (the main account first) and rank order. A player is his name only: no SteamID, no povKey.
//   { version: 1, at: <ISO time>, players: [{ name, me, highlights: [{ no, score, title, stretch? }],
//     bloopers: [{ no, score, title, type }] }] }
// score: the film score (the highlight's under scoring.film.json, the blooper's own).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { writeJsonAtomic, type ClipEntry } from "./index.ts";

export const FILM_SELECTION = path.join(LIBRARY_DIR, "film-selection.json");

export type SelHighlight = { no: number; score: number; title: string; stretch?: string };
export type SelBlooper = { no: number; score: number; title: string; type: string };
export type SelPlayer = { name: string; me: boolean; highlights: SelHighlight[]; bloopers: SelBlooper[] };
export type FilmSelectionFile = { version: 1; at: string; players: SelPlayer[] };

/** One selected clip as filmQueue knows it: its id, and its clip number when the library already held it. */
type Draft<T> = Omit<T, "no"> & { id: string; no?: number };
export type SelectionDraft = { name: string; me: boolean; highlights: Draft<SelHighlight>[]; bloopers: Draft<SelBlooper>[] }[];

/**
 * The snapshot of a film pass's selection once its queue has run: each taken clip by its number (held
 * before the run, or published under its id during it); one the library does not hold now (never made,
 * or deleted during the pass) is left out.
 */
export function filmSelection(draft: SelectionDraft, clips: Record<string, Pick<ClipEntry, "no">>, at = new Date()): FilmSelectionFile {
  const nos = new Set(Object.values(clips).map((c) => c.no).filter((n): n is number => n !== undefined));
  const held = <T extends { id: string; no?: number }>(xs: T[]) => xs.flatMap(({ id, no, ...rest }) => {
    const n = no ?? clips[id]?.no;
    return n === undefined || !nos.has(n) ? [] : [{ no: n, ...rest }];
  });
  return {
    version: 1, at: at.toISOString(),
    players: draft.map((p) => ({ name: p.name, me: p.me, highlights: held(p.highlights) as SelHighlight[], bloopers: held(p.bloopers) as SelBlooper[] })),
  };
}

export const writeFilmSelection = (s: FilmSelectionFile, file = FILM_SELECTION) => writeJsonAtomic(file, s);

const isEntry = (x: unknown) => {
  const e = x as { no?: unknown; score?: unknown; title?: unknown } | null;
  return !!e && typeof e === "object" && Number.isInteger(e.no) && typeof e.score === "number" && typeof e.title === "string";
};
const isPlayer = (x: unknown) => {
  const p = x as { name?: unknown; me?: unknown; highlights?: unknown; bloopers?: unknown } | null;
  return !!p && typeof p === "object" && typeof p.name === "string" && typeof p.me === "boolean"
    && Array.isArray(p.highlights) && p.highlights.every(isEntry) && Array.isArray(p.bloopers) && p.bloopers.every(isEntry);
};
/** The snapshot's whole shape checked: anything else is no snapshot. */
export function parseFilmSelection(text: string): FilmSelectionFile | undefined {
  try {
    const v = JSON.parse(text) as FilmSelectionFile;
    return v && v.version === 1 && typeof v.at === "string" && Array.isArray(v.players) && v.players.every(isPlayer) ? v : undefined;
  } catch { return undefined; }
}
/** The last snapshot; missing, garbled or misshapen reads as none (the picker then shows only the picks). */
export function readFilmSelection(file = FILM_SELECTION): FilmSelectionFile | undefined {
  try { return existsSync(file) ? parseFilmSelection(readFileSync(file, "utf8")) : undefined; } catch { return undefined; }
}
