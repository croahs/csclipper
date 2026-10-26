// Signals outside a launch (src/render/controller/launch.ts, exitOnSignal): the process ends
// through process.exit, so the exit hooks release the locks; while a launch's emergency hook is
// installed (onEmergency) the command's handler steps aside and the launch's hook ends the
// process after its cleanup. The end-to-end cases run in a child process that raises SIGINT
// through Node's own listener path (test/fixtures/signal-child.ts; Windows delivers no console
// signal to a child), judged by its exit code and whether the lock file is left. Listener
// ordering is checked in-process with process.exit mocked. Also the lock refusal naming its holder.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Refusal } from "../src/config.ts";
import { RenderLock, lockStatus } from "../src/render/controller/guards.ts";
import { emergencyActive, exitOnSignal, onEmergency } from "../src/render/controller/launch.ts";

const lockFile = () => path.join(mkdtempSync(path.join(tmpdir(), "sig-")), "x.lock");
const CHILD = path.join(import.meta.dirname, "fixtures", "signal-child.ts");
function child(mode: string) {
  const file = lockFile();
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode, file], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim(), lockLeft: existsSync(file) };
}

test("outside a launch: SIGINT ends the process with 130 and the exit hook releases the lock", () => {
  const r = child("plain");
  assert.equal(r.status, 130, r.err);
  assert.equal(r.lockLeft, false);
  assert.match(r.err, /child plain stopped \(SIGINT\); locks released/);
});

test("during a launch: the launch's cleanup runs and releases the lock, exit 130", () => {
  const r = child("launch-ok");
  assert.equal(r.status, 130, r.err);
  assert.equal(r.lockLeft, false);
  assert.doesNotMatch(r.err, /stopped \(SIGINT\)/); // the command's handler stepped aside
});

test("during a launch whose cleanup cannot verify: exit 3 and the lock stays", () => {
  const r = child("launch-fail");
  assert.equal(r.status, 3, r.err);
  assert.equal(r.lockLeft, true);
  assert.match(r.err, /CLEANUP NOT VERIFIED/);
});

test("after an unverified cleanup, a signal outside a launch exits 3", () => {
  const r = child("after-fail");
  assert.equal(r.out, "unverified=true");
  assert.equal(r.status, 3, r.err);
  assert.equal(r.lockLeft, false); // the command's own lock is still released on exit
});

test("two launches in one process leave no emergency listener behind", () => {
  const r = child("two-launches");
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "sigint=1 active=false"); // the one listener is the command's own
  assert.equal(r.lockLeft, false);
});

test("listener order: the command's handler returns while a hook is active, whichever was installed first", (t) => {
  const exits: (number | undefined)[] = [];
  t.mock.method(process, "exit", ((code?: number) => { exits.push(code); }) as never);
  t.mock.method(console, "error", () => {});
  const cleaned: string[] = [];
  // Hook first, then the command's handler (pnpm clip installs its handler at module load, the launch later; the other order is the batch's).
  const off = onEmergency((reason) => { cleaned.push(reason); return true; }, "test exit");
  const h = exitOnSignal("test cmd");
  try {
    assert.ok(emergencyActive());
    for (const l of process.listeners("SIGINT")) (l as (s: string) => void)("SIGINT");
    assert.deepEqual(cleaned, ["SIGINT"]);
    assert.deepEqual(exits, [130]); // one exit, the hook's
  } finally { off(); h.off(); }
  assert.ok(!emergencyActive());
  const h2 = exitOnSignal("test cmd");
  try { h2.onSignal("SIGTERM"); } finally { h2.off(); }
  assert.deepEqual(exits, [130, 130]);
  assert.equal(process.listeners("SIGINT").filter((l) => l === h2.onSignal).length, 0);
});

test("a lock refusal names its holder and whether it runs; lockStatus reads the same", () => {
  const f = lockFile();
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  writeFileSync(f, String(dead));
  assert.throws(() => new RenderLock(f).acquire(), (e: Error) => e instanceof Refusal && new RegExp(`pid ${dead}, not running`).test(e.message));
  assert.deepEqual(lockStatus(f), { pid: dead, alive: false });
  writeFileSync(f, String(process.pid));
  assert.throws(() => new RenderLock(f).acquire(), (e: Error) => e instanceof Refusal && new RegExp(`pid ${process.pid}, running`).test(e.message));
  assert.deepEqual(lockStatus(f), { pid: process.pid, alive: true });
  writeFileSync(f, "");
  assert.throws(() => new RenderLock(f).acquire(), /holder unknown/);
  assert.deepEqual(lockStatus(f), {});
  assert.deepEqual(lockStatus(path.join(path.dirname(f), "none.lock")), {});
  assert.ok(existsSync(f));
});
