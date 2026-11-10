// pnpm rescore [--dry-run]: the scores the library shows (each highlight's moment: rank, score,
// breakdown, flags) recomputed with the current scoring.json from each demo's cached parse
// (state/<sha>/parse.json), then the library page rewritten. Display only: no clip is rendered,
// trimmed or renumbered, no demo is unsettled, and the clip spans stay as rendered (AGENTS.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadClipRules, STATE_DIR } from "../config.ts";
import { clipSpecs, type ClipSpec } from "../clip/index.ts";
import { editIndex, readIndex, type ClipEntry } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { parseDir, parseIsCurrent, type ParsedDemo } from "../parse/demo.ts";
import { lockStatus } from "../render/controller/guards.ts";
import { loadWeights, moments } from "../score/index.ts";

const dryRun = process.argv.includes("--dry-run");
const w = loadWeights();
const rules = loadClipRules();

// One spec per round (a round is one moment), from each held demo's cached parse. A parse from an
// older parser or schema is skipped: it lacks fields the current scoring reads (pnpm moments re-parses it).
const byDemo = new Map<string, ClipSpec[] | undefined>();
const stale: string[] = [];
for (const c of Object.values(readIndex().clips)) {
  if ((c.kind ?? "highlight") !== "highlight" || !c.moment || byDemo.has(c.demoSha256)) continue;
  const file = path.join(parseDir(c.demoSha256), "parse.json");
  let p = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ParsedDemo) : undefined;
  if (p && !parseIsCurrent(p)) { stale.push(c.demoSha256.slice(0, 12)); p = undefined; }
  byDemo.set(c.demoSha256, p && clipSpecs(p, moments(p, w), w, rules));
}

const lines: string[] = [];
const missing: number[] = [];
const apply = (clips: Record<string, ClipEntry>) => {
  let changed = 0;
  for (const c of Object.values(clips).sort((a, b) => (a.no ?? 0) - (b.no ?? 0))) {
    if ((c.kind ?? "highlight") !== "highlight" || !c.moment) continue;
    const spec = byDemo.get(c.demoSha256)?.find((s) => s.round === c.round);
    if (!spec) { missing.push(c.no ?? 0); continue; }
    const old = c.moment as { score?: number; rank?: number };
    if (old.score === spec.score && old.rank === spec.rank && JSON.stringify(c.moment.breakdown) === JSON.stringify(spec.breakdown) && JSON.stringify(c.moment.flags) === JSON.stringify(spec.flags)) continue;
    lines.push(`clip ${c.no}: ${old.score ?? "?"} -> ${spec.score} (rank ${old.rank ?? "?"} -> ${spec.rank})`);
    c.moment = { ...c.moment, rank: spec.rank, score: spec.score, breakdown: spec.breakdown, flags: spec.flags };
    changed++;
  }
  return changed;
};

const changed = dryRun ? apply(structuredClone(readIndex().clips)) : editIndex(apply);
for (const l of lines) console.log(l);
if (stale.length) console.log(`older parse, not used (pnpm moments "<demo>" re-parses it): ${stale.join(", ")}`);
if (missing.length) console.log(`not rescored (no current cached parse, or the round is no longer a moment): clips ${missing.join(", ")}`);
console.log(`${changed} clip${changed === 1 ? "" : "s"} ${dryRun ? "would change" : "rescored"}`);
// A pnpm go still running keeps its "run in progress" flag on the page.
if (!dryRun && changed) console.log(`library page: ${writeLibraryPage({ running: !!lockStatus(path.join(STATE_DIR, ".go.lock")).alive })}`);
