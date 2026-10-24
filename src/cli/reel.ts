// pnpm deaths <demo.dem> [--timeout <s>] [--dry-run]: the deaths reel (every death of the POV,
//   from the killer's first person).
// pnpm victims <demo.dem> [--timeout <s>] [--dry-run]: the kills reel (every kill by the POV,
//   from the victim's first person).
// One guarded launch for all the reel's takes (src/reel), then post and library. pnpm go
// makes both for every new demo by itself (config.json reels); these make one for any demo
// (a settled one too). A reel the library holds, or one that was deleted, is not made again.
// Exit codes as pnpm clip: 0 ok (or already in the library), 1 failed, 2 refused (nothing
// launched), 3 cleanup not verified.
import { existsSync } from "node:fs";
import path from "node:path";
import { Refusal } from "../config.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { prepareReel, type ReelKind } from "../reel/index.ts";
import { runJobs } from "../queue/job.ts";

const [kindArg, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--timeout");

async function main(): Promise<number> {
  const kind = kindArg as ReelKind;
  if ((kind !== "deaths" && kind !== "kills") || !positional[0]) { console.error("usage: pnpm deaths|victims <demo.dem> [--timeout <s>] [--dry-run]"); return 1; }
  const demo = path.resolve(positional[0]);
  if (!existsSync(demo)) throw new Error(`demo not found: ${demo}`);
  const timeoutS = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
  if (timeoutS !== undefined && !(timeoutS > 0)) throw new Error("--timeout must be a positive number of seconds");
  const unit = await prepareReel(demo, kind, { timeoutS });
  if (!unit) { console.log(`no ${kind === "deaths" ? "deaths" : "kills"} to show in this demo`); return 0; }
  console.log(`${unit.title}: ${unit.takes.length} takes (render key ${unit.renderKey})`);
  if (args.includes("--dry-run")) { for (const t of unit.takes) console.log(`  ticks ${t.startTick}-${t.endTick}, slot ${t.slot}`); return 0; }
  const [r] = await runJobs([unit]);
  if (r.status === "failed") return r.cleanupVerified === false ? 3 : 1;
  return 0;
}

main().then(
  (code) => { process.exitCode = cleanupUnverified() ? 3 : code; },
  (e) => {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  },
);
