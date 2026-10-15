// library/index.html: the template (page.html, committed) with the clip index
// inlined, so it works opened straight from disk (a fetch of index.json over
// file:// does not). Written to a temp file, then renamed; rewritten after
// every clip a run adds, with a "run in progress" flag while pnpm go runs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR, STATE_DIR } from "../config.ts";
import { readRegistry } from "../ingest/index.ts";
import { readIndex } from "./index.ts";

const TEMPLATE = path.join(import.meta.dirname, "page.html");
export const PAGE = path.join(LIBRARY_DIR, "index.html");
const MATCHES = path.join(STATE_DIR, "sources", "matches.json"); // FACEIT match id -> finished_at (unix s)
const MATCH_ID = /1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** running: a pnpm go run is still adding clips (the page says so). */
export function writeLibraryPage(o: { running?: boolean } = {}): string {
  const registry = readRegistry();
  const dates: Record<string, number> = existsSync(MATCHES) ? JSON.parse(readFileSync(MATCHES, "utf8")) : {};
  const clips = Object.values(readIndex().clips).map((c) => {
    const m = (c.moment ?? {}) as { rank?: number; score?: number; kills?: number; flags?: string[]; clutch?: { vs: number; won: boolean } };
    // The match: its demo; dated by FACEIT when the demo's file name carries the match id.
    const matchId = registry[c.demoSha256]?.originalName.match(MATCH_ID)?.[0];
    const finished = matchId ? dates[matchId] : undefined;
    return {
      no: c.no, id: c.id, file: c.file, title: c.title, map: c.map, round: c.round, seconds: c.seconds, createdAt: c.createdAt,
      kind: c.kind ?? "highlight", match: c.demoSha256, matchDate: finished ? new Date(finished * 1000).toISOString() : null,
      rank: m.rank, score: m.score, kills: m.kills, flags: m.flags, clutch: m.clutch,
    };
  });
  // Every "<" escaped, so no title can end or reinterpret the script element.
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), running: !!o.running, clips }).replaceAll("<", "\\u003c");
  const html = readFileSync(TEMPLATE, "utf8").replace("/*__CLIPS__*/[]", () => json);
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const tmp = `${PAGE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, PAGE);
  return PAGE;
}
