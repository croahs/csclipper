// The library page's deep link (#clip=<no>&t=<s>): the parser as page.ts inlines it into the page.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClipHash } from "../src/library/hash.ts";
import { hashParserSource } from "../src/library/page.ts";

// The text the page runs, evaluated on its own: no helper from the module system may leak into it.
const inlined = new Function(`return ${hashParserSource()};`)() as typeof parseClipHash;

for (const [name, parse] of [["module", parseClipHash], ["inlined", inlined]] as const) {
  test(`parseClipHash (${name}): a clip, with and without t`, () => {
    assert.deepEqual(parse("#clip=17"), { no: 17 });
    assert.deepEqual(parse("#clip=17&t=12.5"), { no: 17, t: 12.5 });
    assert.deepEqual(parse("clip=17&t=0"), { no: 17, t: 0 });
    assert.deepEqual(parse("#t=3&clip=4"), { no: 4, t: 3 });
  });
  test(`parseClipHash (${name}): a t that is not a number >= 0 is left out`, () => {
    assert.deepEqual(parse("#clip=17&t=-3"), { no: 17 });
    assert.deepEqual(parse("#clip=17&t=abc"), { no: 17 });
    assert.deepEqual(parse("#clip=17&t="), { no: 17 });
    assert.deepEqual(parse("#clip=17&t=1e3"), { no: 17 });
  });
  test(`parseClipHash (${name}): junk and a missing clip are null`, () => {
    for (const h of ["", "#", "#t=5", "#clip=", "#clip=abc", "#clip=0", "#clip=-2", "#clip=1.5", "#foo", "#clip=17x", undefined as unknown as string]) assert.equal(parse(h), null, String(h));
  });
}
