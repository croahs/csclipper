// pnpm share <no> [--max-mb <n>] [--raw-audio]: library/share/<no>-<slug>.mp4, a copy of the clip
// that plays inline in Discord, browsers and phones (H.264, AAC, faststart) and fits the upload
// limit (config.json → share.maxMegabytes, default 20), its sound evened (config.json → share.audio,
// default "even"; --raw-audio: as the clip has it, for this run). Prints the path, the size and a caption to paste.
// --json: one JSON line instead (pnpm library runs this in a child process).
// Exit 2: the clip is too long for the limit (the message names a limit that works).
import { loadShareLimitMb, makeShare, MB, parseShareArgs, ShareRefusal } from "../share/index.ts";

function main(): number {
  let a;
  try { a = parseShareArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    const r = makeShare(a.no, a.maxMb ?? loadShareLimitMb(), a.json ? () => {} : (s) => console.log(s), a.rawAudio ? "raw" : undefined);
    if (a.json) { console.log(JSON.stringify(r)); return 0; }
    console.log(r.reused ? "already made, still valid:" : `made in ${r.encodeSeconds.toFixed(0)} s (${r.mode}, ${r.width}x${r.height}@${r.fps}):`);
    console.log(`  ${r.path}`);
    console.log(`  ${(r.bytes / MB).toFixed(1)} MB`);
    console.log(`  caption: ${r.caption}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return e instanceof ShareRefusal ? 2 : 1;
  }
}
process.exitCode = main();
