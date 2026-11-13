// Bloopers on synthetic demos: each type found, its look-alikes not, and the clip span clamped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBloopers, type BlooperType } from "../src/film/bloopers.ts";
import { TRACK_STRIDE, smokesOf, type Sample, type Smoke, type Track } from "../src/film/track.ts";
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
function track(at: (id: string, tick: number) => Partial<Sample> | undefined = () => undefined, spotted: [string, string][] = [], smokes?: Smoke[]): Track {
  const ticks: number[] = [];
  for (let t = FREEZE_END; t <= END; t += 16) ticks.push(t);
  const data = PLAYERS.map((id, pi) => ticks.flatMap((t) => {
    const s: Sample = { X: pi * 3000, Y: 0, Z: 0, yaw: 90, pitch: 0, alive: true, spottedBy: 0, ...at(id, t) };
    for (const [by, who] of spotted) if (who === id) s.spottedBy |= 1 << PLAYERS.indexOf(by);
    return [s.X, s.Y, s.Z, s.yaw, s.pitch, s.alive ? 1 : 0, s.spottedBy];
  }));
  assert.equal(data[0].length, ticks.length * TRACK_STRIDE);
  return { schema: 2, key: "test", every: 16, ticks, players: PLAYERS, names: NAMES, data, ...(smokes ? { smokes } : {}) };
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

// B1-B3 (the first n) ahead of A1 with their backs to him between ticks from and to.
const backsBetween = (n: number, from: number, to: number) => (id: string, t: number) => (t < from || t > to ? (id === A1 ? { X: 0, Y: 0, yaw: 0 } : undefined) : backs(n)(id, 12000));

test("behind: minSeconds is a tick span (4 samples cover 0.75 s, 5 cover 1 s), and the seconds reported are that span", () => {
  // Samples fall on 11000 + 16k: 12008, 12024, ... A window of 12008-12056 is 4 samples, 12008-12072 is 5.
  const p = demo({ fires: fires(A1, 12010, 6, 10, "weapon_glock") });
  assert.deepEqual(only(p, "behind", track(backsBetween(2, 12008, 12056), [[A1, B1]])), [], "0.75 s is under the 1 s minimum");
  const [b] = only(p, "behind", track(backsBetween(2, 12008, 12072), [[A1, B1]]));
  assert.equal(b?.detail.seconds, 1);
  // The N streak needs the same span: a third enemy for 4 samples of the 5 leaves N at 2.
  const three = (id: string, t: number) => (id === B3 && t > 12056 ? undefined : backsBetween(3, 12008, 12072)(id, t));
  assert.equal(only(p, "behind", track(three, [[A1, B1]]))[0]?.title, "anna · de_test · R1 · behind 2, no kill");
});

test("behind: a window longer than the 25 s cap keeps its last 25 s and the window's start as its anchor", () => {
  const to = 12008 + 30 * 64;
  const [b] = only(demo({ fires: fires(A1, 12050, 6, 10, "weapon_glock") }), "behind", track(backsBetween(2, 12008, to), [[A1, B1]]));
  assert.ok(b, "kept, not dropped by clampSpan");
  assert.equal(b.endTick, to + 6 * 64, "noKillAfterSeconds after the window");
  assert.equal(b.startTick, b.endTick - 25 * 64);
  assert.ok(b.tick < b.startTick && b.tick >= 12008 && b.tick < 12008 + 16, "the anchor is the window's first sample, before the cut span");
  assert.equal(b.detail.seconds, 30);
});

// The smoke rule: a smoke on the line from A1 (origin, yaw 0) to B1 400 units ahead hides the shots it is up for.
const ahead = facing({ X: 400, Y: 0, yaw: 180 });
const smoke = (X: number, Y: number, from: number, to: number): Smoke => ({ X, Y, Z: 0, from, to });
const sprayIn = (n: number, smokes: Smoke[]) => only(demo({ fires: fires(A1, 12000, n), hurts: [hurt(12100, B1, A1, "m4a1", 20, 80)] }), "spray", track(ahead, [], smokes));

test("spray: shots into a smoke are not missed bullets", () => {
  assert.deepEqual(sprayIn(30, [smoke(200, 0, 11500, 13000)]), [], "a smoke between them for all 30 shots");
  // 40 shots 6 ticks apart from 12000; a smoke up from 12000 to 12054 covers the first 10.
  const [b] = sprayIn(40, [smoke(200, 0, 12000, 12054)]);
  assert.equal(b?.title, "anna · de_test · R1 · 30 bullets, no kill");
  assert.equal(b.detail.bullets, 30);
  assert.equal(b.detail.inSmoke, 10);
  assert.equal(b.tick, 12000 + 39 * 6, "the anchor is still the last shot");
  assert.equal(b.score, sprayIn(30, [])[0].score, "scored on 30 bullets");
});

test("spray: a smoke elsewhere, or one gone before the first shot, changes nothing; standing inside one does", () => {
  const plain = sprayIn(30, []);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].detail.inSmoke, undefined);
  assert.deepEqual(sprayIn(30, [smoke(200, 2000, 11500, 13000)]), plain, "elsewhere on the map");
  assert.deepEqual(sprayIn(30, [smoke(200, 0, 11000, 11999)]), plain, "expired before the first shot");
  assert.deepEqual(sprayIn(30, [smoke(-100, 0, 11500, 13000)]), [], "the shooter stands inside a smoke behind him");
});

test("selfkill: own grenade or fire is rated by the damage it did him; a fall keeps its score", () => {
  const self = (hurts: Hurt[], weapon: string, hp: number) => only(demo({ deaths: [death(12000, A1, A1, weapon, { victimHpBefore: hp })], hurts }), "selfkill")[0];
  // dmg as player_hurt records it: a killing hit is not capped at the health left.
  const finished = self([hurt(11500, B1, A1, "ak47", 88, 12), hurt(12000, A1, A1, "hegrenade", 98, 0)], "hegrenade", 12);
  assert.equal(finished.detail.ownDamage, 12);
  assert.ok(finished.score < 50, `own HE on 12 HP scores ${finished.score}`);
  const burnt = self(Array.from({ length: 8 }, (_, i) => hurt(11600 + 50 * i, A1, A1, "inferno", 15, Math.max(0, 85 - 15 * i))), "inferno", 10);
  assert.equal(burnt.detail.ownDamage, 100);
  assert.equal(burnt.title, "anna · de_test · R1 · killed by own molotov");
  assert.ok(burnt.score >= 90, `own molotov from 100 HP scores ${burnt.score}`);
  const half = self([hurt(11500, B1, A1, "ak47", 80, 20), hurt(12000, A1, A1, "hegrenade", 40, 0)], "hegrenade", 20);
  assert.equal(half.detail.ownDamage, 20, "rated on his own 20, not the enemy's 80");
  // A fall: 80 + 15 x hp/100 + 5 x early, as before (15.6 s in: early 0.987).
  const fall = only(demo({ deaths: [death(12000, null, A1, "worldent", { victimHpBefore: 40 })], hurts: [hurt(12000, null, A1, "", 40, 0)] }), "selfkill")[0];
  assert.equal(fall.score, 91);
  assert.equal(fall.detail.ownDamage, undefined);
});

test("smokesOf: a smoke ends at its own expire, else SMOKE_SECONDS on, never past its round's end", () => {
  const ev = (tick: number, entityid: number) => ({ tick, entityid, x: 1.4, y: 2.6, z: 3 });
  const p = demo();
  assert.deepEqual(smokesOf(p, [ev(12000, 7), ev(13000, 8), ev(19500, 9), ev(5000, 10)], [ev(11000, 7), ev(13100, 7), ev(14000, 8)]), [
    { X: 1, Y: 3, Z: 3, from: 12000, to: 13100 },
    { X: 1, Y: 3, Z: 3, from: 13000, to: 14000 },
    { X: 1, Y: 3, Z: 3, from: 19500, to: END },
  ]);
  assert.equal(smokesOf(p, [ev(12000, 7)], [])[0].to, 12000 + 22 * 64);
});

test("selfnade: his own grenade or fire took 50+ health and he survived that throw", () => {
  const nade = (hurts: Hurt[], deaths: Death[] = []) => demo({ hurts, deaths, fires: [{ tick: 11800, round: 1, player: A1, weapon: "weapon_hegrenade" }] });
  const [he] = only(nade([hurt(12000, A1, A1, "hegrenade", 55, 45)]), "selfnade");
  assert.equal(he?.title, "anna · de_test · R1 · 55 damage from own HE grenade");
  assert.ok(he.score >= 55, `scores ${he.score}`);
  assert.equal(he.tick, 12000, "anchored at the hurt");
  assert.deepEqual([he.startTick, he.endTick], [11800 - 64, 12000 + 3 * 64], "1 s before the throw to 3 s after");
  assert.equal(he.detail.hpAfter, 45);
  assert.deepEqual(only(nade([hurt(12000, A1, A1, "hegrenade", 40, 60)]), "selfnade"), [], "40 is under minDamage");
  // A molotov ticking 8 x 7 over 3 s: one throw.
  const fire = only(demo({ hurts: Array.from({ length: 8 }, (_, i) => hurt(12000 + 27 * i, A1, A1, "inferno", 7, 100 - 7 * (i + 1))) }), "selfnade");
  assert.equal(fire.length, 1);
  assert.equal(fire[0].detail.ownDamage, 56);
  assert.equal(fire[0].tick, 12000 + 27 * 7);
  assert.equal(fire[0].title, "anna · de_test · R1 · 56 damage from own molotov");
  const later = nade([hurt(12000, A1, A1, "hegrenade", 60, 40), hurt(12640, B1, A1, "ak47", 40, 0)], [death(12640, B1, A1, "ak47", { victimHpBefore: 40 })]);
  assert.equal(only(later, "selfnade").length, 1, "killed by an enemy 10 s later: still a selfnade");
  const killed = nade([hurt(12000, A1, A1, "hegrenade", 100, 0)], [death(12000, A1, A1, "hegrenade")]);
  assert.deepEqual(types(killed), ["selfkill"], "the throw that killed him is a selfkill only");
  assert.deepEqual(types(nade([hurt(12000, B1, A1, "hegrenade", 80, 20)])), [], "an enemy's HE");
  // Fire that took 56, a pause, then the same fire kills him: the death is the blooper, not the episode.
  const burn = (from: number, n: number, hp: number) => Array.from({ length: n }, (_, i) => hurt(from + 27 * i, A1, A1, "inferno", 7, hp - 7 * (i + 1)));
  const back = demo({ hurts: [...burn(12000, 8, 100), ...burn(12600, 6, 44), hurt(12800, A1, A1, "inferno", 7, 0)], deaths: [death(12800, A1, A1, "inferno", { victimHpBefore: 2 })] });
  assert.deepEqual(types(back), ["selfkill"], "his own fire killed him later in the round");
  // An HE thrown, then a molotov before it lands: the HE's span starts at the HE's throw.
  const two = demo({ hurts: [hurt(12000, A1, A1, "hegrenade", 55, 45)], fires: [{ tick: 11800, round: 1, player: A1, weapon: "weapon_hegrenade" }, { tick: 11900, round: 1, player: A1, weapon: "weapon_molotov" }] });
  assert.equal(only(two, "selfnade")[0].startTick, 11800 - 64);
  // After the round's end nothing counts.
  assert.deepEqual(only(nade([hurt(END + 100, A1, A1, "hegrenade", 60, 40)]), "selfnade"), []);
});

test("spray: a shot whose nearest sample has him or the enemy dead (no position) is not into smoke", () => {
  // A1 at (1000, 0) facing +X, B1 400 ahead; B1's samples from 12120 on are dead (zero-filled), and a
  // smoke sits on the line from A1 to the map origin, not on the line to B1.
  const at = (id: string, t: number) => (id === A1 ? { X: 1000, Y: 0, yaw: 0 } : id === B1 ? (t >= 12120 ? { X: 0, Y: 0, Z: 0, alive: false } : { X: 1400, Y: 0, yaw: 180 }) : undefined);
  const [b] = only(demo({ fires: fires(A1, 12000, 30), hurts: [hurt(12100, B1, A1, "m4a1", 20, 80)] }), "spray", track(at, [], [smoke(500, 0, 11500, 13000)]));
  assert.equal(b?.detail.bullets, 30);
  assert.equal(b.detail.inSmoke, undefined);
});

test("smokesOf: an expire of the same entity id in a later round does not end an earlier smoke", () => {
  const ev = (tick: number, entityid: number) => ({ tick, entityid, x: 0, y: 0, z: 0 });
  assert.equal(smokesOf(demo(), [ev(12000, 7)], [ev(25000, 7)])[0].to, 12000 + 22 * 64);
});
