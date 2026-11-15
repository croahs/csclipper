// VR copies on the library page: the library/vr/ name parser, the directory reader, and the page
// data's vr key. Pure functions and a temp directory; no library, no FFmpeg, no browser.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pageData } from "../src/library/page.ts";
import type { ClipEntry } from "../src/library/index.ts";
import { readVrFiles, vrFiles, vrPath } from "../src/share/vr.ts";

const SHA = "ab".repeat(32);
const entry = (o: Partial<ClipEntry> & { id: string; no: number }): ClipEntry => ({
  file: `clips/${o.id}.mp4`, title: `de_test · R3 · 2k AK-47`, map: "de_test", demo: "d.dem", demoSha256: SHA, round: 3, startTick: 70000, endTick: 71000,
  seconds: 10, frames: 600, createdAt: "2026-11-12T10:00:00.000Z", renderKey: "k", render: {}, ...o,
});
const reg = { [SHA]: { sha256: SHA, file: "x.dem", originalName: "m.dem", source: "inbox", bytes: 1, addedAt: "2026-11-01T09:00:00.000Z" } };

test("vrFiles: <no>-<slug>_sbs.mp4 names give their clip number", () => {
  assert.deepEqual(vrFiles(["146-de-cache-r6-3k-ak-47-1v3-clutch_sbs.mp4", "251-de-cache-r13-4k-usp-s_sbs.mp4"]),
    { 146: "146-de-cache-r6-3k-ak-47-1v3-clutch_sbs.mp4", 251: "251-de-cache-r13-4k-usp-s_sbs.mp4" });
});

test("vrFiles: a run's temp file and names that do not match are left out", () => {
  assert.deepEqual(vrFiles(["146.1763200000000.tmp.mp4", "146-x_sbs.tmp.mp4", "146-x.mp4", "x-146_sbs.mp4", "146_sbs.mp4", "146-x_sbs.mp4.part", "notes.txt"]), {});
});

test("vrFiles: two files for one number, the last by name wins", () => {
  assert.deepEqual(vrFiles(["7-b_sbs.mp4", "7-a_sbs.mp4"]), { 7: "7-b_sbs.mp4" });
});

test("readVrFiles / vrPath: a missing directory is none; a listed one by clip number", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-vr-"));
  try {
    assert.deepEqual(readVrFiles(path.join(dir, "missing")), {});
    writeFileSync(path.join(dir, "12-de-test-r3_sbs.mp4"), "");
    assert.deepEqual(readVrFiles(dir), { 12: "12-de-test-r3_sbs.mp4" });
    assert.equal(vrPath(12, dir), path.join(dir, "12-de-test-r3_sbs.mp4"));
    assert.equal(vrPath(13, dir), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("page data: vr only when a clip in the index has a copy; a copy of a clip not in the index left out", () => {
  const es = [entry({ id: "a", no: 1 }), entry({ id: "b", no: 2 })];
  assert.equal("vr" in pageData(es, reg, {}, []), false);
  assert.equal("vr" in pageData(es, reg, {}, [], { vr: {} }), false);
  assert.equal("vr" in pageData(es, reg, {}, [], { vr: { 9: "9-x_sbs.mp4" } }), false);
  // Without a copy the data is exactly what it was without the option.
  assert.equal(JSON.stringify(pageData(es, reg, {}, [], { vr: { 9: "9-x_sbs.mp4" } })), JSON.stringify(pageData(es, reg, {}, [])));
  assert.deepEqual(pageData(es, reg, {}, [], { vr: { 2: "2-b_sbs.mp4", 9: "9-x_sbs.mp4" } }).vr, { 2: "2-b_sbs.mp4" });
});
