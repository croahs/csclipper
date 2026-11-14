// pnpm friends [--last <n>] [--missing]: the roster's recent FACEIT matches (STEAM_ID64 and
// FILM_STEAM_ID64S), each marked held, rejected or missing in the store, a missing one with its
// room link. Read-only (src/ingest/friends.ts); needs FACEIT_API_KEY.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { ROOT, Refusal, loadRoster } from "../config.ts";
import { DEMOS_DIR, readRegistry } from "../ingest/index.ts";
import { formatFriends, friendsReport } from "../ingest/friends.ts";
import { NO_KEY, httpTransport } from "../ingest/sources/faceit.ts";

const args = process.argv.slice(2);
const lastAt = args.indexOf("--last");
const last = lastAt >= 0 ? Number(args[lastAt + 1]) : 20;
const missingOnly = args.includes("--missing");
const redactSteamIds = (text: string) => text.replace(/\b7656\d{13}\b/g, "<SteamID64>");
let redact = redactSteamIds;

try {
  const env = existsSync(path.join(ROOT, ".env")) ? parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8")) : {};
  const apiKey = env.FACEIT_API_KEY?.trim();
  if (!apiKey) { console.error(NO_KEY.replace("nothing fetched", "nothing to list")); process.exit(1); }
  const roster = loadRoster();
  // A rejection reason or an error can carry any text (an archive's entry names): no SteamID64 or key leaves.
  redact = (text) => redactSteamIds([...roster, apiKey].reduce((s, v) => s.split(v).join("<redacted>"), text));
  if (roster.length === 1) console.log("FILM_STEAM_ID64S in .env is empty: only your own matches are listed.\n");
  const stored = Object.values(readRegistry()).map((d) => d.originalName);
  // A file ingest rejected keeps its name in demos/rejected/, with <name>.reason.txt beside it.
  const rejectedDir = path.join(DEMOS_DIR, "rejected");
  const rejectedNames = existsSync(rejectedDir) ? readdirSync(rejectedDir).filter((n) => !n.endsWith(".reason.txt")) : [];
  // An archive and the demo unpacked from it can both be there, the reason beside either one.
  const rejected = (id: string) => {
    const names = rejectedNames.filter((x) => x.includes(id));
    if (!names.length) return undefined;
    for (const n of names) {
      const r = path.join(rejectedDir, `${n}.reason.txt`);
      const line = existsSync(r) ? readFileSync(r, "utf8").trim().split(/\r?\n/)[0] : "";
      if (line) return redact(line);
    }
    return "rejected";
  };
  const report = await friendsReport({ apiKey, roster, last, transport: httpTransport, haveMatch: (id) => stored.some((n) => n.includes(id)), rejected });
  for (const line of formatFriends(report, { missingOnly })) console.log(line);
} catch (e) {
  console.error(redact(e instanceof Refusal ? e.message : `pnpm friends: ${(e as Error).message}`));
  process.exit(1);
}
