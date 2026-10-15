// The few demo facts one render needs: tickrate, demo hash, map, the demo's
// game build, the POV player's spectator slot and the round. Full parsing is src/parse/demo.ts.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFileInfo } from "./fileinfo.ts";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");
export const DEMOPARSER_VERSION: string = require("@laihoe/demoparser2/package.json").version;

// HLAE assumes 1/64 s per tick (AfxHookSource2 changelog, 2025-08-12), so a
// demo at any other rate would schedule at the wrong ticks.
export const TICKRATE = 64;

export type ClipFacts = {
  demoSha256: string;
  map: string;
  playbackTicks: number;
  slot: number; // spec_player argument: user_id + 1 (CS Demo Manager; confirmed in M0.2)
  round: number; // 1-based: total_rounds_played + 1 at startTick
  patch: number; // the demo's game build (header patch_version)
};

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function clipFacts(demo: string, pov: string, startTick: number, endTick: number): Promise<ClipFacts> {
  if (startTick < 0 || endTick <= startTick) throw new Error("bad tick range");
  const info = readFileInfo(demo);
  const rate = info.playback_ticks / info.playback_time;
  if (Math.round(rate) !== TICKRATE) throw new Error(`demo tickrate ${rate} != ${TICKRATE}`);
  if (endTick > info.playback_ticks) throw new Error(`end tick ${endTick} past the end of the demo (${info.playback_ticks})`);
  const rows: { user_id: number; total_rounds_played: number; tick: number }[] = dp.parseTicks(demo, ["user_id", "total_rounds_played"], [startTick, endTick], [pov]);
  const atStart = rows.filter((r) => r.tick === startTick);
  const atEnd = rows.filter((r) => r.tick === endTick);
  if (atStart.length !== 1) throw new Error(`POV player not present at tick ${startTick}`);
  if (atEnd.length !== 1) throw new Error(`POV player not present at tick ${endTick}`);
  if (atEnd[0].user_id !== atStart[0].user_id) throw new Error("POV player's user_id changes inside the interval");
  const header = dp.parseHeader(demo);
  return {
    demoSha256: await sha256File(demo),
    map: String(header.map_name),
    patch: Number(header.patch_version),
    playbackTicks: info.playback_ticks,
    slot: atStart[0].user_id + 1,
    round: atStart[0].total_rounds_played + 1,
  };
}
