// A child for test/signals.test.ts: holds a lock, installs the command's signal handling and,
// per mode, a launch's emergency hook, then raises SIGINT through Node's own listener path
// (process.emit; Windows delivers no console signal to a child). What matters is what the
// process does on the way out: its exit code and whether the lock file is still there.
//   node --import tsx signal-child.ts <mode> <lock file>
import { RenderLock } from "../../src/render/controller/guards.ts";
import { cleanupUnverified, emergencyActive, exitOnSignal, onEmergency, ownedCleanup } from "../../src/render/controller/launch.ts";
import type { OwnedTree } from "../../src/render/controller/processes.ts";

const [mode, file] = process.argv.slice(2);
const lock = new RenderLock(file);
lock.acquire();
process.on("exit", () => { if (mode !== "launch-ok" && mode !== "launch-fail") lock.release(); }); // the command's own lock; a launch's is the cleanup's
const h = exitOnSignal(`child ${mode}`);
/** A tree whose snapshot fails: the cleanup cannot verify and the lock stays (launch.ts). */
const failing = { rooted: true, procs: new Map(), discover: () => { throw new Error("no snapshot"); }, suspects: () => [] } as unknown as OwnedTree;
const raise = () => setTimeout(() => process.emit("SIGINT", "SIGINT"), 100);
const log = (m: string) => process.stdout.write(m + "\n");

switch (mode) {
  case "plain": // no launch: the handler ends the process, the exit hook releases the lock
    raise();
    break;
  case "launch-ok": // a launch with nothing spawned: its cleanup releases the lock and exits 130
    onEmergency(ownedCleanup({ tree: () => undefined, lock, unrooted: "n/a", tag: "[test]" }), "test exit");
    raise();
    break;
  case "launch-fail": // a launch whose cleanup cannot verify: exit 3, the lock stays
    onEmergency(ownedCleanup({ tree: () => failing, lock, unrooted: "n/a", tag: "[test]" }), "test exit");
    raise();
    break;
  case "after-fail": { // an earlier launch's cleanup failed (latched); a later signal outside a launch exits 3
    const cleanup = ownedCleanup({ tree: () => failing, lock: new RenderLock(`${file}.other`), unrooted: "n/a", tag: "[test]" });
    cleanup("earlier launch");
    log(`unverified=${cleanupUnverified()}`);
    raise();
    break;
  }
  case "two-launches": { // hooks installed and removed twice leave nothing behind
    for (let i = 0; i < 2; i++) onEmergency(ownedCleanup({ tree: () => undefined, lock, unrooted: "n/a", tag: "[test]" }), "test exit")();
    log(`sigint=${process.listeners("SIGINT").length} active=${emergencyActive()}`);
    h.off();
    break;
  }
  default:
    throw new Error(`unknown mode ${mode}`);
}
setTimeout(() => { log("no exit"); process.exit(99); }, 5000).unref();
