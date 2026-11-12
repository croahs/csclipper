// Post worker (started by pnpm go, not by hand): posts and publishes one demo's units from
// their recorded captures, in its own process, so pnpm go can launch the next demo meanwhile.
// It never launches (every unit is post-only: no capture means a refusal, not a render),
// never takes the clip lock (pnpm go holds it for its launches) and never writes the ledger:
// it writes its results to a file and pnpm go records them.
//   tsx src/cli/post-worker.ts <job.json> <result.json>
//   job.json: { demo, highlights: [{ id, pov: povKey }], bloopers: [{ id, pov: povKey }], reels: ["deaths" | "kills"] }
// A highlight's or blooper's POV comes as its povKey (no SteamID in the file) and is resolved through the
// roster (STEAM_ID64 and FILM_STEAM_ID64S); a key no longer in it fails that unit. A blooper is found
// again by its id among the demo's bloopers, re-detected from the cached parse and track.
import { readFileSync, writeFileSync } from "node:fs";
import { loadIdentities, loadRoster, povKey, povKeyFor } from "../config.ts";
import { buildMoments } from "../clip/moments.ts";
import { blooperClip, detectBloopers, loadBlooperSettings } from "../film/bloopers.ts";
import { parseAnyPov, sampleTrack } from "../film/track.ts";
import { highlightUnit, prepareJob, runJobs, type JobResult, type RenderUnit } from "../queue/job.ts";
import { prepareReel, type ReelKind } from "../reel/index.ts";

type PostJob = { demo: string; highlights: { id: string; pov: string }[]; bloopers?: { id: string; pov: string }[]; reels: ReelKind[] };

async function main() {
  const [jobFile, resultFile] = process.argv.slice(2);
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as PostJob;
  const units: RenderUnit[] = [];
  const results: JobResult[] = [];
  const o = { postOnly: true, inBatch: true };
  const mainPov = loadIdentities().pov;
  // The main POV resolves without the film list, so a normal pnpm go never depends on FILM_STEAM_ID64S.
  let roster: string[] | undefined;
  const resolve = (key: string) => (key === povKey(mainPov) ? mainPov : (roster ??= loadRoster()).find((id) => povKey(id) === key));
  for (const key of new Set(job.highlights.map((h) => h.pov))) {
    const mine = job.highlights.filter((h) => h.pov === key);
    const pov = resolve(key);
    if (!pov) {
      for (const h of mine) results.push({ status: "failed", id: h.id, title: h.id, reasons: [`player ${key} is no longer in the roster (.env STEAM_ID64 / FILM_STEAM_ID64S); not posted`] });
      continue;
    }
    const { specs } = await buildMoments(job.demo, pov, undefined, mainPov);
    for (const { id } of mine) {
      const spec = specs.find((s) => s.id === id);
      if (!spec) { results.push({ status: "failed", id, title: id, reasons: ["moment no longer among the demo's ranked moments"] }); continue; }
      units.push(highlightUnit(await prepareJob({ demo: job.demo, spec, ...o, ...(pov !== mainPov ? { pov } : {}) })));
    }
  }
  // Bloopers: their players resolved, one POV-independent parse and the cached track, detection
  // without the score bar (an id names the blooper; the batch already applied the bar), each found by id.
  const wanted = job.bloopers ?? [];
  if (wanted.length) {
    const povs = new Map<string, string>();
    for (const b of wanted) {
      const pov = resolve(b.pov);
      if (pov) povs.set(b.pov, pov);
      else results.push({ status: "failed", id: b.id, title: b.id, reasons: [`player ${b.pov} is no longer in the roster (.env STEAM_ID64 / FILM_STEAM_ID64S); not posted`] });
    }
    const mine = wanted.filter((b) => povs.has(b.pov));
    try {
      if (mine.length) {
        const p = await parseAnyPov(job.demo, [...povs.values()], mainPov);
        const found = detectBloopers(p, sampleTrack(job.demo, p), [...povs.values()], loadBlooperSettings()).map((b) => blooperClip(b, p.demo.sha256, povKeyFor(b.steamid, mainPov)));
        for (const { id, pov: key } of mine) {
          const blooper = found.find((b) => b.id === id);
          if (!blooper) { results.push({ status: "failed", id, title: id, reasons: ["blooper no longer among the demo's bloopers"] }); continue; }
          const pov = povs.get(key)!;
          units.push(highlightUnit(await prepareJob({ demo: job.demo, blooper, ...o, ...(pov !== mainPov ? { pov } : {}) })));
        }
      }
    } catch (e) {
      for (const { id } of mine) if (!results.some((r) => r.id === id) && !units.some((u) => u.id === id)) results.push({ status: "failed", id, title: id, reasons: [`bloopers: ${(e as Error).message}`] });
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
