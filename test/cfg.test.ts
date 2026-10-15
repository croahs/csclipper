// The crosshair policy: which demos get the demo's crosshair, and what the job cfg sets for each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crosshairSource, jobCfg, type CrosshairSource } from "../src/render/controller/cfg.ts";

const job = (crosshair: CrosshairSource) => jobCfg({
  title: "t", hud: "full", debugCommands: [], lookCfgName: "croclip_look", crosshair, captureSetup: [],
  recordStart: "startmovie x", recordEnd: "endmovie", seekTick: 200, slot: 3, recordStartTick: 400, recordEndTick: 500, quitTick: 600,
});

test("crosshair: demos at or after the cutoff build use the demo's, older ones his own; no cutoff means the demo's", () => {
  assert.equal(crosshairSource(14188, 14182), "demo");
  assert.equal(crosshairSource(14182, 14182), "demo");
  assert.equal(crosshairSource(14181, 14182), "own");
  assert.equal(crosshairSource(14160, 14182), "own");
  assert.equal(crosshairSource(14160, undefined), "demo");
});

test("crosshair: the job cfg shows everyone's crosshair for the demo's, the spectator's own otherwise", () => {
  assert.equal(job("demo").split("\n").filter((l) => l.startsWith("cl_show_observer_crosshair")).join(), "cl_show_observer_crosshair 2");
  assert.equal(job("own").split("\n").filter((l) => l.startsWith("cl_show_observer_crosshair")).join(), "cl_show_observer_crosshair 0");
});
