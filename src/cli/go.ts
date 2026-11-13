// pnpm go [--dry-run] [--retry-failed] [--repost] [--settle-existing] [--no-reels] [--film] [--timeout <s>] [--test-exit-after <s>]: the whole pipeline in
// one command. Ingest demos/inbox/, parse and rank every registered demo,
// render the selected moments (config.json batch: every one with score >= minScore,
// else the best one when none reaches it and fallbackBest) that are not in the library yet, rewrite library/index.html.
// Re-running resumes; with nothing new it launches nothing. --repost runs post
// only, for jobs whose capture is complete (e.g. after a post change): no launch.
// --settle-existing marks every registered demo processed (state/settled.json) and renders
// nothing; later runs skip settled demos, so new rules apply from the next new demo.
// --no-reels: highlights only for this run (config.json reels stays the default).
// --film (pnpm film): per roster player (.env STEAM_ID64 + FILM_STEAM_ID64S) the config.json film.top
// best highlights under the film weights (scoring.film.json) and the film.bloopersTop best bloopers
// scoring film.bloopers.minScore or more, ranked over every registered demo still on disk, from that
// player's first person; no reels, no settling. --dry-run prints each player's ranked tables.
// pnpm film masters [--dry-run] (--film masters): an edit-grade .mov of every clip picked for the film (the
// film picker or the library page's film button), in library/film/masters/<player>/ (src/film/masters.ts).
// Exit codes: 0 ok, 1 a job or demo failed, 2 refused (CS2 running, a guard,
// or another pnpm go), 3 cleanup not verified (the batch stopped; check for cs2.exe by hand).
import path from "node:path";
import { Refusal, STATE_DIR } from "../config.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { cleanupUnverified } from "../render/controller/index.ts";
import { exitOnSignal } from "../render/controller/launch.ts";
import { batchRefusal, runBatch } from "../queue/index.ts";
import { runMasters } from "../film/masters.ts";
import { PAGE } from "../library/page.ts";
import { prunedLine } from "../queue/prune.ts";
import { quickEditOff } from "../quickedit.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function main(): Promise<number> {
  quickEditOff();
  const timeoutS = flag("--timeout") === undefined ? undefined : Number(flag("--timeout"));
  // One batch at a time; released on any exit. A signal outside a launch ends the process so that
  // exit runs (exitOnSignal); inside one, the launch's own hook cleans up first and then exits.
  const lock = new RenderLock(path.join(STATE_DIR, ".go.lock"));
  lock.acquire();
  const release = () => lock.release();
  process.on("exit", release);
  const sig = exitOnSignal("pnpm go");
  try {
    if (args.includes("--film") && args.includes("masters")) return await masters(timeoutS);
    const testExit = flag("--test-exit-after");
    const { report: r, code } = await runBatch({
      dryRun: args.includes("--dry-run"), retryFailed: args.includes("--retry-failed"), repostOnly: args.includes("--repost"), settleExisting: args.includes("--settle-existing"), noReels: args.includes("--no-reels"), film: args.includes("--film"), timeoutS,
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
    if (r.film) {
      // Film: made this run per player (highlights, then bloopers), with clip numbers, then whom each demo lacked.
      const f = r.film;
      const label = (p: { key: string; name?: string }) => p.name ?? `player ${p.key}`;
      const clips = (ms: typeof r.made) => ms.map((m) => `clip ${m.no ?? "?"} (${m.title})`).join(", ");
      console.log(`film (per player the top ${f.top} highlights at ${f.minScore}+ by film score and the top ${f.bloopersTop} bloopers at ${f.blooperMinScore}+, no reels, no settling), ${f.players.length} player(s); already in the library: ${f.held} of the selection:`);
      for (const p of f.players) {
        const hl = r.made.filter((m) => m.kind === "highlight" && m.player?.key === p.key);
        const bl = r.made.filter((m) => m.kind === "blooper" && m.player?.key === p.key);
        const made = [hl.length ? clips(hl) : "", bl.length ? `bloopers: ${clips(bl)}` : ""].filter(Boolean).join("; ");
        console.log(`  ${label(p)}: ${made || (args.includes("--dry-run") ? "dry run, nothing made (would render: above)" : "nothing new")}`);
      }
      for (const p of f.players) {
        const absent = f.absent.filter((a) => a.key === p.key && !f.noPlayer.includes(a.demo));
        if (absent.length) console.log(`  not in ${absent.length} demo(s): ${label(p)}`);
      }
      if (f.noPlayer.length) console.log(`no roster player in: ${f.noPlayer.join(", ")}`);
      if (f.missingFiles) console.log(`registered demos no longer on disk, skipped: ${f.missingFiles}`);
    }
    // Made this run, by kind, with clip numbers (the page and pnpm clip --rerender take them).
    for (const kind of r.film ? [] : ["highlight", "deaths", "kills"]) {
      const made = r.made.filter((m) => m.kind === kind);
      if (made.length) console.log(`${kind === "highlight" ? "highlights" : kind === "deaths" ? "deaths reels" : "kills reels"}: ${made.map((m) => `clip ${m.no ?? "?"} (${m.title})`).join(", ")}`);
    }
    console.log(`already in the library: ${r.skipped.length}`);
    if (r.settled) console.log(`settled demos skipped: ${r.settled}`);
    if (r.autoSettled.length) console.log(`settled now (pass finished): ${r.autoSettled.length} demo(s); rescoring adds no work for them (pnpm unsettle to reopen)`);
    if (r.emptyDemos.length) console.log(`no moment above the threshold: ${r.emptyDemos.join(", ")}`);
    for (const f of r.failed) console.log(`FAILED: ${f}`);
    for (const g of r.givenUp) console.log(`not retried (use --retry-failed): ${g}`);
    for (const d of r.deferred) console.log(`deferred to the next pnpm go (a launch of its own: it plays past the match end): ${d}`);
    if (r.needsRender.length) console.log(`--repost: ${r.needsRender.length} selected moment(s) have no completed capture; a normal pnpm go renders them`);
    for (const d of r.demoErrors) console.log(`demo FAILED: ${d}`);
    if (r.pageError) console.log(`library page FAILED: ${r.pageError}`);
    if (r.pruned?.files) console.log(prunedLine(r.pruned));
    if (r.stoppedBy) console.log(`batch stopped: ${r.stoppedBy === "refusal" ? "a guard refused" : "cleanup not verified"}`);
    console.log(`library: ${PAGE}`);
    return code;
  } finally {
    sig.off();
    lock.release();
    process.off("exit", release);
  }
}

/** pnpm film masters: refused like a batch unless it is a dry run (that launches nothing); the report per kind. */
async function masters(timeoutS: number | undefined): Promise<number> {
  const dryRun = args.includes("--dry-run");
  if (!dryRun) { const refusal = batchRefusal({}); if (refusal) throw refusal; }
  const { report: r, code } = await runMasters({ dryRun, timeoutS });
  console.log("\n== film masters ==");
  if (dryRun) console.log(`would capture: ${r.wouldCapture} master(s) (dry run: nothing written)`);
  for (const m of r.made) console.log(`made: ${m}`);
  console.log(`already made (same key): ${r.held.length}`);
  for (const s of r.skipped) console.log(`skipped: ${s}`);
  for (const f of r.failed) console.log(`FAILED: ${f}`);
  if (r.stoppedBy) console.log("masters stopped: cleanup not verified");
  return code;
}

main().then(
  (code) => { process.exitCode = cleanupUnverified() ? 3 : code; },
  (e) => {
    console.error(String((e as Error).message));
    process.exitCode = cleanupUnverified() ? 3 : e instanceof Refusal ? 2 : 1;
  },
);
