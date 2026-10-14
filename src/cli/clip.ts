// pnpm clip <demo.dem> <startTick> <endTick> [--timeout <s>] [--force] [--dry-run] [--debug-cmd <cmd>]...
// pnpm clip <demo.dem> --top <n> [same options]: the demo's n-th ranked moment (pnpm moments).
// One clip, guarded render → post → library (src/queue/job.ts).
// Exit codes: 0 ok (or already in the library), 1 failed, 2 refused (nothing
// launched), 3 cleanup not verified (a game process may still run; the lock stays).
import { existsSync } from "node:fs";
import path from "node:path";
import { Refusal, loadIdentities } from "../config.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { buildMoments } from "../clip/moments.ts";
import type { ClipSpec } from "../clip/index.ts";
import { clipJob } from "../queue/job.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !["--timeout", "--debug-cmd", "--top"].includes(args[i - 1]));
// --debug-cmd <cmd> (repeatable): a quote-free console command scheduled after spec_player, e.g. a panel dump.
// Only diagnostics are allowed: anything else could leave playback or change the schedule.
const DEBUG_CMD = /^__mirv_panorama_print_children [A-Za-z][A-Za-z0-9_-]*$/;
const debugCommands = args.flatMap((a, i) => (a === "--debug-cmd" && args[i + 1] ? [args[i + 1]] : []));
const [demoArg, startArg, endArg] = positional;
const usage = "usage: pnpm clip <demo.dem> (<startTick> <endTick> | --top <n>) [--timeout <s>] [--force] [--dry-run] [--debug-cmd <cmd>]...";

async function main(): Promise<number> {
  if (!demoArg) { console.error(usage); return 1; }
  const demo = path.resolve(demoArg);
  if (!existsSync(demo)) throw new Error(`demo not found: ${demo}`);
  const bad = debugCommands.find((c) => !DEBUG_CMD.test(c));
  if (bad !== undefined) throw new Error(`--debug-cmd allows only "__mirv_panorama_print_children <PanelId>", got: ${bad}`);
  const timeoutS = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
  if (timeoutS !== undefined && !(timeoutS > 0)) throw new Error("--timeout must be a positive number of seconds");
  // --top n: the spec comes from the ranked moments (parse → score → clip specs).
  let spec: ClipSpec | undefined;
  if (flag("--top") !== undefined) {
    const n = Number(flag("--top"));
    const { specs } = await buildMoments(demo, loadIdentities().pov);
    spec = specs.find((s) => s.rank === n);
    if (!Number.isInteger(n) || !spec) throw new Error(`no moment ranked ${flag("--top")} (this demo has ${specs.length})`);
    console.log(`moment #${n}: ${spec.title} (score ${spec.score}, ticks ${spec.startTick}-${spec.endTick})`);
  }
  const r = await clipJob({
    demo, spec, startTick: Number(startArg), endTick: Number(endArg),
    force: args.includes("--force"), dryRun: args.includes("--dry-run"), timeoutS, debugCommands,
  });
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
