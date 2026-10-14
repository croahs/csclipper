// parse → score → clip specs for one demo, written to state/<sha>/moments.json
// (sorted, the ranked specs) and moments.txt (the readable table), each via a
// temp file and a rename.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDemo, parseDir, type ParsedDemo } from "../parse/demo.ts";
import { loadWeights, moments } from "../score/index.ts";
import { clipSpecs, type ClipSpec } from "./index.ts";

export type MomentsResult = { parsed: ParsedDemo; specs: ClipSpec[]; table: string; file: string; cached: boolean };

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // unique per writer
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function table(p: ParsedDemo, specs: ClipSpec[]): string {
  const head = `${p.demo.map} · ${path.basename(p.demo.path)} · ${p.rounds.length} match rounds (${p.preMatchRounds} pre-match skipped, ${p.rounds.filter((r) => r.phase === "knife").length} knife, ${p.rounds.filter((r) => r.phase === "overtime").length} overtime, ${p.rounds.filter((r) => r.rosterChanged).length} with roster changes)`;
  const rows = specs.map((s) => [
    String(s.rank), `R${s.round}`, s.score.toFixed(1), String(s.kills),
    [s.clutch ? `1v${s.clutch.vs}${s.clutch.won ? " won" : " lost"}` : "", ...s.flags].filter(Boolean).join(", "),
    String(s.startTick), String(s.endTick), ((s.endTick - s.startTick) / p.demo.tickrate).toFixed(1), s.title,
  ]);
  const cols = ["#", "round", "score", "kills", "flags", "start", "end", "sec", "title"];
  const width = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((x, i) => (i === r.length - 1 ? x : x.padEnd(width[i]))).join("  ");
  return [head, "", line(cols), line(width.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n") + "\n";
}

// Bump when the scoring or clip-spec code changes what it produces.
const MOMENTS_SCHEMA = 1;

/** Cached: moments.json counts only if its key (parse key, weights, schema) matches. An empty spec list is a valid result. */
export async function buildMoments(demo: string, pov: string): Promise<MomentsResult> {
  const parsed = await parseDemo(demo, pov);
  const w = loadWeights();
  const key = createHash("sha256").update(JSON.stringify({ parse: parsed.key, weights: w, schema: MOMENTS_SCHEMA })).digest("hex").slice(0, 16);
  const dir = parseDir(parsed.demo.sha256);
  const file = path.join(dir, "moments.json");
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8"));
      // The table is regenerated from the accepted specs and rewritten if it differs, so the two never disagree.
      if (cached.key === key) {
        const t = table(parsed, cached.specs);
        const txt = path.join(dir, "moments.txt");
        if (!existsSync(txt) || readFileSync(txt, "utf8") !== t) writeAtomic(txt, t);
        return { parsed, specs: cached.specs, table: t, file, cached: true };
      }
    } catch {}
  }
  const specs = clipSpecs(parsed, moments(parsed, w), w);
  const t = table(parsed, specs);
  writeAtomic(path.join(dir, "moments.txt"), t);
  writeAtomic(file, JSON.stringify({ key, demo: parsed.demo, pov: parsed.identity, generatedAt: new Date().toISOString(), weights: w, specs }, null, 2));
  return { parsed, specs, table: t, file, cached: false };
}
