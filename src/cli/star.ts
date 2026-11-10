// pnpm fav <no>... / pnpm unfav <no>...: star or unstar clips (library/stars.json), then
// rewrite the library page. A number the index does not hold refuses the whole command.
// Not "pnpm star": pnpm's own star / unstar commands take those names (they star npm packages).
import { readIndex } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { changeStars } from "../library/stars.ts";

const [op, ...args] = process.argv.slice(2);

function main(): number {
  const nos = args.map(Number);
  if ((op !== "star" && op !== "unstar") || !nos.length || nos.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(`usage: pnpm ${op === "unstar" ? "unfav" : "fav"} <clip number>...`);
    return 1;
  }
  const known = new Set(Object.values(readIndex().clips).map((c) => c.no).filter((n): n is number => n !== undefined));
  const r = changeStars(op, nos, known);
  if (r.unknown.length) { console.error(`no clip ${r.unknown.join(", ")}; nothing changed`); return 1; }
  console.log(`${op === "star" ? "starred" : "unstarred"} ${nos.join(", ")}; starred now: ${r.stars.join(", ") || "none"}`);
  writeLibraryPage();
  return 0;
}

process.exitCode = main();
