// pnpm go --film's bloopers in the batch and the library: the overlap pick, the blooper id, held by
// id (deleted too), the page's blooper feats and Player list, the page data of a library without film
// entries, pnpm unsettle refs, and the review fixes (the spotted mask, parseAnyPov
// past an absent player). Fake SteamID64s only; no demo, no launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { blooperClip, blooperId, pickBloopers, type Blooper } from "../src/film/bloopers.ts";
import { povKey } from "../src/config.ts";
import { type ClipEntry } from "../src/library/index.ts";
import { BLOOPER_FEATS, FEATS, featsOf, playersOf, weaponsOf } from "../src/library/facets.ts";
import { pageData } from "../src/library/page.ts";
import { matchDateOf } from "../src/library/match-date.ts";
import { shareCaption } from "../src/share/caption.ts";
import { heldEntry } from "../src/queue/job.ts";
import { demoOfRef } from "../src/queue/index.ts";
import { hasSpotter, parseAnyPov } from "../src/film/track.ts";
import { PovAbsent } from "../src/parse/demo.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAIN = "76561198000000001", A = "76561198000000003";
const SHA = "ab".repeat(32), SHA2 = "cd".repeat(32);

const blooper = (o: Partial<Blooper>): Blooper => ({
  type: "teamkill", steamid: MAIN, name: "me", round: 3, tick: 5000, startTick: 4600, endTick: 5200, score: 70,
  title: "me · de_test · R3 · teamkill on x (AK-47)", detail: {}, ...o,
});

test("bloopers: below the bar dropped; of one player's overlapping, the higher score stays", () => {
  const found = [
    blooper({ type: "spray", tick: 5000, startTick: 4600, endTick: 5300, score: 60 }),
    blooper({ type: "behind", tick: 5100, startTick: 5200, endTick: 5800, score: 80 }), // overlaps the spray
    blooper({ type: "teamkill", tick: 9000, startTick: 8600, endTick: 9200, score: 55 }), // apart
    blooper({ type: "selfkill", tick: 9100, startTick: 8700, endTick: 9300, score: 40 }), // overlaps, but under the bar
    blooper({ steamid: A, type: "spray", tick: 5000, startTick: 4600, endTick: 5300, score: 65 }), // another player: kept
  ];
  const kept = pickBloopers(found, 50);
  assert.deepEqual(kept.map((b) => `${b.steamid === A ? "A" : "M"}:${b.type}`), ["M:behind", "A:spray", "M:teamkill"]);
  // Touching ends are not an overlap; a tie keeps the earlier anchor.
  const touch = pickBloopers([blooper({ startTick: 100, endTick: 200, tick: 150 }), blooper({ type: "spray", startTick: 200, endTick: 300, tick: 250 })], 50);
  assert.equal(touch.length, 2);
  const tie = pickBloopers([blooper({ type: "spray", tick: 260, startTick: 100, endTick: 300 }), blooper({ type: "behind", tick: 150, startTick: 120, endTick: 280 })], 50);
  assert.deepEqual(tie.map((b) => b.type), ["behind"]);
});

test("blooper id: from the event, stable under a span change, different per player and type", () => {
  const key = povKey(A);
  const a = blooperId(SHA, "teamkill", 5000, key);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(blooperClip(blooper({ steamid: A, startTick: 4000, endTick: 5500 }), SHA, key).id, a, "span left out");
  assert.equal(blooperClip(blooper({ steamid: A, startTick: 4700, endTick: 5100, score: 90 }), SHA, key).id, a, "score left out");
  assert.notEqual(blooperId(SHA, "teamkill", 5000), a, "the main POV (no key) differs");
  assert.notEqual(blooperId(SHA, "teamkill", 5000, povKey("76561198000000004")), a, "another player differs");
  assert.notEqual(blooperId(SHA, "spray", 5000, key), a, "another type differs");
  assert.notEqual(blooperId(SHA, "teamkill", 5016, key), a, "another anchor differs");
  // The documented formula, with an empty key for STEAM_ID64.
  assert.equal(blooperId(SHA, "selfkill", 77), createHash("sha256").update(`${SHA}:blooper:selfkill:77:`).digest("hex").slice(0, 16));
});

const entry = (o: Partial<ClipEntry>): ClipEntry => ({
  id: "x", no: 1, file: "clips/x.mp4", title: "de_test · R3 · 3k AK-47", map: "de_test", demo: "d.dem", demoSha256: SHA, round: 3,
  startTick: 100, endTick: 900, seconds: 10, frames: 600, createdAt: "2026-11-01T10:00:00.000Z", renderKey: "k", render: {}, ...o,
});

test("blooper held: its id in the index or among the deleted, whatever the span", () => {
  const id = blooperId(SHA, "spray", 5000, povKey(A));
  const held = entry({ id, kind: "blooper", startTick: 1, endTick: 2, blooper: { type: "spray", score: 70, detail: {} }, player: { name: "a", key: povKey(A) } });
  assert.equal(heldEntry({ [id]: held }, id, SHA, 3)?.id, id);
  assert.equal(heldEntry({ [id]: { ...held, deletedAt: "now" } as ClipEntry }, id, SHA, 3)?.id, id, "deleted counts as held (inLibrary merges state/deleted.json)");
  assert.equal(heldEntry({ [id]: held }, blooperId(SHA, "spray", 5000), SHA, 3), undefined, "the main POV's blooper at the same tick is another clip");
  assert.equal(heldEntry({}, id, SHA, 3), undefined);
});

test("facets: a blooper's type is its feat; the Player list names each key by its newest entry, Me first", () => {
  assert.deepEqual(BLOOPER_FEATS.map((f) => f[1]), ["Teamkill", "Own grenade / fall", "Spray, no kill", "Behind, no kill"]);
  const ka = povKey(A), kb = povKey("76561198000000004");
  assert.deepEqual(playersOf([entry({})]), [], "no player anywhere: no list, no group");
  assert.deepEqual(playersOf([
    entry({ player: { key: ka, name: "old name" }, createdAt: "2026-11-01T00:00:00.000Z" }),
    entry({ player: { key: ka, name: "new name" }, createdAt: "2026-11-05T00:00:00.000Z" }),
    entry({ player: { key: ka, name: "older" }, createdAt: "2026-10-01T00:00:00.000Z" }),
    entry({ player: { key: kb, name: "Bodil" } }),
  ]), [{ key: "me", name: "Me" }, { key: kb, name: "Bodil" }, { key: ka, name: "new name" }]);
  const d = pageData([
    entry({ id: "b", no: 2, kind: "blooper", title: "Bodil · de_test · R3 · 30 bullets, no kill", blooper: { type: "spray", score: 64, detail: { bullets: 30 } }, player: { key: kb, name: "Bodil" } }),
    entry({ id: "h", no: 1, moment: { score: 80, kills: 3 } }),
  ], {}, {}, []);
  const b = d.clips.find((c) => c.id === "b")!;
  assert.deepEqual([b.kind, b.score, b.feats, b.player], ["blooper", 64, ["spray"], kb]);
  assert.equal("player" in d.clips.find((c) => c.id === "h")!, false);
  assert.deepEqual(d.featLabels, [...FEATS, ...BLOOPER_FEATS]);
  assert.deepEqual(d.players, [{ key: "me", name: "Me" }, { key: kb, name: "Bodil" }]);
});

test("page data: a library without any player or blooper gives exactly the data it always did", () => {
  const entries = [
    entry({ id: "h", no: 1, kind: "highlight", moment: { rank: 1, score: 81, kills: 4, flags: ["trade"], weapons: ["ak47", "hegrenade"], clutch: { vs: 2, won: true } } }),
    entry({ id: "r", no: 2, kind: "deaths", title: "de_test · all 7 deaths", reel: { takes: [] } }),
    entry({ id: "o", no: 3, title: "de_test · R5 · ticks 1-2" }), // an old entry: no kind, no moment
  ];
  const registry = { [SHA]: { sha256: SHA, file: "x.dem", originalName: "m.dem", addedAt: "2026-11-01T09:00:00.000Z" } } as never;
  // The mapping as page.ts wrote it before the film mode.
  const before = {
    running: true, hasDeathMap: false,
    clips: entries.map((c) => {
      const m = (c.moment ?? {}) as { rank?: number; score?: number; kills?: number; flags?: string[]; clutch?: { vs: number; won: boolean }; weapons?: string[] };
      const { matchDate, dateFrom } = matchDateOf((registry as Record<string, never>)[c.demoSha256], {});
      return {
        no: c.no, id: c.id, file: c.file, title: c.title, map: c.map, round: c.round, seconds: c.seconds, createdAt: c.createdAt,
        kind: c.kind ?? "highlight", match: c.demoSha256, matchDate, dateFrom,
        rank: m.rank, score: m.score, kills: m.kills, flags: m.flags, clutch: m.clutch,
        caption: shareCaption(c), feats: featsOf(m), weapons: weaponsOf(m),
      };
    }),
    stars: [1], featLabels: FEATS,
  };
  assert.equal(JSON.stringify(pageData(entries, registry, {}, [1, 9], { running: true })), JSON.stringify(before));
});

test("unsettle: a clip number names its demo, a prefix one settled demo", () => {
  assert.equal(demoOfRef(SHA.slice(0, 8), [SHA, SHA2], []), SHA);
  assert.equal(demoOfRef("abab", [SHA, "abab" + "0".repeat(60)], []), undefined, "a prefix matching two demos names none");
  assert.equal(demoOfRef("7", [], [{ no: 7, demoSha256: SHA2 }]), SHA2, "a clip number names its demo");
});

test("spotted mask: an index of 31 or more never reads as spotted (1 << 32 wraps to bit 0)", () => {
  const all = 0x7fffffff; // bits 0-30, the most track.ts stores
  assert.equal(hasSpotter(all, 0), true);
  assert.equal(hasSpotter(all, 30), true);
  assert.equal(hasSpotter(all, 31), false);
  assert.equal(hasSpotter(1, 32), false, "would read bit 0");
  assert.equal(hasSpotter(0b100, 2), true);
  assert.equal(hasSpotter(0b100, 1), false);
});

test("parseAnyPov: an absent player (PovAbsent, whatever its message) moves on to the next; another error stops", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "croc-anypov-"));
  const demo = path.join(dir, "x.dem");
  writeFileSync(demo, "not a demo");
  try {
    const tried: string[] = [];
    const parse = async (_d: string, pov: string) => {
      tried.push(pov);
      if (pov !== "76561198000000005") throw new PovAbsent(`player ${povKey(pov)} not found in this demo's match rounds`);
      return { identity: { steamid: pov } } as never;
    };
    const p = await parseAnyPov(demo, [MAIN, A, "76561198000000005"], MAIN, parse);
    assert.equal((p as { identity: { steamid: string } }).identity.steamid, "76561198000000005");
    assert.deepEqual(tried, [MAIN, A, "76561198000000005"]);
    await assert.rejects(parseAnyPov(demo, [MAIN, A], MAIN, parse), PovAbsent, "none present");
    await assert.rejects(parseAnyPov(demo, [MAIN, A], MAIN, async () => { throw new Error("broken demo"); }), /broken demo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
