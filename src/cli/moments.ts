// pnpm moments <demo.dem> [--pov <steamid64>]: the demo's ranked moments as a table (also written
// to state/<demo sha256>/moments.txt and moments.json). Parsing only, no launch. --pov: another
// player's moments, from that player's first person (pnpm go --film's view; its files go to
// state/<sha>/pov-<povKey>/). The ID is read from the command line only, never written anywhere tracked.
import { existsSync } from "node:fs";
import path from "node:path";
import { STEAMID64_BASE, loadIdentities } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import { PovAbsent } from "../parse/demo.ts";

const args = process.argv.slice(2);
const usage = "usage: pnpm moments <demo.dem> [--pov <steamid64>]";
const i = args.indexOf("--pov");
const povArg = i >= 0 ? args[i + 1] : undefined;
const demoArg = args.find((a, j) => !a.startsWith("--") && args[j - 1] !== "--pov");
if (!demoArg || (i >= 0 && !povArg)) {
  console.error(usage);
  process.exit(1);
}
if (povArg !== undefined && (!/^\d{17}$/.test(povArg) || BigInt(povArg) <= STEAMID64_BASE)) {
  console.error(`--pov needs a SteamID64 (17 digits); ${usage}`);
  process.exit(1);
}
const demo = path.resolve(demoArg);
if (!existsSync(demo)) {
  console.error(`demo not found: ${demo}`);
  process.exit(1);
}
const main = loadIdentities().pov;
try {
  const r = await buildMoments(demo, povArg ?? main, undefined, main);
  process.stdout.write(r.table);
  console.log(`\nwritten: ${r.file}`);
} catch (e) {
  // A player not in this demo is an answer, not a crash.
  if (!(e instanceof PovAbsent)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
