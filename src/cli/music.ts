// pnpm music [--check]: the default tracks of music.json into music/ (gitignored), each checked
// against its sha256 (temp, then rename; a mismatch is deleted and reported). --check only reports.
// Exit 1 when a track is missing or wrong after the run (or, with --check, at all).
import path from "node:path";
import { rmSync } from "node:fs";
import { checkTracks, fetchTrack, loadManifest, MUSIC_DIR } from "../week/music.ts";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((x) => x !== "--check")) { console.error("usage: pnpm music [--check]"); return 1; }
  const check = args.includes("--check");
  const tracks = loadManifest();
  if (!tracks.length) { console.error("music.json lists no tracks"); return 1; }
  let bad = 0;
  for (const { track: t, state } of checkTracks(tracks)) {
    const where = path.join(MUSIC_DIR, t.file);
    if (state === "ok") { console.log(`ok       ${t.file}  (${t.title}, ${t.artist}, ${t.license}, ${t.bpm} BPM)`); continue; }
    if (check) { console.log(`${state.padEnd(8)} ${t.file}`); bad++; continue; }
    if (state === "mismatch") { rmSync(where, { force: true }); console.log(`mismatch ${t.file}: deleted, fetching again`); }
    try {
      await fetchTrack(t);
      console.log(`fetched  ${t.file}  from ${t.url}, sha256 matches`);
    } catch (e) {
      console.error(`failed   ${t.file}: ${(e as Error).message}`);
      bad++;
    }
  }
  console.log(`credit lines (CC BY: required wherever a video with the track is posted):`);
  for (const t of tracks) console.log(`  ${t.credit}`);
  return bad ? 1 : 0;
}
process.exitCode = await main();
