// M0.2 spike: audio timing check for one finished capture job.
// Compares the POV player's weapon_fire ticks (parser) with gunshot onsets in
// the FINAL clip's audio track, both as seconds since the record-start tick.
// Usage: pnpm exec tsx spikes/m0-2-sync.ts <job outDir> [--env <file>]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import path from "node:path";

const require = createRequire(import.meta.url);
const dp = require("@laihoe/demoparser2");
// --env must name the same env file the capture used (default .env).
const envAt = process.argv.indexOf("--env");
const envFile = envAt >= 0 ? process.argv[envAt + 1] : ".env";
const me = parseEnv(readFileSync(envFile, "utf8")).STEAM_ID64!.trim();

const outDir = process.argv[2];
const job = JSON.parse(readFileSync(path.join(outDir, "job.json"), "utf8"));
const result = JSON.parse(readFileSync(path.join(outDir, "result.json"), "utf8"));
if (result.status !== "ok") throw new Error(`job status ${result.status}`);
const TICKRATE = 64;

const shots: number[] = dp
  .parseEvent(job.demo, "weapon_fire", [], [])
  .filter((r: { user_steamid: string; tick: number }) => r.user_steamid === me && r.tick >= job.startTick && r.tick <= job.endTick)
  .map((r: { tick: number }) => (r.tick - job.startTick) / TICKRATE);

// Mono 8 kHz PCM of the final clip's audio; 5 ms RMS windows; onset = loud
// window well above the 10-20 ms before it, at least 50 ms after the last onset.
const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", result.clip, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
const WIN = 40;
const rms: number[] = [];
for (let i = 0; i + WIN <= pcm.length / 2; i += WIN) {
  let s = 0;
  for (let j = 0; j < WIN; j++) { const v = pcm.readInt16LE((i + j) * 2); s += v * v; }
  rms.push(Math.sqrt(s / WIN));
}
const onsets: number[] = [];
let last = -100;
for (let i = 4; i < rms.length; i++) {
  const base = Math.max(rms[i - 2], rms[i - 3], rms[i - 4]);
  if (rms[i] > 800 && rms[i] > 2.5 * base && i - last > 10) { onsets.push((i * WIN) / 8000); last = i; }
}

// Shots more than 300 ms after the previous shot are isolated: in a spray the
// later shots have no clean onset of their own.
const rows = shots.map((t, k) => {
  const near = onsets.reduce((b, o) => (Math.abs(o - t) < Math.abs(b - t) ? o : b), Infinity);
  return {
    shot_s: +t.toFixed(3),
    isolated: k === 0 || t - shots[k - 1] > 0.3,
    nearest_onset_s: Number.isFinite(near) ? +near.toFixed(3) : null,
    offset_ms: Number.isFinite(near) ? Math.round((near - t) * 1000) : null,
  };
});
const iso = rows.filter((r) => r.isolated && r.offset_ms !== null).map((r) => r.offset_ms as number).sort((a, b) => a - b);
console.log(JSON.stringify({
  job: job.jobId,
  clip: result.clip,
  shots: shots.length,
  onsets: onsets.length,
  rows,
  isolated_shots: iso.length,
  isolated_offsets_ms: iso,
  isolated_median_ms: iso.length ? iso[Math.floor(iso.length / 2)] : null,
}, null, 2));
