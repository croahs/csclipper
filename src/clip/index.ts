// Clip specs from moments (PLAN.md §4): engagement-start lead-in, outcome-event
// end, overlapping moments merged and never cut short, the action windows post
// plays at normal speed (the rest is fast-forwarded), a stable id and a
// generated title.
import type { Death, ParsedDemo, Round } from "../parse/demo.ts";
import { clipId } from "../library/index.ts";
import { scoreKills, weaponClass, type Clutch, type Moment, type Weights } from "../score/index.ts";
import type { ClipRules } from "../config.ts";

const ENGAGE_WINDOW_S = 5; // engagement signals this far before the first kill
// Lead-in (before the engagement start) and tail (after the last kill): config.json → clip.
const OUTCOME_TAIL_S = 1; // after a clutch's resolving event, and past round end at most
const OUTCOME_MAX_S = 25; // a POV plant/defuse this long after the last kill still resolves the clutch
const ROUND_END_FOLLOWS_S = 5; // a round end this soon after the last kill is its outcome
// Action windows: around each POV kill, damage dealt or taken, weapon fire and the outcome event.
const ACTION_BEFORE_S = 2;
const ACTION_AFTER_S = 1.5;
// A stretch without action longer than this is fast-forwarded in post; a shorter one plays as is.
export const FAST_FORWARD_GAP_S = 4;

/** Ticks [startTick, endTick) post plays at normal speed; between two windows is fast-forwarded. */
export type ActionWindow = { startTick: number; endTick: number };

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
  /** Normal-speed windows inside [startTick, endTick], in order, more than FAST_FORWARD_GAP_S apart. */
  windows: ActionWindow[];
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

/** Boundaries for one moment, before merging; outcome: the tick of what resolves it. */
function bounds(p: ParsedDemo, r: Round, m: Moment, rules: ClipRules): { start: number; end: number; outcome: number } {
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
  const start = Math.max(r.startTick, engage - rules.leadInSeconds * t);
  let end = last + rules.tailSeconds * t;
  let outcome = last;
  if (m.clutch) {
    // A clutch's outcome is what resolved it: the POV's plant or defuse within
    // 25 s after the last kill, else the round end when it follows that kill
    // directly, else the kill itself; the clip runs to 1 s past it if that is later.
    const bomb = p.bombs.find((b) => b.round === r.n && b.player === me && b.tick >= last && b.tick <= last + OUTCOME_MAX_S * t);
    outcome = bomb ? bomb.tick : r.endTick - last <= ROUND_END_FOLLOWS_S * t ? r.endTick : last;
    end = Math.max(end, outcome + OUTCOME_TAIL_S * t);
  }
  return { start: Math.round(start), end: Math.round(Math.min(end, r.endTick + OUTCOME_TAIL_S * t)), outcome };
}

/**
 * The stretches of [start, end] post plays at normal speed: 2 s before to 1.5 s after each
 * POV kill, damage dealt or taken, weapon fire and outcome event, merged when they overlap
 * or are at most FAST_FORWARD_GAP_S apart, plus the `keep` stretches. The first window starts
 * at `start` and the last ends at `end`, so the lead-in and the clip's end always play in full.
 */
export function actionWindows(p: ParsedDemo, round: number, start: number, end: number, extra: number[] = [], keep: ActionWindow[] = []): ActionWindow[] {
  const t = p.demo.tickrate;
  const me = p.identity.steamid;
  const actions = [
    ...p.deaths.filter((d) => d.round === round && d.attacker === me).map((d) => d.tick),
    ...p.hurts.filter((h) => h.round === round && (h.attacker === me || h.victim === me)).map((h) => h.tick),
    ...p.fires.filter((f) => f.round === round && f.player === me).map((f) => f.tick),
    ...extra,
  ].filter((x) => x >= start && x <= end);
  // `keep`: stretches that always play at normal speed (the tail after each moment's last kill).
  const spans = [
    ...actions.map((a) => ({ startTick: Math.round(a - ACTION_BEFORE_S * t), endTick: Math.round(a + ACTION_AFTER_S * t) })),
    ...keep,
  ].map((w) => ({ startTick: Math.max(start, w.startTick), endTick: Math.min(end, w.endTick) }))
    .filter((w) => w.endTick > w.startTick)
    .sort((a, b) => a.startTick - b.startTick);
  const out: ActionWindow[] = [];
  for (const w of spans) {
    const prev = out[out.length - 1];
    if (prev && w.startTick - prev.endTick <= FAST_FORWARD_GAP_S * t) prev.endTick = Math.max(prev.endTick, w.endTick);
    else out.push(w);
  }
  if (!out.length) return [{ startTick: start, endTick: end }];
  out[0].startTick = start;
  out[out.length - 1].endTick = end;
  return out;
}

export function clipSpecs(p: ParsedDemo, ms: Moment[], w: Weights, rules: ClipRules): ClipSpec[] {
  const t = p.demo.tickrate;
  type Draft = { round: number; kills: Death[]; clutch?: Clutch; roundWon: boolean; start: number; end: number; outcomes: number[]; tails: ActionWindow[] };
  const drafts: Draft[] = ms.map((m) => {
    const b = bounds(p, p.rounds.find((r) => r.n === m.round)!, m, rules);
    const last = m.kills[m.kills.length - 1].tick;
    // The tail after the last kill plays in full even when a later clutch outcome extends the span.
    const tails = [{ startTick: last, endTick: Math.round(last + rules.tailSeconds * p.demo.tickrate) }];
    return { round: m.round, kills: m.kills, clutch: m.clutch, roundWon: m.roundWon, start: b.start, end: b.end, outcomes: [b.outcome], tails };
  });
  // Merge overlapping drafts of the same round.
  drafts.sort((a, b) => a.round - b.round || a.start - b.start);
  const merged: Draft[] = [];
  for (const d of drafts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.round === d.round && d.start <= prev.end) {
      prev.kills = [...prev.kills, ...d.kills].sort((a, b) => a.tick - b.tick);
      prev.clutch = prev.clutch ?? d.clutch;
      prev.end = Math.max(prev.end, d.end);
      prev.outcomes = [...prev.outcomes, ...d.outcomes];
      prev.tails = [...prev.tails, ...d.tails];
    } else merged.push({ ...d, kills: [...d.kills] });
  }
  // No cap: a moment is never cut short (PLAN.md §4); post fast-forwards the stretches without action.
  const specs = merged.map((d) => {
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
      windows: actionWindows(p, d.round, d.start, d.end, d.outcomes, d.tails),
    };
  });
  specs.sort((a, b) => b.score - a.score || a.startTick - b.startTick);
  specs.forEach((s, i) => (s.rank = i + 1));
  return specs;
}
