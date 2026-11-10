// pnpm cut <no> <from> <to>: library/cuts/<no>-<slug>_<from>-<to>.mp4, the part of the clip
// between those times (seconds as it plays, 4.5 or 0:04.5), re-encoded frame-accurately with the
// library's short fades (H.264, AAC, faststart, config.json → cut). The library clip is never
// changed. Prints the path, the size, the length and share's caption. --json: one JSON line
// instead, as pnpm share gives (pnpm library runs this in a child process).
// Exit 2: no such clip, or a cut outside the clip, under 1 s, or the whole clip.
import { MB } from "../share/index.ts";
import { CutRefusal, makeCut, parseCutArgs } from "../share/cut.ts";

function main(): number {
  let a;
  try { a = parseCutArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    const r = makeCut(a.no, a.from, a.to, a.json ? () => {} : (s) => console.log(s));
    if (a.json) { console.log(JSON.stringify(r)); return 0; }
    console.log(r.reused ? "already made, still valid:" : `made in ${r.encodeSeconds.toFixed(0)} s:`);
    console.log(`  ${r.path}`);
    console.log(`  ${(r.bytes / MB).toFixed(1)} MB, ${r.seconds.toFixed(1)} s (${r.from}-${r.to} s of the clip)`);
    console.log(`  caption: ${r.caption}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return e instanceof CutRefusal ? 2 : 1;
  }
}
process.exitCode = main();
