// The page's feat and weapon filters, derived from what a highlight's index entry already
// carries (entry.moment: kills, clutch, weapons). The page writer stores the result per clip in
// the inlined data; the page only filters and counts (live, so a delete in place updates the
// counts). Reels and entries without a moment have
// no feats and no weapons.

/** Filter order and labels, as the sidebar shows them. */
export const FEATS = [["ace", "Ace"], ["4k", "4k"], ["3k", "3k"], ["clutch", "Clutch"]] as const;
export type Feat = (typeof FEATS)[number][0];

type Moment = { kills?: unknown; clutch?: unknown; weapons?: unknown } | undefined;

/** ace: 5 kills; 4k / 3k: exactly 4 / 3; clutch: a 1vX the POV player won. */
export function featsOf(m: Moment): Feat[] {
  if (!m) return [];
  const out: Feat[] = [];
  const k = typeof m.kills === "number" ? m.kills : 0;
  if (k >= 5) out.push("ace");
  else if (k === 4) out.push("4k");
  else if (k === 3) out.push("3k");
  const c = m.clutch as { won?: unknown } | undefined;
  if (c && c.won === true) out.push("clutch");
  return out;
}

// The scorer keeps the game's names for kills without a gun item (demoparser's weapon field).
const WEAPON_LABELS: Record<string, string> = {
  hegrenade: "HE grenade", inferno: "Fire", molotov: "Fire", incgrenade: "Fire",
  knife: "Knife", taser: "Zeus", world: "World",
};

/** The weapons of a moment's kills, labelled, each once. */
export function weaponsOf(m: Moment): string[] {
  const ws = m && Array.isArray(m.weapons) ? m.weapons : [];
  return [...new Set(ws.filter((w): w is string => typeof w === "string" && w !== "").map((w) => WEAPON_LABELS[w.toLowerCase()] ?? w))];
}
