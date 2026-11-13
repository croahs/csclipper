// library/film.html, the film picker: the template (film.html, committed) with its data inlined, as
// index.html is, so it works opened from disk. Written by writeLibraryPage, so every command that
// rewrites the library page rewrites this one too. Per roster player, in the order of the last film
// pass's snapshot (library/film-selection.json), his ranked highlights and bloopers; then every clip
// picked for the film that is in none of those lists ("Picked, not in the current lists"), so no pick
// is ever hidden. A clip the index no longer holds is left out; a player is his name, never an ID.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { BLOOPER_FEATS } from "./facets.ts";
import type { FilmSelectionFile } from "./film-selection.ts";
import type { ClipEntry } from "./index.ts";

const TEMPLATE = path.join(import.meta.dirname, "film.html");
const PICK_STORE = path.join(import.meta.dirname, "pick-store.js");
/** The film-picks store both pages run (pick-store.js), as the text each template's PICKSTORE placeholder takes. */
export const pickStoreSource = () => { const t = readFileSync(PICK_STORE, "utf8"); return t.slice(t.indexOf("(function createPickStore")).trim(); }; // the expression, without the file comment
export const FILM_PAGE = path.join(LIBRARY_DIR, "film.html");
const BLOOPER_LABELS: Record<string, string> = Object.fromEntries(BLOOPER_FEATS);

export type FilmCard = {
  no: number; file: string; title: string; map: string; seconds: number;
  /** The film score (a snapshot list) or the library's score (the picked-but-unlisted group). */
  score?: number; rank?: number; stretch?: string;
  /** A blooper's kind label. */
  blooper?: string;
  /** In the unlisted group only: whose clip it is ("Me" or his name). */
  who?: string;
};
export type FilmSection = { label: string; cards: FilmCard[] };
export type FilmGroup = { heading: string; sub?: string; sections: FilmSection[]; unlisted?: true };

/** The title as a card shows it: without the "<player> · " prefix and the map, which the card shows apart. */
export function cardTitle(e: Pick<ClipEntry, "title" | "map" | "player">): string {
  let t = e.title;
  if (e.player && t.startsWith(`${e.player.name} · `)) t = t.slice(e.player.name.length + 3);
  if (e.map && t.startsWith(`${e.map} · `)) t = t.slice(e.map.length + 3);
  return t;
}

function card(e: ClipEntry, extra: Partial<FilmCard>): FilmCard {
  const type = e.blooper?.type;
  return {
    no: e.no!, file: e.file, title: cardTitle(e), map: (e.map ?? "unknown").replace(/^de_/, ""), seconds: Math.round(e.seconds * 10) / 10,
    ...(type ? { blooper: BLOOPER_LABELS[type] ?? type } : {}), ...extra,
  };
}

/** The picker's inlined data, all but generatedAt: the groups, the picks among held clips, the snapshot's time. */
export function filmPageData(selection: FilmSelectionFile | undefined, entries: ClipEntry[], pickList: number[]) {
  const byNo = new Map(entries.filter((e) => e.no !== undefined).map((e) => [e.no!, e]));
  const listed = new Set<number>();
  const groups: FilmGroup[] = [];
  for (const p of selection?.players ?? []) {
    const hl = p.highlights.flatMap((h, i) => { const e = byNo.get(h.no); return e ? [card(e, { rank: i + 1, score: h.score, ...(h.stretch ? { stretch: h.stretch } : {}) })] : []; });
    const bl = p.bloopers.flatMap((b, i) => { const e = byNo.get(b.no); return e ? [card(e, { rank: i + 1, score: b.score, blooper: BLOOPER_LABELS[b.type] ?? b.type })] : []; });
    for (const c of [...hl, ...bl]) listed.add(c.no);
    groups.push({ heading: p.me ? "Me" : p.name, ...(p.me && p.name ? { sub: p.name } : {}), sections: [{ label: "Highlights", cards: hl }, { label: "Bloopers", cards: bl }] });
  }
  const picks = pickList.filter((n) => byNo.has(n));
  const unlisted = picks.filter((n) => !listed.has(n)).map((n) => {
    const e = byNo.get(n)!;
    const m = e.moment as { score?: number } | undefined;
    const score = e.blooper ? e.blooper.score : m?.score;
    return card(e, { who: e.player?.name ?? "Me", ...(score !== undefined ? { score } : {}) });
  });
  if (unlisted.length) groups.push({ heading: "Picked, not in the current lists", unlisted: true, sections: [{ label: "", cards: unlisted }] });
  return { at: selection?.at ?? null, groups, picks };
}

export function writeFilmPage(entries: ClipEntry[], picks: number[], selection: FilmSelectionFile | undefined): string {
  const data = filmPageData(selection, entries, picks);
  // Every "<" escaped, so no title can end or reinterpret the script element.
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...data }).replaceAll("<", "\\u003c");
  const html = readFileSync(TEMPLATE, "utf8").replace("/*__FILM__*/{}", () => json).replace("/*__PICKSTORE__*/null", () => pickStoreSource());
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const tmp = `${FILM_PAGE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, FILM_PAGE);
  return FILM_PAGE;
}
