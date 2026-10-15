// When a pnpm go pass settles a demo (AGENTS.md: rescoring never adds work for a settled demo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinal, settlesDemos } from "../src/queue/index.ts";

test("settle: rendered, held and failed-for-good are final; a failure with a retry left is not", () => {
  assert.equal(isFinal("done", 1), true);
  assert.equal(isFinal("skipped", 0), true);
  assert.equal(isFinal("failed", 1), false, "one retry left");
  assert.equal(isFinal("failed", 2), true, "no retry left");
});

test("settle: dry runs, reposts and --no-reels passes never settle", () => {
  assert.equal(settlesDemos({}), true);
  assert.equal(settlesDemos({ dryRun: true }), false);
  assert.equal(settlesDemos({ repostOnly: true }), false);
  assert.equal(settlesDemos({ noReels: true }), false);
});
