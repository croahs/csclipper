// pnpm grab [--dry-run] (PLAN.md's "pnpm fetch"; pnpm's own fetch command takes that name):
// "I have played some games". Runs every configured source (FACEIT now;
// Valve matchmaking later), each writing new demos into demos/inbox/, then
// ingests the inbox. Renders nothing; pnpm go does that. With no source
// configured (no FACEIT_API_KEY) it says so and exits 0 without touching anything.
// Exit codes: 0 ok, 1 a source or ingest failed, 2 another pnpm grab is running.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR, loadIdentities } from "../config.ts";
import { INBOX, ingest } from "../ingest/index.ts";
import type { Source } from "../ingest/sources.ts";
import { NO_KEY, faceitSource } from "../ingest/sources/faceit.ts";
import { RenderLock } from "../render/controller/guards.ts";

const dryRun = process.argv.includes("--dry-run");

/** The sources that can run; a missing key is reported, not an error. */
function sources(): Source[] {
  const env = existsSync(path.join(ROOT, ".env")) ? parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8")) : {};
  const out: Source[] = [];
  const faceitKey = env.FACEIT_API_KEY?.trim();
  if (!faceitKey) { console.log(`faceit: skipped. ${NO_KEY}`); return out; }
  // Configuration and identity are only needed once a source can run.
  const conf = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8")).sources ?? {};
  out.push(faceitSource({ apiKey: faceitKey, steamId64: loadIdentities().pov, maxMatchesPerRun: conf.faceit?.maxMatchesPerRun ?? 5 }));
  return out;
}

async function main(): Promise<number> {
  const list = sources();
  if (!list.length) return 0;
  // One grab at a time: sources read and advance their state across a whole run.
  const lock = new RenderLock(path.join(STATE_DIR, ".grab.lock"));
  lock.acquire();
  const release = () => lock.release();
  process.on("exit", release);
  try {
    let code = 0;
    for (const s of list) {
      try {
        const r = await s.fetch({ inbox: INBOX, stateFile: path.join(STATE_DIR, "sources", `${s.name}.json`), dryRun, log: (l) => console.log(l) });
        if (r.skipped) { console.log(`${s.name}: skipped. ${r.skipped}`); continue; }
        console.log(`${s.name}: ${r.fetched.length} demo(s) fetched${dryRun ? " (dry run: nothing written)" : ""}`);
        for (const p of r.pending) { console.log(`${s.name}: waiting on ${p.item}: ${p.reason}`); code = 1; }
      } catch (e) {
        console.error(`${s.name} FAILED: ${(e as Error).message}`);
        code = 1;
      }
    }
    if (dryRun) return code;
    const ing = await ingest();
    for (const a of ing.added) console.log(`ingested ${a.originalName}`);
    for (const r of ing.rejected) { console.log(`rejected ${r.name}: ${r.reason}`); code = 1; }
    for (const w of ing.waiting) console.log(`still being written, next run: ${w}`);
    console.log("inbox ingested; run pnpm go to rank and render");
    return code;
  } finally {
    lock.release();
    process.off("exit", release);
  }
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(String((e as Error).message)); process.exitCode = e instanceof Refusal ? 2 : 1; });
