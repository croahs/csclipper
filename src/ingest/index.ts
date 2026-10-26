// Ingest (PLAN.md §1, watch-folder baseline): files dropped into demos/inbox/
// by hand or by a source (pnpm grab, sources.ts) are taken here. Ingest
// waits until a file has stopped growing, unpacks archives with name, count
// and size limits enforced while unpacking, checks the result is a complete CS2
// demo (header and DEM_FileInfo, parse/fileinfo.ts),
// hashes it, moves it to demos/store/<sha256>.dem and registers it in state/demos.json (committed after each demo).
// The store copy is the demo from then on: the file it arrived in (an archive, or a
// duplicate of a stored demo) is deleted once its content is registered, or kept in
// demos/ingested/ with config.json → ingest.keepOriginals. Anything unusable goes to
// demos/rejected/ with a .reason.txt beside it and is never deleted. A store file that is not in the
// registry (a run died between the move and the commit) is registered on the
// next run. Registry paths are stored relative to the repo root (state-paths.ts) and resolved
// on read; entries from before that rule are rewritten once. Producers must write under a temporary name (a leading dot, or
// .part / .tmp / .crdownload) and rename into place when done; such names are
// ignored. The stable-size wait and the re-checks below catch most writers
// that do not, but only the rename guarantees the stored bytes match the hash.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT, STATE_DIR, loadIngest } from "../config.ts";
import { sha256File } from "../parse/clip-facts.ts";
import { demoIncomplete } from "../parse/fileinfo.ts";
import { toStored } from "../state-paths.ts";

const require = createRequire(import.meta.url);
const Bunzip = require("seek-bzip");

export const DEMOS_DIR = path.join(ROOT, "demos");
export const INBOX = path.join(DEMOS_DIR, "inbox");
const REGISTRY = path.join(STATE_DIR, "demos.json");

/** The folders ingest works in: the repo's by default, a temp root in tests. */
type Dirs = { root: string; inbox: string; store: string; ingested: string; rejected: string; work: string; registry: string };
const dirsOf = (root = ROOT): Dirs => {
  const demos = path.join(root, "demos");
  return { root, inbox: path.join(demos, "inbox"), store: path.join(demos, "store"), ingested: path.join(demos, "ingested"), rejected: path.join(demos, "rejected"), work: path.join(demos, ".unpack"), registry: path.join(root, "state", "demos.json") };
};

const STABLE_MS = 2000; // a file must keep its size and mtime this long
const MAX_DEM_BYTES = 2 * 1024 ** 3; // one demo, bare or unpacked
const MAX_INPUT_BYTES = 2 * 1024 ** 3; // one compressed file read into memory
const MAX_ARCHIVE_ENTRIES = 20;
const MAX_ARCHIVE_TOTAL = 6 * 1024 ** 3;
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"); // bsdtar: reads zip
const PARTIAL = /^\.|\.(part|tmp|crdownload)$/i;

export type DemoRecord = { sha256: string; file: string; originalName: string; source: string; bytes: number; addedAt: string };
export type Registry = Record<string, DemoRecord>;
/** rewritten: registry entries whose stored path was brought into the relative form (a one-time migration). */
export type IngestReport = { added: DemoRecord[]; duplicates: string[]; rejected: { name: string; reason: string }[]; waiting: string[]; rewritten: number };

const readRaw = (file: string): Registry => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
/**
 * A record's file as this checkout sees it: a relative path under the root; an absolute one as it
 * is while it exists, else this root's store/<sha>.dem (the one place ingest ever puts a demo),
 * never a tail match that could pick a stranger's file (state-paths.ts).
 */
const demoPath = (rec: DemoRecord, root: string) =>
  !path.isAbsolute(rec.file) ? path.resolve(root, rec.file) : existsSync(rec.file) ? rec.file : path.join(root, "demos", "store", `${rec.sha256}.dem`);
/** The registry with every `file` resolved for this checkout (on disk they are relative to the root, state-paths.ts). */
export function readRegistry(file = REGISTRY, root = ROOT): Registry {
  const r = readRaw(file);
  for (const rec of Object.values(r)) rec.file = demoPath(rec, root);
  return r;
}
function writeRegistry(file: string, r: Registry, root = ROOT) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const stored = Object.fromEntries(Object.entries(r).map(([k, rec]) => [k, { ...rec, file: toStored(rec.file, root) }]));
  writeFileSync(tmp, JSON.stringify(stored, null, 2) + "\n");
  renameSync(tmp, file);
}
/**
 * Entries written before paths were stored relative (absolute, and 49 of them in a folder this
 * repo had left on 2026-10-26) are rewritten once, in the stored form; returns how many. An
 * absolute path that still exists outside the root is not an old entry and stays as it is.
 */
function normalizeRegistry(file: string, root: string): number {
  const raw = readRaw(file);
  const changed = Object.values(raw).filter((rec) => toStored(demoPath(rec, root), root) !== rec.file);
  if (changed.length) writeRegistry(file, readRegistry(file, root), root);
  return changed.length;
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
function reject(d: Dirs, file: string, reason: string, report: IngestReport, name = path.basename(file)) {
  const to = freePath(d.rejected, name);
  renameSync(file, to);
  writeFileSync(`${to}.reason.txt`, reason + "\n");
  report.rejected.push({ name, reason });
}
let scratchSeq = 0;
/** Scratch names never derive from archive member names. */
const scratch = (d: Dirs) => { mkdirSync(d.work, { recursive: true }); return path.join(d.work, `${process.pid}-${Date.now()}-${scratchSeq++}.dem`); };

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

/** Zip members that are demos, within the limits, and whether the zip holds other files too; throws on anything outside the limits. */
function zipMembers(archive: string): { dems: string[]; others: boolean } {
  const out = execFileSync(TAR, ["-tvf", archive], { encoding: "utf8", maxBuffer: 1 << 24, timeout: 60_000 });
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/);
    if (!m) throw new Error(`unreadable archive listing line: ${l}`);
    return { dir: m[1].startsWith("d"), size: Number(m[2]), name: m[3] };
  });
  if (rows.length > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has ${rows.length} entries (limit ${MAX_ARCHIVE_ENTRIES})`);
  if (rows.reduce((s, r) => s + r.size, 0) > MAX_ARCHIVE_TOTAL) throw new Error("archive unpacks to more than the size limit");
  const files = rows.filter((r) => !r.dir); // a folder entry is not a file the zip is the only copy of
  const dems = files.filter((r) => r.name.toLowerCase().endsWith(".dem"));
  if (!dems.length) throw new Error("archive contains no .dem file");
  const names = new Set<string>();
  for (const r of dems) {
    // Member names go to tar as literal paths: no traversal, no wildcards, no option-like or duplicate names.
    if (r.name.split(/[\\/]/).includes("..") || path.isAbsolute(r.name) || /^[-/\\]|[*?[\]\\:]/.test(r.name)) throw new Error(`unsafe name in archive: ${r.name}`);
    if (names.has(r.name)) throw new Error(`duplicate name in archive: ${r.name}`);
    names.add(r.name);
    if (r.size > MAX_DEM_BYTES) throw new Error(`${r.name} is larger than the demo size limit`);
  }
  return { dems: [...names], others: dems.length < files.length };
}

/**
 * Unpack one inbox file into .dem files under the work dir (or the file itself for a bare .dem).
 * `others`: the archive holds files that are not demos (a zip with a notes.txt beside the demo),
 * which ingest never unpacks, so such an archive is kept, not deleted.
 */
function unpack(d: Dirs, file: string): { dems: string[]; others: boolean } {
  const lower = file.toLowerCase();
  const size = statSync(file).size;
  if (lower.endsWith(".dem")) {
    if (size > MAX_DEM_BYTES) throw new Error("larger than the demo size limit");
    return { dems: [file], others: false };
  }
  if (size > MAX_INPUT_BYTES) throw new Error("larger than the input size limit");
  if (lower.endsWith(".zip")) {
    const outs: string[] = [];
    const members = zipMembers(file);
    try {
      for (const member of members.dems) {
        const out = scratch(d);
        outs.push(out);
        // maxBuffer bounds the output whatever the listing claimed; "--" ends the options.
        writeFileSync(out, execFileSync(TAR, ["-xOf", file, "--", member], { maxBuffer: MAX_DEM_BYTES, timeout: 600_000 }));
      }
    } catch (e) {
      for (const o of outs) rmSync(o, { force: true });
      throw e;
    }
    return { dems: outs, others: members.others };
  }
  if (!/\.(bz2|gz|zst)$/.test(lower)) throw new Error("not a demo or a supported archive (.dem, .zip, .bz2, .gz, .zst)");
  const out = scratch(d);
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
  return { dems: [out], others: false };
}

/** Store files without a registry entry: a run died between the move and the commit. */
async function reconcileStore(d: Dirs, registry: Registry, report: IngestReport) {
  if (!existsSync(d.store)) return;
  for (const n of readdirSync(d.store)) {
    const m = n.match(/^([0-9a-f]{64})\.dem$/);
    if (!m || registry[m[1]]) continue;
    const file = path.join(d.store, n);
    if ((await sha256File(file)) !== m[1]) { reject(d, file, "store file does not match its hash", report); continue; }
    registry[m[1]] = { sha256: m[1], file, originalName: n, source: "store (recovered)", bytes: statSync(file).size, addedAt: new Date().toISOString() };
    report.added.push(registry[m[1]]);
    writeRegistry(d.registry, registry, d.root);
  }
}

/** root: another tree than the repo (tests); keepOriginals: config.json → ingest.keepOriginals when not given. */
export type IngestOptions = { root?: string; keepOriginals?: boolean };

export async function ingest(o: IngestOptions = {}): Promise<IngestReport> {
  const d = dirsOf(o.root);
  const keep = o.keepOriginals ?? loadIngest().keepOriginals;
  mkdirSync(d.inbox, { recursive: true });
  const report: IngestReport = { added: [], duplicates: [], rejected: [], waiting: [], rewritten: normalizeRegistry(d.registry, d.root) };
  const registry = readRegistry(d.registry, d.root);
  await reconcileStore(d, registry, report);
  const list = () => readdirSync(d.inbox).filter((n) => !PARTIAL.test(n) && statSync(path.join(d.inbox, n)).isFile());
  const first = new Map(list().map((n) => [n, statSync(path.join(d.inbox, n))]));
  if (!first.size) return report;
  await sleep(STABLE_MS);
  for (const [n, s0] of first) {
    const file = path.join(d.inbox, n);
    const s1 = existsSync(file) ? statSync(file) : undefined;
    if (!s1 || !sameFile(s0, s1)) { report.waiting.push(n); continue; }
    let dems: string[];
    let others: boolean;
    try { ({ dems, others } = unpack(d, file)); } catch (e) {
      // A file that changed while being unpacked is still being written: next run.
      if (!existsSync(file) || !sameFile(s1, statSync(file))) { report.waiting.push(n); continue; }
      reject(d, file, (e as Error).message, report);
      continue;
    }
    // Read everything first, then re-check: if the original changed meanwhile it
    // is still being written, and nothing is rejected or stored on its account.
    // A bare .dem and every .dem unpacked from an archive: a CS2 header and a valid DEM_FileInfo
    // (a cut-short or half-written demo fails the second).
    const checked = dems.map((dem) => {
      if (!isCs2Demo(dem)) return { dem, ok: false, reason: "not a CS2 demo (no PBDEMS2 header)" };
      const why = demoIncomplete(dem);
      return why ? { dem, ok: false, reason: `incomplete demo (${why})` } : { dem, ok: true, reason: "" };
    });
    const hashed: { dem: string; sha256: string }[] = [];
    for (const c of checked) if (c.ok) hashed.push({ dem: c.dem, sha256: await sha256File(c.dem) });
    if (!existsSync(file) || !sameFile(s1, statSync(file))) {
      for (const x of dems) if (x !== file) rmSync(x, { force: true }); // scratch copies of a moving target
      report.waiting.push(n);
      continue;
    }
    for (const c of checked) if (!c.ok) reject(d, c.dem, c.reason, report, c.dem === file ? n : `${n}.dem`);
    for (const { dem, sha256 } of hashed) {
      if (registry[sha256] && existsSync(registry[sha256].file)) {
        report.duplicates.push(n);
        if (dem !== file) rmSync(dem, { force: true }); // our scratch copy of a demo the store holds
        continue;
      }
      const stored = path.join(d.store, `${sha256}.dem`);
      mkdirSync(d.store, { recursive: true });
      renameSync(dem, stored); // a bare .dem moves too: the store copy is the demo from now on
      registry[sha256] = { sha256, file: stored, originalName: n, source: "inbox", bytes: statSync(stored).size, addedAt: new Date().toISOString() };
      writeRegistry(d.registry, registry, d.root);
      report.added.push(registry[sha256]);
    }
    // What is left in the inbox is the archive, or a duplicate's own file: its content is in the
    // store and registered (above), so it goes, unless originals are kept or the archive holds
    // files that are not demos (never unpacked, so the archive is their only copy). An archive one
    // of whose members was rejected is bad input and stays beside that member in rejected/.
    if (existsSync(file)) {
      if (checked.some((c) => !c.ok)) renameSync(file, freePath(d.rejected, n));
      else if (keep || others) renameSync(file, freePath(d.ingested, n));
      else rmSync(file);
    }
  }
  return report;
}
