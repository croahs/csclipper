// The page's feat, weapon and player filters, derived from what an index entry already carries
// (entry.moment: kills, clutch, weapons; entry.blooper: its type; entry.player). The page writer
// stores the result per clip in the inlined data; the page only filters and counts (live, so a
// delete in place updates the counts). Reels and entries without a moment have no feats and no weapons.

/** Filter order and labels, as the sidebar shows them. */
export const FEATS = [["ace", "Ace"], ["4k", "4k"], ["3k", "3k"], ["clutch", "Clutch"]] as const;
/** A blooper's feat is its type (src/film/bloopers.ts), listed after the highlight feats. */
export const BLOOPER_FEATS = [["teamkill", "Teamkill"], ["selfkill", "Own grenade / fall"], ["spray", "Spray, no kill"], ["behind", "Behind, no kill"]] as const;
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

/** The page's value for entries without `player` (the main account's). A povKey is 8 hex, so it never collides. */
export const ME = "me";
/**
 * The Player filter's rows: "Me" first, then one per player key, labelled with the name on that
 * player's newest entry (in-game names drift between demos), by label. Empty when no entry has a
 * player: the page then shows no Player group at all.
 */
export function playersOf(entries: { player?: { key: string; name: string }; createdAt: string }[]): { key: string; name: string }[] {
  const newest = new Map<string, { name: string; at: string }>();
  for (const e of entries) {
    if (!e.player) continue;
    const cur = newest.get(e.player.key);
    if (!cur || e.createdAt > cur.at) newest.set(e.player.key, { name: e.player.name, at: e.createdAt });
  }
  if (!newest.size) return [];
  const others = [...newest].map(([key, v]) => ({ key, name: v.name })).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return [{ key: ME, name: "Me" }, ...others];
}
