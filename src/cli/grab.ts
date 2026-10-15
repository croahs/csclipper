// pnpm grab [--dry-run] [--browser] [--last <n>] | pnpm grab --login   (PLAN.md's "pnpm fetch"; pnpm's own fetch command takes that name):
// "I have played some games". Runs the demo sources, each writing new demos
// into demos/inbox/, then ingests the inbox. Renders nothing; pnpm go does that.
//   folders  copies new demos from watched folders, read-only (default: CS2's
//            game/csgo, where the FACEIT client's "Watch demo" saves them, and
//            ~/Downloads; config.json sources.folders.dirs)
//   faceit   with FACEIT_API_KEY: new matches from the FACEIT Data API; demos via the
//            Downloads API (needs its scope), or with --browser (or config.json
//            sources.faceit.via "browser") through Peder's logged-in FACEIT session in
//            the installed Chrome/Edge, profile state/browser-profile (docs/faceit-api.md)
//   --last n backfill: the demos of the last n FACEIT matches through the browser session,
//            one at a time with 4-8 s between downloads (config.json sources.faceit.pauseSeconds), skipping those already stored;
//            resumable (state/sources/faceit-backfill.json)
//   --login  opens that profile in a plain browser window to sign in; waits until it is closed
// Pending items (a missing scope, a logged-out browser, a demo not uploaded yet) are listed, not failures.
// Exit codes: 0 ok, 1 a source or a download failed or ingest rejected a file, 2 another pnpm grab is running.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR, loadIdentities } from "../config.ts";
import { INBOX, ingest, readRegistry } from "../ingest/index.ts";
import type { Source } from "../ingest/sources.ts";
import { NO_KEY, faceitBackfill, faceitSource } from "../ingest/sources/faceit.ts";
import { foldersSource } from "../ingest/sources/folders.ts";
import { ROOM_URL, browserDemos, findBrowser, login } from "../ingest/sources/faceit-browser.ts";
import { RenderLock } from "../render/controller/guards.ts";

const dryRun = process.argv.includes("--dry-run");
const loginOnly = process.argv.includes("--login");
const viaBrowserFlag = process.argv.includes("--browser");
// --last <n>: backfill the demos of the last n FACEIT matches through the browser session.
const lastAt = process.argv.indexOf("--last");
const backfillLast = lastAt >= 0 ? Number(process.argv[lastAt + 1]) : undefined;

function sources(): Source[] {
  const env = existsSync(path.join(ROOT, ".env")) ? parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8")) : {};
  const conf = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8")).sources ?? {};
  // Watched folders: the configured list, else CS2's game/csgo (from CS2_EXE) and ~/Downloads.
  const cs2Exe = env.CS2_EXE?.trim();
  const defaults = [...(cs2Exe ? [path.resolve(path.dirname(cs2Exe), "..", "..", "csgo")] : []), path.join(homedir(), "Downloads")];
  const dirs: string[] = Array.isArray(conf.folders?.dirs) ? conf.folders.dirs.map((d: string) => d.replace(/^~(?=$|[\\/])/, homedir())) : defaults;
  const out: Source[] = [foldersSource({ dirs, knownHashes: () => new Set(Object.keys(readRegistry())) })];
  const faceitKey = env.FACEIT_API_KEY?.trim();
  // Demos via the Downloads API, or via the logged-in browser session (--browser, or sources.faceit.via "browser").
  const viaBrowser = viaBrowserFlag || conf.faceit?.via === "browser";
  let demos;
  if (faceitKey && viaBrowser) {
    const b = findBrowser();
    if (!b) throw new Error("--browser needs Google Chrome or Microsoft Edge installed");
    demos = browserDemos({ browser: b, headless: conf.faceit?.headless === true });
  }
  // A match whose id is in a stored demo's file name (FACEIT names demos <match id>-1-1.dem…) is not fetched again.
  const stored = Object.values(readRegistry()).map((d) => d.originalName);
  const haveMatch = (id: string) => stored.some((n) => n.includes(id));
  if (faceitKey && backfillLast !== undefined) {
    const b = findBrowser();
    if (!b) throw new Error("--last needs Google Chrome or Microsoft Edge installed (it downloads through the browser session)");
    // The backfill replaces the normal FACEIT run for this invocation.
    // Pause between downloads: config.json → sources.faceit.pauseSeconds [min, max] (default 4-8 s), one at a time.
    const [lo, hi] = Array.isArray(conf.faceit?.pauseSeconds) ? conf.faceit.pauseSeconds : [4, 8];
    if (!(lo >= 0 && hi >= lo)) throw new Error("config.json sources.faceit.pauseSeconds must be [min, max] seconds");
    const pauseMs = () => (lo + Math.random() * (hi - lo)) * 1000;
    out.push(faceitBackfill({ apiKey: faceitKey, steamId64: loadIdentities().pov, last: backfillLast, demos: browserDemos({ browser: b, headless: conf.faceit?.headless === true }), haveMatch, pauseMs }));
  } else if (faceitKey) out.push(faceitSource({ apiKey: faceitKey, steamId64: loadIdentities().pov, maxMatchesPerRun: conf.faceit?.maxMatchesPerRun ?? 5, demos, haveMatch }));
  else console.log(`faceit: skipped. ${NO_KEY}`);
  return out;
}

async function main(): Promise<number> {
  // One grab at a time, --login included: sources advance their state across a
  // whole run, and the browser profile can only be open once.
  const lock = new RenderLock(path.join(STATE_DIR, ".grab.lock"));
  lock.acquire();
  const release = () => lock.release();
  process.on("exit", release);
  try {
    if (loginOnly) {
      // A plain browser process, not automated: Peder logs in and passes FACEIT's checks himself.
      const b = findBrowser();
      if (!b) { console.error("Neither Google Chrome nor Microsoft Edge is installed; the browser path needs one of them."); return 1; }
      await login(b);
      console.log("Window closed. The FACEIT session is kept in the croclipper profile; run pnpm grab --browser to fetch demos.");
      return 0;
    }
    let code = 0;
    for (const s of sources()) {
      try {
        const r = await s.fetch({ inbox: INBOX, stateFile: path.join(STATE_DIR, "sources", `${s.name}.json`), dryRun, log: (l) => console.log(l) });
        if (r.skipped) { console.log(`${s.name}: skipped. ${r.skipped}`); continue; }
        console.log(`${s.name}: ${r.fetched.length} demo(s) fetched${dryRun ? " (dry run: nothing written)" : ""}`);
        if (r.blocked) console.log(`${s.name}: ${r.blocked}`);
        // A pending FACEIT match comes with its room link: "Download demo" there lands the file in
        // Downloads, where the folders source picks it up on the next run.
        for (const p of r.pending) console.log(`${s.name}: pending ${p.item}: ${p.reason}${s.name.startsWith("faceit") && /^[A-Za-z0-9-]{1,64}$/.test(p.item) ? `
    ${ROOM_URL(p.item)}` : ""}`);
        if (r.failed) code = 1;
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
