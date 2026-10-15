// Watched-folder source: read-only copies into the inbox, deduped by content.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { foldersSource } from "../src/ingest/sources/folders.ts";
import type { SourceContext } from "../src/ingest/sources.ts";

const demo = (fill: number) => Buffer.concat([Buffer.from("PBDEMS2\0", "latin1"), Buffer.alloc(4096, fill)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const OLD = Date.now() / 1000 - 3600; // settled an hour ago

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "croclip-folders-"));
  const watch = path.join(root, "csgo");
  mkdirSync(watch);
  const ctx: SourceContext & { lines: string[] } = { inbox: path.join(root, "inbox"), stateFile: path.join(root, "state", "folders.json"), dryRun: false, log: (l) => ctx.lines.push(l), lines: [] };
  const put = (name: string, data: Buffer | string, mtime = OLD) => { const f = path.join(watch, name); writeFileSync(f, data); utimesSync(f, mtime, mtime); return f; };
  return { watch, ctx, put };
}

test("new demos are copied (temporary name, then renamed); originals untouched", async () => {
  const { watch, ctx, put } = setup();
  const a = put("1-aaa-1-1.dem", demo(1));
  put("1-bbb-1-1.dem.zst", zlib.zstdCompressSync(demo(2)));
  const before = statSync(a);
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set() }).fetch(ctx);
  assert.deepEqual(readdirSync(ctx.inbox).sort(), ["1-aaa-1-1.dem", "1-bbb-1-1.dem.zst"]);
  assert.equal(r.fetched.length, 2);
  assert.deepEqual(readFileSync(a), demo(1));
  assert.equal(statSync(a).mtimeMs, before.mtimeMs);
  assert.deepEqual(readdirSync(watch).sort(), ["1-aaa-1-1.dem", "1-bbb-1-1.dem.zst"]);
});

test("demos already in the store are not copied, raw or compressed", async () => {
  const { watch, ctx, put } = setup();
  put("1-aaa-1-1.dem", demo(1));
  put("1-aaa-copy.dem.zst", zlib.zstdCompressSync(demo(1)));
  put("1-aaa-copy.dem.gz", zlib.gzipSync(demo(1)));
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set([sha(demo(1))]) }).fetch(ctx);
  assert.equal(r.fetched.length, 0);
});

test("the same demo twice in one run is copied once", async () => {
  const { watch, ctx, put } = setup();
  put("1-ccc-1-1.dem.zst", zlib.zstdCompressSync(demo(3)));
  put("1-ccc-1-1(1).dem.zst", zlib.zstdCompressSync(demo(3)));
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set() }).fetch(ctx);
  assert.equal(r.fetched.length, 1);
});

test("a second run copies nothing again; a changed file is looked at again", async () => {
  const { watch, ctx, put } = setup();
  put("1-aaa-1-1.dem", demo(1));
  const src = () => foldersSource({ dirs: [watch], knownHashes: () => new Set() });
  assert.equal((await src().fetch(ctx)).fetched.length, 1);
  assert.equal((await src().fetch(ctx)).fetched.length, 0);
  put("1-aaa-1-1.dem", demo(4), OLD + 60);
  assert.equal((await src().fetch(ctx)).fetched.length, 1);
});

test("a file modified seconds ago waits; zips without a demo and non-CS2 .dem files are left alone", async () => {
  const { watch, ctx, put } = setup();
  put("fresh.dem", demo(5), Date.now() / 1000);
  put("csgo-old.dem", "HL2DEMO\0 something");
  const notes = path.join(watch, "notes.txt"); writeFileSync(notes, "x");
  const r = await foldersSource({ dirs: [watch, path.join(watch, "missing")], knownHashes: () => new Set() }).fetch(ctx);
  assert.equal(r.fetched.length, 0);
  assert.equal(r.pending[0].item, path.join(watch, "fresh.dem"));
  assert.ok(ctx.lines.some((l) => l.includes("does not exist")));
});

test("dry run copies and records nothing", async () => {
  const { watch, ctx, put } = setup();
  put("1-aaa-1-1.dem", demo(1));
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set() }).fetch({ ...ctx, dryRun: true });
  assert.equal(r.fetched.length, 0);
  assert.ok(ctx.lines.some((l) => l.includes("would copy")));
  assert.throws(() => readdirSync(ctx.inbox));
});

test("zips: one with a demo is copied, one without is remembered and left alone", async () => {
  const { watch, ctx } = setup();
  const { execFileSync } = await import("node:child_process");
  const tmp = mkdtempSync(path.join(tmpdir(), "croclip-zip-"));
  writeFileSync(path.join(tmp, "m.dem"), demo(6));
  writeFileSync(path.join(tmp, "readme.txt"), "x");
  const tar = path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-cf", path.join(watch, "with.zip"), "-C", tmp, "m.dem"]);
  execFileSync(tar, ["-a", "-cf", path.join(watch, "without.zip"), "-C", tmp, "readme.txt"]);
  for (const n of ["with.zip", "without.zip"]) utimesSync(path.join(watch, n), OLD, OLD);
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set() }).fetch(ctx);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), ["with.zip"]);
  const seen = JSON.parse(readFileSync(ctx.stateFile, "utf8"));
  assert.equal(Object.values(seen).find((v: any) => v.outcome === "no demo") !== undefined, true);
});

test("a zip that cannot be listed is pending, not remembered", async () => {
  const { watch, ctx, put } = setup();
  put("broken.zip", "not a zip at all");
  const r = await foldersSource({ dirs: [watch], knownHashes: () => new Set() }).fetch(ctx);
  assert.match(r.pending[0]?.reason ?? "", /could not list/);
  assert.throws(() => readFileSync(ctx.stateFile));
});
