// parse → score → clip specs for one demo and POV, written to state/<sha>/moments.json
// (sorted, the ranked specs) and moments.txt (the readable table), each via a
// temp file and a rename; a POV other than STEAM_ID64 into state/<sha>/pov-<povKey>/.
// Film weights (scoring.film.json, pnpm film) go to moments.film.json / moments.film.txt beside them,
// for every POV, so the two modes never rewrite each other's cache. Spans and ids do not depend on
// the weights, so a moment has the same clip id in both. The cache key holds the weights themselves,
// so a change to either file (pace.stretch included) rebuilds that mode's moments on the next run.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isKnifeRound, parseDemo, povDir, type ParsedDemo } from "../parse/demo.ts";
import { TICKRATE } from "../parse/clip-facts.ts";
import { loadFilmWeights, loadWeights, moments } from "../score/index.ts";
import { loadClipRules, loadIdentities, povKeyFor, type ClipRules } from "../config.ts";
import { clipSpecs, type ClipSpec } from "./index.ts";

export type MomentsResult = { parsed: ParsedDemo; specs: ClipSpec[]; table: string; file: string; cached: boolean };

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // unique per writer
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** A film spec scored as a stretch of its kills (pace.stretch): "3 of 5 kills, 1.4 s apart"; empty otherwise. */
export function stretchText(s: Pick<ClipSpec, "stretch" | "kills" | "killTicks">, tickrate = TICKRATE): string {
  if (!s.stretch) return "";
  const n = s.stretch.to - s.stretch.from + 1;
  const gap = n > 1 ? (s.killTicks[s.stretch.to] - s.killTicks[s.stretch.from]) / (n - 1) / tickrate : 0;
  return `${n} of ${s.kills} kills${n > 1 ? `, ${gap.toFixed(1)} s apart` : ""}`;
}

export function table(p: ParsedDemo, specs: ClipSpec[]): string {
  const head = `${p.demo.map} · ${path.basename(p.demo.path)} · ${p.rounds.length} match rounds (${p.preMatchRounds} pre-match skipped, ${p.rounds.filter((r) => isKnifeRound(p, r)).length} knife, ${p.rounds.filter((r) => r.phase === "overtime").length} overtime, ${p.rounds.filter((r) => r.rosterChanged).length} with roster changes)`;
  const rows = specs.map((s) => [
    String(s.rank), `R${s.round}`, s.score.toFixed(1), String(s.kills),
    [s.clutch ? `1v${s.clutch.vs}${s.clutch.won ? " won" : " lost"}` : "", ...s.flags, stretchText(s, p.demo.tickrate)].filter(Boolean).join(", "),
    String(s.startTick), String(s.endTick), ((s.endTick - s.startTick) / p.demo.tickrate).toFixed(1), s.title,
  ]);
  const cols = ["#", "round", "score", "kills", "flags", "start", "end", "sec", "title"];
  const width = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((x, i) => (i === r.length - 1 ? x : x.padEnd(width[i]))).join("  ");
  return [head, "", line(cols), line(width.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n") + "\n";
}

// Bump when the scoring or clip-spec code changes what it produces.
const MOMENTS_SCHEMA = 8; // 8: weapon tests on bare names (knife swings and grenade throws no bullets), knife rounds from the fires, knife multi-kill; 7: trade and save flags; 2: no 30 s cap, action windows; 3: windows reach the span's ends; 4: one moment per round; 5: kept lead-in; 6: tail capped by the next round's start, not round end + 1 s

/**
 * Cached: moments.json counts only if its key (parse key, weights, clip rules, schema) matches.
 * An empty spec list is a valid result. `override` (pnpm clip --rerender --lead) changes the clip
 * rules for this call only: the specs are built fresh and the cache is neither read nor written.
 */
export type Weighting = "normal" | "film";
export async function buildMoments(demo: string, pov: string, override?: Partial<ClipRules>, mainPov = loadIdentities().pov, weighting: Weighting = "normal"): Promise<MomentsResult> {
  // A POV other than STEAM_ID64 (pnpm go --film): its own parse and moments files (povDir), its key in clip ids and titles.
  const playerKey = povKeyFor(pov, mainPov);
  const parsed = await parseDemo(demo, pov, mainPov);
  const w = weighting === "film" ? loadFilmWeights() : loadWeights();
  const base = weighting === "film" ? "moments.film" : "moments";
  const rules = { ...loadClipRules(), ...override };
  if (override) {
    const specs = clipSpecs(parsed, moments(parsed, w), w, rules, playerKey);
    return { parsed, specs, table: table(parsed, specs), file: "", cached: false };
  }
  const key = createHash("sha256").update(JSON.stringify({ parse: parsed.key, weights: w, rules, schema: MOMENTS_SCHEMA })).digest("hex").slice(0, 16);
  const dir = povDir(parsed.demo.sha256, playerKey);
  const file = path.join(dir, `${base}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8"));
      // The table is regenerated from the accepted specs and rewritten if it differs, so the two never disagree.
      if (cached.key === key) {
        const t = table(parsed, cached.specs);
        const txt = path.join(dir, `${base}.txt`);
        if (!existsSync(txt) || readFileSync(txt, "utf8") !== t) writeAtomic(txt, t);
        return { parsed, specs: cached.specs, table: t, file, cached: true };
      }
    } catch {}
  }
  const specs = clipSpecs(parsed, moments(parsed, w), w, rules, playerKey);
  const t = table(parsed, specs);
  writeAtomic(path.join(dir, `${base}.txt`), t);
  writeAtomic(file, JSON.stringify({ key, demo: parsed.demo, pov: parsed.identity, generatedAt: new Date().toISOString(), weights: w, specs }, null, 2));
  return { parsed, specs, table: t, file, cached: false };
}
