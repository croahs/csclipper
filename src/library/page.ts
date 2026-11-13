// library/index.html: the template (page.html, committed) with the clip index
// inlined, so it works opened straight from disk (a fetch of index.json over
// file:// does not). Written to a temp file, then renamed; rewritten after
// every clip a run adds, with a "run in progress" flag while pnpm go runs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { readRegistry, type DemoRecord } from "../ingest/index.ts";
import { shareCaption } from "../share/caption.ts";
import { BLOOPER_FEATS, FEATS, featsOf, playersOf, weaponsOf } from "./facets.ts";
import { parseClipHash } from "./hash.ts";
import { readIndex, type ClipEntry } from "./index.ts";
import { readPicks, readStars } from "./stars.ts";
import { pickStoreSource, writeFilmPage } from "./film-page.ts";
import { readFilmSelection } from "./film-selection.ts";
import { matchDateOf, readMatchDates } from "./match-date.ts";

const TEMPLATE = path.join(import.meta.dirname, "page.html");

/** The deep-link parser (hash.ts) as the page's script runs it: its own source, compiled. */
export const hashParserSource = () => `(${parseClipHash.toString()})`;
export const PAGE = path.join(LIBRARY_DIR, "index.html");

/**
 * The data the page inlines, all but generatedAt. Film entries add to it only where they occur: a
 * clip's `player` (its povKey) and the page's `players` list (playersOf) when an entry has a player,
 * the blooper feat labels when an entry is a blooper, whose score is its own (shown and sorted by).
 * A library with neither gives exactly the data it always did. Film picks (the film button) the same
 * way: `picks` only when a clip in the index is picked.
 */
export function pageData(entries: ClipEntry[], registry: Record<string, DemoRecord>, dates: Record<string, number>, starList: number[], o: { running?: boolean; hasDeathMap?: boolean; picks?: number[] } = {}) {
  const clips = entries.map((c) => {
    const m = (c.moment ?? {}) as { rank?: number; score?: number; kills?: number; flags?: string[]; clutch?: { vs: number; won: boolean }; weapons?: string[] };
    // The match: its demo, dated by the one rule pnpm week also uses (match-date.ts).
    const { matchDate, dateFrom } = matchDateOf(registry[c.demoSha256], dates);
    return {
      no: c.no, id: c.id, file: c.file, title: c.title, map: c.map, round: c.round, seconds: c.seconds, createdAt: c.createdAt,
      kind: c.kind ?? "highlight", match: c.demoSha256, matchDate, dateFrom,
      rank: m.rank, score: c.blooper ? c.blooper.score : m.score, kills: m.kills, flags: m.flags, clutch: m.clutch,
      caption: shareCaption(c), feats: c.blooper ? [c.blooper.type] : featsOf(m), weapons: weaponsOf(m),
      ...(c.player ? { player: c.player.key } : {}),
    };
  });
  // Stars of clips no longer in the index are left out (the file drops them at its next write).
  const nos = new Set(clips.map((c) => c.no));
  const stars = starList.filter((n) => nos.has(n));
  const picks = (o.picks ?? []).filter((n) => nos.has(n));
  const players = playersOf(entries);
  const featLabels = entries.some((c) => c.blooper) ? [...FEATS, ...BLOOPER_FEATS] : FEATS;
  return { running: !!o.running, hasDeathMap: !!o.hasDeathMap, clips, stars, featLabels, ...(players.length ? { players } : {}), ...(picks.length ? { picks } : {}) };
}

/** running: a pnpm go run is still adding clips (the page says so). Writes the film picker (film.html) too. */
export function writeLibraryPage(o: { running?: boolean } = {}): string {
  const hasDeathMap = existsSync(path.join(LIBRARY_DIR, "deaths.html")); // pnpm deathmap has written it: the sidebar links to it
  const entries = Object.values(readIndex().clips), picks = readPicks();
  const data = pageData(entries, readRegistry(), readMatchDates(), readStars(), { running: o.running, hasDeathMap, picks });
  // Every "<" escaped, so no title can end or reinterpret the script element.
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...data }).replaceAll("<", "\\u003c");
  const html = readFileSync(TEMPLATE, "utf8").replace("/*__CLIPS__*/[]", () => json).replace("/*__HASH__*/null", () => hashParserSource()).replace("/*__PICKSTORE__*/null", () => pickStoreSource());
  mkdirSync(LIBRARY_DIR, { recursive: true });
  return libraryThenFilm(() => {
    const tmp = `${PAGE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, html);
    renameSync(tmp, PAGE);
    return PAGE;
  }, () => { writeFilmPage(entries, picks, readFilmSelection()); });
}

/**
 * The library page first, then the film picker, never at the library page's cost: a picker failure
 * (a write error, anything thrown) is one logged line; a library page failure still throws.
 */
export function libraryThenFilm(library: () => string, film: () => void, log: (line: string) => void = console.error): string {
  const page = library();
  try { film(); } catch (e) { log(`film picker not rewritten: ${(e as Error).message}`); }
  return page;
}
