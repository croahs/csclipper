// The first-full-packet fix (src/ingest/full-packet.ts) on its own: snappy decoding, what it
// leaves alone, and that the inbox file is never rewritten. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixFirstFullPacket, unsnappy } from "../src/ingest/full-packet.ts";
import { demoBytes, demoWithFullPacket } from "./demo-bytes.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "croclip-fp-"));

test("unsnappy: literals and the three copy kinds; a length over the limit or a copy out of range is refused", () => {
  // "abcd" literal, copy-1 (len 4, off 4), copy-2 (len 8, off 8), copy-4 (len 2, off 1) -> 18 bytes
  const block = Buffer.from([18, 3 << 2, ...Buffer.from("abcd"), 0b000_000_01, 4, ((8 - 1) << 2) | 2, 8, 0, ((2 - 1) << 2) | 3, 1, 0, 0, 0]);
  assert.equal(unsnappy(block).toString(), "abcdabcdabcdabcddd");
  assert.throws(() => unsnappy(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x07]), 1024), /over the limit/);
  assert.throws(() => unsnappy(Buffer.from([4, 0b000_000_01, 1])), /out of range/);
});

test("a demo without the tables, or one this does not understand, gets no copy", () => {
  const d = dir();
  const cases: [string, Buffer][] = [
    ["clean", demoWithFullPacket(["userinfo"])],
    ["no full packet", demoBytes(1)],
    ["garbage full packet", (() => { const b = demoWithFullPacket(["instancebaseline"], false); b.fill(0xff, 40, 60); return b; })()],
  ];
  for (const [name, bytes] of cases) {
    const file = path.join(d, `${name}.dem`), out = path.join(d, `${name}.out`);
    writeFileSync(file, bytes);
    assert.deepEqual(fixFirstFullPacket(file, out), [], name);
    assert.equal(existsSync(out), false, name);
  }
});

test("the fix writes a copy and leaves its input untouched", () => {
  const d = dir();
  const bad = demoWithFullPacket(["instancebaseline", "userinfo", "AnimAssetData"]);
  const file = path.join(d, "bad.dem"), out = path.join(d, "bad.out");
  writeFileSync(file, bad);
  assert.deepEqual(fixFirstFullPacket(file, out), ["instancebaseline", "AnimAssetData"]);
  assert.deepEqual(readFileSync(file), bad);
  assert.deepEqual(readFileSync(out), demoWithFullPacket(["userinfo"], false));
});
