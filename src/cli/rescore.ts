// pnpm rescore [--dry-run]: the scores the library shows (each highlight's moment: rank, score,
// breakdown, flags) recomputed with the current scoring.json from each demo's cached parse
// (state/<sha>/parse.json; a film player's clip from that player's, in state/<sha>/pov-<povKey>/), then the library page rewritten. Display only: no clip is rendered,
// trimmed or renumbered, no demo is unsettled, and the clip spans stay as rendered (AGENTS.md).
// Bloopers keep the score they were made with (they are counted, not rescored).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadClipRules, loadRoster, povKey, STATE_DIR } from "../config.ts";
import { clipSpecs, type ClipSpec } from "../clip/index.ts";
import { editIndex, readIndex, type ClipEntry } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { parseIsCurrent, povDir, type ParsedDemo } from "../parse/demo.ts";
import { lockStatus } from "../render/controller/guards.ts";
import { loadWeights, moments } from "../score/index.ts";

const dryRun = process.argv.includes("--dry-run");
const w = loadWeights();
const rules = loadClipRules();

// One spec per round (a round is one moment), from each held demo's cached parse of the clip's player:
// the main POV's in state/<sha>/, a film player's (entry.player) in its povDir, that player resolved
// through the roster (.env FILM_STEAM_ID64S); a key no longer in the roster is skipped and counted.
// A parse from an older parser or schema is skipped: it lacks fields the current scoring reads (pnpm moments re-parses it).
const byDemo = new Map<string, ClipSpec[] | undefined>(); // "<sha>:<povKey or empty>"
const stale: string[] = [];
const notInRoster: number[] = [];
let roster: Map<string, string> | undefined; // povKey → SteamID64, loaded only when a film clip is held
const rosterId = (key: string) => (roster ??= new Map(loadRoster().map((id) => [povKey(id), id]))).get(key);
const slot = (c: ClipEntry) => `${c.demoSha256}:${c.player?.key ?? ""}`;
for (const c of Object.values(readIndex().clips)) {
  if ((c.kind ?? "highlight") !== "highlight" || !c.moment || byDemo.has(slot(c))) continue;
  const key = c.player?.key;
  const pov = key ? rosterId(key) : undefined;
  if (key && !pov) { byDemo.set(slot(c), undefined); continue; }
  const file = path.join(povDir(c.demoSha256, key), "parse.json");
  let p = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ParsedDemo) : undefined;
  // A film player's cache must be that player's (the key is a hash prefix; the parse names the SteamID).
  if (p && pov && p.identity.steamid !== pov) p = undefined;
  if (p && !parseIsCurrent(p)) { stale.push(`${c.demoSha256.slice(0, 12)}${key ? ` (${c.player!.name})` : ""}`); p = undefined; }
  byDemo.set(slot(c), p && clipSpecs(p, moments(p, w), w, rules, key));
}

const lines: string[] = [];
const missing: number[] = [];
const apply = (clips: Record<string, ClipEntry>) => {
  let changed = 0;
  notInRoster.length = 0;
  for (const c of Object.values(clips).sort((a, b) => (a.no ?? 0) - (b.no ?? 0))) {
    if ((c.kind ?? "highlight") !== "highlight" || !c.moment) continue;
    if (c.player && !rosterId(c.player.key)) { notInRoster.push(c.no ?? 0); continue; }
    const spec = byDemo.get(slot(c))?.find((s) => s.round === c.round);
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
// Bloopers carry their own score (src/film/bloopers.ts), not a moment's: never rescored here.
const bloopers = Object.values(readIndex().clips).filter((c) => c.kind === "blooper").length;
if (bloopers) console.log(`not rescored (bloopers, scored on their own scale): ${bloopers} clip(s)`);
if (notInRoster.length) console.log(`not rescored (their player is no longer in .env FILM_STEAM_ID64S): ${notInRoster.length} clip(s): ${notInRoster.join(", ")}`);
console.log(`${changed} clip${changed === 1 ? "" : "s"} ${dryRun ? "would change" : "rescored"}`);
// A pnpm go still running keeps its "run in progress" flag on the page.
if (!dryRun && changed) console.log(`library page: ${writeLibraryPage({ running: !!lockStatus(path.join(STATE_DIR, ".go.lock")).alive })}`);
