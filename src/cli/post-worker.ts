// Post worker (started by pnpm go, not by hand): posts and publishes one demo's units from
// their recorded captures, in its own process, so pnpm go can launch the next demo meanwhile.
// It never launches (every unit is post-only: no capture means a refusal, not a render),
// never takes the clip lock (pnpm go holds it for its launches) and never writes the ledger:
// it writes its results to a file and pnpm go records them.
//   tsx src/cli/post-worker.ts <job.json> <result.json>
//   job.json: { demo, highlights: [clip ids], reels: ["deaths" | "kills"] }
import { readFileSync, writeFileSync } from "node:fs";
import { loadIdentities } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import { highlightUnit, prepareJob, runJobs, type JobResult, type RenderUnit } from "../queue/job.ts";
import { prepareReel, type ReelKind } from "../reel/index.ts";

type PostJob = { demo: string; highlights: string[]; reels: ReelKind[] };

async function main() {
  const [jobFile, resultFile] = process.argv.slice(2);
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as PostJob;
  const units: RenderUnit[] = [];
  const results: JobResult[] = [];
  const o = { postOnly: true, inBatch: true };
  if (job.highlights.length) {
    const { specs } = await buildMoments(job.demo, loadIdentities().pov);
    for (const id of job.highlights) {
      const spec = specs.find((s) => s.id === id);
      if (!spec) { results.push({ status: "failed", id, title: id, reasons: ["moment no longer among the demo's ranked moments"] }); continue; }
      units.push(highlightUnit(await prepareJob({ demo: job.demo, spec, ...o })));
    }
  }
  for (const kind of job.reels) {
    const u = await prepareReel(job.demo, kind, o);
    if (u) units.push(u);
  }
  try {
    results.push(...await runJobs(units, { noClipLock: true }));
  } catch (e) {
    for (const u of units) results.push({ status: "failed", id: u.id, title: u.title, reasons: [`post worker: ${(e as Error).message}`] });
  }
  writeFileSync(resultFile, JSON.stringify(results, null, 2));
}

// Ctrl+C reaches this process too: with a handler, the signal is acted on only after the current
// synchronous step (an encode, an index write and its lock release) has finished.
for (const sig of ["SIGINT", "SIGBREAK", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

main().catch((e) => { console.error(String((e as Error).message)); process.exitCode = 1; });
