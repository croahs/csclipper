// pnpm tidy: delete the raw captures (HLAE's intermediate video and audio under state/render/)
// of every clip the library holds or that was deleted (src/queue/prune.ts); pnpm go does the
// same at the end of every run, so this is for freeing disk without a run. Launches nothing,
// touches no clip, demo or state file. Exit 1 when a file could not be deleted, 2 when a clip
// run holds state/.clip.lock (run it again when that is done).
import { prunedLine, sweepUnderClipLock } from "../queue/prune.ts";

const r = sweepUnderClipLock();
if (!r) {
  console.error("refusing: a clip run holds state/.clip.lock; run pnpm tidy when it is done (if nothing is running, delete the lock by hand)");
  process.exitCode = 2;
} else {
  for (const p of r.problems) console.error(`tidy: ${p}`);
  console.log(r.files ? prunedLine(r) : "nothing to remove: no raw capture of a held clip is left under state/render/");
  process.exitCode = r.problems.length ? 1 : 0;
}
