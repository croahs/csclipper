// pnpm grab [--dry-run] (PLAN.md's "pnpm fetch"; pnpm's own fetch command takes that name):
// "I have played some games". Runs the demo sources, each writing new demos
// into demos/inbox/, then ingests the inbox. Renders nothing; pnpm go does that.
//   folders  copies new demos from watched folders, read-only (default: CS2's
//            game/csgo, where the FACEIT client's "Watch demo" saves them, and
//            ~/Downloads; config.json sources.folders.dirs)
//   faceit   with FACEIT_API_KEY: new matches from the FACEIT API; demos need
//            the Downloads API scope (docs/faceit-api.md), else they wait as pending
// Pending items (a missing scope, a demo not uploaded yet) are listed, not failures.
// Exit codes: 0 ok, 1 a source failed or ingest rejected a file, 2 another pnpm grab is running.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR, loadIdentities } from "../config.ts";
import { INBOX, ingest, readRegistry } from "../ingest/index.ts";
import type { Source } from "../ingest/sources.ts";
import { NO_KEY, faceitSource } from "../ingest/sources/faceit.ts";
import { foldersSource } from "../ingest/sources/folders.ts";
import { RenderLock } from "../render/controller/guards.ts";

const dryRun = process.argv.includes("--dry-run");

function sources(): Source[] {
  const env = existsSync(path.join(ROOT, ".env")) ? parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8")) : {};
  const conf = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8")).sources ?? {};
  // Watched folders: the configured list, else CS2's game/csgo (from CS2_EXE) and ~/Downloads.
  const cs2Exe = env.CS2_EXE?.trim();
  const defaults = [...(cs2Exe ? [path.resolve(path.dirname(cs2Exe), "..", "..", "csgo")] : []), path.join(homedir(), "Downloads")];
  const dirs: string[] = Array.isArray(conf.folders?.dirs) ? conf.folders.dirs.map((d: string) => d.replace(/^~(?=$|[\\/])/, homedir())) : defaults;
  const out: Source[] = [foldersSource({ dirs, knownHashes: () => new Set(Object.keys(readRegistry())) })];
  const faceitKey = env.FACEIT_API_KEY?.trim();
  if (faceitKey) out.push(faceitSource({ apiKey: faceitKey, steamId64: loadIdentities().pov, maxMatchesPerRun: conf.faceit?.maxMatchesPerRun ?? 5 }));
  else console.log(`faceit: skipped. ${NO_KEY}`);
  return out;
}

async function main(): Promise<number> {
  // One grab at a time: sources read and advance their state across a whole run.
  const lock = new RenderLock(path.join(STATE_DIR, ".grab.lock"));
  lock.acquire();
  const release = () => lock.release();
  process.on("exit", release);
  try {
    let code = 0;
    for (const s of sources()) {
      try {
        const r = await s.fetch({ inbox: INBOX, stateFile: path.join(STATE_DIR, "sources", `${s.name}.json`), dryRun, log: (l) => console.log(l) });
        if (r.skipped) { console.log(`${s.name}: skipped. ${r.skipped}`); continue; }
        console.log(`${s.name}: ${r.fetched.length} demo(s) fetched${dryRun ? " (dry run: nothing written)" : ""}`);
        if (r.blocked) console.log(`${s.name}: ${r.blocked}`);
        for (const p of r.pending) console.log(`${s.name}: pending ${p.item}: ${p.reason}`);
      } catch (e) {
        console.error(`${s.name} FAILED: ${(e as Error).message}`);
        code = 1;
      }
    }
    if (dryRun) return code;
    const ing = await ingest();
    for (const a of ing.added) console.log(`ingested ${a.originalName}`);
    for (const d of ing.duplicates) console.log(`already in the store: ${d}`);
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
