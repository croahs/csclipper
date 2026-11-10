// pnpm week [<ISO week>] [--top <n>] [--music <file>] [--no-music] [--dry-run] [--json]:
// library/montage/<yyyy>-W<ww>.mp4, the week's top highlights joined into one video (PLAN.md §6,
// best of the week). No week: the most recent one with a highlight. --dry-run prints the selection
// and writes nothing; --json prints one JSON line instead. Exit 2: nothing to make (fewer than 2 clips).
import path from "node:path";
import { fmtMb, makeWeek, parseWeekArgs, planWeek, WeekRefusal } from "../week/index.ts";

function main(): number {
  let a;
  try { a = parseWeekArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    const plan = planWeek(a);
    const { sources: _s, audio: _a, ...pub } = plan;
    const say = a.json ? () => {} : (s: string) => console.log(s);
    if (a.dryRun) {
      if (a.json) { console.log(JSON.stringify({ dryRun: true, ...pub })); return 0; }
      say(`${plan.week} (${plan.range}): ${plan.clips.length} clips in play order, best last:`);
      for (const c of plan.clips) say(`  #${c.no ?? "?"}  score ${c.score}  ${c.seconds.toFixed(1)} s  ${c.title}`);
      for (const s of plan.skipped) say(`  skipped #${s.no ?? "?"} ${s.title}: ${s.reason}`);
      say(`  music: ${plan.music ?? "none"}`);
      say(`  would write ${plan.path} (${plan.seconds.toFixed(1)} s at ${plan.width}x${plan.height}@${plan.fps})`);
      return 0;
    }
    for (const s of plan.skipped) say(`skipped #${s.no ?? "?"} ${s.title}: ${s.reason}`);
    const r = makeWeek(plan, say);
    if (a.json) { console.log(JSON.stringify(r)); return 0; }
    say(r.reused ? "already made, still valid:" : `made in ${r.encodeSeconds.toFixed(0)} s:`);
    say(`  ${r.path}`);
    say(`  ${fmtMb(r.bytes)}, ${r.seconds.toFixed(1)} s`);
    say(`  clips in play order: ${r.clips.map((c) => c.no ?? "?").join(", ")}`);
    say(`  music: ${r.music ? path.basename(r.music) : "none"}`);
    say(`  caption: ${r.caption}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return e instanceof WeekRefusal ? 2 : 1;
  }
}
process.exitCode = main();
