// pnpm film's selection (pure): per roster player, his moments over every registered demo still on
// disk ranked by their film score (scoring.film.json), and the best config.json film.top of those
// scoring film.minScore or more (Peder, 2026-11-13: "nedre grense 40. synd for xz1ted, men sånn er det"); his
// bloopers scoring film.bloopers.minScore or more ranked the same way, the best film.bloopersTop. A clip
// the library holds counts toward the player's number and is not rendered again; a deleted one
// (state/deleted.json) is passed over and the next best takes its place. No record of its own: what the
// library holds is the record, so a later run with more demos re-ranks and renders only what is newly in.

/** One ranked thing: a moment or a blooper, with where it stands and what the library says of it. */
export type Candidate = {
  score: number;
  /** Ties: the demo registered first (its registry order), then the earlier start. */
  demoOrder: number; startTick: number;
  /** The library holds it (its clip number when it has one); deleted: state/deleted.json lists it. */
  held?: { no?: number }; deleted?: boolean;
};

export const byFilmRank = (a: Candidate, b: Candidate) => b.score - a.score || a.demoOrder - b.demoOrder || a.startTick - b.startTick;

/**
 * The best n of xs: best first, the deleted passed over (returned apart, in rank order, for the table).
 * Held ones are taken like any other; the caller renders only the taken ones that are not held.
 */
export function topN<T extends Candidate>(xs: T[], n: number): { taken: T[]; passed: T[] } {
  const taken: T[] = [], passed: T[] = [];
  for (const x of [...xs].sort(byFilmRank)) {
    if (taken.length >= n) break;
    (x.deleted ? passed : taken).push(x);
  }
  return { taken, passed };
}

export type FilmSelection<H extends Candidate, B extends Candidate> = { highlights: { taken: H[]; passed: H[] }; bloopers: { taken: B[]; passed: B[] } };

/**
 * One player's selection: his top highlights among those at minScore or more (absent: 0), and his top
 * bloopers among those at blooperMinScore or more (few or none of either is fine). A held clip under
 * the bound is not taken: it stays in the library, it just is not in the selection.
 */
export function selectFilm<H extends Candidate, B extends Candidate>(highlights: H[], bloopers: B[], s: { top: number; minScore?: number; bloopersTop: number; blooperMinScore: number }): FilmSelection<H, B> {
  return { highlights: topN(highlights.filter((h) => h.score >= (s.minScore ?? 0)), s.top), bloopers: topN(bloopers.filter((b) => b.score >= s.blooperMinScore), s.bloopersTop) };
}

/** What a selection still needs rendered: taken and not held. */
export const toRender = <T extends Candidate>(sel: { taken: T[] }) => sel.taken.filter((x) => !x.held);
