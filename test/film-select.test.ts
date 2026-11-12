// pnpm film's second version: the selection across demos (top N per player, held clips count, a
// deleted one passed over, the blooper bar), the bare-name weapon tests (a knife swing or a grenade
// throw changes no score, an old cache's knife round and flick), the knife multi-kill, the film picks
// file and page data, the masters' plan, key, span, unit and mux arguments, and loadFilm.
// Fake 17-digit SteamIDs only; no demo, no launch, no FFmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFilm, povKey } from "../src/config.ts";
import { selectFilm, toRender, topN, type Candidate } from "../src/film/select.ts";
import { bareWeapon, isGunshot, isKnife, isKnifeRound, type Death, type Fire, type ParsedDemo, type Round } from "../src/parse/demo.ts";
import { loadFilmWeights, loadWeights, moments, scoreKills } from "../src/score/index.ts";
import { clipSpecs } from "../src/clip/index.ts";
import { featsOf } from "../src/library/facets.ts";
import { changePicks, parsePicks, readPicks, readStars, writeStars } from "../src/library/stars.ts";
import { pageData } from "../src/library/page.ts";
import type { ClipEntry } from "../src/library/index.ts";
import { MASTER_TAG, folderName, masterKey, masterMuxArgs, masterPath, masterSpan, masterUnit, planMasters } from "../src/film/masters.ts";
import { MARGIN_TICKS, SETTLE_TICKS } from "../src/render/controller/index.ts";
import { CHAIN_AFTER_TICKS, FIRST_SCHEDULE } from "../src/render/controller/cfg.ts";
import type { PreparedJob } from "../src/queue/job.ts";

const MAIN = "76561198000000001", A = "76561198000000003", B = "76561198000000004";
const SHA = "ab".repeat(32), SHA2 = "cd".repeat(32);
const w = loadWeights(), fw = loadFilmWeights();

// --- selection ---
const cand = (score: number, o: Partial<Candidate> & { tag?: string } = {}) => ({ score, demoOrder: 0, startTick: 0, tag: String(score), ...o });

test("film selection: the top N across demos, best first; ties by demo order, then start", () => {
  const xs = [cand(50, { demoOrder: 1 }), cand(90, { demoOrder: 2 }), cand(70, { demoOrder: 0 }), cand(70, { demoOrder: 1, tag: "70b" }), cand(10)];
  assert.deepEqual(topN(xs, 3).taken.map((x) => x.tag), ["90", "70", "70b"]);
  assert.deepEqual(topN(xs, 10).taken.length, 5, "fewer than N is fine");
  assert.deepEqual(topN([cand(5, { startTick: 900, tag: "late" }), cand(5, { startTick: 100, tag: "early" })], 1).taken.map((x) => x.tag), ["early"]);
});

test("film selection: held clips count toward N and are not rendered; a deleted one is passed over and the next takes its place", () => {
  const xs = [cand(100, { held: { no: 7 } }), cand(95, { deleted: true }), cand(90), cand(80), cand(70)];
  const s = topN(xs, 3);
  assert.deepEqual(s.taken.map((x) => x.score), [100, 90, 80], "95 deleted: 80 moves up into the three");
  assert.deepEqual(s.passed.map((x) => x.score), [95]);
  assert.deepEqual(toRender(s).map((x) => x.score), [90, 80], "the held one is not rendered again");
  // A later run with a better moment from a new demo: it enters, the weakest leaves; nothing held is re-made.
  const later = topN([...xs, cand(99, { demoOrder: 5 })], 3);
  assert.deepEqual(later.taken.map((x) => x.score), [100, 99, 90]);
  assert.deepEqual(toRender(later).map((x) => x.score), [99, 90]);
});

test("film selection: bloopers at the bar or more, the best few; none at all is fine", () => {
  const sel = selectFilm([cand(60)], [cand(49), cand(50), cand(80), cand(55, { deleted: true }), cand(70)], { top: 20, bloopersTop: 2, blooperMinScore: 50 });
  assert.deepEqual(sel.bloopers.taken.map((x) => x.score), [80, 70]);
  assert.deepEqual(selectFilm([], [cand(30), cand(49.9)], { top: 20, bloopersTop: 5, blooperMinScore: 50 }).bloopers.taken, []);
  assert.deepEqual(selectFilm([cand(1)], [], { top: 0, bloopersTop: 5, blooperMinScore: 50 }).highlights.taken, [], "top 0: no highlights");
});

// --- weapons on bare names ---
test("bare weapon names: weapon_fire's prefix is dropped before every test", () => {
  assert.equal(bareWeapon("weapon_knife_ursus"), "knife_ursus");
  assert.equal(bareWeapon("ak47"), "ak47");
  for (const k of ["weapon_knife_ursus", "weapon_knife_t", "weapon_bayonet", "weapon_knife_m9_bayonet", "knife", "knife_t", "bayonet"]) assert.ok(isKnife(k), k);
  for (const g of ["weapon_ak47", "weapon_awp", "weapon_taser", "ak47", "deagle"]) { assert.ok(isGunshot(g), g); assert.ok(!isKnife(g), g); }
  for (const n of ["weapon_hegrenade", "weapon_flashbang", "weapon_smokegrenade", "weapon_molotov", "weapon_incgrenade", "weapon_decoy", "weapon_c4", "weapon_knife", "inferno", "planted_c4", "world"]) assert.ok(!isGunshot(n), n);
});

const T = 64;
const round = (n: number, teams: Record<string, "T" | "CT">, phase: Round["phase"] = "regular"): Round => ({
  n, phase, startTick: n * 20000, freezeEndTick: n * 20000 + 1000, endTick: n * 20000 + 15000, winner: "T", reason: null, rosterChanged: false, equip: { T: 0, CT: 0 }, teams,
});
const kill = (round: number, tick: number, weapon = "ak47", o: Partial<Death> = {}): Death => ({
  tick, round, attacker: MAIN, victim: `v${tick}`, assister: null, weapon, headshot: false, penetrated: false, noscope: false, thrusmoke: false,
  attackerblind: false, distance: 5, victimHpBefore: 100, airborne: false, attackerName: "me", victimName: `v${tick}`, ...o,
});
const fire = (round: number, tick: number, weapon: string, player = MAIN): Fire => ({ tick, round, player, weapon });
function parsed(rounds: Round[], deaths: Death[], fires: Fire[], flicks: ParsedDemo["flicks"] = []): ParsedDemo {
  return {
    schema: 8, key: "k", demo: { path: "d.dem", sha256: SHA, map: "de_test", patch: "1", tickrate: T, playbackTicks: 400000 },
    identity: { steamid: MAIN, name: "me", userIds: [1] }, matchStartTick: 0, preMatchRounds: 0, rounds, deaths, hurts: [], fires, bombs: [], blinds: [], flicks,
  };
}
const teamsFor = (ticks: number[]) => ({ [MAIN]: "T" as const, mate: "T" as const, ...Object.fromEntries(ticks.map((t) => [`v${t}`, "CT" as const])) });

test("a knife swing or a grenade throw changes no score: not the one-bullet kill, not a flick", () => {
  const k = kill(1, 25000);
  const r = [round(1, teamsFor([25000]))];
  const plain = parsed(r, [k], [fire(1, 24990, "weapon_ak47")]);
  const withSwings = parsed(r, [k], [fire(1, 24980, "weapon_hegrenade"), fire(1, 24985, "weapon_knife_ursus"), fire(1, 24990, "weapon_ak47"), fire(1, 24995, "weapon_flashbang")]);
  for (const weights of [w, fw]) {
    const a = scoreKills(plain, [k], undefined, true, weights), b = scoreKills(withSwings, [k], undefined, true, weights);
    assert.deepEqual(b, a);
    assert.ok(a.breakdown.style! > 0, "the one gunshot still makes it a one-bullet kill");
  }
  // An old cache's flick taken from a knife swing (its shot tick holds only that swing): dropped.
  const swingFlick = parsed(r, [k], [fire(1, 24990, "weapon_ak47"), fire(1, 24996, "weapon_knife_t")], [{ killTick: 25000, shotTick: 24996, yawDegrees: 30 }]);
  const gunFlick = parsed(r, [k], [fire(1, 24990, "weapon_ak47")], [{ killTick: 25000, shotTick: 24990, yawDegrees: 30 }]);
  const none = parsed(r, [k], [fire(1, 24990, "weapon_ak47"), fire(1, 24996, "weapon_knife_t")]);
  assert.deepEqual(scoreKills(swingFlick, [k], undefined, true, w), scoreKills(none, [k], undefined, true, w));
  assert.ok(scoreKills(gunFlick, [k], undefined, true, w).score > scoreKills(none, [k], undefined, true, w).score, "a gunshot's flick still counts");
});

test("knife round on an old-style cache: every fire a knife swing (weapon_ prefix), phase never marked: no moments there", () => {
  const r1 = round(1, teamsFor([21000, 22000])), r2 = round(2, teamsFor([41000]));
  const p = parsed([r1, r2], [kill(1, 21000, "knife_t"), kill(1, 22000, "knife"), kill(2, 41000)],
    [fire(1, 20990, "weapon_knife_t"), fire(1, 21990, "weapon_knife"), fire(1, 21500, "weapon_knife_butterfly", "v21000"), fire(2, 40990, "weapon_ak47")]);
  assert.equal(r1.phase, "regular", "as an old cache has it");
  assert.equal(isKnifeRound(p, r1), true);
  assert.equal(isKnifeRound(p, r2), false);
  assert.equal(isKnifeRound(parsed([r1], [], []), r1), false, "no fires: not a knife round");
  assert.deepEqual(moments(p, w).map((m) => m.round), [2], "the knife round's two knife kills are no moment, no bonus");
});

test("knife multi-kill: the second knife kill and each after it earn knife.multi, with a flag and the Knife 2k+ feat", () => {
  const ticks = [41000, 41400, 41800];
  const fires = [fire(2, 40000, "weapon_ak47", "v41000"), ...ticks.map((t) => fire(2, t - 10, "weapon_knife_karambit"))];
  const two = parsed([round(2, teamsFor(ticks))], ticks.slice(0, 2).map((t) => kill(2, t, "knife_karambit")), fires);
  const three = parsed([round(2, teamsFor(ticks))], ticks.map((t) => kill(2, t, "knife_karambit")), fires);
  const one = parsed([round(2, teamsFor(ticks))], [kill(2, 41000, "knife_karambit"), kill(2, 41400)], fires);
  const rules = { leadInSeconds: 4, tailSeconds: 5.5 };
  const [s2] = clipSpecs(two, moments(two, w), w, rules), [s3] = clipSpecs(three, moments(three, w), w, rules), [s1] = clipSpecs(one, moments(one, w), w, rules);
  assert.equal(s2.breakdown.knife, w.knife.multi);
  assert.equal(s3.breakdown.knife, 2 * w.knife.multi);
  assert.equal(s1.breakdown.knife, undefined, "one knife kill: none");
  assert.ok(s2.flags.includes("2 knife kills") && s3.flags.includes("3 knife kills") && !s1.flags.some((f) => /knife kills/.test(f)));
  assert.ok(w.knife.multi >= 40 && s2.score >= 40 + w.knife.multi * 0.9, "clearly felt under scoring.json: past the batch's 40 on the bonus alone");
  assert.ok(fw.knife.multi > w.knife.multi, "larger under the film weights");
  assert.deepEqual(featsOf({ kills: 2, flags: s2.flags }), ["knife2k"]);
  assert.deepEqual(featsOf({ kills: 2, flags: ["2 HS"] }), []);
});

// --- picks ---
const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-picks-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("film picks: their own file, read and written exactly as stars", () => withDir((dir) => {
  const f = path.join(dir, "film-picks.json");
  assert.deepEqual(readPicks(f), [], "missing: none");
  for (const text of ["", "{", '{"version":1,"stars":[1]}', '{"version":2,"picks":[1]}']) { writeFileSync(f, text); assert.deepEqual(readPicks(f), [], text); }
  assert.deepEqual(parsePicks('{"version":1,"picks":[9,3,3,"4",0,-2]}'), [3, 9]);
  const known = new Set([1, 2, 3, 7]);
  assert.deepEqual(changePicks("pick", [3, 1, 3], known, f), { picks: [1, 3], unknown: [] });
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { version: 1, picks: [1, 3] });
  assert.deepEqual(changePicks("unpick", [1], known, f).picks, [3]);
  assert.deepEqual(changePicks("pick", [2, 99], known, f), { picks: [3], unknown: [99] }, "an unknown number refuses the whole change");
  assert.deepEqual(changePicks("pick", [1], new Set([1]), f).picks, [1], "the pick of a clip no longer in the index drops out on write");
  assert.deepEqual(readdirSync(dir), ["film-picks.json"], "no temp file left");
  // Stars and picks never read each other's file.
  const s = path.join(dir, "stars.json");
  writeStars([5], s);
  assert.deepEqual(readPicks(s), []);
  assert.deepEqual(readStars(f), []);
}));

const entry = (o: Partial<ClipEntry> & { id: string; no: number }): ClipEntry => ({
  file: `clips/${o.id}.mp4`, title: `de_test · R3 · 2k AK-47`, map: "de_test", demo: "d.dem", demoSha256: SHA, round: 3, startTick: 70000, endTick: 71000,
  seconds: 10, frames: 600, createdAt: "2026-11-12T10:00:00.000Z", renderKey: "k", render: {}, ...o,
});

test("page data: picks of clips in the index, and only when there are any", () => {
  const es = [entry({ id: "a", no: 1 }), entry({ id: "b", no: 2 })];
  const reg = { [SHA]: { sha256: SHA, file: "x.dem", originalName: "m.dem", source: "inbox", bytes: 1, addedAt: "2026-11-01T09:00:00.000Z" } };
  assert.deepEqual(pageData(es, reg, {}, [], { picks: [2, 9] }).picks, [2]);
  assert.equal("picks" in pageData(es, reg, {}, [], { picks: [9] }), false);
  assert.equal("picks" in pageData(es, reg, {}, []), false);
});

// --- masters ---
test("masters plan: picked highlights and bloopers per demo; a reel, a demo gone or a player out of the roster is skipped", () => {
  const es = [
    entry({ id: "h", no: 1 }),
    entry({ id: "f", no: 2, player: { name: "Alice", key: povKey(A) }, kind: "blooper", title: "Alice · de_test · R4 · fell to his death" }),
    entry({ id: "r", no: 3, kind: "deaths", title: "de_test · deaths" }),
    entry({ id: "g", no: 4, demoSha256: SHA2 }),
    entry({ id: "x", no: 5, player: { name: "Bob", key: povKey(B) } }),
  ];
  const roster = [MAIN, A];
  const plan = planMasters([5, 4, 3, 2, 1, 1, 99], es, {
    demoFile: (sha) => (sha === SHA ? "demos/store/x.dem" : undefined),
    resolvePov: (key) => (!key ? MAIN : roster.find((id) => povKey(id) === key)),
    folderOf: (key) => (key ? folderName(key === povKey(A) ? "Alice" : "Bob", key) : folderName("me: the main?", "me")),
  });
  assert.deepEqual([...plan.byDemo.keys()], [SHA]);
  assert.deepEqual(plan.byDemo.get(SHA)!.map((i) => [i.no, i.pov === MAIN ? "main" : "A", path.basename(path.dirname(i.out)), path.basename(i.out)]),
    [[1, "main", "me_ the main_", "1-de-test-r3-2k-ak-47.mov"], [2, "A", "Alice", "2-alice-de-test-r4-fell-to-his-death.mov"]]);
  assert.deepEqual(plan.skipped.map((s) => s.no), [3, 4, 5]);
  assert.match(plan.skipped[0].skip!, /a reel has no master/);
  assert.match(plan.skipped[1].skip!, /demo is no longer on disk/);
  assert.match(plan.skipped[2].skip!, /no longer in the roster/);
  assert.equal(plan.skipped.length + plan.byDemo.get(SHA)!.length, 5, "99 is no clip: dropped");
});

test("masters folder names: file-safe, a reserved or empty name falls back", () => {
  assert.equal(folderName('a<b>c:"d/e\\f|g?h*', "x"), "a_b_c_d_e_f_g_h_");
  assert.equal(folderName("name. ", "x"), "name");
  assert.equal(folderName("CON", "x"), "x");
  assert.equal(folderName("", "me"), "me");
  assert.equal(masterPath("Alice", { no: 12, title: "Alice · R4" }, "/m"), path.join("/m", "Alice", "12-alice-r4.mov"));
});

test("masters span: the clip plus the handles each side, clamped at the round start and short of the match end, the clip's own span kept", () => {
  const r3 = round(3, {}), last = round(4, {});
  const p = parsed([r3, last], [], []);
  const h = 2 * T;
  assert.deepEqual(masterSpan(p, { round: 3, startTick: 62000, endTick: 70000 }, 2), { startTick: 62000 - h, endTick: 70000 + h });
  assert.deepEqual(masterSpan(p, { round: 3, startTick: r3.startTick + 20, endTick: 70000 }, 2), { startTick: r3.startTick, endTick: 70000 + h }, "not before the round start");
  const beforeEnd = last.endTick - MARGIN_TICKS - CHAIN_AFTER_TICKS - 1;
  assert.deepEqual(masterSpan(p, { round: 4, startTick: 90000, endTick: beforeEnd - 10 }, 2), { startTick: 90000 - h, endTick: beforeEnd }, "the handle stops short of the match end");
  assert.deepEqual(masterSpan(p, { round: 4, startTick: 90000, endTick: last.endTick + 50 }, 2), { startTick: 90000 - h, endTick: last.endTick + 50 + h }, "a clip past the match end keeps its own end");
  assert.equal(masterSpan(p, { round: 9, startTick: 1, endTick: 2 }, 2), undefined);
  assert.ok(FIRST_SCHEDULE + SETTLE_TICKS < r3.startTick, "the fixture is past the earliest playable tick");
});

test("masters key: changes with the clip, span, handles and capture settings; stable otherwise", () => {
  const settings = { width: 1920, height: 1080, fps: 60, aspect: "native" as const, hud: "full" as const, captureCrf: 8 };
  const base = { clipId: "c1", startTick: 100, endTick: 900, handleSeconds: 2, settings };
  const k = masterKey(base);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(masterKey({ ...base, settings: { ...settings } }), k);
  for (const o of [{ clipId: "c2" }, { startTick: 101 }, { endTick: 901 }, { handleSeconds: 3 }, { settings: { ...settings, captureCrf: 12 } }, { settings: { ...settings, fps: 30 } }, { settings: { ...settings, hud: "bare" as const } }])
    assert.notEqual(masterKey({ ...base, ...o }), k, JSON.stringify(o));
});

test("masters mux: the video stream copied, the audio as PCM, .mov, the key in the comment tag; no filter, no encode", () => {
  const a = masterMuxArgs("v.mp4", "a.wav", "out.mov", "0123abcd0123abcd");
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.deepEqual([a[a.indexOf("-i") + 1], a[a.lastIndexOf("-i") + 1]], ["v.mp4", "a.wav"]);
  assert.equal(after("-c:v"), "copy");
  assert.match(after("-c:a"), /^pcm_s(16|24)le$/);
  assert.equal(after("-f"), "mov");
  assert.equal(after("-metadata"), `comment=${MASTER_TAG}0123abcd0123abcd`);
  assert.deepEqual(a.filter((x) => x === "-map"), ["-map", "-map"]);
  assert.ok(a.includes("0:v:0") && a.includes("1:a:0"));
  for (const no of ["-vf", "-af", "-filter_complex", "-crf", "-c:v:0", "libx264"]) assert.ok(!a.includes(no), no);
  assert.equal(a.at(-1), "out.mov");
});

test("masters unit: one take over the span, the master CRF through its RenderSettings, its own id and render key", () => {
  const prep = {
    o: { demo: "d.dem", startTick: 1000, endTick: 2000 }, demo: "d.dem", startTick: 1000, endTick: 2000, matchEnd: 99999, renderKey: "abcdabcdabcdabcd",
    settings: { aspect: "native", hud: "full", width: 1920, height: 1080, fps: 60, captureCrf: 12, crf: 22, fadeSeconds: 0.25 },
    ids: { pov: MAIN }, look: "cfg", crosshair: "demo", facts: { demoSha256: SHA, map: "de_test", slot: 3 },
  } as unknown as PreparedJob;
  const item = { no: 4, entry: entry({ id: "clip1", no: 4 }), folder: "me", out: path.join(tmpdir(), "croclipper-none", "4-x.mov") };
  const u = masterUnit(prep, item, "k".repeat(16), 8);
  assert.equal(u.settings.captureCrf, 8);
  assert.equal(prep.settings.captureCrf, 12, "the prepared job's settings are not altered");
  assert.equal(u.id, "master-clip1");
  assert.notEqual(u.renderKey, prep.renderKey);
  assert.deepEqual(u.takes, [{ startTick: 1000, endTick: 2000, slot: 3 }]);
  assert.equal(u.inLibrary(), false, "no master file yet");
});

test("loadFilm: top, bloopersTop, master handles and CRF validated", () => withDir((dir) => {
  const f = path.join(dir, "config.json");
  const write = (film: unknown) => writeFileSync(f, JSON.stringify({ film }));
  write({ top: 20, bloopersTop: 5, bloopers: { minScore: 50 } });
  assert.deepEqual(loadFilm(f), { top: 20, bloopersTop: 5, masterHandleSeconds: 2, masterCaptureCrf: 8 });
  write({ top: 20, bloopersTop: 5, masterHandleSeconds: 1.5, masterCaptureCrf: 0 });
  assert.deepEqual(loadFilm(f), { top: 20, bloopersTop: 5, masterHandleSeconds: 1.5, masterCaptureCrf: 0 });
  for (const bad of [{ bloopersTop: 5 }, { top: 2.5, bloopersTop: 5 }, { top: 20, bloopersTop: -1 }, { top: 20, bloopersTop: 5, masterCaptureCrf: 52 }, { top: 20, bloopersTop: 5, masterHandleSeconds: -1 }, { minScore: 75, settlesDemo: true }])
    assert.throws(() => { write(bad); loadFilm(f); }, /config\.json film\./, JSON.stringify(bad));
  assert.deepEqual(loadFilm(), { top: 20, bloopersTop: 5, masterHandleSeconds: 2, masterCaptureCrf: 8 }, "the repo's config.json");
}));
