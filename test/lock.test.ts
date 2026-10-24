// RenderLock on temp files: exclusive, released by its owner, and a failed pid
// write (a full disk) leaves no lock behind.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Refusal } from "../src/config.ts";
import { RenderLock } from "../src/render/controller/guards.ts";

const lockFile = () => path.join(mkdtempSync(path.join(tmpdir(), "lock-")), "x.lock");

test("one holder at a time; release removes it", () => {
  const f = lockFile();
  const a = new RenderLock(f);
  a.acquire();
  assert.equal(readFileSync(f, "utf8"), String(process.pid));
  assert.throws(() => new RenderLock(f).acquire(), Refusal);
  a.release();
  assert.ok(!existsSync(f));
});

test("a failed pid write removes the file it created and rethrows the real error", (t) => {
  const f = lockFile();
  t.mock.method(fs, "writeSync", () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new RenderLock(f).acquire(), (e: Error) => !(e instanceof Refusal) && /no space/.test(e.message));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(!existsSync(f));
  const next = new RenderLock(f);
  next.acquire(); // nothing stranded: the next run gets the lock
  next.release();
});
