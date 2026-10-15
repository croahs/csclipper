// pnpm drop <no>...: delete clips by number (not "pnpm rm": pnpm's own rm removes a dependency). Each mp4 moves to library/trash/, its entry leaves
// the index (the number is never reused) and the moment is never made again (state/deleted.json).
// pnpm trash --empty deletes what is in library/trash/ for good.
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TRASH_DIR, deleteClip } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";

const [cmd, ...args] = process.argv.slice(2);

function main(): number {
  if (cmd === "trash") {
    if (!args.includes("--empty")) { console.error("usage: pnpm trash --empty"); return 1; }
    let n = 0;
    try { for (const f of readdirSync(TRASH_DIR)) { rmSync(path.join(TRASH_DIR, f), { force: true }); n++; } } catch {}
    console.log(`trash emptied: ${n} file(s) deleted`);
    return 0;
  }
  const nos = args.map(Number);
  if (!nos.length || nos.some((n) => !Number.isInteger(n) || n < 1)) { console.error("usage: pnpm drop <clip number>..."); return 1; }
  let code = 0;
  for (const no of nos) {
    const e = deleteClip(no);
    if (e) console.log(`deleted clip ${no}: ${e.title} (file in library/trash/, never made again)`);
    else { console.error(`no clip ${no}`); code = 1; }
  }
  writeLibraryPage();
  return code;
}

process.exitCode = main();
