// library/index.html: the template (page.html, committed) with the clip index
// inlined, so it works opened straight from disk (a fetch of index.json over
// file:// does not). Written to a temp file, then renamed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { readIndex } from "./index.ts";

const TEMPLATE = path.join(import.meta.dirname, "page.html");
export const PAGE = path.join(LIBRARY_DIR, "index.html");

export function writeLibraryPage(): string {
  const clips = Object.values(readIndex().clips).map((c) => {
    const m = (c.moment ?? {}) as { rank?: number; score?: number; kills?: number; flags?: string[]; clutch?: { vs: number; won: boolean } };
    return {
      id: c.id, file: c.file, title: c.title, map: c.map, round: c.round, seconds: c.seconds, createdAt: c.createdAt,
      rank: m.rank, score: m.score, kills: m.kills, flags: m.flags, clutch: m.clutch,
    };
  });
  // Every "<" escaped, so no title can end or reinterpret the script element.
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), clips }).replaceAll("<", "\\u003c");
  const html = readFileSync(TEMPLATE, "utf8").replace("/*__CLIPS__*/[]", () => json);
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const tmp = `${PAGE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, PAGE);
  return PAGE;
}
