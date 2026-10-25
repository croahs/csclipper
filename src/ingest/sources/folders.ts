// Watched-folder source: demos that land in other folders on this machine
// (the FACEIT client's "Watch demo" and manual downloads put them in the CS2
// install's game/csgo/; browsers in ~/Downloads). Read-only: originals are
// never modified, moved or deleted. New files are copied into demos/inbox/
// under a temporary name, then renamed; ingest does the rest.
//
// A file counts as handled once copied (or found to be a demo already in the
// store, or a .zip without a demo); handled files are remembered by path,
// size and mtime in this source's state, so they are not read again. A .dem,
// or the demo inside a .dem.zst / .dem.gz, is hashed first and skipped when
// its content is already in the store; .bz2 and .zip are deduped by ingest.
// A .dem that is not complete (no valid DEM_FileInfo: cut short, or still being
// written) is pending and never remembered, so it is looked at again next run.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import zlib from "node:zlib";
import { sha256File } from "../../parse/clip-facts.ts";
import { demoIncomplete } from "../../parse/fileinfo.ts";
import type { Source, SourceContext, SourceResult } from "../sources.ts";

const NAMES = /\.(dem|dem\.zst|dem\.bz2|dem\.gz|zip)$/i;
/** The largest demo file a source copies into the inbox (ingest's own limit too). */
export const MAX_DEMO_BYTES = 2 * 1024 ** 3;
const MAX_BYTES = MAX_DEMO_BYTES;
const SETTLED_MS = 10_000; // a file modified more recently may still be written
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

type Seen = Record<string, { size: number; mtimeMs: number; outcome: "copied" | "in store" | "no demo" | "too large" }>;
export type FoldersOptions = {
  dirs: string[];
  /** Content hashes already ingested (demos/store). */
  knownHashes: () => Set<string>;
  now?: () => number;
};

const isDemoHeader = (file: string) => {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(8); readSync(fd, b, 0, 8, 0); return b.toString("latin1") === "PBDEMS2\0"; } finally { closeSync(fd); }
};
/** sha256 of the demo inside a .zst / .gz file (streamed, bounded); undefined if it cannot be read. */
function innerSha256(file: string): Promise<string | undefined> {
  const unzip = file.toLowerCase().endsWith(".zst") ? zlib.createZstdDecompress() : zlib.createGunzip();
  const h = createHash("sha256");
  let total = 0;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | undefined) => { if (!settled) { settled = true; src.destroy(); unzip.destroy(); resolve(v); } };
    const src = createReadStream(file);
    unzip.on("data", (c: Buffer) => { total += c.length; if (total > MAX_BYTES) done(undefined); else h.update(c); });
    unzip.on("end", () => done(h.digest("hex")));
    unzip.on("error", () => done(undefined));
    src.on("error", () => done(undefined));
    src.pipe(unzip);
  });
}

/** Whether a zip lists a .dem member (a quick listing; ingest checks the rest). */
// Throws when the zip cannot be listed (locked, still being written): the caller retries next run.
function zipHasDemo(file: string): boolean {
  const out = execFileSync(TAR, ["-tf", file], { encoding: "utf8", maxBuffer: 1 << 22, timeout: 30_000 });
  return out.split(/\r?\n/).some((n) => n.toLowerCase().endsWith(".dem"));
}
function freeName(dir: string, base: string) {
  const ext = base.toLowerCase().match(NAMES)?.[0] ?? "";
  const stem = base.slice(0, base.length - ext.length);
  let n = base;
  for (let i = 1; existsSync(path.join(dir, n)) || existsSync(path.join(dir, `.${n}.part`)); i++) n = `${stem}-${i}${ext}`;
  return n;
}

/**
 * Copy file into the inbox under its own name (a free variant of it): under a temporary name
 * first, then the original re-checked against `was` (size and mtime), then renamed. Returns the
 * inbox path; throws, leaving nothing in the inbox, when the copy fails or the original changed.
 */
export function copyIntoInbox(file: string, inbox: string, was: { size: number; mtimeMs: number }): string {
  mkdirSync(inbox, { recursive: true });
  const final = freeName(inbox, path.basename(file));
  const part = path.join(inbox, `.${final}.part`);
  try {
    copyFileSync(file, part);
    const after = statSync(file);
    if (after.size !== was.size || after.mtimeMs !== was.mtimeMs) throw new Error("changed while being copied; next run");
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, path.join(inbox, final));
  return path.join(inbox, final);
}

export function foldersSource(o: FoldersOptions): Source {
  return {
    name: "folders",
    async fetch(ctx: SourceContext): Promise<SourceResult> {
      const result: SourceResult = { fetched: [], pending: [] };
      const seen: Seen = existsSync(ctx.stateFile) ? JSON.parse(readFileSync(ctx.stateFile, "utf8")) : {};
      const save = () => {
        if (ctx.dryRun) return;
        mkdirSync(path.dirname(ctx.stateFile), { recursive: true });
        const tmp = `${ctx.stateFile}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(seen, null, 2) + "\n");
        renameSync(tmp, ctx.stateFile);
      };
      const known = o.knownHashes();
      const now = (o.now ?? Date.now)();
      for (const dir of o.dirs) {
        if (!existsSync(dir)) { ctx.log(`folders: ${dir} does not exist; skipped`); continue; }
        for (const name of readdirSync(dir)) {
          if (name.startsWith(".") || !NAMES.test(name)) continue;
          const file = path.join(dir, name);
          let s;
          try { s = statSync(file); } catch { continue; }
          if (!s.isFile()) continue;
          const key = path.resolve(file).toLowerCase();
          const prev = seen[key];
          if (prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs) continue; // handled before, unchanged
          if (s.size > MAX_BYTES) { ctx.log(`folders: ${file} is larger than the demo size limit; skipped`); seen[key] = { size: s.size, mtimeMs: s.mtimeMs, outcome: "too large" }; save(); continue; }
          if (now - s.mtimeMs < SETTLED_MS) { result.pending.push({ item: file, reason: "modified in the last few seconds; next run" }); continue; }
          const lower = name.toLowerCase();
          let sha: string | undefined; // the demo's content hash, when it can be read cheaply
          if (lower.endsWith(".dem")) {
            if (!isDemoHeader(file)) continue; // not a CS2 demo (e.g. a CS:GO one): leave it alone
            // Cut short or still being written (a download the game left half-done): not copied, not remembered.
            if (demoIncomplete(file)) { result.pending.push({ item: file, reason: "incomplete or still being written" }); continue; }
            sha = await sha256File(file);
            if (known.has(sha)) { seen[key] = { size: s.size, mtimeMs: s.mtimeMs, outcome: "in store" }; save(); continue; }
          } else if (/\.(zst|gz)$/.test(lower)) {
            // Compressed copies of demos already stored (the same match downloaded twice) are not copied again.
            sha = await innerSha256(file);
            if (sha && known.has(sha)) { seen[key] = { size: s.size, mtimeMs: s.mtimeMs, outcome: "in store" }; save(); continue; }
          } else if (lower.endsWith(".zip")) {
            let has: boolean;
            // A zip that cannot be listed now is tried again next run, not remembered as demo-free.
            try { has = zipHasDemo(file); } catch { result.pending.push({ item: file, reason: "could not list the zip; next run" }); continue; }
            if (!has) { seen[key] = { size: s.size, mtimeMs: s.mtimeMs, outcome: "no demo" }; save(); continue; }
          }
          if (ctx.dryRun) { ctx.log(`folders: would copy ${file}`); continue; }
          // Copy under a temporary name, check the original did not change meanwhile, rename.
          let copied: string;
          try { copied = copyIntoInbox(file, ctx.inbox, s); } catch (e) {
            result.pending.push({ item: file, reason: (e as Error).message });
            continue;
          }
          seen[key] = { size: s.size, mtimeMs: s.mtimeMs, outcome: "copied" };
          if (sha) known.add(sha); // the same demo in another file this run is not copied twice
          save();
          result.fetched.push(copied);
          ctx.log(`folders: copied ${file}`);
        }
      }
      return result;
    },
  };
}
