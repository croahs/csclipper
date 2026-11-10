// pnpm vertical <no> [--shift <percent>]: library/vertical/<no>-<slug>.mp4, a 9:16 copy of the
// clip for Reels, TikTok and Shorts (the centre column, config.json → vertical, H.264, AAC,
// faststart). Prints the path, the size and a caption to paste. --shift moves the column by that
// percent of the frame width (negative: left). --json: one JSON line instead, as pnpm share gives.
// Exit 2: no such clip, or a source already narrower than 9:16.
import { MB } from "../share/index.ts";
import { makeVertical, parseVerticalArgs, VerticalRefusal } from "../share/vertical.ts";

function main(): number {
  let a;
  try { a = parseVerticalArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    const r = makeVertical(a.no, a.shift, a.json ? () => {} : (s) => console.log(s));
    if (a.json) { console.log(JSON.stringify(r)); return 0; }
    console.log(r.reused ? "already made, still valid:" : `made in ${r.encodeSeconds.toFixed(0)} s (${r.width}x${r.height}@${r.fps}, crop x=${r.crop.x}):`);
    console.log(`  ${r.path}`);
    console.log(`  ${(r.bytes / MB).toFixed(1)} MB, ${r.seconds.toFixed(1)} s`);
    console.log(`  caption: ${r.caption}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return e instanceof VerticalRefusal ? 2 : 1;
  }
}
process.exitCode = main();
