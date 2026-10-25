// M0.4 spike: CS2 downloads a match from a share code, launched directly (no HLAE). Throwaway;
// results go in docs/spikes.md. Spec: docs/m6-mm-fetch.md, "Contract: the fetch launch" and
// "Phase 1: gate M0.4" (the contract wins).
// Usage: pnpm exec tsx spikes/m0-4-cs2-download.ts <share code> [<share code> ...]
//          [--no-insecure] [--idle <s>] [--timeout <s>] [--kill-after <s>] [--watch-after <s>] [--gone-grace <s>]
//          [--out <new dir>] [--env <file>] [--dry-run]
// Env file (default .env): STEAM_ID64, RENDER_STEAM_ID64 (the only Steam account allowed to run
// this), CS2_EXE (HLAE_EXE must be set too; it is not used). Exit codes: 0 every code done or gone?,
// 1 a code pending or a launch failure, 2 refused (nothing launched; a dry run exits 0),
// 3 cleanup not verified or a cs2.exe appeared after it (a game may be running; the lock stays).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ShareCode } from "globaloffensive-sharecode";
import { Refusal, ROOT, STATE_DIR, loadIdentities } from "../src/config.ts";
import { SHARE_CODE } from "../src/ingest/sources/valve.ts";
import { readFileInfo } from "../src/parse/fileinfo.ts";
import { RenderLock, guard } from "../src/render/controller/guards.ts";
import { OwnedTree, isRunning, key, killExact, snapshot, type Proc } from "../src/render/controller/processes.ts";

const POLL_MS = 500;
const STABLE_MS = 10_000; // a done .dem: size and mtime unchanged this long after every check passed
const QUIET_MS = 10_000; // cleanup: continuous quiet required after the first empty snapshot
const VERIFY_LIMIT_MS = 60_000; // cleanup: give up verifying after this long
const EXTRA_KILL_ROUNDS = 5; // cleanup: survivors found during verification are re-killed at most this often
const ROOT_DEADLINE_MS = 5_000; // the spawned cs2.exe must be seen as our child within this
const GONE_GRACE_DEFAULT_S = 60; // a gone? code ends the launch only after this long with replays/ quiet (startup logs "failed to download item <workshop id>", which matches the gone filter); --gone-grace overrides
const REPORT_LINES = 200;
const LOCK_FILE = path.join(STATE_DIR, ".render.lock");
const OTHER_LOCKS = [".clip.lock", ".go.lock"].map((f) => path.join(STATE_DIR, f));
const DICTIONARY = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789"; // globaloffensive-sharecode's alphabet
const DEM_RE = /^match730_(\d{21})_\d+_\d+\.dem$/;
const GONE_A = /not available|no longer|unavailable|could not|failed|expired|invalid|error/i;
const GONE_B = /download|match|replay|share|csgo_download/i;
const DL_RE = /download|replay|csgo_download|share ?code/i;
const IDENTITY_RE = /steam ?id|account ?id|logged ?on|logon/i;
const WATCHED_IMAGES = new Set(["cs2.exe", "hlae.exe", "steam.exe"]);

// --- fatal paths: refusals before launch, signals and crashes after it -------------------
let lock: RenderLock | undefined;
let lockHeld = false;
let keepLock = false; // set once the exit code is 3 (cleanup not verified, or a late cs2.exe): the lock stays
const releaseLock = () => { if (lockHeld && !keepLock) { lock?.release(); lockHeld = false; } };
// Set immediately before the spawn; emergency ends run it before choosing the exit code.
let cleanupHook: ((reason: string) => boolean) | undefined;
let finishHook: ((note: string) => void) | undefined; // best-effort report on an emergency end
function emergency(reason: string, okCode: number): never {
  if (!cleanupHook) { releaseLock(); process.exit(okCode); }
  const ok = cleanupHook(reason);
  try { finishHook?.(`${reason}; the watch period was skipped`); } catch {}
  // Verified: the lock goes, as render() releases it on a signal (no watch period on an emergency end).
  if (!ok) keepLock = true;
  releaseLock();
  process.exit(ok && !keepLock ? okCode : 3);
}
process.on("uncaughtException", (e) => {
  console.error(e instanceof Refusal ? e.message : (e.stack ?? e.message));
  emergency(`uncaught: ${e.message}`, e instanceof Refusal ? 2 : 1);
});
process.on("unhandledRejection", (e) => { throw e instanceof Error ? e : new Error(String(e)); });
for (const sig of ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] as const) process.on(sig, () => emergency(sig, 130));
process.on("exit", () => { if (cleanupHook && !cleanupHook("spike exit")) process.exitCode = 3; });

// --- arguments ---------------------------------------------------------------------------
const VALUE_FLAGS = new Set(["--idle", "--timeout", "--kill-after", "--watch-after", "--gone-grace", "--out", "--env"]);
const BOOL_FLAGS = new Set(["--no-insecure", "--dry-run"]);
const argv = process.argv.slice(2);
const opt = new Map<string, string>();
const bools = new Set<string>();
const codeArgs: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Refusal(`refusing: ${a} needs a value`);
    opt.set(a, argv[++i]);
  } else if (BOOL_FLAGS.has(a)) bools.add(a);
  else if (a.startsWith("--")) throw new Refusal(`refusing: unknown option ${a}`);
  else codeArgs.push(a);
}
const num = (name: string, def: number, min: number) => {
  const raw = opt.get(name);
  if (raw === undefined) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) throw new Refusal(`refusing: ${name} must be a number >= ${min}`);
  return v;
};
const dryRun = bools.has("--dry-run");
const insecure = !bools.has("--no-insecure");

// Share codes first, before the env file, the lock or anything else.
if (!codeArgs.length) throw new Refusal("refusing: give at least one share code");
type CodeTrack = {
  code: string; matchId: string; outcomeId: string; token: string; padded: string; prefix: string;
  state: "queued" | "downloading" | "done" | "gone?";
  presentAtSpawn: string[];
  candidates: Set<string>;
  firstActivityS?: number; firstDemS?: number; fileInfoOkS?: number; doneS?: number; file?: string;
  ok: Map<string, { size: number; mtimeMs: number; since: number }>;
  goneSince?: number; goneLines: string[]; notes: string[];
  lastInfo?: string; lastFileInfoError?: string;
};
const codes: CodeTrack[] = codeArgs.map((code) => {
  if (!SHARE_CODE.test(code)) throw new Refusal(`refusing: not a share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx): ${code}`);
  // SHARE_CODE allows [A-Za-z0-9]; the decoder silently mis-decodes characters outside its alphabet.
  const bad = [...code.slice(5).replaceAll("-", "")].filter((ch) => !DICTIONARY.includes(ch));
  if (bad.length) throw new Refusal(`refusing: ${code} has characters no share code uses: ${[...new Set(bad)].join("")}`);
  const d = new ShareCode(code).decode() as unknown as { matchId: string; outcomeId: string; token: string } | false;
  if (!d || !/^\d+$/.test(d.matchId) || !/^\d+$/.test(d.outcomeId) || !/^\d+$/.test(d.token) || d.outcomeId.length > 21) throw new Refusal(`refusing: ${code} does not decode`);
  const padded = d.outcomeId.padStart(21, "0");
  return {
    code, matchId: d.matchId, outcomeId: d.outcomeId, token: d.token, padded, prefix: `match730_${padded}_`,
    state: "queued", presentAtSpawn: [], candidates: new Set(), ok: new Map(), goneLines: [], notes: [],
  };
});
if (new Set(codes.map((c) => c.code)).size !== codes.length) throw new Refusal("refusing: the same share code twice");
if (new Set(codes.map((c) => c.padded)).size !== codes.length) throw new Refusal("refusing: two codes decode to the same outcome id");

const idleS = num("--idle", 180, 1);
const timeoutS = num("--timeout", 120 + 180 * codes.length, 1);
const killAfterS = opt.has("--kill-after") ? num("--kill-after", 0, 0) : undefined;
const watchAfterS = num("--watch-after", 30, 0);
const GONE_GRACE_MS = num("--gone-grace", GONE_GRACE_DEFAULT_S, 0) * 1000;
const ids = loadIdentities(opt.has("--env") ? path.resolve(opt.get("--env")!) : undefined);
const runStamp = Date.now();
const outDir = path.resolve(opt.get("--out") ?? path.join(ROOT, "spikes", "out", `m0-4-${runStamp}`));
if (existsSync(outDir)) throw new Refusal(`refusing: output folder already exists: ${outDir}`);
const csgoDir = path.resolve(path.dirname(ids.cs2Exe), "..", "..", "csgo");
const replaysDir = path.join(csgoDir, "replays");
const consoleLog = path.join(csgoDir, "console.log");
const steamInf = path.join(csgoDir, "steam.inf");

// The launch line, exactly as the contract's "Spawn" paragraph: nothing that joins a server.
function buildArgs(stamp: number): string[] {
  const a = [...(insecure ? ["-insecure"] : []), "-novid", "-sw", "-width", "1280", "-height", "720", "-condebug", "+echo", `croclip_fetch_${stamp}`];
  for (const c of codes) a.push("+csgo_download_match", c.code);
  // Self-check: only the flags above and share codes, -insecure first unless dropped on purpose.
  if (insecure && a[0] !== "-insecure") throw new Error("refusing: launch without -insecure");
  const plusCmds = a.filter((x) => x.startsWith("+"));
  if (plusCmds.some((x) => x !== "+echo" && x !== "+csgo_download_match")) throw new Error("refusing: unexpected console command on the launch line");
  return a;
}
const childEnv: NodeJS.ProcessEnv = {};
const envRemoved: string[] = [];
for (const [k, v] of Object.entries(process.env)) {
  if (k.toUpperCase() === "USRLOCALCSGO") envRemoved.push(k);
  else childEnv[k] = v;
}
const fmtCmd = (a: string[]) => [`"${ids.cs2Exe}"`, ...a].join(" ");
const NO_INSECURE_BANNER = "!!! -insecure WAS DROPPED (--no-insecure): this launch is secure-capable; gate question 2 only !!!";

if (dryRun) {
  const a = buildArgs(Date.now());
  console.log(JSON.stringify({
    dryRun: true,
    codes: codes.map((c) => ({ code: c.code, matchId: c.matchId, outcomeId: c.outcomeId, token: c.token, candidateName: `${c.prefix}<n>_<n>.dem` })),
    exe: ids.cs2Exe,
    argv: a,
    commandLine: fmtCmd(a),
    markerNote: "croclip_fetch_<stamp>: the real stamp is the spawn time in ms",
    envKeysRemoved: envRemoved,
    watch: { replays: replaysDir, replaysExists: existsSync(replaysDir), consoleLog, steamInf },
    lockFile: LOCK_FILE,
    outDir,
    limits: { idleS, timeoutS, killAfterS: killAfterS ?? null, watchAfterS },
  }, null, 2));
  if (!insecure) console.log(NO_INSECURE_BANNER);
  process.exit(0);
}

// --- refuse before anything is written or launched ---------------------------------------
lock = new RenderLock(LOCK_FILE);
lock.acquire();
lockHeld = true;
try {
  guard(ids);
  for (const f of OTHER_LOCKS) if (existsSync(f)) throw new Refusal(`refusing: ${f} exists (a clip or pnpm go is running)`);
} catch (e) { releaseLock(); throw e; }
mkdirSync(outDir, { recursive: true });

// --- event log -----------------------------------------------------------------------------
let spawnedAt: number | undefined;
const secs = (t: number) => (spawnedAt === undefined ? null : Math.round((t - spawnedAt) / 100) / 10);
const timeline = path.join(outDir, "timeline.jsonl");
function ev(kind: string, details: Record<string, unknown> = {}, at = Date.now()) {
  try { appendFileSync(timeline, JSON.stringify({ t: new Date(at).toISOString(), s: secs(at), kind, details }) + "\n"); }
  catch (e) { console.error(`timeline write failed: ${(e as Error).message}`); }
}
const say = (msg: string, at = Date.now()) => console.log(`[m0-4 ${secs(at) === null ? "pre" : `+${secs(at)!.toFixed(1)}s`}] ${msg}`);

// --- processes: owned tree, event log (gate question 8) ---------------------------------
let tree: OwnedTree | undefined;
type ProcEvent = { at: number; kind: "present" | "appeared" | "gone"; p: Proc; cmd?: string | null };
const procEvents: ProcEvent[] = [];
let watchedNow = new Map<string, Proc>();
let procBaselineDone = false;
const cmdLines = new Map<string, string | null>(); // key(p) → CommandLine, once per cs2.exe
const snapMs: number[] = [];
function cs2CommandLine(p: Proc): string | null {
  const k = key(p);
  if (cmdLines.has(k)) return cmdLines.get(k)!;
  let cmd: string | null = null;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'cs2.exe'\" | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; created = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }); cmd = $_.CommandLine } }) | ConvertTo-Json -Compress"],
      { encoding: "utf8", maxBuffer: 1 << 24, timeout: 15_000 }).trim();
    const v = out ? JSON.parse(out) : [];
    const rows: { pid: number; created: string; cmd: string | null }[] = Array.isArray(v) ? v : [v];
    const row = rows.find((r) => r.pid === p.pid && r.created === p.created);
    cmd = row ? (row.cmd ?? "<CommandLine empty: not readable>") : "<gone before the CommandLine query>";
  } catch (e) { cmd = `<CommandLine query failed: ${(e as Error).message.split("\n")[0]}>`; }
  cmdLines.set(k, cmd);
  return cmd;
}
function observe(snap: Proc[], at: number) {
  const cur = new Map(snap.filter((p) => WATCHED_IMAGES.has(p.name.toLowerCase())).map((p) => [key(p), p] as const));
  for (const [k, p] of cur) {
    if (watchedNow.has(k)) continue;
    const cmd = p.name.toLowerCase() === "cs2.exe" ? cs2CommandLine(p) : undefined;
    const kind = procBaselineDone ? "appeared" : "present";
    procEvents.push({ at, kind, p, cmd });
    ev(`process-${kind}`, { name: p.name, pid: p.pid, ppid: p.ppid, created: p.created, owned: tree?.procs.has(k) ?? false, ...(cmd !== undefined ? { commandLine: cmd } : {}) }, at);
    if (procBaselineDone) say(`process appeared: ${p.name} pid ${p.pid} ppid ${p.ppid}${cmd ? ` cmd: ${cmd}` : ""}`, at);
  }
  for (const [k, p] of watchedNow) {
    if (cur.has(k)) continue;
    procEvents.push({ at, kind: "gone", p });
    ev("process-gone", { name: p.name, pid: p.pid, ppid: p.ppid, created: p.created, owned: tree?.procs.has(k) ?? false }, at);
    say(`process gone: ${p.name} pid ${p.pid}`, at);
  }
  watchedNow = cur;
  procBaselineDone = true;
}
/** One snapshot: the owned tree grows from it, and the process event log sees it. */
function poll(): Proc[] {
  const a = Date.now();
  const snap = snapshot();
  snapMs.push(Date.now() - a);
  tree?.discover(snap);
  observe(snap, Date.now());
  return snap;
}

// --- replays/ (files, per-code state) -------------------------------------------------
type FStat = { size: number; mtimeMs: number };
function walk(dir: string, rel = "", out = new Map<string, FStat>()): Map<string, FStat> {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, r, out); continue; }
    try { const st = statSync(full); out.set(r, { size: st.size, mtimeMs: st.mtimeMs }); } catch {} // vanished between readdir and stat
  }
  return out;
}
const replaysExistedAtSpawn = existsSync(replaysDir);
const baseline = walk(replaysDir);
let files = new Map(baseline);
type FileHist = { presentAtSpawn: boolean; baseSize?: number; firstS: number | null; lastChangeS: number | null; size: number; goneS: number | null; changes: number };
const fileHist = new Map<string, FileHist>();
for (const [n, st] of baseline) fileHist.set(n, { presentAtSpawn: true, baseSize: st.size, firstS: null, lastChangeS: null, size: st.size, goneS: null, changes: 0 });
let lastReplaysChange = 0;
let lastDoneAt = 0;
let maxConcurrent = 0;
const concurrentSamples: { s: number | null; names: string[] }[] = [];
const lastGrewSay = new Map<string, number>();
for (const c of codes) {
  c.presentAtSpawn = [...baseline.keys()].filter((n) => n.startsWith(c.prefix));
  if (c.presentAtSpawn.length) c.notes.push(`already present at spawn: ${c.presentAtSpawn.join(", ")} (can only become done if size or mtime changes)`);
}

function setState(c: CodeTrack, state: CodeTrack["state"], why: string, at: number) {
  if (c.state === state) return;
  ev("code-state", { code: c.code, from: c.state, to: state, why }, at);
  say(`${c.code}: ${c.state} -> ${state} (${why})`, at);
  c.state = state;
}

function scanReplays(at: number) {
  const cur = walk(replaysDir);
  const changedNow: string[] = [];
  const touch = (n: string, kind: string, st: FStat) => {
    const h = fileHist.get(n) ?? { presentAtSpawn: false, firstS: secs(at), lastChangeS: null, size: 0, goneS: null, changes: 0 };
    h.lastChangeS = secs(at); h.size = st.size; h.changes++;
    if (kind === "file-appeared") { h.goneS = null; if (h.firstS === null) h.firstS = secs(at); }
    fileHist.set(n, h);
    ev(kind, { name: n, size: st.size, mtimeMs: st.mtimeMs }, at);
    if (kind !== "file-grew") say(`${kind.slice(5)}: ${n} (${st.size} bytes)`, at);
    else if (at - (lastGrewSay.get(n) ?? 0) >= 10_000) { lastGrewSay.set(n, at); say(`growing: ${n} (${st.size} bytes)`, at); }
    changedNow.push(n);
    for (const c of codes) if (n.startsWith(c.prefix)) {
      c.firstActivityS ??= secs(at) ?? undefined;
      if (c.state === "queued") setState(c, "downloading", `${kind.slice(5)}: ${n}`, at);
    }
  };
  for (const [n, st] of cur) {
    const prev = files.get(n);
    if (!prev) touch(n, "file-appeared", st);
    else if (st.size > prev.size) touch(n, "file-grew", st);
    else if (st.size < prev.size) touch(n, "file-shrank", st);
    else if (st.mtimeMs !== prev.mtimeMs) touch(n, "file-touched", st);
  }
  for (const [n, st] of files) {
    if (cur.has(n)) continue;
    const h = fileHist.get(n);
    if (h) { h.goneS = secs(at); h.lastChangeS = secs(at); h.changes++; }
    ev("file-gone", { name: n, lastSize: st.size }, at);
    say(`gone: ${n}`, at);
    changedNow.push(n);
  }
  files = cur;
  if (changedNow.length) lastReplaysChange = at;
  const data = [...new Set(changedNow)].filter((n) => !n.endsWith(".info"));
  if (data.length > 1) concurrentSamples.push({ s: secs(at), names: data });
  maxConcurrent = Math.max(maxConcurrent, data.length);
}

/** Field 1 of the .dem.info protobuf (CDataGCCStrike15_v2_MatchInfo.matchid), as a decimal string. */
function infoMatchId(file: string): string {
  const b = readFileSync(file);
  let p = 0;
  const varint = (): bigint => {
    let r = 0n, sh = 0n;
    for (;;) {
      if (p >= b.length || sh > 63n) throw new Error("truncated or overlong varint");
      const x = b[p++];
      r |= BigInt(x & 127) << sh; sh += 7n;
      if (!(x & 128)) return r;
    }
  };
  const k = varint();
  if (k !== 8n) throw new Error(`first field has key ${k}, expected 8 (field 1, varint)`);
  return varint().toString();
}

function updateCodes(at: number) {
  for (const c of codes) {
    if (c.state === "done") continue;
    for (const [n, st] of files) {
      const m = DEM_RE.exec(n);
      if (!m || m[1] !== c.padded) continue;
      c.candidates.add(n);
      const base = baseline.get(n);
      if (base && base.size === st.size && base.mtimeMs === st.mtimeMs) continue; // unchanged since spawn: never done on its own
      c.firstDemS ??= secs(at) ?? undefined;
      const full = path.join(replaysDir, n);
      let infoOk = false;
      try {
        const id = infoMatchId(`${full}.info`);
        infoOk = id === c.matchId;
        const note = infoOk ? `${n}.info field 1 = matchId` : `${n}.info field 1 = ${id}, NOT the code's matchId ${c.matchId}`;
        if (note !== c.lastInfo) { c.lastInfo = note; ev("info-check", { code: c.code, file: `${n}.info`, field1: id, matches: infoOk }, at); if (!infoOk) say(`${c.code}: ${note}`, at); }
      } catch (e) {
        const note = `${n}.info: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (e as Error).message}`;
        if (note !== c.lastInfo) { c.lastInfo = note; ev("info-check", { code: c.code, file: `${n}.info`, error: note }, at); }
      }
      let fiOk = false;
      try {
        readFileInfo(full);
        fiOk = true;
        if (c.fileInfoOkS === undefined) { c.fileInfoOkS = secs(at) ?? undefined; ev("fileinfo-ok", { code: c.code, file: n, size: st.size }, at); say(`${c.code}: ${n} passes readFileInfo (${st.size} bytes)`, at); }
      } catch (e) { c.lastFileInfoError = (e as Error).message; }
      if (!infoOk || !fiOk) { c.ok.delete(n); continue; }
      const k = c.ok.get(n);
      if (!k || k.size !== st.size || k.mtimeMs !== st.mtimeMs) { c.ok.set(n, { size: st.size, mtimeMs: st.mtimeMs, since: at }); continue; }
      if (at - k.since >= STABLE_MS) {
        c.file = n; c.doneS = secs(at) ?? undefined; lastDoneAt = at;
        setState(c, "done", `${n}: .info matches, readFileInfo passes, stable ${STABLE_MS / 1000}s`, at);
        break;
      }
    }
  }
}

// --- console.log -------------------------------------------------------------------------
let marker = "";
let logOurs = false;
let markerSeenS: number | null = null;
let processedLen = 0;
let afterMarker = false;
type Line = { s: number | null; line: string; codes?: string[] };
const cmdLineLines: Line[] = [];
const delayedLines: Line[] = [];
const identityLines: Line[] = [];
const goneCandidates: Line[] = [];
const dlLines: Line[] = [];
function readConsole(at: number) {
  let text: string;
  try {
    if (statSync(consoleLog).mtimeMs < (spawnedAt ?? at) - 1000) return;
    text = readFileSync(consoleLog, "utf8");
  } catch { return; }
  if (!logOurs) {
    if (!text.includes(marker)) return;
    logOurs = true; markerSeenS = secs(at);
    ev("marker-seen", { marker }, at);
    say("console.log is this launch's (marker seen)", at);
  }
  if (text.length < processedLen) { ev("console-truncated", { from: processedLen, to: text.length }, at); processedLen = 0; afterMarker = false; }
  const end = text.lastIndexOf("\n") + 1; // complete lines only
  if (end <= processedLen) return;
  const chunk = text.slice(processedLen, end);
  processedLen = end;
  const s = secs(at);
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    if (line.includes(marker)) afterMarker = true;
    const isCmd = line.includes("[CommandLine]");
    const rec = (list: Line[], category: string, extra: Partial<Line> = {}) => {
      list.push({ s, line, ...extra });
      ev("console-line", { category, line, ...extra }, at);
    };
    if (isCmd) rec(cmdLineLines, "commandline");
    if (/DELAYED COMMAND/.test(line)) rec(delayedLines, "delayed-command");
    if (s !== null && s <= 60 && IDENTITY_RE.test(line)) { rec(identityLines, "identity"); say(`identity-like line: ${line}`, at); }
    if (!afterMarker || isCmd) continue;
    const idHits = codes.filter((c) => line.includes(c.matchId) || line.includes(c.outcomeId));
    if (GONE_A.test(line) && GONE_B.test(line)) {
      const attributed = codes.length === 1 ? codes : idHits;
      rec(goneCandidates, "gone-candidate", { codes: attributed.map((c) => c.code) });
      say(`gone-candidate line: ${line}`, at);
      for (const c of attributed) {
        c.goneLines.push(line);
        if (c.state !== "done" && c.state !== "gone?") { c.goneSince = at; setState(c, "gone?", `console: ${line.slice(0, 160)}`, at); }
      }
    } else if (DL_RE.test(line) || idHits.length) rec(dlLines, "download-related", idHits.length ? { codes: idHits.map((c) => c.code) } : {});
  }
}

// --- cleanup ---------------------------------------------------------------------------------
// mirrors render() cleanup(), plus re-kill of survivors and a 10 s quiet period (contract, Exit)
type CleanupResult = { reason: string; verified: boolean; errors: string[]; killed: string[]; extraRounds: number; quietMs: number; longestQuietMs: number; seconds: number };
let cleanupResult: CleanupResult | undefined;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function cleanup(reason: string): boolean {
  if (cleanupResult) return cleanupResult.verified;
  const t = Date.now();
  const r: CleanupResult = { reason, verified: false, errors: [], killed: [], extraRounds: 0, quietMs: 0, longestQuietMs: 0, seconds: 0 };
  cleanupResult = r; // latched first: a signal during cleanup does not start a second one
  ev("kill", { phase: "start", reason });
  say(`cleanup (${reason})`);
  const kill = (p: Proc) => {
    try {
      const out = killExact(p);
      r.killed.push(`${p.name} pid ${p.pid}: ${out}`);
      ev("kill", { name: p.name, pid: p.pid, created: p.created, result: out });
      if (out === "killed") say(`killed ${p.name} pid ${p.pid}`);
    } catch (e) { r.errors.push(`${p.name} pid ${p.pid}: ${(e as Error).message}`); }
  };
  if (tree) {
    // Without the root nothing it started could be tracked: fail closed.
    if (!tree.rooted) r.errors.push("the spawned cs2.exe was never identified as this spike's child, so its processes were not tracked");
    // Kill rounds, oldest first (the root before anything it started), re-discovering after each round.
    const done = new Set<string>();
    for (let round = 0; round < 5; round++) {
      try { poll(); } catch (e) { r.errors.push(`could not list owned processes: ${(e as Error).message}`); break; }
      const pending = [...tree.procs.values()].filter((p) => !done.has(key(p))).sort((a, b) => a.created.localeCompare(b.created));
      if (!pending.length) break;
      for (const p of pending) { done.add(key(p)); kill(p); }
    }
  }
  // Verification: no owned process, no suspect orphan and no cs2.exe at all, continuously for
  // QUIET_MS. Owned survivors go back into the kill rounds; suspects are never killed, only waited for.
  let quietSince: number | undefined;
  const deadline = Date.now() + VERIFY_LIMIT_MS;
  for (;;) {
    let snap: Proc[];
    try { snap = poll(); } catch (e) { r.errors.push(`verification failed: ${(e as Error).message}`); break; }
    const now = Date.now();
    const left = tree ? [...tree.procs.values()].filter((o) => isRunning(o, snap)) : [];
    const suspects = tree ? tree.suspects(snap) : [];
    const cs2 = snap.filter((x) => x.name.toLowerCase() === "cs2.exe");
    if (!left.length && !suspects.length && !cs2.length) {
      if (quietSince === undefined) { quietSince = now; ev("verification", { quiet: "started" }); }
      r.longestQuietMs = Math.max(r.longestQuietMs, now - quietSince);
      if (now - quietSince >= QUIET_MS) { r.quietMs = now - quietSince; break; }
    } else {
      if (quietSince !== undefined) ev("verification", { quiet: "broken", afterMs: now - quietSince, left: left.map((p) => p.pid), suspects: suspects.map((p) => p.pid), cs2: cs2.map((p) => p.pid) });
      quietSince = undefined;
      if (left.length && r.extraRounds < EXTRA_KILL_ROUNDS) {
        r.extraRounds++;
        ev("verification", { reKillRound: r.extraRounds, procs: left.map((p) => `${p.name}:${p.pid}`) });
        for (const p of left) kill(p);
        continue;
      }
    }
    if (now > deadline) {
      for (const p of left) r.errors.push(`${p.name} pid ${p.pid} still running`);
      for (const p of suspects) r.errors.push(`${p.name} pid ${p.pid} may be an orphan of ours and is still running`);
      if (cs2.length) r.errors.push(`cs2.exe still running (pid ${cs2.map((p) => p.pid).join(", ")}${cs2.some((p) => !tree?.procs.has(key(p))) ? "; not owned, never killed" : ""})`);
      if (!left.length && !suspects.length && !cs2.length) r.errors.push(`quiet period not reached within ${VERIFY_LIMIT_MS / 1000}s`);
      break;
    }
    pause(POLL_MS);
  }
  r.verified = r.errors.length === 0;
  r.seconds = Math.round((Date.now() - t) / 100) / 10;
  ev("verification", { verified: r.verified, errors: r.errors, quietMs: r.quietMs, extraRounds: r.extraRounds });
  if (!r.verified) keepLock = true;
  if (!r.verified) console.error(`CLEANUP NOT VERIFIED (${reason}): ${r.errors.join("; ")}. Check for cs2.exe by hand. The lock stays: ${LOCK_FILE}`);
  else say(`cleanup verified: ${Math.round(r.quietMs / 100) / 10}s of quiet`);
  return r.verified;
}

// --- report ------------------------------------------------------------------------------------
let launchArgs: string[] = [];
let endReason = "";
let failure: string | undefined;
let watch: { seconds: number; lateCs2: string[]; skipped?: string } | undefined;
const leftovers: { name: string; size: number; fileInfo: string }[] = [];
function dedupe(lines: Line[]): string[] {
  const seen = new Map<string, { first: Line; n: number }>();
  for (const l of lines) {
    const k = l.line.replace(/^\d\d\/\d\d \d\d:\d\d:\d\d\s+/, "");
    const e = seen.get(k);
    if (e) e.n++; else seen.set(k, { first: l, n: 1 });
  }
  return [...seen.values()].slice(0, REPORT_LINES).map(({ first, n }) => `[+${first.s ?? "?"}s]${n > 1 ? ` (x${n})` : ""}${first.codes?.length ? ` {${first.codes.join(", ")}}` : ""} ${first.line}`);
}
function steamInfVersions(): string {
  try {
    const inf = readFileSync(steamInf, "utf8");
    const get = (k: string) => inf.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "?";
    return `ClientVersion ${get("ClientVersion")}, PatchVersion ${get("PatchVersion")}`;
  } catch (e) { return `unknown (${(e as Error).message})`; }
}
function outcome(c: CodeTrack) { return c.state === "done" || c.state === "gone?" ? c.state : `pending (last state: ${c.state})`; }
function exitCode(): number {
  if (!cleanupResult?.verified || (watch?.lateCs2.length ?? 0) > 0) return 3;
  if (failure || codes.some((c) => c.state !== "done" && c.state !== "gone?")) return 1;
  return 0;
}
function writeReport(note?: string) {
  const fence = (lines: string[]) => (lines.length ? ["```text", ...lines, "```"] : ["(none)"]);
  const t = (s: number | null | undefined) => (s === undefined || s === null ? "-" : `${s}s`);
  const newFiles = [...fileHist.entries()].filter(([, h]) => h.changes > 0);
  const temp = newFiles.filter(([n]) => !DEM_RE.test(n) && !/^match730_\d{21}_\d+_\d+\.dem\.info$/.test(n));
  const bz2 = newFiles.filter(([n]) => /\.bz2$/i.test(n));
  const windows = codes.map((c) => ({ c, from: c.firstActivityS, to: c.doneS ?? Math.max(-1, ...newFiles.filter(([n]) => n.startsWith(c.prefix)).map(([, h]) => h.lastChangeS ?? -1)) }));
  const active = windows.filter((w) => w.from !== undefined && w.to !== undefined && w.to >= 0);
  const overlaps = active.flatMap((a, i) => active.slice(i + 1).filter((b) => a.from! <= b.to! && b.from! <= a.to!).map((b) => `${a.c.code} and ${b.c.code}`));
  const meanSnap = snapMs.length ? Math.round(snapMs.reduce((x, y) => x + y, 0) / snapMs.length) : 0;
  const cr = cleanupResult;
  const L: string[] = [
    "# M0.4 spike report",
    "",
    ...(insecure ? [] : [`**${NO_INSECURE_BANNER}**`, ""]),
    ...(note ? [`**Emergency end: ${note}**`, ""] : []),
    `Run: ${new Date(runStamp).toISOString()}; exit code ${exitCode()}; end reason: ${endReason || "-"}${failure ? `; launch failure: ${failure}` : ""}`,
    "",
    "## Command line",
    "",
    "```text", fmtCmd(launchArgs), "```",
    "",
    `-insecure: ${insecure ? "passed" : "DROPPED (--no-insecure)"}. Env keys removed: ${envRemoved.join(", ") || "none"}. Limits: idle ${idleS}s, timeout ${timeoutS}s, kill-after ${killAfterS ?? "-"}s, watch-after ${watchAfterS}s.`,
    "",
    "## Codes",
    "",
  ];
  for (const c of codes) {
    L.push(`### ${c.code}: ${outcome(c)}`, "",
      `- matchId ${c.matchId}, outcomeId ${c.outcomeId}, token ${c.token}; candidate prefix \`${c.prefix}\``,
      `- candidate file(s): ${[...c.candidates].join(", ") || "none"}${c.file ? `; done file: ${c.file}` : ""}`,
      `- present at spawn: ${c.presentAtSpawn.join(", ") || "nothing"}`,
      `- seconds from spawn: first file activity ${t(c.firstActivityS)}, .dem appeared/changed ${t(c.firstDemS)}, passes readFileInfo ${t(c.fileInfoOkS)}, done ${t(c.doneS)}`,
      `- .info check (last): ${c.lastInfo ?? "-"}; last readFileInfo error: ${c.lastFileInfoError ?? "-"}`,
      ...(c.goneLines.length ? [`- gone? lines: ${c.goneLines.length} (listed under console)`] : []),
      ...c.notes.map((n) => `- ${n}`), "");
  }
  L.push("## replays/", "",
    `Folder: ${replaysDir} (${replaysExistedAtSpawn ? "existed" : "did not exist"} at spawn; ${baseline.size} file(s) then).`, "",
    "Files that appeared, changed or went away after the spawn (first seen, last change, last size):", "",
    ...(newFiles.length ? newFiles.map(([n, h]) => `- ${n}: ${h.presentAtSpawn ? `present at spawn (${h.baseSize} bytes)` : `first ${t(h.firstS)}`}, last change ${t(h.lastChangeS)}, ${h.goneS !== null ? `gone at ${t(h.goneS)}` : `${h.size} bytes`}, ${h.changes} change(s)`) : ["(none)"]), "",
    `.bz2 / temporary names: ${bz2.length ? `.bz2 seen: ${bz2.map(([n]) => n).join(", ")}` : "no .bz2 seen"}; other names than match730_<21>_<n>_<n>.dem[.info]: ${temp.map(([n]) => n).join(", ") || "none"}.`, "",
    `Sequence vs parallel: at most ${maxConcurrent} data file(s) (.info excluded) changed in the same poll${concurrentSamples.length ? ` (${concurrentSamples.length} poll(s) with more than one; first: +${concurrentSamples[0].s}s ${concurrentSamples[0].names.join(", ")})` : ""}. Per-code activity windows: ${windows.map((w) => `${w.c.code} ${t(w.from)}..${w.to !== undefined && w.to >= 0 ? `${w.to}s` : "-"}`).join("; ")}. ${codes.length > 1 ? (overlaps.length ? `Overlapping windows: ${overlaps.join("; ")}.` : "No overlapping windows.") : "(one code: not observable)"}`, "",
    "After the kill (completeness check on what is left, gate question 7):", "",
    ...(leftovers.length ? leftovers.map((l) => `- ${l.name}: ${l.size} bytes, readFileInfo: ${l.fileInfo}`) : ["(no changed .dem left)"]), "",
    "## console.log", "",
    `Marker \`${marker}\`: ${logOurs ? `seen at ${t(markerSeenS)}` : "NEVER seen (console.log is not this launch's)"}.`, "",
    "[CommandLine] lines:", "", ...fence(dedupe(cmdLineLines)), "",
    "DELAYED COMMAND lines:", "", ...fence(dedupe(delayedLines)), "",
    "Logon-identity-like lines in the first 60 s (gate question 9):", "", ...fence(dedupe(identityLines)), "",
    "Gone-candidate lines (failure word + download word; {codes} = attributed, which marks gone?):", "", ...fence(dedupe(goneCandidates)), "",
    "Other download-related lines (download/replay/share code, or a code's matchId/outcomeId; {codes} = id hit):", "", ...fence(dedupe(dlLines)), "",
    "## Processes (cs2.exe, HLAE.exe, steam.exe)", "",
    `Snapshots: ${snapMs.length}, ${meanSnap} ms mean, ${snapMs.length ? Math.max(...snapMs) : 0} ms max each, ${POLL_MS} ms sleep between polls.`, "",
    ...(procEvents.length ? procEvents.map((e) => `- ${e.kind === "present" ? "before spawn" : t(secs(e.at))} ${e.kind} ${e.p.name} pid ${e.p.pid} ppid ${e.p.ppid} created ${e.p.created} owned: ${tree?.procs.has(key(e.p)) ? "yes" : "no"}${e.cmd !== undefined ? ` cmd: \`${(e.cmd ?? "null").replaceAll("`", "'")}\`` : ""}`) : ["(none)"]), "",
    `Owned tree: ${tree ? `${tree.rooted ? "rooted" : "NEVER ROOTED"}; ${tree.list().join(", ") || "empty"}` : "no tree (nothing spawned)"}.`, "",
    "## Cleanup", "",
    ...(cr ? [
      `- reason: ${cr.reason}`,
      `- verified: ${cr.verified ? "yes" : "NO"}; quiet period ${Math.round(cr.quietMs / 100) / 10}s (longest seen ${Math.round(cr.longestQuietMs / 100) / 10}s); took ${cr.seconds}s`,
      `- kills: ${cr.killed.join("; ") || "none"}; extra kill rounds during verification: ${cr.extraRounds}`,
      ...(cr.errors.length ? [`- errors: ${cr.errors.join("; ")}`] : []),
    ] : ["(not run)"]),
    `- watch after verification: ${watch ? (watch.skipped ?? `${watch.seconds}s, late cs2.exe: ${watch.lateCs2.join("; ") || "none"}`) : "not run"}`,
    `- lock ${LOCK_FILE}: ${exitCode() === 3 ? "KEPT (check for cs2.exe by hand, then delete it)" : "released"}`, "",
    "## Versions", "",
    `- CS2 (${steamInf}): ${steamInfVersions()}`,
    `- Node ${process.version}, os.release() ${os.release()}`, "");
  writeFileSync(path.join(outDir, "report.md"), L.join("\n"));
  try { copyFileSync(consoleLog, path.join(outDir, "console.log")); } catch {}
}
function checkLeftovers() {
  for (const [n, st] of walk(replaysDir)) {
    const base = baseline.get(n);
    if (!DEM_RE.test(n) || (base && base.size === st.size && base.mtimeMs === st.mtimeMs)) continue;
    let fi = "passes";
    try { readFileInfo(path.join(replaysDir, n)); } catch (e) { fi = `rejects: ${(e as Error).message}`; }
    leftovers.push({ name: n, size: st.size, fileInfo: fi });
  }
}
finishHook = (note) => { try { scanReplays(Date.now()); checkLeftovers(); } catch {} writeReport(note); };

// --- launch ---------------------------------------------------------------------------------------
if (!insecure) console.log(NO_INSECURE_BANNER);
ev("start", { codes: codes.map((c) => c.code), outDir, insecure });
try {
  poll(); // process baseline, before the spawn
  ev("replays-baseline", { dir: replaysDir, exists: replaysExistedAtSpawn, files: [...baseline].map(([n, s]) => ({ name: n, size: s.size, mtimeMs: s.mtimeMs })) });
  // Re-check right before the launch: the account or a running CS2 may have changed.
  guard(ids);
} catch (e) { releaseLock(); throw e; }
const stamp = Date.now();
marker = `croclip_fetch_${stamp}`;
launchArgs = buildArgs(stamp);
writeFileSync(path.join(outDir, "args.json"), JSON.stringify({
  exe: ids.cs2Exe, argv: launchArgs, commandLine: fmtCmd(launchArgs), envKeysRemoved: envRemoved,
  options: { codes: codes.map((c) => c.code), insecure, idleS, timeoutS, killAfterS: killAfterS ?? null, watchAfterS, outDir },
  watch: { replays: replaysDir, consoleLog, steamInf }, lockFile: LOCK_FILE,
}, null, 2));
say(`launching: ${fmtCmd(launchArgs)}`);

cleanupHook = cleanup;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  spawnedAt = Date.now();
  const child = spawn(ids.cs2Exe, launchArgs, { env: childEnv, stdio: "ignore", windowsHide: true });
  let spawnError: Error | undefined;
  child.on("error", (e) => { spawnError = e; });
  if (child.pid === undefined) throw new Error("cs2.exe did not start");
  tree = new OwnedTree(child.pid, "cs2.exe", spawnedAt);
  ev("spawned", { pid: child.pid });
  lastReplaysChange = spawnedAt;
  poll();
  let rootedSaid = false;
  while (true) {
    await sleep(POLL_MS);
    if (spawnError) { failure = `cs2.exe spawn error: ${spawnError.message}`; endReason = "launch failure"; break; }
    const snap = poll();
    const now = Date.now();
    if (tree.rooted && !rootedSaid) { rootedSaid = true; ev("rooted", { pid: tree.rootPid }); say(`owned tree rooted at cs2.exe pid ${tree.rootPid}`); }
    scanReplays(now);
    readConsole(now);
    updateCodes(now);
    if (!tree.rooted && now - spawnedAt > ROOT_DEADLINE_MS) { failure = "the spawned cs2.exe was never seen as this spike's child"; endReason = "launch failure"; break; }
    const games = tree.games();
    if (games.length > 0 && !games.some((g) => isRunning(g, snap))) { endReason = "the owned cs2.exe exited on its own"; break; }
    const settled = codes.every((c) => c.state === "done" || (c.state === "gone?" && now - c.goneSince! >= GONE_GRACE_MS && now - lastReplaysChange >= GONE_GRACE_MS));
    if (settled) { endReason = "every code done or gone?"; break; }
    if (now - Math.max(lastReplaysChange, lastDoneAt) >= idleS * 1000) { endReason = `idle: nothing under replays/ changed for ${idleS}s and no code reached done`; break; }
    if (killAfterS !== undefined && now - spawnedAt >= killAfterS * 1000) { endReason = `--kill-after ${killAfterS}s`; break; }
    if (now - spawnedAt >= timeoutS * 1000) { endReason = `hard cap ${timeoutS}s`; break; }
  }
  // Reconcile every code once more before the kill.
  const now = Date.now();
  scanReplays(now); readConsole(now); updateCodes(now);
} catch (e) {
  failure = `spike error: ${(e as Error).message}`;
  endReason ||= "launch failure";
}
ev("end", { reason: endReason, failure: failure ?? null, codes: codes.map((c) => ({ code: c.code, state: c.state })) });
say(`ending: ${endReason}${failure ? ` (${failure})` : ""}`);
const verified = cleanup(failure ?? endReason);
// What the kill left behind (gate question 7), and the final console lines.
{ const now = Date.now(); scanReplays(now); readConsole(now); checkLeftovers(); }

// --- watch for a late cs2.exe (gate question 8) -----------------------------------------------
if (verified) {
  watch = { seconds: watchAfterS, lateCs2: [] };
  ev("watch", { phase: "start", seconds: watchAfterS });
  const until = Date.now() + watchAfterS * 1000;
  while (Date.now() < until) {
    let snap: Proc[];
    try { snap = poll(); } catch (e) { watch.lateCs2.push(`<snapshot failed during the watch, nothing verified after it: ${(e as Error).message}>`); keepLock = true; break; }
    for (const p of snap.filter((x) => x.name.toLowerCase() === "cs2.exe")) {
      const tag = `${p.name} pid ${p.pid} ppid ${p.ppid} created ${p.created}`;
      if (!watch.lateCs2.includes(tag)) { watch.lateCs2.push(tag); keepLock = true; ev("watch", { lateCs2: tag, commandLine: cs2CommandLine(p) }); console.error(`LATE cs2.exe after verified cleanup: ${tag} (not owned, never killed)`); }
    }
    await sleep(POLL_MS);
  }
  ev("watch", { phase: "end", lateCs2: watch.lateCs2 });
} else watch = { seconds: 0, lateCs2: [], skipped: "skipped: cleanup not verified" };

const code = exitCode();
if (code === 3) keepLock = true;
releaseLock();
cleanupHook = undefined; // done: the exit handler has nothing left to run
writeReport();
for (const c of codes) say(`${c.code}: ${outcome(c)}${c.file ? ` (${c.file})` : ""}`);
say(`report: ${path.join(outDir, "report.md")}; exit ${code}${code === 3 ? `; lock kept: ${LOCK_FILE}` : ""}`);
if (!insecure) console.log(NO_INSECURE_BANNER);
process.exit(code);
