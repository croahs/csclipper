// The death map's filter, clustering and summary: used by the page in the browser and by the tests.
// The page inlines this file with its types stripped (deathmap/index.ts), so it stays self-contained:
// no imports, erasable TypeScript only, every top-level declaration on its own `export` line.

export type Side = "CT" | "T";
export type Group = "rifle" | "sniper" | "smg" | "pistol" | "shotgun" | "other";
export type Kind = "enemy" | "suicide" | "world" | "team";
/** One death of the POV player. Positions are game X/Y; f: he faced his killer (null: unknown or no killer). */
export type Row = {
  m: number; r: number; s: Side; w: string; g: Group; k: Kind;
  hs: boolean; f: boolean | null; o: boolean; d: number;
  v: [number, number] | null; a: [number, number] | null;
  clip?: number; t?: number;
};
export type Match = { date: string | null; dateFrom: "faceit" | "added" | null; rounds: { CT: number; T: number } };
export type Filter = { side: Side | "all"; group: Group | "all"; behind: boolean; hs: boolean; opening: boolean; match: number };
export type Spot = { x: number; y: number; n: number; members: number[] };

export const SPOT_RADIUS = 300; // game units (about 7.6 m): killers or deaths this close to a spot's seed are one spot

export const ALL: Filter = { side: "all", group: "all", behind: false, hs: false, opening: false, match: -1 };

export function passes(x: Row, f: Filter): boolean {
  return (f.side === "all" || x.s === f.side) && (f.group === "all" || x.g === f.group) && (!f.behind || x.f === false)
    && (!f.hs || x.hs) && (!f.opening || x.o) && (f.match < 0 || x.m === f.match);
}

/** Rounds played under the filter's side and match (the other filters narrow deaths, not rounds). */
export function roundsFor(matches: Match[], f: Filter): number {
  let n = 0;
  matches.forEach((m, i) => { if (f.match < 0 || f.match === i) n += f.side === "all" ? m.rounds.CT + m.rounds.T : m.rounds[f.side]; });
  return n;
}

/**
 * Spots: the densest point (most neighbours within radius) seeds a spot that takes every unassigned
 * point within radius of it; repeat. Deterministic; members are indexes into points; largest first.
 */
export function cluster(points: [number, number][], radius: number = SPOT_RADIUS): Spot[] {
  const r2 = radius * radius;
  const near = (i: number, j: number) => (points[i][0] - points[j][0]) ** 2 + (points[i][1] - points[j][1]) ** 2 <= r2;
  const density = points.map((_, i) => points.reduce((n, _p, j) => n + (near(i, j) ? 1 : 0), 0));
  const order = points.map((_, i) => i).sort((a, b) => density[b] - density[a] || a - b);
  const taken = new Array<boolean>(points.length).fill(false);
  const spots: Spot[] = [];
  for (const seed of order) {
    if (taken[seed]) continue;
    const members = order.filter((j) => !taken[j] && near(seed, j));
    for (const j of members) taken[j] = true;
    const x = members.reduce((s, j) => s + points[j][0], 0) / members.length;
    const y = members.reduce((s, j) => s + points[j][1], 0) / members.length;
    spots.push({ x: Math.round(x), y: Math.round(y), n: members.length, members: members.sort((a, b) => a - b) });
  }
  return spots.sort((a, b) => b.n - a.n);
}

export type Summary = {
  total: number; enemy: number; other: { suicide: number; world: number; team: number };
  rounds: number; perRound: number | null;
  behind: number; facingKnown: number; hs: number; avgDistance: number | null;
  weapons: [string, number][];
  killerSpots: Spot[]; deathSpots: Spot[]; // members index into the rows summarized
};

/** The summary for rows already filtered; killer analysis covers deaths by an enemy only. */
export function summarize(rows: Row[], rounds: number, radius: number = SPOT_RADIUS): Summary {
  const enemyIdx = rows.map((_, i) => i).filter((i) => rows[i].k === "enemy");
  const enemy = enemyIdx.map((i) => rows[i]);
  const other = { suicide: 0, world: 0, team: 0 };
  for (const x of rows) if (x.k !== "enemy") other[x.k]++;
  const weapons = new Map<string, number>();
  for (const x of enemy) weapons.set(x.w, (weapons.get(x.w) ?? 0) + 1);
  const withDist = enemy.filter((x) => x.d > 0);
  const spotsOf = (idx: number[], pos: (x: Row) => [number, number] | null) => {
    const has = idx.filter((i) => pos(rows[i]));
    return cluster(has.map((i) => pos(rows[i])!), radius).map((s) => ({ ...s, members: s.members.map((j) => has[j]) }));
  };
  return {
    total: rows.length, enemy: enemy.length, other, rounds, perRound: rounds ? rows.length / rounds : null,
    behind: enemy.filter((x) => x.f === false).length, facingKnown: enemy.filter((x) => x.f !== null).length,
    hs: enemy.filter((x) => x.hs).length,
    avgDistance: withDist.length ? withDist.reduce((s, x) => s + x.d, 0) / withDist.length : null,
    weapons: [...weapons.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    killerSpots: spotsOf(enemyIdx, (x) => x.a),
    deathSpots: spotsOf(rows.map((_, i) => i), (x) => x.v),
  };
}
