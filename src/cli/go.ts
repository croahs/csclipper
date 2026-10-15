// pnpm go [--dry-run] [--retry-failed] [--repost] [--settle-existing] [--no-reels] [--timeout <s>] [--test-exit-after <s>]: the whole pipeline in
// one command. Ingest demos/inbox/, parse and rank every registered demo,
// render the selected moments (config.json batch: every one with score >= minScore,
// else the best one when none reaches it and fallbackBest) that are not in the library yet, rewrite library/index.html.
// Re-running resumes; with nothing new it launches nothing. --repost runs post
// only, for jobs whose capture is complete (e.g. after a post change): no launch.
// --settle-existing marks every registered demo processed (state/settled.json) and renders
// nothing; later runs skip settled demos, so new rules apply from the next new demo.
// --no-reels: highlights only for this run (config.json reels stays the default).
// Exit codes: 0 ok, 1 a job or demo failed, 2 refused (CS2 running, a guard,
// or another pnpm go), 3 cleanup not verified (the batch stopped; check for cs2.exe by hand).
import path from "node:path";
import { Refusal, STATE_DIR } from "../config.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { runBatch } from "../queue/index.ts";
import { PAGE } from "../library/page.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main(): Promise<number> {
  const timeoutS = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
  // One batch at a time; released on any exit, including a signal.
  const lock = new RenderLock(path.join(STATE_DIR, ".go.lock"));
  lock.acquire();
  const release = () => lock.release();
  process.on("exit", release);
  try {
    const testExit = flag("--test-exit-after");
    const { report: r, code } = await runBatch({
      dryRun: args.includes("--dry-run"), retryFailed: args.includes("--retry-failed"), repostOnly: args.includes("--repost"), settleExisting: args.includes("--settle-existing"), noReels: args.includes("--no-reels"), timeoutS,
      testExitAfterS: testExit === undefined ? undefined : Number(testExit),
    });
    if (r.settledNow !== undefined) {
      console.log(args.includes("--dry-run")
        ? `would settle ${r.settledNow} demo(s) (dry run: nothing written)`
        : `settled ${r.settledNow} demo(s) now, ${r.settled} in all: pnpm go skips them from here on (state/settled.json)`);
      return code;
    }
    console.log("\n== batch ==");
    console.log(`demos: ${r.demos} (${r.ingested} new), moments selected: ${r.selected}`);
    console.log(`rendered: ${r.rendered.length ? r.rendered.join(" | ") : "none"}`);
    // Made this run, by kind, with clip numbers (the page and pnpm clip --rerender take them).
    for (const kind of ["highlight", "deaths", "kills"]) {
      const made = r.made.filter((m) => m.kind === kind);
      if (made.length) console.log(`${kind === "highlight" ? "highlights" : kind === "deaths" ? "deaths reels" : "kills reels"}: ${made.map((m) => `clip ${m.no ?? "?"} (${m.title})`).join(", ")}`);
    }
    console.log(`already in the library: ${r.skipped.length}`);
    if (r.settled) console.log(`settled demos skipped: ${r.settled}`);
    if (r.emptyDemos.length) console.log(`no moment above the threshold: ${r.emptyDemos.join(", ")}`);
    for (const f of r.failed) console.log(`FAILED: ${f}`);
    for (const g of r.givenUp) console.log(`not retried (use --retry-failed): ${g}`);
    if (r.needsRender.length) console.log(`--repost: ${r.needsRender.length} selected moment(s) have no completed capture; a normal pnpm go renders them`);
    for (const d of r.demoErrors) console.log(`demo FAILED: ${d}`);
    if (r.pageError) console.log(`library page FAILED: ${r.pageError}`);
    if (r.stoppedBy) console.log(`batch stopped: ${r.stoppedBy === "refusal" ? "a guard refused" : "cleanup not verified"}`);
    console.log(`library: ${PAGE}`);
    return code;
  } finally {
    lock.release();
    process.off("exit", release);
  }
}

main().then(
  (code) => { process.exitCode = cleanupUnverified() ? 3 : code; },
  (e) => {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  },
);
