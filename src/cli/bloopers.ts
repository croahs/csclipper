// pnpm bloopers <demo.dem> [--ids <id,id>] [--all]: the demo's bloopers (src/film/bloopers.ts) as a
// ranked table. Roster: --ids, or every player in the match with --all, else the .env POV. Parsing
// only, no launch; the first run samples the demo's track (cached in state/<sha>/).
import { existsSync } from "node:fs";
import path from "node:path";
import { loadIdentities } from "../config.ts";
import { detectBloopers, loadBlooperSettings, type Blooper } from "../film/bloopers.ts";
import { parseAnyPov, sampleTrack } from "../film/track.ts";

const args = process.argv.slice(2);
const demoArg = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--ids");
const idsAt = args.indexOf("--ids");
if (!demoArg || (idsAt >= 0 && !args[idsAt + 1])) {
  console.error("usage: pnpm bloopers <demo.dem> [--ids <steamid,steamid>] [--all]");
  process.exit(1);
}
const demo = path.resolve(demoArg);
if (!existsSync(demo)) {
  console.error(`demo not found: ${demo}`);
  process.exit(1);
}
const cfg = loadBlooperSettings();
let t0 = performance.now();
const p = await parseAnyPov(demo, loadIdentities().pov);
const parseMs = performance.now() - t0;
t0 = performance.now();
const track = sampleTrack(demo, p);
const trackMs = performance.now() - t0;
const everyone = [...new Set(p.rounds.flatMap((r) => Object.keys(r.teams)))];
const roster = args.includes("--all") ? everyone : idsAt >= 0 ? args[idsAt + 1].split(",").map((s) => s.trim()) : [loadIdentities().pov];
t0 = performance.now();
const found = detectBloopers(p, track, roster, cfg);
const detectMs = performance.now() - t0;

const t = p.demo.tickrate;
const detail = (b: Blooper) => Object.entries(b.detail).filter(([k]) => k !== "victim" && k !== "target" && k !== "who").map(([k, v]) => `${k}=${v}`).join(" ");
const rows = found.map((b) => [String(b.score), b.type, `R${b.round}`, b.name, ((b.endTick - b.startTick) / t).toFixed(1), b.title.split(" · ").slice(3).join(" · "), detail(b)]);
const head = ["score", "type", "round", "player", "span s", "what", "detail"];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
console.log(`${p.demo.map} · ${roster.length === everyone.length && args.includes("--all") ? "all players" : `${roster.length} player(s)`} · ${found.length} bloopers, ${found.filter((b) => b.score >= cfg.minScore).length} at ${cfg.minScore}+`);
if (rows.length) { console.log(line(head)); for (const r of rows) console.log(line(r)); }
console.log(`parse ${(parseMs / 1000).toFixed(1)} s · track ${(trackMs / 1000).toFixed(1)} s · detect ${(detectMs / 1000).toFixed(2)} s`);
