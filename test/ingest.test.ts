// Ingest (src/ingest/index.ts) on a temp root: the file a demo arrived in is deleted once the
// store holds its content, or kept in demos/ingested/ with keepOriginals; bad input stays in
// rejected/. Each run waits 2 s for the inbox to settle, so the cases share runs.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ingest, readRegistry } from "../src/ingest/index.ts";
import { demoBytes, truncatedDemo } from "./demo-bytes.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "croclip-ingest-"));
  const inbox = path.join(root, "demos", "inbox");
  mkdirSync(inbox, { recursive: true });
  const put = (name: string, data: Buffer) => writeFileSync(path.join(inbox, name), data);
  const ls = (sub: string) => { const d = path.join(root, "demos", sub); return existsSync(d) ? readdirSync(d).sort() : []; };
  return { root, put, ls };
}

test("archives and duplicates are deleted once the store holds their content; bad input stays in rejected/", async () => {
  const { root, put, ls } = setup();
  put("1-aaa-1-1.dem", demoBytes(1));
  put("1-bbb-1-1.dem.zst", zlib.zstdCompressSync(demoBytes(2)));
  put("1-ccc-1-1.dem.gz", zlib.gzipSync(demoBytes(3)));
  put("1-aaa-again.dem.zst", zlib.zstdCompressSync(demoBytes(1))); // the same demo as the bare one
  put("short.dem.zst", zlib.zstdCompressSync(truncatedDemo(4)));
  put("notes.txt", Buffer.from("hello"));
  const r = await ingest({ root, keepOriginals: false });
  assert.deepEqual(r.added.map((a) => a.originalName).sort(), ["1-aaa-1-1.dem", "1-bbb-1-1.dem.zst", "1-ccc-1-1.dem.gz"]);
  assert.deepEqual(r.duplicates, ["1-aaa-again.dem.zst"]);
  assert.deepEqual(r.rejected.map((x) => x.name).sort(), ["notes.txt", "short.dem.zst.dem"]);
  assert.deepEqual(ls("store"), [sha(demoBytes(1)), sha(demoBytes(2)), sha(demoBytes(3))].sort().map((h) => `${h}.dem`));
  assert.deepEqual(ls("inbox"), []);
  assert.deepEqual(ls("ingested"), []);
  // The bad archive beside its unpacked member, each rejection with its reason; no duplicate copies.
  assert.deepEqual(ls("rejected"), ["notes.txt", "notes.txt.reason.txt", "short.dem.zst", "short.dem.zst.dem", "short.dem.zst.dem.reason.txt"]);
  assert.deepEqual(ls(".unpack"), []);
  assert.equal(Object.keys(readRegistry(path.join(root, "state", "demos.json"))).length, 3);
});

test("a zip of demos only is deleted; a zip that also holds other files is kept in ingested/, since those were never unpacked", async () => {
  const { root, put, ls } = setup();
  const src = path.join(root, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "a.dem"), demoBytes(5));
  writeFileSync(path.join(src, "b.dem"), demoBytes(6));
  writeFileSync(path.join(src, "notes.txt"), "scrim notes");
  mkdirSync(path.join(src, "sub"));
  writeFileSync(path.join(src, "sub", "c.dem"), demoBytes(7));
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-cf", path.join(root, "demos.zip"), "-C", src, "a.dem", "b.dem"]);
  execFileSync(tar, ["-a", "-cf", path.join(root, "folder.zip"), "-C", src, "sub"]); // a folder entry plus the demo in it
  execFileSync(tar, ["-a", "-cf", path.join(root, "mixed.zip"), "-C", src, "a.dem", "notes.txt"]);
  for (const z of ["demos.zip", "folder.zip", "mixed.zip"]) put(z, readFileSync(path.join(root, z)));
  const r = await ingest({ root, keepOriginals: false });
  assert.deepEqual(r.added.map((a) => a.originalName).sort(), ["demos.zip", "demos.zip", "folder.zip"]);
  assert.deepEqual(r.duplicates, ["mixed.zip"]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(ls("store"), [sha(demoBytes(5)), sha(demoBytes(6)), sha(demoBytes(7))].sort().map((h) => `${h}.dem`));
  assert.deepEqual(ls("inbox"), []);
  assert.deepEqual(ls("ingested"), ["mixed.zip"]);
});

test("keepOriginals moves archives and duplicates to ingested/ instead", async () => {
  const { root, put, ls } = setup();
  put("1-bbb-1-1.dem.zst", zlib.zstdCompressSync(demoBytes(2)));
  put("1-bbb-copy.dem", demoBytes(2));
  const r = await ingest({ root, keepOriginals: true });
  assert.equal(r.added.length + r.duplicates.length, 2);
  assert.deepEqual(ls("store"), [`${sha(demoBytes(2))}.dem`]);
  assert.deepEqual(ls("inbox"), []);
  // The archive, and the bare duplicate (the store already had its bytes).
  assert.deepEqual(ls("ingested"), ["1-bbb-1-1.dem.zst", "1-bbb-copy.dem"]);
});
