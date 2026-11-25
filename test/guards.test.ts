// The FACEIT anti-cheat guard (2026-10-25: with the FACEIT client running, HLAE could
// not create cs2.exe and every launch timed out on a hidden "Access is denied" dialog).
// tasklist, sc query and reg query are mocked; nothing on this machine is read.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import child_process from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Refusal, STEAMID64_BASE } from "../src/config.ts";
import { faceitRefusal, guard } from "../src/render/controller/guards.ts";
import { OwnedTree, compareCreated, killExact, serviceRunning, snapshot } from "../src/render/controller/processes.ts";
import { regValue } from "../src/steam.ts";
import { batchRefusal } from "../src/queue/index.ts";

const RENDER = (STEAMID64_BASE + 1234n).toString();
const ids = { pov: (STEAMID64_BASE + 1n).toString(), renderAccount: RENDER, hlaeExe: "x", cs2Exe: "y" };

const sc = (state: string, label = "STATE") => `\nSERVICE_NAME: FACEITService \n        TYPE               : 10  WIN32_OWN_PROCESS  \n        ${label.padEnd(18)} : ${state} \n        WIN32_EXIT_CODE    : 0  (0x0)\n`;
const tasklist = (running: string[], image: string) =>
  running.includes(image.toLowerCase()) ? `"${image}","1234","Console","1","10,000 K"\r\n` : "INFO: No tasks are running which match the specified criteria.\r\n";

type World = { images?: string[] | Error; service?: string | "missing" | Error; loggedIn?: string | Error; scLabel?: string };
/** Fake tasklist / sc / reg for the guard's probes; anything else is an error. */
function fakeWorld(t: { mock: { method: typeof import("node:test").mock.method; restoreAll: () => void } }, w: World) {
  const images = Array.isArray(w.images) ? w.images.map((i) => i.toLowerCase()) : [];
  t.mock.method(child_process, "execFileSync", ((file: string, args: string[]) => {
    if (file === "tasklist") { if (w.images instanceof Error) throw w.images; return tasklist(images, args[1].replace("IMAGENAME eq ", "")); }
    if (file === "sc.exe") {
      if (w.service === "missing") throw Object.assign(new Error("Command failed: sc.exe query"), { status: 1060, stdout: "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n" });
      if (w.service instanceof Error) throw w.service;
      return sc(w.service ?? "1  STOPPED", w.scLabel);
    }
    if (file === "reg") {
      if (w.loggedIn instanceof Error) throw w.loggedIn;
      return `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\ActiveProcess\r\n    ActiveUser    REG_DWORD    0x${Number(w.loggedIn ?? 1234).toString(16)}\r\n\r\n`;
    }
    throw new Error(`unexpected command in the test: ${file} ${args.join(" ")}`);
  }) as typeof child_process.execFileSync);
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
}

test("serviceRunning reads sc query: every state but STOPPED counts, not installed does not, a translated label still parses", (t) => {
  const restore = fakeWorld(t, { service: "4  RUNNING" });
  try {
    assert.equal(serviceRunning("FACEITService"), true);
    for (const s of ["2  START_PENDING", "3  STOP_PENDING", "7  PAUSED"]) { restore(); fakeWorld(t, { service: s }); assert.equal(serviceRunning("FACEITService"), true, s); }
    restore(); fakeWorld(t, { service: "1  STOPPED" });
    assert.equal(serviceRunning("FACEITService"), false);
    // A non-English Windows translates the label, not the state name.
    restore(); fakeWorld(t, { service: "4  RUNNING", scLabel: "STATUS" });
    assert.equal(serviceRunning("FACEITService"), true);
    restore(); fakeWorld(t, { service: "1  STOPPED", scLabel: "ÉTAT" });
    assert.equal(serviceRunning("FACEITService"), false);
    restore(); fakeWorld(t, { service: "missing" });
    assert.equal(serviceRunning("FACEITService"), false);
    // An answer without a state line is an error, never "not running".
    restore(); fakeWorld(t, { service: "4  something else" });
    assert.throws(() => serviceRunning("FACEITService"), /no service state/);
    restore(); fakeWorld(t, { service: Object.assign(new Error("sc.exe timed out"), { status: null }) });
    assert.throws(() => serviceRunning("FACEITService"), /timed out/);
  } finally { restore(); }
});

test("faceitRefusal names what runs: the client, its service process, the service; none means no refusal", (t) => {
  const restore = fakeWorld(t, {});
  try {
    assert.equal(faceitRefusal(), undefined);
    restore(); fakeWorld(t, { images: ["faceitclient.exe"] });
    const r = faceitRefusal();
    assert.ok(r instanceof Refusal);
    assert.match(r.message, /^refusing: the FACEIT client's anti-cheat is running \(faceitclient\.exe\); it blocks HLAE from starting cs2\.exe\. Exit the FACEIT client from its tray icon and run again\.$/);
    restore(); fakeWorld(t, { images: ["faceitclient.exe", "faceitservice.exe"], service: "4  RUNNING" });
    assert.match(faceitRefusal()!.message, /\(faceitclient\.exe, faceitservice\.exe, FACEITService\)/);
    restore(); fakeWorld(t, { service: "4  RUNNING" });
    assert.match(faceitRefusal()!.message, /\(FACEITService\)/);
    // A probe that cannot answer refuses as well, never passes: sc failing, sc unparsable, tasklist failing.
    restore(); fakeWorld(t, { service: Object.assign(new Error("sc.exe timed out"), { status: null }) });
    assert.match(faceitRefusal()!.message, /^refusing: could not tell whether the FACEIT client's anti-cheat is running: sc\.exe timed out/);
    restore(); fakeWorld(t, { service: "4  something else" });
    assert.match(faceitRefusal()!.message, /^refusing: could not tell whether .*: sc query FACEITService: no service state/);
    restore(); fakeWorld(t, { images: new Error("tasklist timed out") });
    assert.match(faceitRefusal()!.message, /^refusing: could not tell whether .*: tasklist timed out/);
  } finally { restore(); }
});

test("guard: passes on the render account with nothing running; refuses under FACEIT anti-cheat; CS2 running is still reported first", (t) => {
  const restore = fakeWorld(t, { loggedIn: "1234" });
  try {
    assert.doesNotThrow(() => guard(ids));
    restore(); fakeWorld(t, { loggedIn: "1234", images: ["faceitclient.exe"] });
    assert.throws(() => guard(ids), (e: Error) => e instanceof Refusal && /the FACEIT client's anti-cheat is running \(faceitclient\.exe\)/.test(e.message));
    restore(); fakeWorld(t, { loggedIn: "1234", service: "4  RUNNING" });
    assert.throws(() => guard(ids), /the FACEIT client's anti-cheat is running \(FACEITService\)/);
    restore(); fakeWorld(t, { loggedIn: "1234", images: ["cs2.exe", "faceitclient.exe"] });
    assert.throws(() => guard(ids), (e: Error) => e instanceof Refusal && e.message === "refusing: CS2 is already running");
    // The other guards are untouched: the wrong account refuses before any FACEIT probe.
    restore(); fakeWorld(t, { loggedIn: "999", images: ["faceitclient.exe"] });
    assert.throws(() => guard(ids), /not RENDER_STEAM_ID64/);
  } finally { restore(); }
});

test("pnpm go refuses up front under FACEIT anti-cheat, except on a dry run, a repost or --settle-existing", (t) => {
  const restore = fakeWorld(t, { images: ["faceitclient.exe"] });
  try {
    assert.equal(batchRefusal({})!.message, "refusing: the FACEIT client's anti-cheat is running (faceitclient.exe); it blocks HLAE from starting cs2.exe. Exit the FACEIT client from its tray icon and run again.");
    assert.equal(batchRefusal({ dryRun: true }), undefined, "a dry run launches nothing");
    assert.equal(batchRefusal({ repostOnly: true }), undefined);
    assert.equal(batchRefusal({ settleExisting: true }), undefined);
    // CS2 running still refuses a dry run, as before; a repost never looks.
    restore(); fakeWorld(t, { images: ["cs2.exe", "faceitclient.exe"] });
    assert.equal(batchRefusal({ dryRun: true })!.message, "refusing: CS2 is already running");
    assert.equal(batchRefusal({})!.message, "refusing: CS2 is already running");
    assert.equal(batchRefusal({ repostOnly: true }), undefined);
    restore(); fakeWorld(t, {});
    assert.equal(batchRefusal({}), undefined);
  } finally { restore(); }
});

test("guard classifies reg and tasklist probe failures as Refusal", (t) => {
  const restore = fakeWorld(t, { loggedIn: new Error("reg query timed out") });
  try {
    assert.throws(() => guard(ids), (e: Error) => e instanceof Refusal && /could not read Steam ActiveUser.*reg query timed out/.test(e.message));
    restore(); fakeWorld(t, { loggedIn: "1234", images: new Error("tasklist timed out") });
    assert.throws(() => guard(ids), (e: Error) => e instanceof Refusal && /could not tell whether CS2 is running.*tasklist timed out/.test(e.message));
  } finally { restore(); }
});

test("processes: snapshot and killExact format CreationDate in UTC and ordering holds across DST fallback", (t) => {
  const scripts: string[] = [];
  t.mock.method(child_process, "execFileSync", ((file: string, args: string[]) => {
    if (file === "powershell.exe") {
      scripts.push(args[3]);
      if (args[3].includes("ConvertTo-Json")) {
        return JSON.stringify([{ pid: process.pid, ppid: 1, name: "node.exe", created: "2026-10-25T00:59:59.0000000Z" }]);
      }
      return "killed";
    }
    throw new Error(`unexpected command: ${file}`);
  }) as typeof child_process.execFileSync);
  syncBuiltinESMExports();
  try {
    const snap = snapshot();
    assert.equal(snap.length, 1);
    assert.match(scripts[0], /\.ToUniversalTime\(\)\.ToString\('o'\)/);
    assert.equal(killExact(snap[0]), "killed");
    assert.match(scripts[1], /\.ToUniversalTime\(\)\.ToString\('o'\)/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  // Across autumn DST rollback (02:30+02:00 is 00:30Z; 02:00+01:00 is 01:00Z, 30 min later).
  const beforeFallback = "2026-10-25T02:30:00.0000000+02:00";
  const afterFallback = "2026-10-25T02:00:00.0000000+01:00";
  assert.ok(compareCreated(beforeFallback, afterFallback) < 0);
  // UTC timestamps order strictly by UTC time and retain sub-millisecond order.
  const utc1 = "2026-10-25T00:30:00.0000001Z";
  const utc2 = "2026-10-25T00:30:00.0000002Z";
  assert.ok(compareCreated(utc1, utc2) < 0);

  const spawnedAt = Date.parse(beforeFallback);
  const tree = new OwnedTree(200, "HLAE.exe", spawnedAt);
  const root = { pid: 200, ppid: process.pid, name: "HLAE.exe", created: beforeFallback };
  const child = { pid: 300, ppid: 200, name: "cs2.exe", created: afterFallback };
  tree.discover([root, child]);
  assert.equal(tree.rooted, true);
  assert.equal(tree.games().length, 1);
  assert.equal(tree.games()[0].pid, 300);

  // Suspect detection after parent exits across DST fallback: orphan younger than parent, holder younger than orphan.
  const orphan = { pid: 400, ppid: 200, name: "ffmpeg.exe", created: afterFallback };
  const holder = { pid: 200, ppid: 1, name: "other.exe", created: "2026-10-25T02:05:00.0000000+01:00" };
  assert.deepEqual(tree.suspects([orphan, holder]).map((p) => p.pid), [400]);
});

test("regValue escapes regex metacharacters in the registry value name", (t) => {
  t.mock.method(child_process, "execFileSync", (() =>
    "\r\nHKEY_CURRENT_USER\\Test\r\n    aX+b    REG_SZ    wrong\r\n    a.+b    REG_SZ    exact-match\r\n\r\n"
  ) as unknown as typeof child_process.execFileSync);
  syncBuiltinESMExports();
  try {
    assert.equal(regValue("HKCU\\Test", "a.+b"), "exact-match");
    assert.equal(regValue("HKCU\\Test", "name(with)[special]"), undefined);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
