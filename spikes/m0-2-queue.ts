// M0.2 spike: minimal queue around m0-2-capture.ts, to show one interrupted
// job being recorded as failed and recovered by a retry in a fresh launch.
// Usage: pnpm exec tsx spikes/m0-2-queue.ts <demo.dem> <start>-<end> [<start>-<end> ...] [--interrupt-first <s>]
// Exits non-zero if any range exhausts its attempts or a cleanup is unverified.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--interrupt-first");
const interruptAfter = i >= 0 ? args.splice(i, 2)[1] : undefined;
const [demo, ...ranges] = args;
const MAX_ATTEMPTS = 2;

const log: Record<string, unknown>[] = [];
let failedRanges = 0;
let first = true;
for (const range of ranges) {
  const [start, end] = range.split("-");
  let ok = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
    // Each attempt gets its own fresh folder, passed explicitly: no guessing which output is whose.
    const out = path.resolve("spikes", "out", `${path.basename(demo, ".dem").slice(0, 10)}-${start}-${end}-${Date.now()}-a${attempt}`);
    const extra = first && attempt === 1 && interruptAfter ? ["--kill-after", interruptAfter] : [];
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--import", "tsx", "spikes/m0-2-capture.ts", demo, start, end, "--out", out, ...extra], { stdio: "inherit" });
    const resultFile = path.join(out, "result.json");
    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { status: "failed", reasons: ["no result.json"] };
    ok = r.status === 0 && r.signal === null && result.status === "ok" && existsSync(path.join(out, "clip.mp4"));
    log.push({ range, attempt, exit: r.status, signal: r.signal, seconds: Math.round((Date.now() - t0) / 1000), status: ok ? "ok" : "failed", reasons: result.reasons ?? [], out });
    if (r.status === 3) {
      console.error("cleanup not verified: stopping the queue");
      console.log(JSON.stringify(log, null, 2));
      process.exit(3);
    }
  }
  if (!ok) failedRanges++;
  first = false;
}
console.log("\n== queue log ==");
console.log(JSON.stringify(log, null, 2));
process.exitCode = failedRanges ? 1 : 0;
