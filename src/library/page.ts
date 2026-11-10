// library/index.html: the template (page.html, committed) with the clip index
// inlined, so it works opened straight from disk (a fetch of index.json over
// file:// does not). Written to a temp file, then renamed; rewritten after
// every clip a run adds, with a "run in progress" flag while pnpm go runs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { readRegistry } from "../ingest/index.ts";
import { shareCaption } from "../share/caption.ts";
import { FEATS, featsOf, weaponsOf } from "./facets.ts";
import { readIndex } from "./index.ts";
import { readStars } from "./stars.ts";
import { matchDateOf, readMatchDates } from "./match-date.ts";

const TEMPLATE = path.join(import.meta.dirname, "page.html");
export const PAGE = path.join(LIBRARY_DIR, "index.html");

/** running: a pnpm go run is still adding clips (the page says so). */
export function writeLibraryPage(o: { running?: boolean } = {}): string {
  const registry = readRegistry();
  const dates = readMatchDates();
  const clips = Object.values(readIndex().clips).map((c) => {
    const m = (c.moment ?? {}) as { rank?: number; score?: number; kills?: number; flags?: string[]; clutch?: { vs: number; won: boolean }; weapons?: string[] };
    // The match: its demo, dated by the one rule pnpm week also uses (match-date.ts).
    const { matchDate, dateFrom } = matchDateOf(registry[c.demoSha256], dates);
    return {
      no: c.no, id: c.id, file: c.file, title: c.title, map: c.map, round: c.round, seconds: c.seconds, createdAt: c.createdAt,
      kind: c.kind ?? "highlight", match: c.demoSha256, matchDate, dateFrom,
      rank: m.rank, score: m.score, kills: m.kills, flags: m.flags, clutch: m.clutch,
      caption: shareCaption(c), feats: featsOf(m), weapons: weaponsOf(m),
    };
  });
  // Stars of clips no longer in the index are left out (the file drops them at its next write).
  const nos = new Set(clips.map((c) => c.no));
  const stars = readStars().filter((n) => nos.has(n));
  // Every "<" escaped, so no title can end or reinterpret the script element.
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), running: !!o.running, clips, stars, featLabels: FEATS }).replaceAll("<", "\\u003c");
  const html = readFileSync(TEMPLATE, "utf8").replace("/*__CLIPS__*/[]", () => json);
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const tmp = `${PAGE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, PAGE);
  return PAGE;
}
