// pnpm week's beat analysis on synthetic audio: click tracks generated here as PCM, no files.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptRefit, analyse, chooseStartBar, envelope, planTrack, SR, unitBeats, wrapSigned } from "../src/week/beats.ts";

/** Deterministic noise, so a failing run can be repeated exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A kick at each time in `at` (s): a 55 Hz body decaying over 60 ms and a 4 ms click, plus quiet noise. */
function clicks(at: number[], seconds: number, gain: (i: number) => number = () => 1): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * SR));
  const r = rng(7);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.003 * r();
  for (const [k, t] of at.entries()) {
    const s0 = Math.round(t * SR), g = gain(k);
    for (let j = 0; j < Math.round(0.15 * SR) && s0 + j < pcm.length; j++) {
      const u = j / SR;
      pcm[s0 + j] += g * (0.8 * Math.sin(2 * Math.PI * 55 * u) * Math.exp(-u / 0.06) + 0.3 * r() * Math.exp(-u / 0.004));
    }
  }
  return pcm;
}
const grid = (bpm: number, offset: number, seconds: number) => {
  const out: number[] = [];
  for (let t = offset; t < seconds; t += 60 / bpm) out.push(t);
  return out;
};

for (const bpm of [175, 138, 100]) {
  test(`click track at ${bpm} BPM: tempo within 0.5 % and phase within 15 ms, with and without the prior`, () => {
    const offset = 0.123, beat = 60 / bpm;
    const env = envelope(clicks(grid(bpm, offset, 60), 60));
    for (const prior of [bpm, null]) {
      const a = analyse(env, prior);
      assert.ok(Math.abs(a.bpm / bpm - 1) < 0.005, `prior ${prior}: ${a.bpm} BPM`);
      const err = wrapSigned(a.phase - offset, beat);
      assert.ok(Math.abs(err) < 0.015, `prior ${prior}: phase off by ${(err * 1000).toFixed(1)} ms`);
    }
    assert.ok(Math.abs(analyse(env, null).estimatedBpm / bpm - 1) < 0.005, "the estimate alone, no octave error");
  });
}

test("accents on every fourth click: the bar's one is found", () => {
  const bpm = 138, offset = 0.2, beat = 60 / bpm;
  // The accented clicks are the 3rd, 7th, ... (index 2 mod 4).
  const env = envelope(clicks(grid(bpm, offset, 40), 40, (k) => (k % 4 === 2 ? 1 : 0.35)));
  const a = analyse(env, bpm);
  const firstAccent = offset + 2 * beat;
  const down = a.phase + a.downbeat * beat;
  assert.ok(Math.abs(wrapSigned(down - firstAccent, 4 * beat)) < 0.015, `downbeat at ${down}, accent at ${firstAccent}`);
});

test("unitBeats: one bar when a bar lasts at most 1.8 s, else half a bar", () => {
  assert.equal(unitBeats(60 / 175), 4); // 1.371 s per kill
  assert.equal(unitBeats(60 / 136), 4); // 1.765 s
  assert.equal(unitBeats(60 / 134), 4); // 1.791 s, just under
  assert.equal(unitBeats(60 / 130), 2); // a bar of 1.846 s: half bars of 0.923 s
  assert.equal(unitBeats(60 / 100), 2); // half bars of 1.2 s
});

test("acceptRefit: both ends clear with both grids, the worst end better, neither end worse past 10 ms", () => {
  assert.equal(acceptRefit([-39, 3], [-5, -6]), true, "fixes the start, the end moves within 10 ms");
  assert.equal(acceptRefit([20.7, null], [1, 2]), false, "no evidence at one end with the whole-file grid");
  assert.equal(acceptRefit([20, 5], [2, null]), false, "no evidence at one end with the refitted grid");
  assert.equal(acceptRefit([20, 5], [2, 15]), false, "the end gets worse past the tolerance");
  assert.equal(acceptRefit([12, 30], [14, 25]), false, "an end over 10 ms gets worse");
  assert.equal(acceptRefit([12, 30], [11, 4]), true);
});

test("chooseStartBar: the loudest stretch, starting where the loudness jumps", () => {
  const db = [-30, -30, -30, -30, -12, -12, -12, -12, -12, -12, -25, -25];
  assert.equal(chooseStartBar(db, 4), 4);
  assert.equal(chooseStartBar(db, 12), 0);
});

test("a 1 % tempo drift: the used-section fit keeps the last anchor within 20 ms of its click", () => {
  // 180 s whose tempo slides linearly from 175 to 176.75 BPM; the beat times are its integral.
  const seconds = 180, at: number[] = [];
  for (let t = 0.05; t < seconds; ) { at.push(t); t += 60 / (175 * (1 + 0.01 * (t / seconds))); }
  const env = envelope(clicks(at, seconds));
  const a = analyse(env, 175);
  const m = planTrack(env, a, 40);
  const beats = Math.round((m.bars * 4 * m.beatSeconds) / m.beatSeconds);
  const last = m.start + beats * m.beatSeconds; // the grid's beat at the end of the used section
  const nearest = at.reduce((b, t) => (Math.abs(t - last) < Math.abs(b - last) ? t : b), at[0]);
  assert.ok(m.refit, `the refit was accepted: ${JSON.stringify(m.driftMs)}`);
  assert.ok(Math.abs(nearest - last) < 0.020, `last anchor ${((last - nearest) * 1000).toFixed(1)} ms from its click (refit ${m.refit}, ${JSON.stringify(m.driftMs)})`);
  // and the start is a click (a bar line of the fitted grid)
  const s = at.reduce((b, t) => (Math.abs(t - m.start) < Math.abs(b - m.start) ? t : b), at[0]);
  assert.ok(Math.abs(s - m.start) < 0.020, `start ${m.start} vs click ${s}`);
});

test("a track too short for the video loops on a bar line", () => {
  const env = envelope(clicks(grid(120, 0.1, 20), 20));
  const m = planTrack(env, analyse(env, 120), 60);
  const bars = m.loopSeconds === null ? NaN : m.loopSeconds / (4 * m.beatSeconds);
  assert.ok(Math.abs(bars - Math.round(bars)) < 1e-6 && bars >= 8, `loop ${m.loopSeconds} s`);
  assert.ok(Math.abs(wrapSigned(m.start - 0.1, 0.5)) < 0.015);
});
