// pnpm clip <demo.dem> <startTick> <endTick> [--timeout <s>] [--dry-run] [--debug-cmd <cmd>]...
// pnpm clip <demo.dem> --top <n> [same options]: the demo's n-th ranked moment (pnpm moments).
// pnpm clip --rerender <no|id> [--lead <s>] [--timeout <s>] [--dry-run]: render a library clip (by clip number or id) again, now (the only
//   way a finished clip is re-made: AGENTS.md). The moment is ranked afresh from its demo; when the
//   span rules changed its id, the old clip is moved to library/replaced/ once the new one is in.
// One clip, guarded render → post → library (src/queue/job.ts).
// Exit codes: 0 ok (or already in the library), 1 failed, 2 refused (nothing
// launched), 3 cleanup not verified (a game process may still run; the lock stays).
import { existsSync } from "node:fs";
import path from "node:path";
import { Refusal, loadIdentities } from "../config.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { exitOnSignal } from "../render/controller/launch.ts";
import { buildMoments } from "../clip/moments.ts";
import type { ClipSpec } from "../clip/index.ts";
import { clipJob, heldEntry } from "../queue/job.ts";
import { readIndex } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !["--timeout", "--debug-cmd", "--top", "--rerender", "--lead"].includes(args[i - 1]));
// --debug-cmd <cmd> (repeatable): a quote-free console command scheduled after spec_player, e.g. a panel dump.
// Only diagnostics are allowed: anything else could leave playback or change the schedule.
const DEBUG_CMD = /^__mirv_panorama_print_children [A-Za-z][A-Za-z0-9_-]*$/;
const debugCommands = args.flatMap((a, i) => (a === "--debug-cmd" && args[i + 1] ? [args[i + 1]] : []));
const [demoArg, startArg, endArg] = positional;
const usage = "usage: pnpm clip <demo.dem> (<startTick> <endTick> | --top <n>) [--timeout <s>] [--dry-run] [--debug-cmd <cmd>]...\n       pnpm clip --rerender <no|id> [--lead <s>] [--timeout <s>] [--dry-run]";

async function rerender(ref: string, timeoutS: number | undefined, lead: number | undefined): Promise<number> {
  // A clip number ("17") or a clip id.
  const clips = readIndex().clips;
  const entry = clips[ref] ?? (/^\d+$/.test(ref) ? Object.values(clips).find((c) => c.no === Number(ref)) : undefined);
  if (!entry) throw new Error(`no clip ${ref} in library/index.json`);
  const id = entry.id;
  if (!existsSync(entry.demo)) throw new Error(`the clip's demo is gone: ${entry.demo}`);
  const dryRun = args.includes("--dry-run");
  let r;
  if (!Array.isArray(entry.moment?.killTicks)) {
    if (lead !== undefined) throw new Error("--lead applies to ranked moments; a hand-written range is re-rendered by its own ticks");
    // A hand-written range: the same ticks again (its id comes from them).
    console.log(`re-rendering clip ${entry.no ?? id}: ticks ${entry.startTick}-${entry.endTick}`);
    r = await clipJob({ demo: entry.demo, startTick: entry.startTick, endTick: entry.endTick, force: true, dryRun, timeoutS });
  } else {
    // A ranked moment: ranked afresh, so new span rules apply. Its spec is the one with the same id,
    // else the one sharing the most kills with it that shares none with another library clip; a tie refuses.
    const clips = readIndex().clips;
    // --lead: this clip's spec is built with that lead-in instead of the configured one.
    const { specs } = await buildMoments(entry.demo, loadIdentities().pov, lead !== undefined ? { leadInSeconds: lead } : undefined);
    const mine = new Set(entry.moment!.killTicks as number[]);
    const shared = (s: ClipSpec) => s.killTicks.filter((t) => mine.has(t)).length;
    const candidates = specs
      .filter((s) => s.id === id || (s.round === entry.round && shared(s) > 0 && !Object.values(clips).some((e) => e.id !== id && heldEntry({ [e.id]: e }, s.id, entry.demoSha256, s.round, s))))
      .sort((x, y) => Number(y.id === id) - Number(x.id === id) || shared(y) - shared(x));
    const spec = candidates[0];
    if (!spec) throw new Error(`clip ${entry.no ?? id}'s moment is no longer among the demo's ranked moments`);
    if (spec.id !== id && candidates[1] && shared(candidates[1]) === shared(spec)) throw new Error(`clip ${entry.no ?? id} matches more than one ranked moment equally (${candidates.map((c) => c.id).join(", ")}); nothing rendered`);
    console.log(`re-rendering clip ${entry.no ?? id} as moment ${spec.id}: ${spec.title} (ticks ${spec.startTick}-${spec.endTick})`);
    r = await clipJob({ demo: entry.demo, spec, force: true, dryRun, timeoutS, replaces: spec.id !== id ? id : undefined, leadOverride: lead });
    if (r.status === "done" && spec.id !== id) console.log(`replaced ${id}: moved to library/replaced/`);
  }
  if (r.status === "done") writeLibraryPage();
  if (r.status === "failed") return r.cleanupVerified === false ? 3 : 1;
  return 0;
}

async function main(): Promise<number> {
  const rerenderId = flag("--rerender");
  if (args.includes("--rerender")) {
    if (!rerenderId || !/^(\d+|[0-9a-f]{16})$/.test(rerenderId)) { console.error(usage); return 1; }
    const t = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
    if (t !== undefined && !(t > 0)) throw new Error("--timeout must be a positive number of seconds");
    if (args.includes("--lead") && (flag("--lead") === undefined || flag("--lead")!.startsWith("--"))) throw new Error("--lead needs a number of seconds");
    const lead = flag("--lead") === undefined ? undefined : Number(flag("--lead"));
    if (lead !== undefined && !(lead >= 0 && lead <= 30)) throw new Error("--lead must be a number of seconds from 0 to 30");
    return rerender(rerenderId, t, lead);
  }
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
    dryRun: args.includes("--dry-run"), timeoutS, debugCommands,
  });
  if (r.status === "failed") return r.cleanupVerified === false ? 3 : 1;
  return 0;
}

// A signal outside the launch (ranking, post) ends the process so the clip lock's exit hook runs
// (src/queue/job.ts); inside it, the launch's own hook cleans up first and then exits.
exitOnSignal("pnpm clip");
main().then(
  (code) => { process.exitCode = cleanupUnverified() ? 3 : code; },
  (e) => {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  },
);
