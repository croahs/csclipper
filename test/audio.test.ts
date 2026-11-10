// Even sound: the filter builder, post's graph with and without it, and the share key. Pure
// functions plus one temp file for the key; no FFmpeg.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAudioMode, loadEvenAudio, type EvenAudio, type RenderSettings } from "../src/config.ts";
import { audioFilter } from "../src/post/audio.ts";
import { postGraph, segments } from "../src/post/index.ts";
import { shareKey } from "../src/share/index.ts";

const P: EvenAudio = { thresholdDb: -40, ratio: 3, attackMs: 5, releaseMs: 400, makeupDb: 20, limitDb: -3 };
const CHAIN = "acompressor=threshold=-40dB:ratio=3:attack=5:release=400:makeup=20dB,alimiter=limit=-3dB:attack=5:release=100:level=0:latency=1";

test("audioFilter: raw adds nothing, even is the exact chain", () => {
  assert.equal(audioFilter("raw", P), "");
  assert.equal(audioFilter("even", P), CHAIN);
  assert.equal(audioFilter("even", { ...P, thresholdDb: -24.5, makeupDb: 0 }), CHAIN.replace("-40dB", "-24.5dB").replace("makeup=20dB", "makeup=0dB"));
});

test("audioFilter: refuses parameters out of FFmpeg's range", () => {
  for (const bad of [{ thresholdDb: -61 }, { thresholdDb: 1 }, { ratio: 0.5 }, { ratio: 21 }, { attackMs: 0 }, { releaseMs: 10000 }, { makeupDb: -1 }, { makeupDb: 37 }, { limitDb: -25 }, { limitDb: 0.5 }, { ratio: Number.NaN }]) {
    assert.throws(() => audioFilter("even", { ...P, ...bad }), /config\.json audio\./, JSON.stringify(bad));
  }
  assert.throws(() => audioFilter("loud" as never, P), /raw" or "even/);
});

test("config.json: post defaults to raw, share to even, and the shipped parameters build", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "croclipper-audio-"));
  try {
    const f = path.join(dir, "config.json");
    writeFileSync(f, "{}");
    assert.equal(loadAudioMode("post", f), "raw");
    assert.equal(loadAudioMode("share", f), "even");
    writeFileSync(f, JSON.stringify({ post: { audio: "loud" } }));
    assert.throws(() => loadAudioMode("post", f), /post\.audio/);
    assert.throws(() => loadEvenAudio(f), /audio\.thresholdDb/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(loadAudioMode("post"), "raw");
  assert.ok(audioFilter("even", loadEvenAudio()).startsWith("acompressor="));
});

const m = { fps: 60, tickrate: 64, recordStartTick: 1000, recordEndTick: 3812, frames: 3000 };
const s: RenderSettings = { aspect: "native", hud: "full", width: 1920, height: 1080, fps: 60, captureCrf: 12, crf: 22, fadeSeconds: 0.25 };
const segs = segments(m, 1300, 3000, [{ startTick: 1300, endTick: 1700 }, { startTick: 2600, endTick: 3000 }]);
const d = segs.reduce((n, x) => n + x.outSeconds, 0);
// The graph main (fd6046c) builds for these segments, byte for byte.
const MAIN_GRAPH = "[0:v]split=3[vs0][vs1][vs2];[1:a]asplit=3[as0][as1][as2];[vs0]trim=start_frame=278:end_frame=653,setpts=PTS-STARTPTS[v0];[as0]atrim=start=4.633333:end=10.883333,asetpts=PTS-STARTPTS[a0];[vs1]trim=start_frame=653:end_frame=1497,setpts=(PTS-STARTPTS)/8,fps=60[v1];[as1]atrim=start=10.883333:end=12.641667,asetpts=PTS-STARTPTS,volume=0[a1];[vs2]trim=start_frame=1497:end_frame=1872,setpts=PTS-STARTPTS[v2];[as2]atrim=start=24.950000:end=31.200000,asetpts=PTS-STARTPTS[a2];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac];[vc]null,fade=t=in:st=0:d=0.25,fade=t=out:st=14.008333:d=0.25[v];[ac]anull,afade=t=in:st=0:d=0.25,afade=t=out:st=14.008333:d=0.25[a]";

test("postGraph: raw is main's graph unchanged", () => {
  assert.equal(postGraph(segs, 60, s, d), MAIN_GRAPH);
  assert.equal(postGraph(segs, 60, s, d, audioFilter("raw", P)), MAIN_GRAPH);
});

test("postGraph: even runs the chain after the concat (fast-forward stays muted) and before the fades", () => {
  const g = postGraph(segs, 60, s, d, CHAIN);
  assert.equal(g, MAIN_GRAPH.replace("[ac]anull,afade", `[ac]anull,${CHAIN},afade`));
  assert.ok(g.indexOf("volume=0") < g.indexOf("concat") && g.indexOf("concat") < g.indexOf("acompressor"));
});

test("shareKey: raw keeps the key a file made before even sound has; even and its parameters change it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "croclipper-audio-"));
  try {
    const f = path.join(dir, "clip.mp4");
    writeFileSync(f, "x");
    const st = statSync(f);
    const legacy = createHash("sha256").update(`1:abc:${st.size}:${Math.round(st.mtimeMs)}:1000`).digest("hex").slice(0, 16);
    const e = { id: "abc" };
    assert.equal(shareKey(e, f, 1000), legacy);
    assert.equal(shareKey(e, f, 1000, audioFilter("raw", P)), legacy);
    const even = shareKey(e, f, 1000, audioFilter("even", P));
    assert.notEqual(even, legacy);
    assert.notEqual(shareKey(e, f, 1000, audioFilter("even", { ...P, makeupDb: 18 })), even);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
