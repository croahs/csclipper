// Beat analysis for the fragmovie (PLAN.md §6, best of the week): tempo, beat phase, bar phase and
// where in the track the montage starts. Pure over mono PCM (Float32, SR Hz) that FFmpeg decodes;
// src/week/music.ts does the decoding and the cache. No dependencies.

export const SR = 22050;
/** Envelope hop and window in samples: 2.9 ms steps, an 11.6 ms trailing window. */
export const HOP = 64;
const WIN = 256;
/** Energy is kept at every ENERGY_STEP-th frame (46 ms) for the per-bar loudness. */
const ENERGY_STEP = 16;
/**
 * Where an onset peaks in the envelope relative to the sound's start: the trailing window sees the
 * attack one hop late on average and the 150 Hz low-pass delays the kick by about 3 ms. Measured
 * on synthetic kicks (test/beats.test.ts), subtracted from every envelope time.
 */
export const ONSET_LAG_S = 0.0045;
/** Bumped when anything above or the analysis changes, so cached analyses are made again. */
export const ANALYSIS_VERSION = 1;

export type Envelope = {
  sr: number;
  hop: number;
  seconds: number;
  /** Onset strength per frame: log-energy flux, low band (< 150 Hz, the kick) and full band mixed. */
  onset: Float32Array;
  /** The low band's flux alone (bar phase: the kick marks the one). */
  low: Float32Array;
  /** Full-band energy (mean square) every ENERGY_STEP frames. */
  energy: Float32Array;
};

/** Second-order low-pass (RBJ biquad, Q 0.707). */
function lowpass(x: Float32Array, sr: number, f: number): Float32Array {
  const w = (2 * Math.PI * f) / sr, alpha = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function logFlux(sig: Float32Array, frames: number): Float32Array {
  const sq = new Float64Array(sig.length + 1);
  for (let i = 0; i < sig.length; i++) sq[i + 1] = sq[i] + sig[i] * sig[i];
  const e = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const end = Math.min(sig.length, i * HOP), start = Math.max(0, end - WIN);
    e[i] = (sq[end] - sq[start]) / WIN;
  }
  const floor = (sq[sig.length] / Math.max(1, sig.length)) * 1e-3 + 1e-12;
  const flux = new Float32Array(frames);
  let prev = Math.log(floor), sum = 0;
  for (let i = 0; i < frames; i++) {
    const l = Math.log(e[i] + floor);
    flux[i] = Math.max(0, l - prev);
    prev = l;
    sum += flux[i];
  }
  const mean = sum / Math.max(1, frames) || 1;
  for (let i = 0; i < frames; i++) flux[i] /= mean;
  return flux;
}

export function envelope(pcm: Float32Array, sr = SR): Envelope {
  const frames = Math.floor(pcm.length / HOP);
  const low = logFlux(lowpass(lowpass(pcm, sr, 150), sr, 150), frames);
  const all = logFlux(pcm, frames);
  const onset = new Float32Array(frames);
  for (let i = 0; i < frames; i++) onset[i] = 0.6 * low[i] + 0.4 * all[i];
  const energy = new Float32Array(Math.ceil(frames / ENERGY_STEP));
  const span = HOP * ENERGY_STEP;
  for (let k = 0; k < energy.length; k++) {
    let s = 0;
    const a = k * span, b = Math.min(pcm.length, a + span);
    for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
    energy[k] = s / Math.max(1, b - a);
  }
  return { sr, hop: HOP, seconds: pcm.length / sr, onset, low, energy };
}

const dtOf = (env: Envelope) => env.hop / env.sr;
const frameRange = (env: Envelope, from: number, to: number) => {
  const dt = dtOf(env);
  return [Math.max(1, Math.ceil((from + ONSET_LAG_S) / dt)), Math.min(env.onset.length, Math.floor((to + ONSET_LAG_S) / dt))];
};
const wrap = (x: number, p: number) => ((x % p) + p) % p;
/** x folded into (-p/2, p/2]. */
export const wrapSigned = (x: number, p: number) => { const w = wrap(x, p); return w > p / 2 ? w - p : w; };

/**
 * The envelope folded onto one beat period: a 1 ms-bin histogram of onset strength by phase,
 * smoothed (Gaussian, 4 ms). Its peak is the beat's phase; its height says how well P fits.
 */
function foldHistogram(env: Envelope, period: number, from: number, to: number, sig = env.onset): Float64Array {
  const dt = dtOf(env), binW = 0.001, n = Math.max(8, Math.round(period / binW)), bw = period / n;
  const h = new Float64Array(n);
  const [a, b] = frameRange(env, from, to);
  for (let i = a; i < b; i++) {
    const v = sig[i];
    if (!v) continue;
    const x = wrap(i * dt - ONSET_LAG_S, period) / bw, k = Math.floor(x), f = x - k;
    h[k % n] += v * (1 - f);
    h[(k + 1) % n] += v * f;
  }
  const r = 12, sg = 4, ker = Array.from({ length: 2 * r + 1 }, (_, j) => Math.exp(-((j - r) ** 2) / (2 * sg * sg)));
  const s = new Float64Array(n);
  for (let k = 0; k < n; k++) { let acc = 0; for (let j = -r; j <= r; j++) acc += h[(k + j + n) % n] * ker[j + r]; s[k] = acc; }
  return s;
}

function fold(env: Envelope, period: number, from: number, to: number): { phase: number; score: number } {
  const s = foldHistogram(env, period, from, to), n = s.length, bw = period / n;
  let best = 0;
  for (let k = 1; k < n; k++) if (s[k] > s[best]) best = k;
  const y0 = s[(best - 1 + n) % n], y1 = s[best], y2 = s[(best + 1) % n];
  const den = y0 - 2 * y1 + y2, off = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
  return { phase: wrap((best + off) * bw, period), score: y1 };
}

export type Grid = { bpm: number; phase: number };

/** Best tempo in [lo, hi] BPM and its phase over [from, to] s: coarse steps of 0.02 %, then 0.002 %. */
export function fitGrid(env: Envelope, lo: number, hi: number, from = 0, to = env.seconds): Grid {
  let best = { bpm: lo, phase: 0, score: -1 };
  const scan = (a: number, b: number, step: number) => {
    for (let bpm = a; bpm <= b + 1e-9; bpm *= 1 + step) {
      const f = fold(env, 60 / bpm, from, to);
      if (f.score > best.score) best = { bpm, ...f };
    }
  };
  scan(lo, hi, 2e-4);
  const c = best.bpm;
  scan(Math.max(lo, c * (1 - 3e-4)), Math.min(hi, c * (1 + 3e-4)), 2e-5);
  return { bpm: best.bpm, phase: best.phase };
}

/** Tempo with no prior: the strongest autocorrelation lag of the onset envelope within 80–190 BPM. */
export function estimateTempo(env: Envelope, lo = 80, hi = 190): number {
  const x = env.onset, dt = dtOf(env), n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  const lagLo = Math.floor(60 / hi / dt), lagHi = Math.ceil(60 / lo / dt);
  const r = new Float64Array(lagHi + 2);
  for (let l = lagLo - 1; l <= lagHi + 1; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += (x[i] - mean) * (x[i + l] - mean);
    r[l] = s;
  }
  let best = lagLo;
  for (let l = lagLo; l <= lagHi; l++) if (r[l] > r[best]) best = l;
  const den = r[best - 1] - 2 * r[best] + r[best + 1];
  const lag = best + (den < 0 ? (0.5 * (r[best - 1] - r[best + 1])) / den : 0);
  return Math.min(hi, Math.max(lo, 60 / (lag * dt)));
}

/** Which beat of four is the one: the residue (0–3, counted from the grid's phase) with the most low-band onset. */
export function barPhase(env: Envelope, g: Grid, from = 0, to = env.seconds): number {
  const beat = 60 / g.bpm, dt = dtOf(env), sums = [0, 0, 0, 0];
  const j0 = Math.ceil((from - g.phase) / beat), j1 = Math.floor((to - g.phase) / beat);
  for (let j = Math.max(0, j0); j <= j1; j++) {
    const t = g.phase + j * beat + ONSET_LAG_S;
    let m = 0;
    for (let i = Math.round((t - 0.015) / dt); i <= Math.round((t + 0.015) / dt); i++) if (i >= 0 && i < env.low.length) m = Math.max(m, env.low[i]);
    sums[j % 4] += m;
  }
  return sums.indexOf(Math.max(...sums));
}

export type Analysis = {
  version: number;
  seconds: number;
  /** The manifest's BPM when given (the fit stays within ±1.5 % of it), else null. */
  prior: number | null;
  /** Autocorrelation estimate with no prior (reported; used only when there is no prior). */
  estimatedBpm: number;
  bpm: number;
  /** Time of a beat (s, in [0, beat)). */
  phase: number;
  /** Beats phase + (downbeat + 4m)·beat are the ones. */
  downbeat: number;
};

export const PRIOR_TOLERANCE = 0.015;

export function analyse(env: Envelope, prior: number | null = null): Analysis {
  const estimatedBpm = estimateTempo(env);
  const centre = prior ?? estimatedBpm;
  const g = fitGrid(env, centre * (1 - PRIOR_TOLERANCE), centre * (1 + PRIOR_TOLERANCE));
  return { version: ANALYSIS_VERSION, seconds: env.seconds, prior, estimatedBpm, bpm: g.bpm, phase: g.phase, downbeat: barPhase(env, g) };
}

/**
 * Grid unit in beats: one bar (4 beats) when a bar lasts at most 1.8 s, else half a bar. Anchors
 * count from a bar line, so every anchored kill lands on the one (or on the half-bar at slow
 * tempi). 175 BPM: a bar, 1.371 s; 136 BPM: a bar, 1.765 s; 100 BPM: half a bar, 1.2 s.
 */
export const unitBeats = (beatSeconds: number) => (4 * beatSeconds <= 1.8 + 1e-9 ? 4 : 2);

export type MusicPlan = {
  /** Time of a beat (s, in [0, beat)) of the grid used. */
  phase: number;
  bpm: number;
  beatSeconds: number;
  /** Track time (s) of the video's t = 0: a bar line. */
  start: number;
  /** Bars needed, and when the track is too short even from its first bar: loop this many seconds from start. */
  bars: number;
  loopSeconds: number | null;
  /** The grid used is the one refitted on the used section (refit tried and accepted). */
  refit: boolean;
  /** A refit was tried (the whole-file grid was off at an end) but rejected, so the whole-file grid stays. */
  refitRejected: boolean;
  /**
   * How far the onsets of the first and the last 16 beats of the used section sit from the grid
   * (ms, signed; null: no clear peak there), with the whole-file grid and with the refitted grid
   * when one was tried.
   */
  driftMs: { before: [number | null, number | null]; refitted: [number | null, number | null] | null };
};

/** Mean energy of each bar from `first` on, in dB. */
export function barEnergies(env: Envelope, first: number, bar: number): number[] {
  const step = dtOf(env) * ENERGY_STEP, out: number[] = [];
  for (let t = first; t + bar <= env.seconds + 1e-9; t += bar) {
    let s = 0, n = 0;
    for (let k = Math.floor(t / step); k < Math.min(env.energy.length, Math.floor((t + bar) / step)); k++) { s += env.energy[k]; n++; }
    out.push(10 * Math.log10(s / Math.max(1, n) + 1e-12));
  }
  return out;
}

/**
 * The first bar of the drop: the window of `need` bars with the highest mean loudness, plus a bonus
 * for a jump in loudness into its first bar (a drop starts there, not one bar into it). Ties: earliest.
 */
export function chooseStartBar(db: number[], need: number): number {
  let best = 0, bestScore = -Infinity;
  for (let s = 0; s + need <= db.length; s++) {
    let m = 0;
    for (let k = s; k < s + need; k++) m += db[k];
    m /= need;
    const jump = s > 0 ? Math.max(0, db[s] - db[s - 1]) : 0;
    const score = m + 0.5 * Math.min(jump, 6);
    if (score > bestScore + 1e-9) { bestScore = score; best = s; }
  }
  return best;
}

/**
 * Signed distance (s) of the onsets in [from, to] from the grid: that stretch folded onto the beat,
 * its peak looked for within ±60 ms (at most a quarter beat) of the grid's phase. A breakdown whose
 * strongest onsets are off the beat (hats on the and) would otherwise read as a half-beat error.
 * null when the stretch has no clear peak there (under 1.5× the fold's mean): no evidence either way.
 */
export function phaseError(env: Envelope, g: Grid, from: number, to: number): number | null {
  const beat = 60 / g.bpm;
  const h = foldHistogram(env, beat, from, to);
  const n = h.length, bw = beat / n, reach = Math.min(0.06, beat / 4);
  const centre = g.phase / bw;
  let best = -1, bestV = -Infinity, mean = 0;
  for (let k = 0; k < n; k++) mean += h[k] / n;
  for (let d = -Math.round(reach / bw); d <= Math.round(reach / bw); d++) {
    const k = (((Math.round(centre) + d) % n) + n) % n;
    if (h[k] > bestV) { bestV = h[k]; best = Math.round(centre) + d; }
  }
  if (!(bestV > 1.5 * mean)) return null;
  return wrapSigned(best * bw - g.phase, beat);
}

const DRIFT_TOLERANCE_MS = 10;

/**
 * Whether a refitted grid replaces the whole-file one: both ends of the used section must show a
 * clear peak with both grids, the worst end must improve, and neither end may get worse beyond the
 * drift tolerance (an end already within 10 ms may move within 10 ms: a strict "better at both"
 * would reject a refit that fixes 39 ms at one end for 3 ms at the other).
 */
export function acceptRefit(before: [number | null, number | null], after: [number | null, number | null]): boolean {
  if ([...before, ...after].some((x) => x === null)) return false;
  const b = before.map((x) => Math.abs(x!)), f = after.map((x) => Math.abs(x!));
  return Math.max(...f) < Math.max(...b) && f.every((x, i) => x <= Math.max(b[i], DRIFT_TOLERANCE_MS));
}

/** Where the video starts in the track, and the grid used for the `seconds` it needs. */
export function planTrack(env: Envelope, a: Analysis, seconds: number): MusicPlan {
  const g: Grid = { bpm: a.bpm, phase: a.phase };
  const beat = 60 / g.bpm, bar = 4 * beat;
  const firstDown = wrap(g.phase + a.downbeat * beat, bar);
  const need = Math.max(1, Math.ceil(seconds / bar - 1e-9));
  const db = barEnergies(env, firstDown, bar);
  if (db.length < need) {
    const loop = Math.max(1, db.length) * bar;
    return { bpm: g.bpm, phase: g.phase, beatSeconds: beat, start: firstDown, bars: need, loopSeconds: loop, refit: false, refitRejected: false, driftMs: { before: [null, null], refitted: null } };
  }
  const start = firstDown + chooseStartBar(db, need) * bar;
  // Checked at both ends of the used section: a grid can sit on the onsets at one end only.
  const ends = (gr: Grid, s: number, b: number): [number | null, number | null] => {
    const ms = (x: number | null) => (x === null ? null : x * 1000);
    const bt = 60 / gr.bpm;
    return [ms(phaseError(env, gr, s, s + 16 * bt)), ms(phaseError(env, gr, s + need * b - 16 * bt, s + need * b))];
  };
  const before = ends(g, start, bar);
  const keep: MusicPlan = { bpm: g.bpm, phase: g.phase, beatSeconds: beat, start, bars: need, loopSeconds: null, refit: false, refitRejected: false, driftMs: { before, refitted: null } };
  if (!before.some((x) => x !== null && Math.abs(x) > DRIFT_TOLERANCE_MS)) return keep;
  const centre = a.prior ?? a.bpm;
  const fitted = fitGrid(env, centre * (1 - PRIOR_TOLERANCE), centre * (1 + PRIOR_TOLERANCE), start, start + need * bar);
  const down = barPhase(env, fitted, start, start + need * bar);
  const fBeat = 60 / fitted.bpm, fBar = 4 * fBeat;
  // The bar line of the refitted grid nearest the chosen start, kept inside the track.
  const d0 = fitted.phase + down * fBeat;
  let fStart = d0 + Math.round((start - d0) / fBar) * fBar;
  while (fStart < 0) fStart += fBar;
  while (fStart + need * fBar > env.seconds && fStart - fBar >= 0) fStart -= fBar;
  const after = ends(fitted, fStart, fBar);
  if (!acceptRefit(before, after)) return { ...keep, refitRejected: true, driftMs: { before, refitted: after } };
  return { bpm: fitted.bpm, phase: fitted.phase, beatSeconds: fBeat, start: fStart, bars: need, loopSeconds: null, refit: true, refitRejected: false, driftMs: { before, refitted: after } };
}
