// The date a clip's match is shown under: one rule for the library page (page.ts inlines it,
// page.html falls back to the clip's createdAt the same way clipDate does) and pnpm week, so the
// two cannot put a clip in different weeks.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config.ts";
import type { DemoRecord } from "../ingest/index.ts";

const MATCHES = path.join(STATE_DIR, "sources", "matches.json"); // FACEIT match id -> finished_at (unix s)
const MATCH_ID = /1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** FACEIT match id -> finished_at (unix seconds), as pnpm grab recorded them; {} when none. */
export const readMatchDates = (file = MATCHES): Record<string, number> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

export type MatchDate = { matchDate: string | null; dateFrom: "faceit" | "added" | null };

/**
 * A demo's match date: by FACEIT when the demo's file name carries the match id and pnpm grab has
 * seen it (needs FACEIT_API_KEY), else by when the demo was added here, which the page labels as
 * such (a demo carries no match time of its own).
 */
export function matchDateOf(demo: Pick<DemoRecord, "originalName" | "addedAt"> | undefined, dates: Record<string, number>): MatchDate {
  const matchId = demo?.originalName.match(MATCH_ID)?.[0];
  const finished = matchId ? dates[matchId] : undefined;
  const matchDate = finished ? new Date(finished * 1000).toISOString() : demo?.addedAt ?? null;
  return { matchDate, dateFrom: finished ? "faceit" : matchDate ? "added" : null };
}

/** The date the page shows and sorts a clip by (page.html dateOf): its match date, else when the clip was made. */
export const clipDate = (m: MatchDate, createdAt: string): string => m.matchDate || createdAt;
