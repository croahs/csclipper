// Ingest (PLAN.md §1, watch-folder baseline): every source drops files into
// demos/inbox/; ingest waits until a file has stopped growing, unpacks
// archives with name, count and size limits enforced while unpacking, checks
// the result is a CS2 demo, hashes it, moves it to demos/store/<sha256>.dem and
// registers it in state/demos.json (committed after each demo). Originals go
// to demos/ingested/, anything unusable to demos/rejected/ with a
// .reason.txt beside it; nothing is deleted. A store file that is not in the
// registry (a run died between the move and the commit) is registered on the
// next run. Producers must write under a temporary name (a leading dot, or
// .part / .tmp / .crdownload) and rename into place when done; such names are
// ignored. The stable-size wait and the re-checks below catch most writers
// that do not, but only the rename guarantees the stored bytes match the hash.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT, STATE_DIR } from "../config.ts";
import { sha256File } from "../parse/clip-facts.ts";
import { SOURCES } from "./sources.ts";

const require = createRequire(import.meta.url);
const Bunzip = require("seek-bzip");

export const DEMOS_DIR = path.join(ROOT, "demos");
export const INBOX = path.join(DEMOS_DIR, "inbox");
const STORE = path.join(DEMOS_DIR, "store");
const INGESTED = path.join(DEMOS_DIR, "ingested");
const REJECTED = path.join(DEMOS_DIR, "rejected");
const WORK = path.join(DEMOS_DIR, ".unpack");
const REGISTRY = path.join(STATE_DIR, "demos.json");

const STABLE_MS = 2000; // a file must keep its size and mtime this long
const MAX_DEM_BYTES = 2 * 1024 ** 3; // one demo, bare or unpacked
const MAX_INPUT_BYTES = 2 * 1024 ** 3; // one compressed file read into memory
const MAX_ARCHIVE_ENTRIES = 20;
const MAX_ARCHIVE_TOTAL = 6 * 1024 ** 3;
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"); // bsdtar: reads zip
const PARTIAL = /^\.|\.(part|tmp|crdownload)$/i;

export type DemoRecord = { sha256: string; file: string; originalName: string; source: string; bytes: number; addedAt: string };
export type Registry = Record<string, DemoRecord>;
export type IngestReport = { added: DemoRecord[]; duplicates: string[]; rejected: { name: string; reason: string }[]; waiting: string[] };

export const readRegistry = (): Registry => (existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, "utf8")) : {});
function writeRegistry(r: Registry) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${REGISTRY}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  renameSync(tmp, REGISTRY);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sameFile = (a: Stats, b: Stats) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
const isCs2Demo = (file: string) => {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(8); readSync(fd, b, 0, 8, 0); return b.toString("latin1") === "PBDEMS2\0"; } finally { closeSync(fd); }
};
/** A free name in dir for base (adds -1, -2, … if taken). */
function freePath(dir: string, base: string) {
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(base);
  let p = path.join(dir, base);
  for (let i = 1; existsSync(p); i++) p = path.join(dir, `${path.basename(base, ext)}-${i}${ext}`);
  return p;
}
function reject(file: string, reason: string, report: IngestReport, name = path.basename(file)) {
  const to = freePath(REJECTED, name);
  renameSync(file, to);
  writeFileSync(`${to}.reason.txt`, reason + "\n");
  report.rejected.push({ name, reason });
}
let scratchSeq = 0;
/** Scratch names never derive from archive member names. */
const scratch = () => { mkdirSync(WORK, { recursive: true }); return path.join(WORK, `${process.pid}-${Date.now()}-${scratchSeq++}.dem`); };

/** Writes into a file, refusing to go past `limit` bytes (seek-bzip output stream). */
class BoundedFileOut {
  private fd: number;
  private buf = Buffer.alloc(1 << 20);
  private n = 0;
  written = 0;
  constructor(readonly file: string, readonly limit: number) { this.fd = openSync(file, "w"); }
  writeByte(b: number) {
    if (++this.written > this.limit) throw new Error("unpacks to more than the demo size limit");
    this.buf[this.n++] = b;
    if (this.n === this.buf.length) this.flush();
  }
  write(buffer: Uint8Array, off: number, len: number) { for (let i = 0; i < len; i++) this.writeByte(buffer[off + i]); return len; }
  flush() { if (this.n) { writeSync(this.fd, this.buf, 0, this.n); this.n = 0; } }
  close() { this.flush(); closeSync(this.fd); }
}

/** Zip members that are demos, within the limits; throws on anything outside them. */
function zipMembers(archive: string): string[] {
  const out = execFileSync(TAR, ["-tvf", archive], { encoding: "utf8", maxBuffer: 1 << 24, timeout: 60_000 });
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/);
    if (!m) throw new Error(`unreadable archive listing line: ${l}`);
    return { size: Number(m[1]), name: m[2] };
  });
  if (rows.length > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has ${rows.length} entries (limit ${MAX_ARCHIVE_ENTRIES})`);
  if (rows.reduce((s, r) => s + r.size, 0) > MAX_ARCHIVE_TOTAL) throw new Error("archive unpacks to more than the size limit");
  const dems = rows.filter((r) => r.name.toLowerCase().endsWith(".dem"));
  if (!dems.length) throw new Error("archive contains no .dem file");
  const names = new Set<string>();
  for (const r of dems) {
    // Member names go to tar as literal paths: no traversal, no wildcards, no option-like or duplicate names.
    if (r.name.split(/[\\/]/).includes("..") || path.isAbsolute(r.name) || /^[-/\\]|[*?[\]\\:]/.test(r.name)) throw new Error(`unsafe name in archive: ${r.name}`);
    if (names.has(r.name)) throw new Error(`duplicate name in archive: ${r.name}`);
    names.add(r.name);
    if (r.size > MAX_DEM_BYTES) throw new Error(`${r.name} is larger than the demo size limit`);
  }
  return [...names];
}

/** Unpack one inbox file into .dem files under WORK (or the file itself for a bare .dem). */
function unpack(file: string): string[] {
  const lower = file.toLowerCase();
  const size = statSync(file).size;
  if (lower.endsWith(".dem")) {
    if (size > MAX_DEM_BYTES) throw new Error("larger than the demo size limit");
    return [file];
  }
  if (size > MAX_INPUT_BYTES) throw new Error("larger than the input size limit");
  if (lower.endsWith(".zip")) {
    const outs: string[] = [];
    try {
      for (const member of zipMembers(file)) {
        const out = scratch();
        outs.push(out);
        // maxBuffer bounds the output whatever the listing claimed; "--" ends the options.
        writeFileSync(out, execFileSync(TAR, ["-xOf", file, "--", member], { maxBuffer: MAX_DEM_BYTES, timeout: 600_000 }));
      }
    } catch (e) {
      for (const o of outs) rmSync(o, { force: true });
      throw e;
    }
    return outs;
  }
  if (!/\.(bz2|gz|zst)$/.test(lower)) throw new Error("not a demo or a supported archive (.dem, .zip, .bz2, .gz, .zst)");
  const out = scratch();
  try {
    if (lower.endsWith(".bz2")) {
      const w = new BoundedFileOut(out, MAX_DEM_BYTES);
      try { Bunzip.decode(readFileSync(file), w); } finally { w.close(); }
    } else if (lower.endsWith(".gz")) writeFileSync(out, zlib.gunzipSync(readFileSync(file), { maxOutputLength: MAX_DEM_BYTES }));
    else writeFileSync(out, zlib.zstdDecompressSync(readFileSync(file), { maxOutputLength: MAX_DEM_BYTES }));
  } catch (e) {
    rmSync(out, { force: true }); // our own partial scratch output, not the user's file
    throw e;
  }
  return [out];
}

/** Store files without a registry entry: a run died between the move and the commit. */
async function reconcileStore(registry: Registry, report: IngestReport) {
  if (!existsSync(STORE)) return;
  for (const n of readdirSync(STORE)) {
    const m = n.match(/^([0-9a-f]{64})\.dem$/);
    if (!m || registry[m[1]]) continue;
    const file = path.join(STORE, n);
    if ((await sha256File(file)) !== m[1]) { reject(file, "store file does not match its hash", report); continue; }
    registry[m[1]] = { sha256: m[1], file, originalName: n, source: "store (recovered)", bytes: statSync(file).size, addedAt: new Date().toISOString() };
    report.added.push(registry[m[1]]);
    writeRegistry(registry);
  }
}

export async function ingest(): Promise<IngestReport> {
  mkdirSync(INBOX, { recursive: true });
  for (const s of SOURCES) await s.fetch(INBOX);
  const report: IngestReport = { added: [], duplicates: [], rejected: [], waiting: [] };
  const registry = readRegistry();
  await reconcileStore(registry, report);
  const list = () => readdirSync(INBOX).filter((n) => !PARTIAL.test(n) && statSync(path.join(INBOX, n)).isFile());
  const first = new Map(list().map((n) => [n, statSync(path.join(INBOX, n))]));
  if (!first.size) return report;
  await sleep(STABLE_MS);
  for (const [n, s0] of first) {
    const file = path.join(INBOX, n);
    const s1 = existsSync(file) ? statSync(file) : undefined;
    if (!s1 || !sameFile(s0, s1)) { report.waiting.push(n); continue; }
    let dems: string[];
    try { dems = unpack(file); } catch (e) {
      // A file that changed while being unpacked is still being written: next run.
      if (!existsSync(file) || !sameFile(s1, statSync(file))) { report.waiting.push(n); continue; }
      reject(file, (e as Error).message, report);
      continue;
    }
    // Read everything first, then re-check: if the original changed meanwhile it
    // is still being written, and nothing is rejected or stored on its account.
    const checked = dems.map((dem) => ({ dem, ok: isCs2Demo(dem) }));
    const hashed: { dem: string; sha256: string }[] = [];
    for (const c of checked) if (c.ok) hashed.push({ dem: c.dem, sha256: await sha256File(c.dem) });
    if (!existsSync(file) || !sameFile(s1, statSync(file))) {
      for (const d of dems) if (d !== file) rmSync(d, { force: true }); // scratch copies of a moving target
      report.waiting.push(n);
      continue;
    }
    for (const c of checked) if (!c.ok) reject(c.dem, "not a CS2 demo (no PBDEMS2 header)", report, c.dem === file ? n : `${n}.dem`);
    for (const { dem, sha256 } of hashed) {
      if (registry[sha256] && existsSync(registry[sha256].file)) {
        report.duplicates.push(n);
        if (dem !== file) renameSync(dem, freePath(REJECTED, `${sha256}.duplicate.dem`));
        continue;
      }
      const stored = path.join(STORE, `${sha256}.dem`);
      mkdirSync(STORE, { recursive: true });
      renameSync(dem, stored); // a bare .dem moves too: the store copy is the demo from now on
      registry[sha256] = { sha256, file: stored, originalName: n, source: "inbox", bytes: statSync(stored).size, addedAt: new Date().toISOString() };
      writeRegistry(registry);
      report.added.push(registry[sha256]);
    }
    if (existsSync(file)) renameSync(file, freePath(INGESTED, n)); // the archive, or a duplicate's original
  }
  return report;
}
