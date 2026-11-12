// pnpm fav <no>... / pnpm unfav <no>...: star or unstar clips (library/stars.json); pnpm pick <no>... /
// pnpm unpick <no>...: tick or untick clips' "Film" box (library/film-picks.json, what pnpm film masters
// makes). Then the library page is rewritten. A number the index does not hold refuses the whole command.
// Not "pnpm star": pnpm's own star / unstar commands take those names (they star npm packages).
import { readIndex } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { changePicks, changeStars } from "../library/stars.ts";

const [op, ...args] = process.argv.slice(2);
const USAGE: Record<string, string> = { star: "fav", unstar: "unfav", pick: "pick", unpick: "unpick" };

function main(): number {
  const nos = args.map(Number);
  if (!USAGE[op] || !nos.length || nos.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(`usage: pnpm ${USAGE[op] ?? "fav"} <clip number>...`);
    return 1;
  }
  const known = new Set(Object.values(readIndex().clips).map((c) => c.no).filter((n): n is number => n !== undefined));
  if (op === "pick" || op === "unpick") {
    const r = changePicks(op, nos, known);
    if (r.unknown.length) { console.error(`no clip ${r.unknown.join(", ")}; nothing changed`); return 1; }
    console.log(`${op === "pick" ? "picked for the film" : "unpicked"} ${nos.join(", ")}; film picks now: ${r.picks.join(", ") || "none"}`);
  } else {
    const r = changeStars(op as "star" | "unstar", nos, known);
    if (r.unknown.length) { console.error(`no clip ${r.unknown.join(", ")}; nothing changed`); return 1; }
    console.log(`${op === "star" ? "starred" : "unstarred"} ${nos.join(", ")}; starred now: ${r.stars.join(", ") || "none"}`);
  }
  writeLibraryPage();
  return 0;
}

process.exitCode = main();
