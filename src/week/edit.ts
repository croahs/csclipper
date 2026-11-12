// The fragmovie's edit (PLAN.md §6, best of the week): kills to clip seconds, shots around them,
// and their placement on the music's grid so every shot's first kill lands on an anchor. Pure.

/** A clip's time map (index.json → render.segments): demo ticks to seconds in the clip file. */
export type Segment = { startTick: number; endTick: number; speed: number; outSeconds: number };

/** Seconds into the clip at which a demo tick plays; ticks outside the clip clamp to its ends. */
export function tickSeconds(segs: Segment[], tick: number): number {
  let t = 0;
  for (const s of segs) {
    if (tick < s.startTick) return t;
    if (tick <= s.endTick) return t + ((tick - s.startTick) / (s.endTick - s.startTick || 1)) * s.outSeconds;
    t += s.outSeconds;
  }
  return t;
}

/** The stretches of the clip (seconds) that play faster or slower than real time. */
export function fastRanges(segs: Segment[]): [number, number][] {
  const out: [number, number][] = [];
  let t = 0;
  for (const s of segs) {
    if (s.speed !== 1) out.push([t, t + s.outSeconds]);
    t += s.outSeconds;
  }
  return out;
}

export type ShotRules = { preSeconds: number; postSeconds: number };
/**
 * A shot in clip seconds: [from, to] is its natural extent (kills ± the rules, clamped), and
 * [leadLimit, tailLimit] how far it may be stretched to fill the grid (the clip's ends, a
 * fast-forward stretch, the neighbouring shot of the same clip).
 */
export type Shot = { from: number; to: number; kills: number[]; leadLimit: number; tailLimit: number };

/**
 * Shots around a clip's kills (clip seconds): from preSeconds before a kill to postSeconds after
 * it; kills whose shots touch or overlap merge into one (a burst plays in real time) unless a
 * fast-forward stretch lies between them. Clamped to the clip, and never starting or ending
 * inside a fast-forward stretch (moved to its boundary).
 */
export function buildShots(kills: number[], clipSeconds: number, fast: [number, number][], r: ShotRules): Shot[] {
  const ks = [...kills].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const k of ks) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    const fastBetween = last !== undefined && fast.some(([a, b]) => a < k && b > last && !(a <= last && b >= k));
    if (g && k - r.preSeconds <= last! + r.postSeconds && !fastBetween) g.push(k);
    else groups.push([k]);
  }
  const raw = groups.map((g) => {
    const first = g[0], last = g[g.length - 1];
    let from = Math.max(0, first - r.preSeconds), to = Math.min(clipSeconds, last + r.postSeconds);
    for (const [a, b] of fast) {
      if (b <= first && b > from) from = b;
      else if (a < from && from < b) from = a; // the kill itself is inside the stretch
      if (a >= last && a < to) to = a;
      else if (a < to && to < b) to = b;
    }
    return { from, to, kills: g, leadLimit: 0, tailLimit: clipSeconds };
  });
  // Moving ends to a fast-forward boundary can make two shots overlap (kills on either side of,
  // or inside, one stretch both widened to it): such shots become one, each kill kept once, so
  // no frame is planned twice.
  const shots: Shot[] = [];
  for (const s of raw) {
    const p = shots[shots.length - 1];
    if (p && s.from < p.to - 1e-9) {
      p.from = Math.min(p.from, s.from);
      p.to = Math.max(p.to, s.to);
      p.kills = [...new Set([...p.kills, ...s.kills])].sort((a, b) => a - b);
    } else shots.push(s);
  }
  for (const [i, s] of shots.entries()) {
    s.leadLimit = Math.max(0, i > 0 ? shots[i - 1].to : 0, ...fast.filter(([, b]) => b <= s.from).map(([, b]) => b));
    s.tailLimit = Math.min(clipSeconds, i < shots.length - 1 ? shots[i + 1].from : clipSeconds, ...fast.filter(([a]) => a >= s.to).map(([a]) => a));
  }
  return shots;
}

/** The music's grid in video seconds: anchors every `unit`, bar lines every `bar`, both from t = 0. */
export type Grid = { unit: number; bar: number };
export type ClipCut = { clip: number; shots: Shot[] };

export type Placed = {
  clip: number;
  /** Clip seconds played, [from, to); past `to - hold` the last frame of footage is held. */
  from: number;
  to: number;
  kills: number[];
  /** Video seconds: where the first kill lands (an anchor), where the shot is cut in, where it ends. */
  anchor: number;
  cut: number;
  end: number;
  /** Seconds the last frame is held because the clip's end or a fast-forward stretch stopped the tail. */
  hold: number;
  /** How many following shots of the same clip were merged into this one (their kills are off the grid). */
  merged: number;
};
export type Timeline = { card: number; shots: Placed[]; closeAt: number; total: number };

const EPS = 1e-6;
/** How much of the last kill the anchor-earlier fallback must keep on screen. */
const KEEP_AFTER_LAST_KILL = 0.25;

/**
 * Places the shots (in the order given) on the grid. The title card is one bar; the first shot is
 * cut in on that bar line and its first kill lands on the first anchor after its lead-in. Each
 * next shot takes the first anchor late enough that the previous shot has played to its natural
 * end before the cut; the slack is filled by the previous shot's tail, then by this shot's
 * lead-in, else the anchor moves one unit earlier when the previous shot still shows its last
 * kill + 0.25 s. Failing all three, footage is never played twice: when the neighbouring shot of
 * the same clip is what stopped the fill, the two merge into one continuous shot (the later kills
 * off the grid, like a burst); when the clip's end or a fast-forward stretch stopped it, the
 * previous shot holds its last frame. After the last shot's natural end the video runs on to the
 * next bar line, then fades for a bar.
 *
 * Two behaviours that are intended, not bugs:
 * - "Hold to the bar line" means the last shot's footage keeps PLAYING to that bar line and on
 *   through the closing fade; nothing is frozen there. A frame is held only when the clip itself
 *   runs out of footage first (hold > 0).
 * - When the first shot's clip has too little footage before its first kill to reach back to the
 *   bar line after the card, the title card stays up longer than one bar (card > bar); the first
 *   kill still lands on an anchor, the cut into it just comes later than the bar line.
 */
export function layout(clips: ClipCut[], grid: Grid): Timeline {
  const { unit, bar } = grid;
  const flat = clips.flatMap((c) => c.shots.map((s) => ({ clip: c.clip, s })));
  if (!flat.length) throw new Error("layout: no shots");
  const up = (t: number) => Math.ceil(t / unit - EPS) * unit;
  // Each placed shot with its natural end and tail limit (a merge moves both).
  const placed: (Placed & { natTo: number; tailLimit: number })[] = [];
  let card = bar;
  for (const [i, { clip, s }] of flat.entries()) {
    const k0 = s.kills[0], lead = k0 - s.from;
    if (i === 0) {
      const anchor = up(bar + lead);
      let from = k0 - (anchor - bar), cut = bar;
      // Not enough footage before the kill: the card stays up longer, the kill stays on its anchor.
      if (from < s.leadLimit - EPS) { from = s.leadLimit; cut = anchor - (k0 - from); }
      card = cut;
      placed.push({ clip, from, to: s.to, kills: [...s.kills], anchor, cut, end: 0, hold: 0, merged: 0, natTo: s.to, tailLimit: s.tailLimit });
      continue;
    }
    const p = placed[placed.length - 1];
    const sameClip = p.clip === clip;
    const prevEnd = p.anchor + (p.natTo - p.kills[0]);
    let anchor = up(prevEnd + lead), cut = anchor - lead, from = s.from;
    let slack = cut - prevEnd;
    const t = Math.min(slack, Math.max(0, p.tailLimit - p.natTo));
    p.to = p.natTo + t;
    slack -= t;
    if (slack > EPS) {
      const limit = Math.max(s.leadLimit, sameClip ? p.to : 0);
      const l = Math.min(slack, Math.max(0, from - limit));
      from -= l; cut -= l; slack -= l;
    }
    if (slack > EPS) {
      const a2 = anchor - unit, cut2 = a2 - lead, prevTo = p.kills[0] + (cut2 - p.anchor);
      if (cut2 > p.cut + EPS && prevTo >= p.kills[p.kills.length - 1] + KEEP_AFTER_LAST_KILL - EPS) {
        anchor = a2; cut = cut2; from = s.from; p.to = prevTo; slack = 0;
      }
    }
    if (slack > EPS) {
      if (sameClip && Math.abs(p.tailLimit - s.from) < EPS) {
        // The neighbour stopped the fill: play through it as one shot.
        p.kills.push(...s.kills); p.natTo = s.to; p.to = s.to; p.tailLimit = s.tailLimit; p.merged++;
        continue;
      }
      p.to += slack; p.hold = slack;
    }
    placed.push({ clip, from, to: s.to, kills: [...s.kills], anchor, cut, end: 0, hold: 0, merged: 0, natTo: s.to, tailLimit: s.tailLimit });
  }
  const last = placed[placed.length - 1];
  const naturalEnd = last.anchor + (last.natTo - last.kills[0]);
  const closeAt = Math.ceil(naturalEnd / bar - EPS) * bar;
  const total = closeAt + bar;
  // The last shot keeps playing footage through the hold and the fade; only past its tail limit is a frame held.
  last.to = last.kills[0] + (total - last.anchor);
  last.hold = Math.max(0, last.to - last.tailLimit);
  for (const [i, p] of placed.entries()) p.end = i + 1 < placed.length ? placed[i + 1].cut : total;
  return { card, shots: placed.map(({ natTo: _n, tailLimit: _t, ...p }) => p), closeAt, total };
}

export type FrameShot = { clip: number; inFrame: number; frames: number; holdFrames: number; cutFrame: number; anchor: number; kills: number[]; merged: number };
export type FramePlan = { fps: number; cardFrames: number; shots: FrameShot[]; closeAt: number; total: number; totalFrames: number };

/**
 * The timeline in whole frames: every cut on a frame of the video, every in-point on a frame of
 * the clip, chosen so the first kill lands within half a frame of its anchor. holdFrames: the
 * shot's last frames that repeat its last frame of footage.
 */
export function toFrames(tl: Timeline, fps: number): FramePlan {
  const totalFrames = Math.round(tl.total * fps);
  const cuts = tl.shots.map((s) => Math.round(s.cut * fps));
  const shots = tl.shots.map((s, i) => {
    const frames = (i + 1 < cuts.length ? cuts[i + 1] : totalFrames) - cuts[i];
    const inFrame = Math.max(0, Math.round(s.kills[0] * fps - s.anchor * fps + cuts[i]));
    // Footage up to the clip frame where it stops (the clip's end or a fast-forward stretch).
    const footage = s.hold > EPS ? Math.max(1, Math.min(frames, Math.round((s.to - s.hold) * fps) - inFrame)) : frames;
    return {
      clip: s.clip,
      cutFrame: cuts[i],
      inFrame,
      frames,
      holdFrames: frames - footage,
      anchor: s.anchor,
      kills: s.kills,
      merged: s.merged,
    };
  });
  return { fps, cardFrames: cuts[0], shots, closeAt: tl.closeAt, total: totalFrames / fps, totalFrames };
}

/** Video time (s) at which a clip-time kill plays in a framed shot. */
export const killVideoTime = (s: FrameShot, kill: number, fps: number) => (s.cutFrame + kill * fps - s.inFrame) / fps;

/**
 * The cap: while the video is longer than maxSeconds, drop whole clips from the low-score end
 * (`clips` is in play order, ascending score), never the best three. Returns the clips kept, the
 * timeline, and whether it is still over the cap.
 */
export function fitCap(clips: ClipCut[], grid: Grid, maxSeconds: number): { kept: ClipCut[]; dropped: ClipCut[]; timeline: Timeline; over: boolean } {
  let kept = clips;
  let tl = layout(kept, grid);
  while (tl.total > maxSeconds + EPS && kept.length > 3) {
    kept = kept.slice(1);
    tl = layout(kept, grid);
  }
  return { kept, dropped: clips.slice(0, clips.length - kept.length), timeline: tl, over: tl.total > maxSeconds + EPS };
}
