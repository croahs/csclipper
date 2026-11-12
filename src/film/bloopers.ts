// Bloopers ("tabber"): the funniest mistakes of a roster's players in one demo, each a clip span
// in that player's first person. Four kinds: a teamkill, a death by one's own grenade or a fall,
// a spray of a magazine at an enemy right in front without a kill, and standing behind several
// enemies who face away without killing any of them. detectBloopers is pure: the parse (rounds,
// deaths, hurts, fires) and the track (positions and views every 0.25 s, src/film/track.ts) in,
// scored bloopers out. Thresholds: BLOOPER_DEFAULTS, overridable in config.json → film.bloopers.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import { weaponName } from "../clip/index.ts";
import { NOT_A_GUN, facingDeg, matchEndTick, type ParsedDemo, type Round, type Team } from "../parse/demo.ts";
import { MARGIN_TICKS, SETTLE_TICKS } from "../render/controller/index.ts";
import { CHAIN_AFTER_TICKS, FIRST_SCHEDULE } from "../render/controller/cfg.ts";
import { sampleAt, type Sample, type Track } from "./track.ts";

export type BlooperType = "teamkill" | "selfkill" | "spray" | "behind";
export type Blooper = {
  type: BlooperType; steamid: string; name: string; round: number;
  tick: number; // the anchor event: the kill, the death, the spray's last shot, the window's start
  startTick: number; endTick: number; // the clip span, clamped like a reel take
  score: number; // 0..100, higher = funnier; comparable across types
  title: string; // "<name> · <map> · R<round> · <what>"
  detail: Record<string, number | string>; // what the score was built from
};

export type BlooperSettings = {
  minScore: number; // the batch renders bloopers scoring this or more
  spray: {
    minBullets: number; // gun shots in one episode
    gapSeconds: number; // the longest pause inside an episode
    rangeUnits: number; // "right in front": this close (3D) ...
    coneDeg: number; // ... and this far off the view's yaw ...
    pitchDeg: number; // ... and its pitch,
    frontShare: number; // at this share of the episode's samples
    noKillAfterSeconds: number; // no kill from the first shot until this long after the last
  };
  behind: {
    minEnemies: number; // enemies in view at once, facing away
    minSeconds: number; // for this long
    rangeUnits: number;
    coneDeg: number; // the player's view cone (half-angle, yaw)
    facingAwayDeg: number; // facingDeg(enemy, player) at least this
    minShots: number; // gun shots in the window or shotsAfterSeconds after it
    shotsAfterSeconds: number;
    noKillAfterSeconds: number; // no kill from the window's start until this long after its end
  };
};

export const BLOOPER_DEFAULTS: BlooperSettings = {
  minScore: 50,
  spray: { minBullets: 25, gapSeconds: 1, rangeUnits: 700, coneDeg: 12, pitchDeg: 20, frontShare: 0.6, noKillAfterSeconds: 2 },
  behind: { minEnemies: 2, minSeconds: 1, rangeUnits: 1200, coneDeg: 35, facingAwayDeg: 110, minShots: 3, shotsAfterSeconds: 4, noKillAfterSeconds: 6 },
};

/** BLOOPER_DEFAULTS with config.json → film.bloopers laid over them (absent: the defaults). */
export function loadBlooperSettings(file = path.join(ROOT, "config.json")): BlooperSettings {
  const o = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).film?.bloopers : undefined) ?? {};
  const d = BLOOPER_DEFAULTS;
  const s: BlooperSettings = { minScore: o.minScore ?? d.minScore, spray: { ...d.spray, ...o.spray }, behind: { ...d.behind, ...o.behind } };
  const bad = (k: string, v: unknown) => typeof v !== "number" || !Number.isFinite(v) || v < 0;
  if (bad("minScore", s.minScore)) throw new Error("config.json film.bloopers.minScore must be a number >= 0");
  for (const g of ["spray", "behind"] as const) for (const [k, v] of Object.entries(s[g])) if (bad(k, v)) throw new Error(`config.json film.bloopers.${g}.${k} must be a number >= 0`);
  return s;
}

// --- geometry ---
const angDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const dist = (a: Sample, b: Sample) => Math.hypot(b.X - a.X, b.Y - a.Y, b.Z - a.Z);
/** How far b is off a's view: yaw and pitch, degrees (b's chest against a's eyes). */
function offView(a: Sample, b: Sample): { yaw: number; pitch: number } {
  const dx = b.X - a.X, dy = b.Y - a.Y, dz = b.Z + 40 - (a.Z + 64);
  const yawTo = (Math.atan2(dy, dx) * 180) / Math.PI;
  const pitchTo = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI; // CS pitch: positive looks down
  return { yaw: angDiff(a.yaw, yawTo), pitch: angDiff(a.pitch, pitchTo) };
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Weapons whose death or damage is a thrown grenade (or its fire). */
const GRENADE = /^(hegrenade|inferno|molotov|incgrenade|flashbang|smokegrenade|decoy)$/;
const THROWN = /^(hegrenade|molotov|incgrenade)$/; // a damaging throw (weapon_fire) or its kill
// weapon_fire names carry a "weapon_" prefix (weapon_ak47, weapon_knife_t) that deaths and hurts do not.
const bare = (w: string) => w.replace(/^weapon_/, "");
const isGun = (w: string) => !NOT_A_GUN.test(bare(w));
const NADES: Record<string, string> = { hegrenade: "HE grenade", inferno: "molotov", molotov: "molotov", incgrenade: "incendiary", flashbang: "flashbang", smokegrenade: "smoke grenade", decoy: "decoy" };
const named = (w: string) => NADES[bare(w)] ?? weaponName(bare(w));

/**
 * The clip span around an anchor, clamped like reelTakes: round start, the demo's playable
 * bounds, and short of the match end when the anchor is. Undefined when it cannot hold the anchor.
 */
export function clampSpan(p: ParsedDemo, r: Round, anchor: number, from: number, to: number): { startTick: number; endTick: number } | undefined {
  const earliest = FIRST_SCHEDULE + SETTLE_TICKS + MARGIN_TICKS + 32;
  const latest = p.demo.playbackTicks - MARGIN_TICKS - 1;
  const beforeEnd = matchEndTick(p) - MARGIN_TICKS - CHAIN_AFTER_TICKS - 1;
  const startTick = Math.max(r.startTick, earliest, Math.round(from));
  const endTick = Math.min(latest, Math.round(to), anchor <= beforeEnd ? beforeEnd : Infinity);
  return startTick <= anchor && anchor <= endTick && startTick < endTick ? { startTick, endTick } : undefined;
}

export function detectBloopers(p: ParsedDemo, track: Track, roster: string[], cfg: BlooperSettings = BLOOPER_DEFAULTS): Blooper[] {
  const t = p.demo.tickrate;
  const S = (s: number) => Math.round(s * t);
  const inRoster = new Set(roster);
  const slot = new Map(track.players.map((id, i) => [id, i]));
  const nameOf = (id: string) => {
    const i = slot.get(id);
    if (i !== undefined && track.names[i]) return track.names[i];
    const d = p.deaths.find((x) => x.attacker === id || x.victim === id);
    return (d ? (d.attacker === id ? d.attackerName : d.victimName) : "") || "unknown player";
  };
  // Sample indices whose tick is in [from, to].
  const samplesIn = (from: number, to: number) => {
    let lo = 0, hi = track.ticks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (track.ticks[m] < from) lo = m + 1; else hi = m; }
    const out: number[] = [];
    for (let i = lo; i < track.ticks.length && track.ticks[i] <= to; i++) out.push(i);
    return out;
  };
  const out: Blooper[] = [];
  const add = (r: Round, b: Omit<Blooper, "startTick" | "endTick" | "title" | "name"> & { what: string }, from: number, to: number) => {
    const span = clampSpan(p, r, b.tick, from, to);
    if (!span) return;
    const name = nameOf(b.steamid);
    const { what, ...rest } = b;
    out.push({ ...rest, name, ...span, score: Math.round(Math.max(0, Math.min(100, b.score))), title: `${name} · ${p.demo.map} · R${r.n} · ${what}` });
  };

  for (const r of p.rounds) {
    // A knife round: parse marks it; its fire names are checked here without the prefix as well.
    const swings = p.fires.filter((f) => f.round === r.n && f.tick <= r.endTick);
    if (r.phase === "knife" || (swings.length && swings.every((f) => /^(knife|bayonet)/.test(bare(f.weapon))))) continue;
    const inRound = (tick: number) => tick > r.startTick && tick <= r.endTick;
    const deaths = p.deaths.filter((d) => d.round === r.n && inRound(d.tick));
    const secondsIn = (tick: number) => Math.max(0, (tick - r.freezeEndTick) / t);
    const early = (tick: number) => clamp01(1 - (secondsIn(tick) - 15) / 45); // 1 up to 15 s in, 0 from 60 s
    const enemyKills = (id: string, team: Team, from: number, to: number) =>
      deaths.filter((d) => d.attacker === id && d.victim !== id && r.teams[d.victim] !== team && d.tick >= from && d.tick <= to);
    const deathOf = (id: string) => deaths.find((d) => d.victim === id);

    for (const id of Object.keys(r.teams).filter((x) => inRoster.has(x))) {
      const team = r.teams[id];
      const enemies = Object.keys(r.teams).filter((x) => r.teams[x] !== team);
      const died = deathOf(id);
      const best = new Map<BlooperType, Parameters<typeof add>>();
      const keep = (args: Parameters<typeof add>) => { const k = args[1].type, cur = best.get(k); if (!cur || args[1].score > cur[1].score) best.set(k, args); };

      // 1. teamkill: this player killed a teammate.
      for (const d of deaths.filter((x) => x.attacker === id && x.victim !== id && r.teams[x.victim] === team)) {
        const knife = /^(knife|bayonet)/.test(d.weapon), nade = GRENADE.test(d.weapon);
        const how = knife ? 20 : nade ? 15 : d.distance <= 3 ? 15 : 5; // point-blank: 3 m
        const lost = r.winner !== null && r.winner !== team;
        const score = 55 + how + 10 * early(d.tick) + (d.victimHpBefore >= 100 ? 10 : 0) + (lost ? 10 : 0);
        keep([r, {
          type: "teamkill", steamid: id, round: r.n, tick: d.tick, score,
          what: `teamkill on ${d.victimName || nameOf(d.victim)} (${named(d.weapon)})`,
          detail: { victim: d.victimName || nameOf(d.victim), weapon: d.weapon, metres: Math.round(d.distance), victimHp: d.victimHpBefore, secondsIn: Math.round(secondsIn(d.tick)), roundLost: lost ? "yes" : "no" },
        }, d.tick - S(6), d.tick + S(3)]);
      }

      // 2. selfkill: own grenade or fire, or a fall. Bomb deaths (planted_c4) and disconnects ("world",
      // no damage at all) are not: a fall is a death whose damage came from no one, at that tick.
      if (died) {
        const d = died;
        const own = d.attacker === id && THROWN.test(d.weapon === "inferno" ? "molotov" : d.weapon);
        const fall = !own && (d.attacker === null || d.attacker === id) && !/c4/.test(d.weapon) &&
          p.hurts.some((h) => h.victim === id && h.attacker === null && h.health === 0 && Math.abs(h.tick - d.tick) <= 2 && !/c4/.test(h.weapon));
        if (own || fall) {
          const throwTick = own ? p.fires.filter((f) => f.player === id && f.round === r.n && THROWN.test(bare(f.weapon)) && f.tick <= d.tick).at(-1)?.tick : undefined;
          const cause = fall ? "fall" : `own ${named(d.weapon)}`;
          const score = 65 + (fall ? 15 : 10) + 15 * (d.victimHpBefore / 100) + 5 * early(d.tick);
          keep([r, {
            type: "selfkill", steamid: id, round: r.n, tick: d.tick, score,
            what: fall ? "fell to his death" : `killed by ${cause}`,
            detail: { cause, hpBefore: d.victimHpBefore, secondsIn: Math.round(secondsIn(d.tick)), ...(throwTick !== undefined ? { thrownSecondsBefore: Math.round((d.tick - throwTick) / t * 10) / 10 } : {}) },
          }, Math.min(d.tick - S(7), throwTick !== undefined ? throwTick - S(1) : Infinity), d.tick + S(2)]);
        }
      }

      const me = slot.get(id);
      if (me === undefined) { for (const a of best.values()) add(...a); continue; }
      const shots = p.fires.filter((f) => f.player === id && f.round === r.n && inRound(f.tick) && isGun(f.weapon));
      const hurtsBetween = (a: string, b: string, from: number, to: number) =>
        p.hurts.filter((h) => h.round === r.n && h.attacker === a && h.victim === b && h.tick >= from && h.tick <= to).reduce((s, h) => s + h.dmg, 0);
      const sees = (a: number, b: number, i: number) => (sampleAt(track, b, i).spottedBy & (1 << a)) !== 0; // a had b spotted at sample i

      // 3. spray: an episode of minBullets+ gun shots, no kill, an enemy right in front most of the time.
      const sc = cfg.spray;
      const episodes: (typeof shots)[] = [];
      for (const f of shots) {
        const cur = episodes.at(-1);
        if (cur && f.tick - cur.at(-1)!.tick <= S(sc.gapSeconds)) cur.push(f); else episodes.push([f]);
      }
      for (const ep of episodes.filter((e) => e.length >= sc.minBullets)) {
        const first = ep[0].tick, last = ep.at(-1)!.tick;
        if (enemyKills(id, team, first, last + S(sc.noKillAfterSeconds)).length) continue;
        const idx = samplesIn(first, last).filter((i) => sampleAt(track, me, i).alive);
        if (!idx.length) continue;
        let pick: { e: string; share: number; metres: number; sight: string[]; dealt: number; taken: number; killedBy: boolean } | undefined;
        for (const e of enemies) {
          const ei = slot.get(e);
          if (ei === undefined) continue;
          const front = idx.filter((i) => {
            const a = sampleAt(track, me, i), b = sampleAt(track, ei, i);
            if (!b.alive || dist(a, b) > sc.rangeUnits) return false;
            const off = offView(a, b);
            return off.yaw <= sc.coneDeg && off.pitch <= sc.pitchDeg;
          });
          const share = front.length / idx.length;
          if (front.length < 2 || share < sc.frontShare) continue;
          // No map geometry: in sight means damage either way, a spotted flag either way while he is in
          // front (a flag from before he was there proves nothing about the spray), or the enemy killing him.
          const dealt = hurtsBetween(id, e, first - S(1), last + S(2)), taken = hurtsBetween(e, id, first - S(1), last + S(2));
          const killedBy = !!died && died.attacker === e && died.tick >= first && died.tick <= last + S(2);
          const spotted = front.some((i) => sees(me, ei, i) || sees(ei, me, i));
          const sight = [dealt ? "dealt" : "", taken ? "taken" : "", spotted ? "spotted" : "", killedBy ? "killed" : ""].filter(Boolean);
          if (!sight.length) continue;
          const metres = median(front.map((i) => dist(sampleAt(track, me, i), sampleAt(track, ei, i))));
          if (!pick || share > pick.share || (share === pick.share && metres < pick.metres)) pick = { e, share, metres, sight, dealt, taken, killedBy };
        }
        if (!pick) continue;
        const bullets = ep.length;
        // Damage to anyone counts against it: hits on another enemy mean the spray was a fight elsewhere.
        const dealtAll = enemies.reduce((sum, e) => sum + hurtsBetween(id, e, first, last + S(1)), 0);
        const score = 30 + 25 * clamp01((bullets - sc.minBullets) / 20) + 15 * clamp01((sc.rangeUnits - pick.metres) / (sc.rangeUnits - 150))
          + 15 * clamp01(1 - dealtAll / 100) + (pick.killedBy ? 15 : 0);
        const deathSoon = died && died.tick >= first && died.tick <= last + S(4) ? died.tick : undefined;
        const end = Math.max(last + S(3), deathSoon !== undefined ? deathSoon + S(2) : 0);
        keep([r, {
          type: "spray", steamid: id, round: r.n, tick: last, score,
          what: `${bullets} bullets, no kill`,
          detail: {
            bullets, weapon: named(ep.at(-1)!.weapon), target: nameOf(pick.e), units: Math.round(pick.metres), inFront: `${Math.round(pick.share * 100)}%`,
            dealt: pick.dealt, dealtAll, taken: pick.taken, died: pick.killedBy ? "to him" : deathSoon !== undefined ? "yes" : "no", sight: pick.sight.join("+"),
          },
        }, Math.max(first - S(3), end - S(20)), end]);
      }

      // 4. behind: minEnemies+ enemies in view, near, facing away, for minSeconds; he shoots, kills none.
      const bc = cfg.behind;
      const rs = samplesIn(r.freezeEndTick, r.endTick);
      const counted = rs.map((i) => {
        const a = sampleAt(track, me, i);
        if (!a.alive) return [] as { e: string; units: number }[];
        return enemies.flatMap((e) => {
          const ei = slot.get(e);
          if (ei === undefined) return [];
          const b = sampleAt(track, ei, i);
          if (!b.alive || dist(a, b) > bc.rangeUnits || offView(a, b).yaw > bc.coneDeg || facingDeg(b, a) < bc.facingAwayDeg) return [];
          return [{ e, units: dist(a, b) }];
        });
      });
      const need = Math.max(1, Math.round((bc.minSeconds * t) / track.every));
      for (let s = 0; s < rs.length; ) {
        if (counted[s].length < bc.minEnemies) { s++; continue; }
        let e = s;
        while (e + 1 < rs.length && counted[e + 1].length >= bc.minEnemies && track.ticks[rs[e + 1]] - track.ticks[rs[e]] === track.every) e++;
        const at = rs.slice(s, e + 1), run = counted.slice(s, e + 1);
        const from = track.ticks[rs[s]], to = track.ticks[rs[e]];
        s = e + 1;
        if (run.length < need) continue;
        // N: the most enemies that stayed in view together for `need` samples in a row.
        let n = bc.minEnemies;
        for (let k = bc.minEnemies + 1; k <= 5; k++) {
          let streak = 0, ok = false;
          for (const c of run) { streak = c.length >= k ? streak + 1 : 0; if (streak >= need) ok = true; }
          if (ok) n = k; else break;
        }
        const fired = shots.filter((f) => f.tick >= from && f.tick <= to + S(bc.shotsAfterSeconds)).length;
        if (fired < bc.minShots || enemyKills(id, team, from, to + S(bc.noKillAfterSeconds)).length) continue;
        const who = [...new Set(run.flatMap((c) => c.map((x) => x.e)))];
        const units = median(run.flatMap((c) => c.map((x) => x.units)));
        const dealt = who.reduce((sum, x) => sum + hurtsBetween(id, x, from, to + S(bc.shotsAfterSeconds)), 0);
        const deathSoon = died && died.tick >= from && died.tick <= to + S(bc.noKillAfterSeconds) ? died : undefined;
        const spotted = samplesIn(from, to + S(bc.shotsAfterSeconds)).some((i) => who.some((x) => sees(me, slot.get(x)!, i)));
        // Without map geometry the enemies may be behind a wall: no spotted flag, no damage dealt and
        // not killed by one of them is no sign he saw them: such a window scores 35 at most.
        const diedToThem = !!deathSoon && who.includes(deathSoon.attacker ?? "");
        const sighted = spotted || dealt > 0 || diedToThem;
        const raw = 25 + (n >= 4 ? 40 : n === 3 ? 28 : 0) + (deathSoon ? 12 : 0) + 10 * clamp01(fired / 20) + 10 * clamp01((bc.rangeUnits - units) / 900)
          + 5 * clamp01((run.length - need) / (2 * need));
        const score = sighted ? raw : Math.min(raw, 35);
        const end = deathSoon ? Math.min(to + S(bc.noKillAfterSeconds), deathSoon.tick + S(2)) : to + S(bc.noKillAfterSeconds);
        keep([r, {
          type: "behind", steamid: id, round: r.n, tick: from, score,
          what: `behind ${n}, no kill`,
          detail: {
            enemies: n, who: who.map(nameOf).join(", "), seconds: Math.round(((to - from) / t + track.every / t) * 10) / 10, shots: fired, dealt, units: Math.round(units),
            died: deathSoon ? (diedToThem ? "to them" : "yes") : "no", spotted: spotted ? "yes" : "no", sighted: sighted ? "yes" : "no",
          },
        }, Math.max(from - S(3), end - S(25)), end]);
      }
      for (const a of best.values()) add(...a);
    }
  }
  return out.sort((a, b) => b.score - a.score || a.tick - b.tick);
}
