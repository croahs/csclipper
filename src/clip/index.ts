// Clip specs from moments (PLAN.md §4): engagement-start lead-in, outcome-event
// end, overlapping moments merged, a 30 s cap with splitting, a stable id and
// a generated title.
import type { Death, ParsedDemo, Round } from "../parse/demo.ts";
import { clipId } from "../library/index.ts";
import { scoreKills, weaponClass, type Clutch, type Moment, type Weights } from "../score/index.ts";

const ENGAGE_WINDOW_S = 5; // engagement signals this far before the first kill
const LEAD_IN_S = 2;
const TAIL_S = 2.5; // after the last kill
const OUTCOME_TAIL_S = 1; // after a clutch's resolving event, and past round end at most
const MAX_S = 30;
const OUTCOME_MAX_S = 25; // a POV plant/defuse this long after the last kill still resolves the clutch
const ROUND_END_FOLLOWS_S = 5; // a round end this soon after the last kill is its outcome

export type ClipSpec = {
  id: string;
  rank: number;
  title: string;
  round: number;
  startTick: number;
  endTick: number;
  score: number;
  breakdown: Record<string, number>;
  kills: number;
  killTicks: number[];
  weapons: string[];
  flags: string[];
  clutch?: Clutch;
  aboveThreshold: boolean;
};

const WEAPON_NAMES: Record<string, string> = {
  ak47: "AK-47", m4a1: "M4A4", m4a1_silencer: "M4A1-S", m4a1_silencer_off: "M4A1-S", awp: "AWP", deagle: "Deagle", ssg08: "Scout",
  glock: "Glock", hkp2000: "P2000", usp_silencer: "USP-S", p250: "P250", fiveseven: "Five-SeveN", tec9: "Tec-9", cz75a: "CZ75",
  elite: "Dualies", revolver: "R8", galilar: "Galil", famas: "FAMAS", aug: "AUG", sg556: "SG 553", mac10: "MAC-10", mp9: "MP9",
  mp7: "MP7", mp5sd: "MP5", ump45: "UMP", p90: "P90", bizon: "Bizon", nova: "Nova", xm1014: "XM1014", mag7: "MAG-7",
  sawedoff: "Sawed-Off", m249: "M249", negev: "Negev", g3sg1: "G3SG1", scar20: "SCAR-20",
};
const weaponName = (w: string) => (weaponClass(w) === "knife" ? "knife" : WEAPON_NAMES[w] ?? w);

function flagsOf(kills: Death[]): string[] {
  const f: string[] = [];
  const hs = kills.filter((k) => k.headshot).length;
  if (hs) f.push(hs === kills.length && hs > 1 ? "all HS" : `${hs} HS`);
  if (kills.some((k) => k.penetrated)) f.push("wallbang");
  if (kills.some((k) => k.noscope)) f.push("no-scope");
  if (kills.some((k) => k.thrusmoke)) f.push("through smoke");
  if (kills.some((k) => k.attackerblind)) f.push("while blind");
  return f;
}

function title(map: string, round: number, kills: Death[], clutch?: Clutch): string {
  const counts = new Map<string, number>();
  for (const k of kills) counts.set(weaponName(k.weapon), (counts.get(weaponName(k.weapon)) ?? 0) + 1);
  const weapon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const what = kills.length === 1 ? `${weapon} kill` : `${kills.length}k ${weapon}`;
  const c = clutch ? ` · 1v${clutch.vs} clutch${clutch.won ? "" : " (lost)"}` : "";
  return `${map} · R${round} · ${what}${c}`;
}

/** Boundaries for one moment, before merging and the cap. */
function bounds(p: ParsedDemo, r: Round, m: Moment): { start: number; end: number } {
  const t = p.demo.tickrate;
  const me = p.identity.steamid;
  const first = m.kills[0].tick;
  const last = m.kills[m.kills.length - 1].tick;
  const from = first - ENGAGE_WINDOW_S * t;
  const signals = [
    ...p.fires.filter((f) => f.round === r.n && f.player === me).map((f) => f.tick),
    ...p.hurts.filter((h) => h.round === r.n && (h.attacker === me || h.victim === me)).map((h) => h.tick),
  ].filter((x) => x >= from && x <= first);
  const engage = signals.length ? Math.min(...signals) : first;
  const start = Math.max(r.startTick, engage - LEAD_IN_S * t);
  let end = last + TAIL_S * t;
  if (m.clutch) {
    // A clutch ends 1 s after what resolved it: the POV's plant or defuse after
    // the last kill, else the round end when it follows that kill directly, else
    // the kill itself. The outcome stays within 25 s of the last kill, so the
    // 30 s piece that holds the outcome (the cap splits from the end) holds the kill too.
    const bomb = p.bombs.find((b) => b.round === r.n && b.player === me && b.tick >= last && b.tick <= last + OUTCOME_MAX_S * t);
    const outcome = bomb ? bomb.tick : r.endTick - last <= ROUND_END_FOLLOWS_S * t ? r.endTick : last;
    end = outcome + OUTCOME_TAIL_S * t;
  }
  return { start: Math.round(start), end: Math.round(Math.min(end, r.endTick + OUTCOME_TAIL_S * t)) };
}

export function clipSpecs(p: ParsedDemo, ms: Moment[], w: Weights): ClipSpec[] {
  const t = p.demo.tickrate;
  type Draft = { round: number; kills: Death[]; clutch?: Clutch; roundWon: boolean; start: number; end: number };
  const drafts: Draft[] = ms.map((m) => ({ round: m.round, kills: m.kills, clutch: m.clutch, roundWon: m.roundWon, ...bounds(p, p.rounds.find((r) => r.n === m.round)!, m) }));
  // Merge overlapping drafts of the same round.
  drafts.sort((a, b) => a.round - b.round || a.start - b.start);
  const merged: Draft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.round === d.round && d.start <= prev.end) {
      prev.kills = [...prev.kills, ...d.kills].sort((a, b) => a.tick - b.tick);
      prev.clutch = prev.clutch ?? d.clutch;
      prev.end = Math.max(prev.end, d.end);
    } else merged.push({ ...d, kills: [...d.kills] });
  }
  // Cap: a longer draft is split from its end backwards; only the piece holding
  // the outcome (the last one) keeps the clutch label. Pieces without kills go.
  const pieces: Draft[] = [];
  for (const d of merged) {
    let end = d.end;
    let first = true;
    while (end > d.start) {
      const start = Math.max(d.start, end - MAX_S * t);
      const kills = d.kills.filter((k) => k.tick >= start && k.tick < end);
      if (kills.length) pieces.push({ ...d, kills, clutch: first ? d.clutch : undefined, start, end });
      first = false;
      end = start;
    }
  }
  const specs = pieces.map((d) => {
    const s = scoreKills(d.kills, d.clutch, d.roundWon, w, t);
    return {
      id: clipId(p.demo.sha256, d.round, d.start, d.end),
      rank: 0,
      title: title(p.demo.map, d.round, d.kills, d.clutch),
      round: d.round, startTick: d.start, endTick: d.end,
      score: s.score, breakdown: s.breakdown,
      kills: d.kills.length, killTicks: d.kills.map((k) => k.tick),
      weapons: [...new Set(d.kills.map((k) => weaponName(k.weapon)))],
      flags: flagsOf(d.kills),
      ...(d.clutch ? { clutch: d.clutch } : {}),
      aboveThreshold: s.score >= w.threshold,
    };
  });
  specs.sort((a, b) => b.score - a.score || a.startTick - b.startTick);
  specs.forEach((s, i) => (s.rank = i + 1));
  return specs;
}
