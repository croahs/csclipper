// Bloopers on synthetic demos: each type found, its look-alikes not, and the clip span clamped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBloopers, type BlooperType } from "../src/film/bloopers.ts";
import { TRACK_STRIDE, type Sample, type Track } from "../src/film/track.ts";
import type { Death, Fire, Hurt, ParsedDemo, Round } from "../src/parse/demo.ts";

// Fake SteamID64s: A1 and A2 are T, B1-B3 CT.
const A1 = "70000000000000001", A2 = "70000000000000002", B1 = "70000000000000011", B2 = "70000000000000012", B3 = "70000000000000013";
const PLAYERS = [A1, A2, B1, B2, B3];
const NAMES = ["anna", "arne", "bjorn", "berit", "bodil"];
const FREEZE_END = 11000, END = 20000;

const round = (o: Partial<Round> = {}): Round => ({
  n: 1, startTick: 10000, freezeEndTick: FREEZE_END, endTick: END, winner: "CT", reason: null, phase: "regular",
  teams: { [A1]: "T", [A2]: "T", [B1]: "CT", [B2]: "CT", [B3]: "CT" }, rosterChanged: false, equip: { T: 0, CT: 0 }, ...o,
});
const death = (tick: number, attacker: string | null, victim: string, weapon: string, o: Partial<Death> = {}): Death => ({
  tick, round: 1, attacker, victim, assister: null, weapon, headshot: false, penetrated: false, noscope: false, thrusmoke: false, attackerblind: false,
  distance: 5, victimHpBefore: 100, airborne: false, attackerName: NAMES[PLAYERS.indexOf(attacker ?? "")] ?? "", victimName: NAMES[PLAYERS.indexOf(victim)], ...o,
});
const hurt = (tick: number, attacker: string | null, victim: string, weapon: string, dmg: number, health: number): Hurt => ({ tick, round: 1, attacker, victim, dmg, health, weapon });
const fires = (player: string, from: number, n: number, every = 6, weapon = "weapon_ak47"): Fire[] => Array.from({ length: n }, (_, i) => ({ tick: from + i * every, round: 1, player, weapon }));
const demo = (o: { deaths?: Death[]; hurts?: Hurt[]; fires?: Fire[]; rounds?: Round[] } = {}): ParsedDemo => ({
  schema: 8, key: "test", demo: { path: "test.dem", sha256: "test", map: "de_test", patch: "1", tickrate: 64, playbackTicks: 200000 },
  identity: { steamid: A1, name: "anna", userIds: [1] }, matchStartTick: 9000, preMatchRounds: 0,
  rounds: o.rounds ?? [round()], deaths: o.deaths ?? [], hurts: o.hurts ?? [], fires: o.fires ?? [], bombs: [], blinds: [], flicks: [],
});

// Everyone alive and 3000 units apart unless `at` says otherwise; spotted: [spotter, spotted] pairs at every sample.
function track(at: (id: string, tick: number) => Partial<Sample> | undefined = () => undefined, spotted: [string, string][] = []): Track {
  const ticks: number[] = [];
  for (let t = FREEZE_END; t <= END; t += 16) ticks.push(t);
  const data = PLAYERS.map((id, pi) => ticks.flatMap((t) => {
    const s: Sample = { X: pi * 3000, Y: 0, Z: 0, yaw: 90, pitch: 0, alive: true, spottedBy: 0, ...at(id, t) };
    for (const [by, who] of spotted) if (who === id) s.spottedBy |= 1 << PLAYERS.indexOf(by);
    return [s.X, s.Y, s.Z, s.yaw, s.pitch, s.alive ? 1 : 0, s.spottedBy];
  }));
  assert.equal(data[0].length, ticks.length * TRACK_STRIDE);
  return { schema: 1, key: "test", every: 16, ticks, players: PLAYERS, names: NAMES, data };
}
const types = (p: ParsedDemo, tr = track(), roster = PLAYERS) => detectBloopers(p, tr, roster).map((b) => b.type).sort();
const only = (p: ParsedDemo, type: BlooperType, tr = track(), roster = PLAYERS) => detectBloopers(p, tr, roster).filter((b) => b.type === type);

test("teamkill: a roster player kills a teammate; an enemy kill is none", () => {
  const [b] = only(demo({ deaths: [death(12000, A1, A2, "hegrenade")] }), "teamkill");
  assert.equal(b.steamid, A1);
  assert.equal(b.tick, 12000);
  assert.equal(b.title, "anna · de_test · R1 · teamkill on arne (HE grenade)");
  assert.ok(b.score >= 50 && b.score <= 100);
  assert.deepEqual([b.startTick, b.endTick], [12000 - 6 * 64, 12000 + 3 * 64]);
  assert.deepEqual(types(demo({ deaths: [death(12000, A1, B1, "ak47")] })), []);
});

test("selfkill: own HE grenade (the throw in the span) and a fall; a bomb death and a disconnect are none", () => {
  const he = only(demo({ deaths: [death(12000, A1, A1, "hegrenade")], hurts: [hurt(12000, A1, A1, "hegrenade", 100, 0)], fires: [{ tick: 11300, round: 1, player: A1, weapon: "weapon_hegrenade" }] }), "selfkill");
  assert.equal(he.length, 1);
  assert.ok(he[0].startTick <= 11300, "the throw is in the clip");
  const fall = only(demo({ deaths: [death(12000, null, A1, "worldent")], hurts: [hurt(12000, null, A1, "", 100, 0)] }), "selfkill");
  assert.equal(fall[0]?.title, "anna · de_test · R1 · fell to his death");
  assert.deepEqual(types(demo({ deaths: [death(12000, null, A1, "planted_c4")], hurts: [hurt(12000, null, A1, "planted_c4", 255, 0)] })), []);
  assert.deepEqual(types(demo({ deaths: [death(12000, A1, A1, "world")] })), [], "a disconnect: no damage behind it");
});

// A1 at the origin looking along +X (yaw 0); `enemy` placed by `where`.
const facing = (where: Partial<Sample>, enemy = B1) => (id: string) => (id === A1 ? { X: 0, Y: 0, yaw: 0 } : id === enemy ? where : undefined);

test("spray: 30 bullets at an enemy right in front, no kill", () => {
  const p = demo({ fires: fires(A1, 12000, 30), hurts: [hurt(12100, B1, A1, "m4a1", 20, 80)] });
  const [b] = only(p, "spray", track(facing({ X: 400, Y: 0, yaw: 180 })));
  assert.equal(b?.title, "anna · de_test · R1 · 30 bullets, no kill");
  assert.equal(b.detail.target, "bjorn");
  assert.equal(b.tick, 12000 + 29 * 6);
});

test("spray: a kill in it, an enemy off to the side, or no sign of sight is none", () => {
  const front = track(facing({ X: 400, Y: 0, yaw: 180 }), [[A1, B1]]);
  assert.equal(only(demo({ fires: fires(A1, 12000, 30) }), "spray", front).length, 1, "spotted is enough sight");
  assert.deepEqual(only(demo({ fires: fires(A1, 12000, 30), deaths: [death(12150, A1, B1, "ak47")] }), "spray", front), []);
  assert.deepEqual(only(demo({ fires: fires(A1, 12000, 30) }), "spray", track(facing({ X: 0, Y: 400, yaw: 270 }), [[A1, B1]])), [], "90 degrees off");
  assert.deepEqual(only(demo({ fires: fires(A1, 12000, 30) }), "spray", track(facing({ X: 400, Y: 0, yaw: 180 }))), [], "no damage, no spotted flag");
  assert.deepEqual(only(demo({ fires: fires(A1, 12000, 24) }), "spray", front), [], "under minBullets");
});

// B1-B3 ahead of A1 from 12000 to 12000 + 2 s, looking further along +X (their backs to him).
const backs = (n: number) => (id: string, t: number) => {
  if (id === A1) return { X: 0, Y: 0, yaw: 0 };
  const k = [B1, B2, B3].indexOf(id);
  if (k < 0 || k >= n || t < 12000 || t > 12128) return undefined;
  return { X: 400 + 100 * k, Y: 60 * (k - 1), yaw: 0 };
};

test("behind: three enemies with their backs to him, he shoots and kills none; three outrank two", () => {
  const p = demo({ fires: fires(A1, 12050, 6, 10, "weapon_glock") });
  const [three] = only(p, "behind", track(backs(3), [[A1, B1]]));
  const [two] = only(p, "behind", track(backs(2), [[A1, B1]]));
  assert.equal(three?.title, "anna · de_test · R1 · behind 3, no kill");
  assert.equal(two?.title, "anna · de_test · R1 · behind 2, no kill");
  assert.ok(three.score >= two.score + 15, `${three.score} vs ${two.score}`);
});

test("behind 2: with a kill, or without firing, is none", () => {
  const tr = track(backs(2), [[A1, B1]]);
  assert.deepEqual(only(demo({ fires: fires(A1, 12050, 6, 10), deaths: [death(12300, A1, B2, "ak47")] }), "behind", tr), []);
  assert.deepEqual(only(demo({ fires: fires(A1, 12050, 2, 10) }), "behind", tr), [], "two shots");
  assert.deepEqual(only(demo(), "behind", tr), []);
});

test("knife rounds and players outside the roster are out", () => {
  const tk = [death(12000, A1, A2, "knife")];
  assert.deepEqual(types(demo({ deaths: tk, rounds: [round({ phase: "knife" })] })), []);
  assert.deepEqual(types(demo({ deaths: tk, fires: [{ tick: 11900, round: 1, player: A1, weapon: "weapon_knife_t" }] })), [], "knife-only fires mark a knife round too");
  assert.deepEqual(types(demo({ deaths: tk }), track(), [A2, B1]), []);
  assert.deepEqual(types(demo({ deaths: tk }), track(), [A1]), ["teamkill"]);
});

test("one per player, round and type: the best", () => {
  const p = demo({ deaths: [death(12000, A1, A2, "ak47", { distance: 20 }), death(12500, A1, B1, "ak47"), death(13000, A1, B2, "knife", { victimName: "berit" })], rounds: [round({ teams: { [A1]: "T", [A2]: "T", [B1]: "T", [B2]: "T", [B3]: "CT" } })] });
  const tks = only(p, "teamkill");
  assert.equal(tks.length, 1);
  assert.equal(tks[0].detail.weapon, "knife");
});

test("span: clamped at the round start and short of the match end", () => {
  const [early] = only(demo({ deaths: [death(10100, A1, A2, "ak47")], rounds: [round({ startTick: 10000 })] }), "teamkill");
  assert.equal(early.startTick, 10000, "not before the round start");
  const [late] = only(demo({ deaths: [death(19900, A1, A2, "ak47")] }), "teamkill");
  assert.ok(late.endTick < END && late.endTick >= 19900, `ends ${late.endTick}, short of the match end ${END}`);
  assert.equal(late.endTick, END - 32 - 16 - 1);
});
