// The library page's deep link: #clip=<no> or #clip=<no>&t=<seconds> (the death map links here).
// page.ts inlines this function's own source into the page, so it is written for that: one plain
// function, no nested functions or imports (tsx would wrap those in a helper the page lacks).
// test/deeplink.test.ts runs the inlined text itself.

/** { no, t } from a location hash; null when it names no clip. A t that is not a number >= 0 is left out. */
export function parseClipHash(hash: string): { no: number; t?: number } | null {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const clip = params.get("clip");
  if (clip === null || !/^\d+$/.test(clip) || Number(clip) < 1) return null;
  const out: { no: number; t?: number } = { no: Number(clip) };
  const t = params.get("t");
  if (t !== null && /^\d+(\.\d+)?$/.test(t.trim())) out.t = Number(t);
  return out;
}
