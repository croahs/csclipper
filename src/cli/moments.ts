// pnpm moments <demo.dem>: the demo's ranked moments as a table (also written
// to state/<demo sha256>/moments.txt and moments.json). Parsing only, no launch.
import { existsSync } from "node:fs";
import path from "node:path";
import { loadIdentities } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";

const demoArg = process.argv[2];
if (!demoArg) {
  console.error("usage: pnpm moments <demo.dem>");
  process.exit(1);
}
const demo = path.resolve(demoArg);
if (!existsSync(demo)) {
  console.error(`demo not found: ${demo}`);
  process.exit(1);
}
const r = await buildMoments(demo, loadIdentities().pov);
process.stdout.write(r.table);
console.log(`\nwritten: ${r.file}`);
