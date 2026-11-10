// Death map data (src/deathmap/): pure building against small synthetic parses with made-up ids.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { buildDeathMap, deathRows, loadDemos, reelOffsets, renderDeathMap, viewScript, weaponGroup, type Sources } from "../src/deathmap/index.ts";
import { DEMOPARSER_VERSION } from "../src/parse/clip-facts.ts";
import { hasPositions, parseIsCurrent } from "../src/parse/demo.ts";
import type { Death, ParsedDemo, Round } from "../src/parse/demo.ts";
import { ALL, cluster, passes, roundsFor, summarize } from "../src/deathmap/view.ts";

const ME = "10000000000000001", MATE = "10000000000000002", E1 = "10000000000000003", E2 = "10000000000000004";
const round = (n: number, me: "CT" | "T", phase: Round["phase"] = "regular"): Round => ({
  n, startTick: n * 1000, freezeEndTick: n * 1000 + 100, endTick: n * 1000 + 900, winner: null, reason: null, phase,
  teams: { [ME]: me, [MATE]: me, [E1]: me === "CT" ? "T" : "CT", [E2]: me === "CT" ? "T" : "CT" }, rosterChanged: false, equip: { T: 0, CT: 0 },
});
const death = (o: Partial<Death> & Pick<Death, "tick" | "round" | "victim">): Death => ({
  attacker: E1, assister: null, weapon: "ak47", headshot: false, penetrated: false, noscope: false, thrusmoke: false, attackerblind: false,
  distance: 10, victimHpBefore: 100, airborne: false, attackerName: "e", victimName: "v", victimPos: [0, 0, 0], attackerPos: [500, 0, 0], ...o,
});
const parse = (rounds: Round[], deaths: Death[], map = "de_test"): ParsedDemo => ({
  schema: 8, key: `${"a".repeat(64)}:demoparser2@${DEMOPARSER_VERSION}:schema8:pov${ME}`, demo: { path: "x.dem", sha256: "a".repeat(64), map, patch: "1", tickrate: 64, playbackTicks: 99999 },
  identity: { steamid: ME, name: "me", userIds: [1] }, matchStartTick: 500, preMatchRounds: 0, rounds, deaths,
  hurts: [], fires: [], bombs: [], blinds: [], flicks: [], footprint: [0, 0, 1, 0],
});

test("weapon class mapping, unknown weapon is other", () => {
  assert.equal(weaponGroup("ak47"), "rifle");
  assert.equal(weaponGroup("awp"), "sniper");
  assert.equal(weaponGroup("ssg08"), "sniper");
  assert.equal(weaponGroup("scar20"), "sniper");
  assert.equal(weaponGroup("mac10"), "smg");
  assert.equal(weaponGroup("deagle"), "pistol");
  assert.equal(weaponGroup("glock"), "pistol");
  assert.equal(weaponGroup("mag7"), "shotgun");
  assert.equal(weaponGroup("hegrenade"), "other");
  assert.equal(weaponGroup("knife_t"), "other");
  assert.equal(weaponGroup("world"), "other");
  assert.equal(weaponGroup("some_new_gun"), "other");
});

test("side at death, facing, opening death, knife round out, suicide/world/team apart", () => {
  const p = parse([round(1, "T", "knife"), round(2, "CT"), round(3, "T"), round(4, "T")], [
    death({ tick: 1500, round: 1, victim: ME }), // knife round: out
    death({ tick: 2200, round: 2, victim: MATE }), // a teammate dies first
    death({ tick: 2300, round: 2, victim: ME, povFacingDeg: 30, headshot: true }), // facing, not opening
    death({ tick: 2950, round: 2, victim: E1, attacker: ME }), // after round end: ignored
    death({ tick: 3100, round: 3, victim: ME, povFacingDeg: 120, weapon: "awp" }), // from behind, opening
    death({ tick: 4100, round: 4, victim: ME, attacker: ME, weapon: "hegrenade" }), // suicide
  ]);
  const { rows, rounds } = deathRows(p, 60, 0);
  assert.deepEqual(rounds, { CT: 1, T: 2 });
  assert.deepEqual(rows.map((r) => [r.r, r.s, r.k, r.f, r.o, r.g]), [
    [2, "CT", "enemy", true, false, "rifle"],
    [3, "T", "enemy", false, true, "sniper"],
    [4, "T", "suicide", null, true, "other"],
  ]);
  assert.equal(rows[2].a, null, "no killer position off the killer analysis");
  const world = deathRows(parse([round(1, "CT")], [death({ tick: 1200, round: 1, victim: ME, attacker: null, weapon: "world" })]), 60, 0).rows[0];
  assert.equal(world.k, "world");
  const team = deathRows(parse([round(1, "CT")], [death({ tick: 1200, round: 1, victim: ME, attacker: MATE })]), 60, 0).rows[0];
  assert.equal(team.k, "team");
  const s = summarize([...rows, world, team], 3);
  assert.equal(s.total, 5);
  assert.equal(s.enemy, 2);
  assert.deepEqual(s.other, { suicide: 1, world: 1, team: 1 });
  assert.equal(s.behind, 1);
  assert.equal(s.hs, 1);
});

test("filters partition: CT + T = all", () => {
  const p = parse([round(1, "CT"), round(2, "T")], [death({ tick: 1200, round: 1, victim: ME }), death({ tick: 2200, round: 2, victim: ME })]);
  const data = buildDeathMap([{ p, date: null, dateFrom: null }], 60);
  const rows = data.maps[0].rows;
  const n = (f: typeof ALL) => rows.filter((x) => passes(x, f)).length;
  assert.equal(n({ ...ALL, side: "CT" }) + n({ ...ALL, side: "T" }), n(ALL));
  assert.equal(roundsFor(data.maps[0].matches, { ...ALL, side: "T" }), 1);
  assert.equal(roundsFor(data.maps[0].matches, ALL), 2);
});

test("clustering: two close killers one spot, a far one another", () => {
  const spots = cluster([[0, 0], [100, 50], [3000, 3000]], 300);
  assert.equal(spots.length, 2);
  assert.deepEqual(spots[0].members, [0, 1]);
  assert.equal(spots[0].x, 50);
  assert.deepEqual(spots[1].members, [2]);
});

test("reel take offsets from the windows; omitted when they do not add up", () => {
  const entry = { seconds: 22, reel: { takes: [{ round: 1, tick: 1000, weapon: "AK-47", player: "a" }, { round: 2, tick: 5000, weapon: "AWP", player: "b" }] },
    render: { windows: [{ startTick: 552, endTick: 1256 }, { startTick: 4552, endTick: 5256 }] } };
  assert.deepEqual([...reelOffsets(entry, 64)!], [[1000, 0], [5000, 11]]);
  assert.equal(reelOffsets({ ...entry, seconds: 40 }, 64), undefined);
  // A death the reel holds no take for (5100) gets no link.
  const p = parse([round(1, "CT"), round(5, "CT")], [death({ tick: 1000, round: 1, victim: ME }), death({ tick: 5000, round: 5, victim: ME }), death({ tick: 5100, round: 5, victim: ME })]);
  const rows = buildDeathMap([{ p, date: null, dateFrom: null, reel: { no: 7, ...entry } }], 60).maps[0].rows;
  assert.deepEqual(rows.map((r) => [r.clip, r.t]), [[7, 0], [7, 11], [undefined, undefined]]);
});

test("the inlined JSON escapes every <, and the inlined view runs as plain script", () => {
  const p = parse([round(1, "CT")], [death({ tick: 1200, round: 1, victim: ME, weapon: "</script><b>" })], "de_</script>");
  const html = renderDeathMap(buildDeathMap([{ p, date: null, dateFrom: null }], 60), "<script>/*__VIEW__*/</script><script>/*__DATA__*/null</script>");
  const data = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.ok(!data.includes("<"));
  assert.equal(JSON.parse(data).maps[0].map, "de_</script>");
  const ctx = vm.createContext({});
  vm.runInContext(viewScript() + "\nthis.out = cluster([[0,0],[10,0]], 300).length;", ctx);
  assert.equal(ctx.out, 1);
});

test("parseIsCurrent: a schema 8 cache is current with or without the death map's fields", () => {
  const withFields = parse([round(1, "CT")], [death({ tick: 1200, round: 1, victim: ME, povFacingDeg: 10 })]);
  const { footprint: _f, ...without } = withFields;
  const old = { ...without, deaths: without.deaths.map(({ victimPos: _v, attackerPos: _a, povFacingDeg: _p, ...d }) => d) } as ParsedDemo;
  assert.equal(parseIsCurrent(withFields), true);
  assert.equal(parseIsCurrent(old), true);
  assert.equal(hasPositions(withFields), true);
  assert.equal(hasPositions(old), false);
});

test("loadDemos: positions used as cached, re-parsed once when the demo is there, else counted and left alone", async () => {
  const withPos = parse([round(1, "CT")], [death({ tick: 1200, round: 1, victim: ME })]);
  const { footprint: _f, ...old } = withPos;
  const reg = (sha: string, file: string) => ({ sha256: sha, file, originalName: "x.dem", source: "inbox", bytes: 1, addedAt: "2026-11-01T00:00:00.000Z" });
  const registry = { aa: reg("aa", "aa.dem"), bb: reg("bb", "bb.dem"), cc: reg("cc", "cc.dem"), dd: reg("dd", "dd.dem") } as any;
  const caches: Record<string, ParsedDemo> = { aa: withPos, bb: old as ParsedDemo, cc: old as ParsedDemo };
  const calls: string[] = [];
  const src: Sources = {
    readCache: (sha) => caches[sha], hasDemo: (f) => f === "cc.dem",
    parse: async (f) => { calls.push(`parse ${f}`); return withPos; }, reparse: async (f) => { calls.push(`reparse ${f}`); return withPos; },
  };
  const l = await loadDemos(registry, ME, src);
  assert.deepEqual(l.demos.map((x) => x.sha), ["aa", "cc"]); // aa as cached, cc re-parsed
  assert.deepEqual(calls, ["reparse cc.dem"]);
  assert.deepEqual(l.noPositions, [{ sha: "bb", map: "de_test" }]);
  assert.deepEqual(l.unread.map((x) => x.sha), ["dd"]);
  const data = buildDeathMap(l.demos.map(({ p }) => ({ p, date: null, dateFrom: null })), 60, new Date(), l.noPositions.map((x) => ({ ...x, date: null })));
  assert.deepEqual(data.coverage, { withPositions: 2, total: 3 });
  assert.deepEqual(data.maps[0].coverage, { withPositions: 2, total: 3 });
  // A map with no positioned match still gets an entry, so the page can say why it is empty.
  const only = buildDeathMap([], 60, new Date(), [{ sha: "bb", map: "de_old", date: null }]);
  assert.deepEqual(only.maps.map((m) => [m.map, m.rows.length, m.coverage.total]), [["de_old", 0, 1]]);
});
