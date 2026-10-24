// Demo sources (PLAN.md §1). A source fetches what is new since its last run
// and writes the files into demos/inbox/ under a temporary name (leading dot,
// or .part), renaming each when complete, so ingest only ever sees finished
// files. Its own progress (last FACEIT match, last share code) lives in
// state/sources/<name>.json. `pnpm grab` runs every source, then ingest;
// `pnpm go` does not fetch. FACEIT is src/ingest/sources/faceit.ts; Valve
// matchmaking (Game Coordinator via the alt account) is
// src/ingest/sources/valve.ts.
export type SourceContext = {
  inbox: string;
  stateFile: string; // this source's own state, e.g. state/sources/faceit.json
  dryRun: boolean; // list what would be fetched, write nothing
  log: (line: string) => void;
};

export type SourceResult = {
  /** Files renamed into the inbox, complete. */
  fetched: string[];
  /** Items left for the next run, with why (download failed, not ready yet). */
  pending: { item: string; reason: string }[];
  /** Set when the source cannot run at all (no API key): a message, not a failure. */
  skipped?: string;
  /** Set when the source runs but cannot fetch for a known, external reason (a missing API scope, a logged-out browser); its pending items are not failures. */
  blocked?: string;
  /** Set when an item actually failed (a bad download, a browser error): the CLI exits 1; the item is still pending, nothing is skipped. */
  failed?: boolean;
};

export type Source = {
  name: string;
  fetch(ctx: SourceContext): Promise<SourceResult>;
};
