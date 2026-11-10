// The caption for a shared clip: one line of plain text to paste next to the file. Pure, so the
// library page (inlined per clip) and pnpm share give the same line.

export type CaptionInput = { title: string; kind?: "highlight" | "deaths" | "kills"; map?: string; round: number; reel?: { takes: unknown[] } };

/** "de_dust2" -> "Dust2"; undefined when the map is unknown. */
export function mapLabel(map: string | undefined): string | undefined {
  const m = map?.trim().replace(/^[a-z]+_/i, "");
  return m ? m[0].toUpperCase() + m.slice(1) : undefined;
}

/**
 * Highlight: what happened, then where: "de_cache · R12 · 3k Deagle clutch" ->
 * "3k Deagle clutch · Cache · round 12 #CS2" (a hand-picked tick range has no "what": the map and
 * round only). Reels: "Cache · all 9 deaths from the killer's view #CS2", and "... kills from the
 * victim's view" for kills.
 */
export function shareCaption(e: CaptionInput): string {
  const parts = e.title.split(" · ").map((p) => p.trim()).filter(Boolean);
  const map = mapLabel(e.map ?? (/^[a-z]+_\w+$/i.test(parts[0] ?? "") ? parts[0] : undefined));
  const where = (rest: string[]) => [...rest, map].filter(Boolean).join(" · ");
  if (e.kind === "deaths" || e.kind === "kills") {
    const n = e.reel?.takes.length;
    const what = e.kind === "deaths" ? "death" : "kill";
    const count = n === undefined ? `every ${what}` : n === 1 ? `1 ${what}` : `all ${n} ${what}s`;
    return `${where([])}${map ? " · " : ""}${count} from the ${e.kind === "deaths" ? "killer's" : "victim's"} view #CS2`;
  }
  // Highlight titles: "<map> · R<n> · <what>[ · <clutch>]" or "<map> · R<n> · ticks a-b".
  const what = parts.filter((p, i) => !(i === 0 && /^[a-z]+_\w+$/i.test(p)) && !/^R\d+$/.test(p) && !/^ticks \d+-\d+$/.test(p));
  return `${where(what)} · round ${e.round} #CS2`.replace(/^ · /, "");
}
