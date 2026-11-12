// pnpm week [<ISO week>] [--top <n>] [--seconds <n>] [--music <file>] [--no-music] [--dry-run] [--json]:
// library/montage/<yyyy>-W<ww>.mp4, the week's top highlights cut to the shots around their kills
// on the music's beat (PLAN.md §6, best of the week). No week: the most recent one with a
// highlight. --dry-run prints the plan and writes nothing; --json prints one JSON line instead.
// Exit 2: nothing to make (fewer than 2 clips) or no track (pnpm music fetches the defaults).
import path from "node:path";
import { fmtMb, makeWeek, parseWeekArgs, planWeek, WeekRefusal, type WeekPlan } from "../week/index.ts";

const t2 = (s: number) => s.toFixed(2);

function printPlan(p: WeekPlan, say: (s: string) => void) {
  say(`${p.week} (${p.range}): ${p.clips.length} clips, ${p.shots.length} shots, ${t2(p.seconds)} s (cap ${p.maxSeconds} s${p.overCap ? ", EXCEEDED: the best three alone are longer" : ""})`);
  if (p.track) {
    const t = p.track;
    say(`  track ${path.basename(t.file)}: ${t.bpm.toFixed(2)} BPM, from ${t2(t.start)} s in the track${t.loopSeconds ? `, looped every ${t2(t.loopSeconds)} s` : ""}; grid unit ${t.unitBeats} beat${t.unitBeats > 1 ? "s" : ""} = ${t.unitSeconds.toFixed(3)} s, bar ${t.barSeconds.toFixed(3)} s${t.refit ? " (grid refitted on the used section)" : t.refitRejected ? " (a refit on the used section was tried and rejected; whole-file grid)" : ""}`);
  } else say(`  no music: fixed grid 0.6 s, bar 2.4 s`);
  say(`  card 0–${t2(p.card)} s; close: hold to ${t2(p.closeAt)} s, fade to ${t2(p.seconds)} s`);
  say(`  clip    in → out (clip s)    at → end (video s)  anchor  kills (video s)`);
  for (const s of p.shots)
    say(`  #${String(s.no ?? "?").padEnd(5)} ${t2(s.in).padStart(6)} → ${t2(s.out).padEnd(6)}       ${t2(s.at).padStart(6)} → ${t2(s.end).padEnd(6)}  ${t2(s.anchor).padStart(6)}  ${s.kills.map(t2).join(" ")}${s.label ? `  "${s.label}"` : ""}${s.merged ? `  (${s.merged + 1} shots merged: the gap between them would have repeated footage)` : ""}${s.hold > 0.001 ? `  (holds its last frame ${t2(s.hold)} s: the clip ends or fast-forward starts)` : ""}`);
  say(`  play order, best last: ${p.clips.map((c) => `#${c.no ?? "?"} (${c.score})`).join(", ")}`);
  for (const d of p.dropped) say(`  dropped for the ${p.maxSeconds} s cap: #${d.no ?? "?"} ${d.title}`);
  for (const s of p.skipped) say(`  skipped #${s.no ?? "?"} ${s.title}: ${s.reason}`);
}

function main(): number {
  let a;
  try { a = parseWeekArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); return 1; }
  try {
    const plan = planWeek(a);
    const { internal: _x, ...pub } = plan;
    const say = a.json ? () => {} : (s: string) => console.log(s);
    const credit = () => (plan.track ? (plan.credit ? `  credit (required wherever it is posted): ${plan.credit}` : `  no credit known for ${path.basename(plan.track.file)}`) : "  music: none");
    if (a.dryRun) {
      if (a.json) { console.log(JSON.stringify({ dryRun: true, ...pub })); return 0; }
      printPlan(pub, say);
      say(credit());
      say(`  would write ${plan.path}`);
      return 0;
    }
    for (const s of plan.skipped) say(`skipped #${s.no ?? "?"} ${s.title}: ${s.reason}`);
    for (const d of plan.dropped) say(`dropped for the ${plan.maxSeconds} s cap: #${d.no ?? "?"} ${d.title}`);
    if (plan.overCap) say(`the best three alone run ${plan.seconds.toFixed(1)} s, over the ${plan.maxSeconds} s cap; nothing is shortened`);
    const r = makeWeek(plan, say);
    if (a.json) { console.log(JSON.stringify(r)); return 0; }
    say(r.reused ? "already made, still valid:" : `made in ${r.encodeSeconds.toFixed(0)} s:`);
    say(`  ${r.path}`);
    say(`  ${fmtMb(r.bytes)}, ${r.seconds.toFixed(2)} s, ${r.shots.length} shots`);
    say(`  clips in play order: ${r.clips.map((c) => c.no ?? "?").join(", ")}`);
    say(r.track ? `  music: ${path.basename(r.track.file)}, ${r.track.bpm.toFixed(2)} BPM from ${r.track.start.toFixed(2)} s` : "  music: none");
    say(credit());
    say(`  caption: ${r.caption.replaceAll("\n", " / ")}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return e instanceof WeekRefusal ? 2 : 1;
  }
}
process.exitCode = main();
