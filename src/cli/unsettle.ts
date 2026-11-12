// pnpm unsettle [--film] <demo sha256 prefix (6+ chars) | clip number>...: reopen settled demos, so the next pnpm go
// renders their moments that qualify under the current rules (and the reels it has not made).
// A demo is settled when a pnpm go pass over it finishes, or by pnpm go --settle-existing.
// --film: removes the demo's player-demo pairs from state/film.json instead (every player's), so the next
// pnpm film looks at it again; state/settled.json is left as it is.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config.ts";
import { readIndex, writeJsonAtomic } from "../library/index.ts";
import { FILM, demoOfRef, filmDemos, readFilmState, unsettleFilm } from "../queue/index.ts";

const SETTLED = path.join(STATE_DIR, "settled.json");
const args = process.argv.slice(2);
const film = args.includes("--film");
const refs = args.filter((a) => a !== "--film");
if (!refs.length) { console.error("usage: pnpm unsettle [--film] <demo sha256 prefix | clip number>..."); process.exit(1); }
const clips = Object.values(readIndex().clips);
let code = 0;
if (film) {
  let state = readFilmState();
  for (const ref of refs) {
    const sha = demoOfRef(ref, filmDemos(state), clips);
    if (!sha) { console.error(`${ref}: no clip with that number, or the prefix matches no single demo in state/film.json`); code = 1; continue; }
    const r = unsettleFilm(state, sha);
    if (!r.removed) { console.log(`${sha.slice(0, 12)}: no film pairs`); continue; }
    state = r.film;
    console.log(`${sha.slice(0, 12)}: ${r.removed} film pair(s) removed; the next pnpm film looks at it again`);
  }
  writeJsonAtomic(FILM, state);
} else {
  const settled: Record<string, string> = existsSync(SETTLED) ? JSON.parse(readFileSync(SETTLED, "utf8")) : {};
  for (const ref of refs) {
    // A clip number is short; a demo hash prefix is at least 6 characters (and may be all digits).
    const sha = demoOfRef(ref, Object.keys(settled), clips);
    if (!sha) { console.error(`${ref}: no clip with that number, or the prefix matches no single settled demo`); code = 1; continue; }
    if (!settled[sha]) { console.log(`${sha.slice(0, 12)}: not settled`); continue; }
    delete settled[sha];
    console.log(`${sha.slice(0, 12)}: unsettled; the next pnpm go looks at it again`);
  }
  writeJsonAtomic(SETTLED, settled);
}
process.exitCode = code;
