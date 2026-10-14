// Demo sources (PLAN.md §1). A source fetches what is new since its last run
// and drops the files into demos/inbox/; ingest does the rest (wait until
// stable, unpack, hash, register). Its own state (last FACEIT match, last
// share code) belongs in state/sources/<name>.json. The watch folder itself
// needs no source: files dropped into demos/inbox/ by hand are ingested as
// they are. FACEIT and Valve matchmaking are later milestones.
export type Source = {
  name: string;
  /** Download anything new into `inbox`; return the files written. */
  fetch(inbox: string): Promise<string[]>;
};

export const SOURCES: Source[] = [];
