// Death map (PLAN.md §7): library/deaths.html, where and how the POV player dies, per map, from the
// demos' cached parses. The data is built here (pure, tested in test/deathmap.test.ts); the page
// (deathmap/page.html) filters, clusters and summarizes it in the browser with view.ts, which is
// inlined with its types stripped so the page and the tests run the same code.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { LIBRARY_DIR, loadIdentities } from "../config.ts";
import { readRegistry, type Registry } from "../ingest/index.ts";
import { readIndex, type ClipEntry } from "../library/index.ts";
import { matchDateOf, readMatchDates } from "../library/match-date.ts";
import { FOOTPRINT_CELL, hasPositions, parseDemo, parseDir, parseIsCurrent, reparseDemo, type ParsedDemo } from "../parse/demo.ts";
import { loadWeights, weaponClass } from "../score/index.ts";
import { weaponName } from "../clip/index.ts";
import type { Group, Match, Row } from "./view.ts";

export const PAGE = path.join(LIBRARY_DIR, "deaths.html");
const TEMPLATE = path.join(import.meta.dirname, "page.html");
const VIEW = path.join(import.meta.dirname, "view.ts");

const AUTO_SNIPERS = new Set(["g3sg1", "scar20"]);
/** The death map's weapon class: the scoring's classes folded to six; anything unknown is other. */
export function weaponGroup(weapon: string): Group {
  if (AUTO_SNIPERS.has(weapon)) return "sniper";
  const c = weaponClass(weapon);
  if (c === "awp" || c === "scout") return "sniper";
  if (c === "deagle" || c === "pistol") return "pistol";
  if (c === "rifle" || c === "smg" || c === "shotgun") return c;
  return "other"; // knife, grenades, fire, the bomb, the world, anything new
}

/** Seconds into a deaths reel at which each take starts, by event tick; undefined when the windows do not add up to the reel's length. */
export function reelOffsets(c: Pick<ClipEntry, "seconds" | "reel"> & { render?: unknown }, tickrate: number): Map<number, number> | undefined {
  const takes = c.reel?.takes;
  const windows = (c.render as { windows?: { startTick: number; endTick: number }[] } | undefined)?.windows;
  if (!takes?.length || windows?.length !== takes.length) return undefined;
  const lengths = windows.map((w) => (w.endTick - w.startTick) / tickrate);
  if (Math.abs(lengths.reduce((a, b) => a + b, 0) - c.seconds) > 0.5) return undefined;
  const out = new Map<number, number>();
  let at = 0;
  takes.forEach((t, i) => { out.set(t.tick, Math.round(at * 10) / 10); at += lengths[i]; });
  return out;
}

/** The POV's deaths in a demo's counted rounds (knife rounds out; warmup is never a match round), and the rounds he played per side. */
export function deathRows(p: ParsedDemo, facingMaxDeg: number, m: number, reel?: { no: number; ticks: Set<number>; offsets?: Map<number, number> }): { rows: Row[]; rounds: Match["rounds"] } {
  const me = p.identity.steamid;
  const rounds = { CT: 0, T: 0 };
  const rows: Row[] = [];
  for (const r of p.rounds) {
    const side = r.teams[me];
    if (r.phase === "knife" || !side) continue;
    rounds[side]++;
    const inRound = p.deaths.filter((d) => d.round === r.n && d.tick <= r.endTick).sort((a, b) => a.tick - b.tick);
    const firstTeamDeath = inRound.find((d) => r.teams[d.victim] === side);
    for (const d of inRound.filter((x) => x.victim === me)) {
      const kind = d.attacker === null ? "world" : d.attacker === me ? "suicide" : r.teams[d.attacker] === side ? "team" : "enemy";
      const at = reel?.offsets?.get(d.tick);
      rows.push({
        m, r: r.n, s: side, w: weaponName(d.weapon), g: weaponGroup(d.weapon), k: kind,
        hs: d.headshot, f: kind === "enemy" && d.povFacingDeg !== undefined ? d.povFacingDeg <= facingMaxDeg : null,
        o: firstTeamDeath?.tick === d.tick, d: Math.round(d.distance * 10) / 10,
        v: d.victimPos ? [d.victimPos[0], d.victimPos[1]] : null,
        a: kind === "enemy" && d.attackerPos ? [d.attackerPos[0], d.attackerPos[1]] : null,
        ...(reel?.ticks.has(d.tick) ? { clip: reel.no } : {}),
        ...(at !== undefined ? { t: at } : {}),
      });
    }
  }
  return { rows, rounds };
}

/** Every cell the parse knows a player stood in on this map: the footprint plus every death's two positions. */
function cellsOf(p: ParsedDemo, into: Set<string>) {
  const fp = p.footprint ?? [];
  for (let i = 0; i + 1 < fp.length; i += 2) into.add(`${fp[i]},${fp[i + 1]}`);
  for (const d of p.deaths) for (const pos of [d.victimPos, d.attackerPos]) if (pos) into.add(`${Math.round(pos[0] / FOOTPRINT_CELL)},${Math.round(pos[1] / FOOTPRINT_CELL)}`);
}

export type DemoIn = { p: ParsedDemo; date: string | null; dateFrom: Match["dateFrom"]; reel?: Pick<ClipEntry, "no" | "seconds" | "reel"> & { render?: unknown } };
export type Coverage = { withPositions: number; total: number }; // matches
export type MapData = { map: string; cell: number; backdrop: number[]; matches: Match[]; rows: Row[]; coverage: Coverage };
export type DeathMapData = { generatedAt: string; facingMaxDeg: number; coverage: Coverage; maps: MapData[] };
/** A match whose parse has no positions and whose demo has left the store: counted, never plotted. */
export type NoPositions = { sha: string; map: string; date: string | null };

/** The page's data: one entry per map (most deaths first), each match's deaths and rounds, the backdrop cells, the coverage. */
export function buildDeathMap(demos: DemoIn[], facingMaxDeg: number, now = new Date(), noPositions: NoPositions[] = []): DeathMapData {
  const byMap = new Map<string, DemoIn[]>();
  for (const x of demos) byMap.set(x.p.demo.map, [...(byMap.get(x.p.demo.map) ?? []), x]);
  // A map whose every match lacks positions still gets its entry, so its coverage explains the empty plot.
  for (const x of noPositions) if (!byMap.has(x.map)) byMap.set(x.map, []);
  const maps: MapData[] = [...byMap.entries()].map(([map, xs]) => {
    xs.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    const cells = new Set<string>();
    const rows: Row[] = [];
    const matches: Match[] = xs.map((x, m) => {
      cellsOf(x.p, cells);
      // A death links to the reel only when the reel holds its take (a take that could not be spectated was skipped).
      const reel = x.reel?.no !== undefined && x.reel.reel ? { no: x.reel.no, ticks: new Set(x.reel.reel.takes.map((t) => t.tick)), offsets: reelOffsets(x.reel, x.p.demo.tickrate) } : undefined;
      const built = deathRows(x.p, facingMaxDeg, m, reel);
      rows.push(...built.rows);
      return { date: x.date, dateFrom: x.dateFrom, rounds: built.rounds };
    });
    const coverage = { withPositions: xs.length, total: xs.length + noPositions.filter((x) => x.map === map).length };
    return { map, cell: FOOTPRINT_CELL, backdrop: [...cells].flatMap((c) => c.split(",").map(Number)), matches, rows, coverage };
  });
  maps.sort((a, b) => b.rows.length - a.rows.length || a.map.localeCompare(b.map));
  const coverage = { withPositions: demos.length, total: demos.length + noPositions.length };
  return { generatedAt: now.toISOString(), facingMaxDeg, coverage, maps };
}

/** view.ts as plain browser script: types stripped, `export` dropped. */
export function viewScript(source = readFileSync(VIEW, "utf8")): string {
  // stripTypeScriptTypes says it is experimental on every call; that note is not for pnpm deathmap's output.
  const warn = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try { return module.stripTypeScriptTypes(source).replace(/^export /gm, ""); } finally { process.emitWarning = warn; }
}

/** The page: template + view script + data, every "<" in the data escaped so nothing in it can end the script element. */
export function renderDeathMap(data: DeathMapData, template = readFileSync(TEMPLATE, "utf8"), view = viewScript()): string {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return template.replace("/*__VIEW__*/", () => view).replace("/*__DATA__*/null", () => json);
}

/** A demo's match date, by the one rule the library page and pnpm week use (library/match-date.ts). */
function matchDate(sha: string, registry: Registry, dates: Record<string, number>): Pick<DemoIn, "date" | "dateFrom"> {
  const m = matchDateOf(registry[sha], dates);
  return { date: m.matchDate, dateFrom: m.dateFrom };
}

export type Sources = {
  readCache: (sha: string) => ParsedDemo | undefined; // the cached parse, if any (current or not)
  hasDemo: (file: string) => boolean;
  parse: (file: string) => Promise<ParsedDemo>; // the cached parse function (a stale or missing cache)
  reparse: (file: string) => Promise<ParsedDemo>; // a current cache without positions: once more, same key
};
export type Loaded = { demos: { sha: string; p: ParsedDemo }[]; noPositions: { sha: string; map: string }[]; reparsed: string[]; unread: { sha: string; why: string }[] };

/**
 * Which parse each registered demo contributes. A current cache with positions is used as is; one
 * without them is re-parsed when the demo is still in the store, else counted as "no positions" and
 * left untouched; with no current cache the demo is parsed if it is there, else it is unread. No cache
 * is ever deleted or invalidated.
 */
export async function loadDemos(registry: Registry, pov: string, src: Sources): Promise<Loaded> {
  const out: Loaded = { demos: [], noPositions: [], reparsed: [], unread: [] };
  // A fresh parse whose position extraction failed (the parse itself is complete) has no positions either.
  const add = (sha: string, p: ParsedDemo) => { if (hasPositions(p)) out.demos.push({ sha, p }); else out.noPositions.push({ sha, map: p.demo.map }); };
  for (const [sha, rec] of Object.entries(registry)) {
    try {
      const c = src.readCache(sha);
      const current = c && parseIsCurrent(c) && c.identity.steamid === pov ? c : undefined;
      if (current && hasPositions(current)) out.demos.push({ sha, p: current });
      else if (current && src.hasDemo(rec.file)) { add(sha, await src.reparse(rec.file)); out.reparsed.push(sha); }
      else if (current) out.noPositions.push({ sha, map: current.demo.map });
      else if (src.hasDemo(rec.file)) add(sha, await src.parse(rec.file));
      else out.unread.push({ sha, why: "no current parse and the demo is no longer in the store" });
    } catch (e) { out.unread.push({ sha, why: (e as Error).message }); }
  }
  return out;
}

/** Reads the registry and the parses (launches nothing) and writes library/deaths.html, temp then rename. */
export async function writeDeathMap(log: (m: string) => void = console.log): Promise<{ file: string; data: DeathMapData; loaded: Loaded }> {
  const pov = loadIdentities().pov;
  const facingMaxDeg = loadWeights().style.facingMaxDegrees;
  const registry = readRegistry();
  const dates = readMatchDates();
  const reels = new Map(Object.values(readIndex().clips).filter((c) => c.kind === "deaths").map((c) => [c.demoSha256, c]));
  const loaded = await loadDemos(registry, pov, {
    readCache: (sha) => { const f = path.join(parseDir(sha), "parse.json"); try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ParsedDemo) : undefined; } catch { return undefined; } },
    hasDemo: existsSync,
    parse: (file) => parseDemo(file, pov),
    reparse: (file) => reparseDemo(file, pov),
  });
  for (const x of loaded.reparsed) log(`${x.slice(0, 12)}: re-parsed once to add positions`);
  for (const x of loaded.noPositions) log(`${x.sha.slice(0, 12)} (${x.map}): no positions (parsed before the death map, demo no longer in the store)`);
  const why = new Map<string, number>();
  for (const x of loaded.unread) why.set(x.why, (why.get(x.why) ?? 0) + 1);
  for (const [w, n] of why) log(`${n} demo(s) not read: ${w}`);
  const demos = loaded.demos.map(({ sha, p }) => ({ p, ...matchDate(sha, registry, dates), reel: reels.get(sha) }));
  const data = buildDeathMap(demos, facingMaxDeg, new Date(), loaded.noPositions.map((x) => ({ ...x, ...matchDate(x.sha, registry, dates) })));
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const tmp = `${PAGE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, renderDeathMap(data));
  renameSync(tmp, PAGE);
  return { file: PAGE, data, loaded };
}
