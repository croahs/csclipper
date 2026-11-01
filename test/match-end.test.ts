// A take that plays past the match end puts CS2 in its end-of-match state, which no seek back undoes:
// every later take of the launch records the end-of-match screen (clip 186, 2026-10-31). planTakes
// (src/queue/job.ts) runs such a take last and lets only one unit have one. Ticks from that launch
// (de_inferno, last round end 127752). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTakes, type RenderUnit } from "../src/queue/job.ts";
import { MARGIN_TICKS, passesMatchEnd } from "../src/render/controller/index.ts";
import { CHAIN_AFTER_TICKS } from "../src/render/controller/cfg.ts";
import { isFinal } from "../src/queue/index.ts";

const END = 127752;
const unit = (id: string, takes: [number, number][]) =>
  ({ id, matchEndTick: END, takes: takes.map(([startTick, endTick]) => ({ startTick, endTick, slot: 1 })) }) as unknown as RenderUnit;
const order = (us: RenderUnit[]) => planTakes(us).plan.map((x) => `${x.u.id}${x.k}`);

test("passesMatchEnd counts the record margin and the chain's wait before the next seek", () => {
  const lastShort = END - MARGIN_TICKS - CHAIN_AFTER_TICKS - 1;
  assert.equal(passesMatchEnd({ endTick: lastShort }, END), false);
  assert.equal(passesMatchEnd({ endTick: lastShort + 1 }, END), true);
  assert.equal(passesMatchEnd({ endTick: 127740 }, END), true); // the kills reel take that ended at 127772 with its margin
});

test("the take past the match end runs last, not in tick order", () => {
  // As in the launch behind clip 186: the R17 highlight started after the reel's late take but runs last now.
  const highlight = unit("h", [[127276, 127964]]);
  const reel = unit("r", [[16211, 16915], [127100, 127690]]); // its last take stops short (reelTakes clamps it)
  assert.deepEqual(order([highlight, reel]), ["r0", "r1", "h0"]);
  assert.deepEqual(planTakes([highlight, reel]).deferred, []);
});

test("a second unit with a take past the match end is deferred, not recorded after the first", () => {
  const highlight = unit("h", [[127276, 127964]]);
  const reel = unit("r", [[16211, 16915], [127164, 127752]]); // a kill right at the match end
  const r = planTakes([highlight, reel]);
  assert.deepEqual(r.deferred.map((u) => u.id), ["r"]);
  assert.deepEqual(r.plan.map((x) => `${x.u.id}${x.k}`), ["h0"]);
  // On its own (the next pnpm go) the reel runs, its late take last.
  assert.deepEqual(order([reel]), ["r0", "r1"]);
});

test("three units past the match end: one per launch, the others deferred each time", () => {
  const a = unit("a", [[127276, 127964]]), b = unit("b", [[127200, 127760]]), c = unit("c", [[127300, 127800]]);
  assert.deepEqual(planTakes([a, b, c]).deferred.map((u) => u.id), ["b", "c"]);
  assert.deepEqual(planTakes([b, c]).deferred.map((u) => u.id), ["c"]); // a is in the library now
  assert.deepEqual(planTakes([c]).deferred, []);
});

test("a deferral is never final, so its demo stays open however many attempts came before", () => {
  for (const attempts of [1, 2, 5]) assert.equal(isFinal("deferred", attempts), false);
  assert.equal(isFinal("failed", 1), false);
  assert.equal(isFinal("failed", 2), true);
  assert.equal(isFinal("done", 1), true);
});
