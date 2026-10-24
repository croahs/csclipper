// RenderLock on temp files: exclusive, released by its owner, a failed pid
// write (a full disk) leaves no lock behind, and takeOverDead replaces only a
// lock whose pid is gone.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("takeOverDead replaces a lock whose pid is gone, and only that", () => {
  // A pid that existed and has exited.
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const f = lockFile();
  writeFileSync(f, String(dead));
  assert.throws(() => new RenderLock(f).acquire(), Refusal); // the render lock stays manual
  const a = new RenderLock(f);
  assert.equal(a.acquire({ takeOverDead: true }), dead);
  assert.equal(readFileSync(f, "utf8"), String(process.pid));
  a.release();
  // A live holder (this test's parent shell or any running pid) is never taken over.
  writeFileSync(f, String(process.ppid));
  assert.throws(() => new RenderLock(f).acquire({ takeOverDead: true }), Refusal);
  // An empty lock (unknown holder) is never taken over either.
  writeFileSync(f, "");
  assert.throws(() => new RenderLock(f).acquire({ takeOverDead: true }), Refusal);
});

test("takeover is serialized: a recovery in progress, or one that already won, makes the next contender refuse", () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const f = lockFile();
  writeFileSync(f, String(dead));
  // Another process is mid-recovery: the stale lock is left alone.
  writeFileSync(`${f}.takeover`, "1");
  assert.throws(() => new RenderLock(f).acquire({ takeOverDead: true }), /recovering/);
  assert.equal(readFileSync(f, "utf8"), String(dead));
  fs.rmSync(`${f}.takeover`);
  // The first contender wins and leaves no takeover file; a later one finds a live pid and refuses.
  const a = new RenderLock(f);
  assert.equal(a.acquire({ takeOverDead: true }), dead);
  assert.ok(!existsSync(`${f}.takeover`));
  assert.throws(() => new RenderLock(f).acquire({ takeOverDead: true }), Refusal);
  assert.equal(readFileSync(f, "utf8"), String(process.pid));
  a.release();
});

test("eight processes recovering the same stale lock at once: exactly one gets it", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const f = lockFile();
  writeFileSync(f, String(dead));
  const guards = new URL("../src/render/controller/guards.ts", import.meta.url).href;
  // A winner holds the lock until every contender has reported (its stdin closes), so a late
  // contender can never find the slot free and win a second time.
  const script = `import { RenderLock } from ${JSON.stringify(guards)};
    try { new RenderLock(${JSON.stringify(f)}).acquire({ takeOverDead: true }); console.log("won"); process.stdin.resume(); await new Promise((r) => process.stdin.on("end", r)); }
    catch (e) { console.log(e.constructor.name === "Refusal" ? "refused" : "error " + e.message); }`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: path.join(import.meta.dirname, "..") }));
  let reported = 0;
  const runs = children.map((c) => new Promise<string>((resolve) => {
    let out = "";
    c.stdout.on("data", (d) => {
      const first = !out;
      out += d;
      if (first && ++reported === children.length) for (const k of children) k.stdin.end();
    });
    c.on("close", () => resolve(out.trim()));
  }));
  const results = await Promise.all(runs);
  assert.equal(results.filter((r) => r === "won").length, 1, results.join(", "));
  assert.equal(results.filter((r) => r === "refused").length, 7, results.join(", "));
  assert.ok(!existsSync(`${f}.takeover`));
});
