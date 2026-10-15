// pnpm unsettle <demo sha256 prefix (6+ chars) | clip number>...: reopen settled demos, so the next pnpm go
// renders their moments that qualify under the current rules (and the reels it has not made).
// A demo is settled when a pnpm go pass over it finishes, or by pnpm go --settle-existing.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config.ts";
import { readIndex, writeJsonAtomic } from "../library/index.ts";

const SETTLED = path.join(STATE_DIR, "settled.json");
const refs = process.argv.slice(2);
if (!refs.length) { console.error("usage: pnpm unsettle <demo sha256 prefix | clip number>..."); process.exit(1); }
const settled: Record<string, string> = existsSync(SETTLED) ? JSON.parse(readFileSync(SETTLED, "utf8")) : {};
let code = 0;
for (const ref of refs) {
  // A clip number is short; a demo hash prefix is at least 6 characters (and may be all digits).
  const sha = /^\d{1,5}$/.test(ref)
    ? Object.values(readIndex().clips).find((c) => c.no === Number(ref))?.demoSha256
    : Object.keys(settled).filter((k) => k.startsWith(ref.toLowerCase())).length === 1 ? Object.keys(settled).find((k) => k.startsWith(ref.toLowerCase())) : undefined;
  if (!sha) { console.error(`${ref}: no clip with that number, or the prefix matches no single settled demo`); code = 1; continue; }
  if (!settled[sha]) { console.log(`${sha.slice(0, 12)}: not settled`); continue; }
  delete settled[sha];
  console.log(`${sha.slice(0, 12)}: unsettled; the next pnpm go looks at it again`);
}
writeJsonAtomic(SETTLED, settled);
process.exitCode = code;
