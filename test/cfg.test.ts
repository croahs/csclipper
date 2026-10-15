// The crosshair policy (which demos get the demo's crosshair, what the job cfg sets) and the clip rules loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crosshairSource, jobCfgs, type CfgTake, type CrosshairSource } from "../src/render/controller/cfg.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadClipRules } from "../src/config.ts";

const take = (seekTick: number, slot: number, i: number): CfgTake => ({ seekTick, slot, recordStartTick: seekTick + 128, recordEndTick: seekTick + 600, select: `mirv_streams record screen settings croclip${i}` });
const cfgs = (crosshair: CrosshairSource, takes: CfgTake[] = [take(200, 3, 0)]) => jobCfgs({
  title: "t", hud: "full", debugCommands: [], lookCfgName: "croclip_look", crosshair, captureSetup: [],
  recordStart: "mirv_streams record start", recordEnd: "mirv_streams record end", takes, takeCfgName: (i) => `croclip_x_t${i}`,
});
const job = (crosshair: CrosshairSource) => cfgs(crosshair).main;

test("crosshair: demos at or after the cutoff build use the demo's, older ones his own; no cutoff means the demo's", () => {
  assert.equal(crosshairSource(14188, 14182), "demo");
  assert.equal(crosshairSource(14182, 14182), "demo");
  assert.equal(crosshairSource(14181, 14182), "own");
  assert.equal(crosshairSource(14160, 14182), "own");
  assert.equal(crosshairSource(14160, undefined), "demo");
});

test("crosshair: the job cfg shows everyone's crosshair for the demo's, the spectator's own otherwise", () => {
  assert.equal(job("demo").split("\n").filter((l: string) => l.startsWith("cl_show_observer_crosshair")).join(), "cl_show_observer_crosshair 2");
  assert.equal(job("own").split("\n").filter((l: string) => l.startsWith("cl_show_observer_crosshair")).join(), "cl_show_observer_crosshair 0");
});

// --- clip rules (config.json → clip) ---------------------------------------------------

test("chained takes: each take's end runs the next take's cfg, which clears, selects its output and seeks; the last quits", () => {
  // Take 2 seeks back before take 1 (a rewind).
  const c = cfgs("demo", [take(200, 3, 0), take(5000, 7, 1), take(1000, 3, 2)]);
  assert.match(c.main, /mirv_streams record screen settings croclip0\nmirv_cmd addAtTick 96 demo_gototick 200/);
  assert.match(c.main, /^mirv_cmd addAtTick 816 exec croclip_x_t1$/m, "take 0 records to 800; the next cfg runs 16 ticks later");
  assert.deepEqual(c.takes.map((t) => t.name), ["croclip_x_t1", "croclip_x_t2"]);
  const [t1, t2] = c.takes.map((t) => t.body.split("\n"));
  assert.deepEqual(t1.slice(1, 4), ["mirv_cmd clear", "mirv_streams record screen settings croclip1", "demo_gototick 5000"]);
  assert.ok(t1.includes("mirv_cmd addAtTick 5017 spec_player 7"));
  assert.ok(t1.includes("mirv_cmd addAtTick 5616 exec croclip_x_t2"));
  assert.deepEqual(t2.slice(1, 4), ["mirv_cmd clear", "mirv_streams record screen settings croclip2", "demo_gototick 1000"]);
  assert.ok(t2.includes("mirv_cmd addAtTick 1664 quit"), "the last take quits 64 ticks after its record end (1600)");
  assert.ok(!c.main.includes("quit"));
});

test("clip rules: lead-in and tail are read; missing or negative values refuse", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclip-rules-"));
  const file = (clip: unknown) => { const f = path.join(dir, `${Math.random()}.json`); writeFileSync(f, JSON.stringify({ clip })); return f; };
  assert.deepEqual(loadClipRules(file({ leadInSeconds: 4, tailSeconds: 5.5 })), { leadInSeconds: 4, tailSeconds: 5.5 });
  assert.throws(() => loadClipRules(file({ leadInSeconds: 4 })), /tailSeconds/);
  assert.throws(() => loadClipRules(file({ leadInSeconds: -1, tailSeconds: 5.5 })), /leadInSeconds/);
});
