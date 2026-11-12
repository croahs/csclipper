// pnpm go --film: the roster, povKey, the per-POV caches, clip ids and held moments per player, the
// film pick and the film settle bookkeeping. Fake SteamID64s only; no demo, no launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Refusal, STATE_DIR, loadRoster, parseRoster, pickFilm, povKey, povKeyFor } from "../src/config.ts";
import { DEMOPARSER_VERSION } from "../src/parse/clip-facts.ts";
import { parseKey, povDir, type Death, type ParsedDemo } from "../src/parse/demo.ts";
import { clipId, type ClipEntry } from "../src/library/index.ts";
import { heldEntry } from "../src/queue/job.ts";
import { filmPair, filmSettles, settleFilm, type BatchOptions } from "../src/queue/index.ts";
import { clipSpecs, type ClipSpec } from "../src/clip/index.ts";
import { loadWeights, moments } from "../src/score/index.ts";

// Fake 17-digit IDs above the SteamID64 base.
const MAIN = "76561198000000001", RENDER = "76561198000000002", A = "76561198000000003", B = "76561198000000004";
const SHA = "ab".repeat(32);

test("roster: STEAM_ID64 first, then FILM_STEAM_ID64S split on commas and whitespace, deduplicated", () => {
  assert.deepEqual(parseRoster(MAIN, RENDER, ""), [MAIN]);
  assert.deepEqual(parseRoster(MAIN, RENDER, `${A}, ${B}\n${A} ${MAIN}`), [MAIN, A, B]);
  assert.deepEqual(parseRoster(MAIN, RENDER, ` ,${B},,`), [MAIN, B]);
});

test("roster: a malformed entry or the render account refuses, naming the position and never the value", () => {
  for (const bad of ["123", "7656119800000000x", "00000000000000001", "765611980000000011"]) {
    assert.throws(() => parseRoster(MAIN, RENDER, `${A},${bad}`), (e: Error) => e instanceof Refusal && /entry 2 is not a SteamID64/.test(e.message) && !e.message.includes(bad));
  }
  assert.throws(() => parseRoster(MAIN, RENDER, `${RENDER}`), (e: Error) => e instanceof Refusal && /RENDER_STEAM_ID64/.test(e.message) && !e.message.includes(RENDER));
});

test("roster: loadRoster reads .env; FILM_STEAM_ID64S is optional", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-roster-"));
  try {
    const env = path.join(dir, ".env");
    const base = `STEAM_ID64=${MAIN}\nRENDER_STEAM_ID64=${RENDER}\nHLAE_EXE=x\nCS2_EXE=y\n`;
    writeFileSync(env, base);
    assert.deepEqual(loadRoster(env), [MAIN]);
    writeFileSync(env, `${base}FILM_STEAM_ID64S=${A},${B}\n`);
    assert.deepEqual(loadRoster(env), [MAIN, A, B]);
    writeFileSync(env, `${base}FILM_STEAM_ID64S=${A} ${RENDER}\n`);
    assert.throws(() => loadRoster(env), Refusal);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("povKey: the first 8 hex of sha256 of the SteamID64; none for the main POV", () => {
  assert.equal(povKey(A), createHash("sha256").update(A).digest("hex").slice(0, 8));
  assert.match(povKey(A), /^[0-9a-f]{8}$/);
  assert.notEqual(povKey(A), povKey(B));
  assert.equal(povKeyFor(MAIN, MAIN), undefined);
  assert.equal(povKeyFor(A, MAIN), povKey(A));
});

test("parse cache: the main POV's path and key are unchanged; another POV's go to pov-<povKey>/", () => {
  assert.equal(path.join(povDir(SHA, povKeyFor(MAIN, MAIN)), "parse.json"), path.join(STATE_DIR, SHA, "parse.json"));
  assert.equal(povDir(SHA, povKeyFor(A, MAIN)), path.join(STATE_DIR, SHA, `pov-${povKey(A)}`));
  // The key form every cache made before this was written with.
  assert.equal(parseKey(SHA, MAIN), `${SHA}:demoparser2@${DEMOPARSER_VERSION}:schema8:pov${MAIN}`);
});

test("clip id: without a key exactly the old hash; with one, the key is part of it", () => {
  const old = createHash("sha256").update(`${SHA}:7:1000:2000`).digest("hex").slice(0, 16);
  assert.equal(clipId(SHA, 7, 1000, 2000), old);
  assert.equal(clipId(SHA, 7, 1000, 2000, undefined), old);
  assert.equal(clipId(SHA, 7, 1000, 2000, povKey(A)), createHash("sha256").update(`${SHA}:7:1000:2000:${povKey(A)}`).digest("hex").slice(0, 16));
  assert.notEqual(clipId(SHA, 7, 1000, 2000, povKey(A)), clipId(SHA, 7, 1000, 2000, povKey(B)));
});

test("held: a shared kill tick holds a moment only for the same player", () => {
  const entry = (id: string, player?: ClipEntry["player"]): ClipEntry => ({
    id, file: `clips/${id}.mp4`, title: id, demo: "d.dem", demoSha256: SHA, round: 3, startTick: 900, endTick: 1500, seconds: 9, frames: 540,
    createdAt: "2026-11-12T00:00:00.000Z", renderKey: "k", render: {}, moment: { killTicks: [1000] }, ...(player ? { player } : {}),
  });
  const clips = { main: entry("main"), a: entry("a", { name: "Alice", key: povKey(A) }) };
  const spec = { killTicks: [1000, 1100] } as ClipSpec; // another span over the same kill tick
  assert.equal(heldEntry(clips, "new", SHA, 3, spec)?.id, "main", "main POV: the main entry");
  assert.equal(heldEntry(clips, "new", SHA, 3, spec, povKey(A))?.id, "a", "player A: A's entry");
  assert.equal(heldEntry(clips, "new", SHA, 3, spec, povKey(B)), undefined, "player B: neither");
  assert.equal(heldEntry({ main: clips.main }, "new", SHA, 3, spec, povKey(A)), undefined, "the main POV's clip never holds A's moment");
  assert.equal(heldEntry({ a: clips.a }, "new", SHA, 3, spec), undefined, "A's clip never holds the main POV's moment");
});

test("film pick: every moment at minScore or more, no fallback", () => {
  const specs = [{ score: 92 }, { score: 75 }, { score: 74.9 }, { score: 40 }];
  assert.deepEqual(pickFilm(specs, { minScore: 75 }), [{ score: 92 }, { score: 75 }]);
  assert.deepEqual(pickFilm([{ score: 74.9 }, { score: 30 }], { minScore: 75 }), [], "nothing reaches it: nothing, never the best");
});

test("film settle: the pairs looked at, and the demo when settlesDemo; never on a dry run or a repost", () => {
  const now = "2026-11-12T10:00:00.000Z";
  const keys = [povKey(MAIN), povKey(A), povKey(A)];
  const s = settleFilm({}, {}, SHA, keys, true, now);
  assert.deepEqual(s.pairs, [filmPair(SHA, povKey(MAIN)), filmPair(SHA, povKey(A))]);
  assert.deepEqual(s.film, { [`${SHA}:${povKey(MAIN)}`]: now, [`${SHA}:${povKey(A)}`]: now });
  assert.deepEqual(s.settled, { [SHA]: now });
  // A pair already done keeps its time; a demo already settled is not rewritten.
  const again = settleFilm({ [filmPair(SHA, povKey(MAIN))]: "earlier" }, { [SHA]: "earlier" }, SHA, keys, true, now);
  assert.deepEqual(again.pairs, [filmPair(SHA, povKey(A))]);
  assert.equal(again.film![filmPair(SHA, povKey(MAIN))], "earlier");
  assert.equal(again.settled, undefined);
  // settlesDemo false: film pairs only. Nothing new: nothing to write.
  assert.equal(settleFilm({}, {}, SHA, keys, false, now).settled, undefined);
  const none = settleFilm(s.film!, { [SHA]: now }, SHA, keys, true, now);
  assert.deepEqual([none.pairs, none.film, none.settled], [[], undefined, undefined]);
  assert.equal(filmSettles({}), true);
  assert.equal(filmSettles({ dryRun: true }), false);
  assert.equal(filmSettles({ repostOnly: true }), false);
  assert.equal(filmSettles({ noReels: true } as BatchOptions), true, "a film pass owes no reels");
});

test("clip specs: another POV's ids carry its key and its titles lead with the player's name; the main POV's do not", () => {
  const w = loadWeights();
  const rules = { leadInSeconds: 4, tailSeconds: 5.5 };
  const kill = (tick: number): Death => ({
    tick, round: 1, attacker: A, victim: `v${tick}`, assister: null, weapon: "ak47", headshot: true, penetrated: false, noscope: false, thrusmoke: false,
    attackerblind: false, distance: 10, victimHpBefore: 100, airborne: false, attackerName: "Alice", victimName: `v${tick}`,
  });
  const p = {
    schema: 8, key: "k", demo: { path: "d.dem", sha256: SHA, map: "de_test", patch: "1", tickrate: 64, playbackTicks: 100000 },
    identity: { steamid: A, name: "Alice", userIds: [1] }, matchStartTick: 0, preMatchRounds: 0,
    rounds: [{ n: 1, phase: "regular", startTick: 0, freezeEndTick: 10, endTick: 9000, winner: "T", reason: null, rosterChanged: false, equip: { T: 0, CT: 0 },
      teams: { [A]: "T", mate: "T", v1000: "CT", v1100: "CT" } }],
    deaths: [kill(1000), kill(1100)], hurts: [], fires: [], bombs: [], blinds: [], flicks: [],
  } as unknown as ParsedDemo;
  const [film] = clipSpecs(p, moments(p, w), w, rules, povKey(A));
  const [main] = clipSpecs(p, moments(p, w), w, rules);
  assert.equal(film.title, `Alice · ${main.title}`);
  assert.ok(main.title.startsWith("de_test · R1 · "));
  assert.equal(main.id, clipId(SHA, 1, main.startTick, main.endTick));
  assert.equal(film.id, clipId(SHA, 1, main.startTick, main.endTick, povKey(A)));
});
