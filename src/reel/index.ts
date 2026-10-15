// Reels (PLAN.md, Deaths reel and Victims reel): one clip per demo of many short
// takes from other players' first person. "deaths": every death of the POV player,
// from his killer's view; "kills": every kill of his, from the victim's view (after
// the death the game shows its death camera). Each take's window around the event is
// config.json → reels (7 s before; 4 s after a death, 2 s after a kill). Each take gets a line of text (round, weapon, the other player),
// short fades, and all takes are concatenated. A reel is a RenderUnit, so pnpm go
// renders it in the same launch as the demo's highlights.
import { createHash } from "node:crypto";
import path from "node:path";
import { loadCrosshairCutoff, loadIdentities, loadReels, loadSettings } from "../config.ts";
import { weaponName } from "../clip/index.ts";
import { parseDemo, type Death, type ParsedDemo } from "../parse/demo.ts";
import { slotOf } from "../parse/clip-facts.ts";
import { povKills } from "../score/index.ts";
import { MARGIN_TICKS, SETTLE_TICKS, type TakeSpec } from "../render/controller/index.ts";
import { FIRST_SCHEDULE, SPECTATOR_PANELS, crosshairSource, lookCfg } from "../render/controller/cfg.ts";
import { toolVersions } from "../render/versions.ts";
import { postReel } from "../post/index.ts";
import { clipPath, clipTmpPath, ensureClipsDir, publish, readDeleted, readIndex } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import type { JobInput, JobResult, RenderUnit } from "../queue/job.ts";

export type ReelKind = "deaths" | "kills";

export type ReelTake = TakeSpec & { tick: number; round: number; weapon: string; player: string; steamid: string };

/** The events a reel shows, in tick order: every death of his (suicides and world deaths too), or his kills of enemies. */
export function reelEvents(p: ParsedDemo, kind: ReelKind): Death[] {
  const me = p.identity.steamid;
  const rounds = p.rounds.filter((r) => r.phase !== "knife");
  if (kind === "kills") return rounds.flatMap((r) => povKills(p, r));
  return p.deaths
    .filter((d) => d.victim === me && rounds.some((r) => r.n === d.round && d.tick <= r.endTick))
    .sort((a, b) => a.tick - b.tick);
}

/** A reel's takes, with the other player's slot resolved; events whose player cannot be spectated are skipped. */
export function reelTakes(p: ParsedDemo, kind: ReelKind, log: (m: string) => void = console.log): ReelTake[] {
  const t = p.demo.tickrate;
  const w = { beforeS: loadReels()[kind].beforeSeconds, afterS: loadReels()[kind].afterSeconds };
  // The first take's seek must land after FIRST_SCHEDULE, and every take inside the demo.
  const earliest = FIRST_SCHEDULE + SETTLE_TICKS + MARGIN_TICKS + 32;
  const latest = p.demo.playbackTicks - MARGIN_TICKS - 1;
  const out: ReelTake[] = [];
  for (const d of reelEvents(p, kind)) {
    const round = p.rounds.find((r) => r.n === d.round)!;
    const startTick = Math.max(round.startTick, earliest, Math.round(d.tick - w.beforeS * t));
    const endTick = Math.min(latest, Math.round(d.tick + w.afterS * t));
    // A death without another player behind it (his own grenade, a fall) is shown from his own view.
    const byOther = kind === "kills" || (d.attacker !== null && d.attacker !== d.victim);
    const steamid = kind === "deaths" ? (byOther ? d.attacker! : d.victim) : d.victim;
    const player = kind === "deaths" ? (byOther ? d.attackerName : d.attacker === d.victim ? "himself" : "the world") : d.victimName;
    // The take must contain the event itself (a demo cut short, or an event right at its start, cannot).
    if (!(startTick < d.tick && d.tick <= endTick)) { log(`${kind} reel: R${d.round} tick ${d.tick}: outside what the demo can show; skipped`); continue; }
    const slot = slotOf(p.demo.path, steamid, startTick, endTick);
    if (slot === undefined) { log(`${kind} reel: R${d.round} tick ${d.tick}: ${player || steamid} cannot be spectated over the take; skipped`); continue; }
    out.push({ startTick, endTick, slot, tick: d.tick, round: d.round, weapon: weaponName(d.weapon), player, steamid });
  }
  return out;
}

/** The library already holds this demo's reel of this kind (any render key or take list). */
// A deleted reel counts as held: deleting it means "never make it again".
const heldReel = (demoSha256: string, kind: ReelKind) => [...Object.values(readIndex().clips), ...Object.values(readDeleted())].find((c) => c.kind === kind && c.demoSha256 === demoSha256);

/** A reel as a render unit; undefined when the demo has nothing for it. */
export async function prepareReel(demoArg: string, kind: ReelKind, o: Omit<JobInput, "demo"> = {}): Promise<RenderUnit | undefined> {
  const demo = path.resolve(demoArg);
  const ids = loadIdentities();
  const settings = loadSettings();
  const p = await parseDemo(demo, ids.pov);
  const takes = reelTakes(p, kind);
  if (!takes.length) return undefined;
  const cutoff = loadCrosshairCutoff();
  const crosshair = crosshairSource(Number(p.demo.patch), cutoff);
  const look = lookCfg(ids.cs2Exe, ids.pov, crosshair);
  const versions = toolVersions(ids.cs2Exe, ids.hlaeExe);
  const { node: _node, ...outputVersions } = versions;
  // The key names each take's event and slot, not its window: the capture records the ticks it
  // covers, so a capture taken with a wider window serves a narrower one (post trims; a window the
  // capture does not cover fails in post and is never re-launched for silently).
  const renderInputs = {
    settings, versions: outputVersions, kind, takes: takes.map(({ tick, slot }) => ({ tick, slot })),
    lookCfgSha256: createHash("sha256").update(look).digest("hex"), marginTicks: MARGIN_TICKS, settleTicks: SETTLE_TICKS, spectatorPanels: SPECTATOR_PANELS,
    ...(crosshair === "own" ? { crosshair } : {}),
  };
  const renderKey = createHash("sha256").update(JSON.stringify({ ...renderInputs, pov: ids.pov })).digest("hex").slice(0, 16);
  const id = createHash("sha256").update(`${p.demo.sha256}:${kind}:${takes.map((x) => x.tick).join(",")}`).digest("hex").slice(0, 16);
  const title = `${p.demo.map} · ${kind}`;
  const label = (x: ReelTake) => `R${x.round}  ${x.weapon}  ${kind === "deaths" ? "killed by" : "killed"} ${x.player}`.trim();
  return {
    id, title, demo, demoSha256: p.demo.sha256, map: p.demo.map, o: { ...o, demo },
    takes: takes.map(({ startTick, endTick, slot }) => ({ startTick, endTick, slot })),
    startTick: takes[0].startTick, endTick: takes[takes.length - 1].endTick,
    renderKey, settings, ids, look, crosshair, debugCommands: [],
    inLibrary: () => !!heldReel(p.demo.sha256, kind),
    finish: (captures, workDir, attempt, fail): JobResult => {
      ensureClipsDir();
      const tmp = clipTmpPath(id, attempt);
      const r = postReel(captures.map((c, i) => ({ ...c, startTick: takes[i].startTick, endTick: takes[i].endTick, label: label(takes[i]) })), settings, workDir, tmp);
      if (r.status !== "ok") return fail(r.reasons);
      publish(tmp, {
        id, file: `clips/${id}.mp4`, title, map: p.demo.map, demo, demoSha256: p.demo.sha256, round: takes[0].round,
        startTick: takes[0].startTick, endTick: takes[takes.length - 1].endTick, seconds: r.plan!.seconds, frames: r.plan!.frames,
        createdAt: new Date().toISOString(), renderKey,
        render: { ...renderInputs, node: versions.node, windows: takes.map(({ startTick, endTick }) => ({ startTick, endTick })), mappings: captures.map((c) => c.mapping), workDir },
        kind, timing: "scheduled",
        crosshair: { source: crosshair, demoPatch: Number(p.demo.patch), cutoff: cutoff ?? null },
        reel: { takes: takes.map(({ round, tick, weapon, player }) => ({ round, tick, weapon, player })) },
      });
      try { writeLibraryPage({ running: !!o.inBatch }); } catch (e) { console.error(`library page not rewritten: ${(e as Error).message}`); }
      console.log(`ok: ${clipPath(id)} (${title}: ${takes.length} takes, ${r.plan!.seconds.toFixed(1)} s)`);
      return { status: "done", id, title, clip: clipPath(id) };
    },
  };
}

