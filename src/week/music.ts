// The fragmovie's music (PLAN.md §6, best of the week): the tracked manifest music.json, the
// downloads into music/ (gitignored, never committed), which track a run uses, and the cached beat
// analysis next to each track (music/<file>.beats.json).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";
import { postFfmpeg } from "../post/ffmpeg.ts";
import { analyse, ANALYSIS_VERSION, envelope, SR, type Analysis, type Envelope } from "./beats.ts";

export const MUSIC_DIR = path.join(ROOT, "music");
export const MANIFEST = path.join(ROOT, "music.json");
export const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"]);

export type Track = { file: string; url: string; sha256: string; bpm: number; title: string; artist: string; license: string; credit: string };

export function loadManifest(file = MANIFEST): Track[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { tracks?: unknown };
  if (!Array.isArray(raw.tracks)) throw new Error(`${path.basename(file)}: needs a "tracks" array`);
  return raw.tracks.map((t, i) => {
    const o = t as Record<string, unknown>;
    const str = (k: string) => { if (typeof o[k] !== "string" || !(o[k] as string).trim()) throw new Error(`${path.basename(file)}: track ${i + 1} needs "${k}"`); return o[k] as string; };
    const f = str("file");
    if (f !== path.basename(f) || !AUDIO_EXT.has(path.extname(f).toLowerCase())) throw new Error(`${path.basename(file)}: track ${i + 1} "file" must be a plain audio file name`);
    const sha = str("sha256").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${path.basename(file)}: ${f} sha256 must be 64 hex digits`);
    if (!/^https:\/\//.test(str("url"))) throw new Error(`${path.basename(file)}: ${f} url must be https`);
    if (typeof o.bpm !== "number" || !(o.bpm >= 40 && o.bpm <= 300)) throw new Error(`${path.basename(file)}: ${f} bpm must be a number in 40–300`);
    return { file: f, url: str("url"), sha256: sha, bpm: o.bpm, title: str("title"), artist: str("artist"), license: str("license"), credit: str("credit") };
  });
}

export const sha256Of = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export type TrackState = { track: Track; state: "ok" | "missing" | "mismatch" };
export const checkTracks = (tracks: Track[], dir = MUSIC_DIR): TrackState[] =>
  tracks.map((track) => {
    const f = path.join(dir, track.file);
    return { track, state: !existsSync(f) ? "missing" : sha256Of(f) === track.sha256 ? "ok" : "mismatch" };
  });

/**
 * Downloads one track to a temp name in `dir`, checks its sha256 and only then renames it into
 * place; a mismatch is deleted and thrown. `get` is fetch (a stand-in in the tests).
 */
export async function fetchTrack(t: Track, dir = MUSIC_DIR, get: typeof fetch = fetch): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, t.file);
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const res = await get(t.url, { headers: { "user-agent": "croclipper (music fetch)" } });
    if (!res.ok) throw new Error(`${t.file}: HTTP ${res.status} from ${t.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== t.sha256) throw new Error(`${t.file}: sha256 ${sha} does not match the manifest's ${t.sha256}; not kept`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The audio files in `dir`, by name. */
export function musicFiles(dir = MUSIC_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && AUDIO_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => d.name)
    .sort((x, y) => x.localeCompare(y, "en", { sensitivity: "base" }));
}

/**
 * Which track a run uses: --music (a path, or a file name in music/), else config.json →
 * montage.music when that file is in music/, else the first audio file by name in music/; null
 * when there is none.
 */
export function pickTrack(music: string | undefined, configured: string | null, dir = MUSIC_DIR): string | null {
  if (music) {
    for (const f of [path.resolve(music), path.join(dir, music)]) if (existsSync(f) && statSync(f).isFile()) return f;
    throw new Error(`--music: no such file: ${music} (neither a path nor a file in ${dir})`);
  }
  if (configured && existsSync(path.join(dir, configured))) return path.join(dir, configured);
  const first = musicFiles(dir)[0];
  return first ? path.join(dir, first) : null;
}

/** The manifest entry for a file in music/ (by name), or undefined. */
export const manifestEntry = (file: string, tracks: Track[]) =>
  path.resolve(path.dirname(file)) === path.resolve(MUSIC_DIR) ? tracks.find((t) => t.file === path.basename(file)) : undefined;

/** Decodes a track to mono Float32 PCM at SR (FFmpeg). Throws when it cannot be decoded. */
export function decodeMono(file: string): Float32Array {
  const r = spawnSync(postFfmpeg(), ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 30 });
  const out = r.stdout as Buffer | null;
  if (r.error || r.status !== 0 || !out || out.length < SR * 4) throw new Error(`cannot decode ${path.basename(file)}: ${r.error?.message ?? String(r.stderr).slice(0, 300) ?? "no audio"}`);
  const copy = new Uint8Array(out.length - (out.length % 4));
  copy.set(out.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

type Cached = { version: number; bytes: number; mtimeMs: number; prior: number | null; analysis: Analysis; env: { sr: number; hop: number; seconds: number; onset: string; low: string; energy: string } };
const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const unb64 = (s: string) => { const b = Buffer.from(s, "base64"); const u = new Uint8Array(b.length); u.set(b); return new Float32Array(u.buffer); };

/**
 * The beat analysis of a track and its envelope, from music/<file>.beats.json when that was made
 * from the same file (size and mtime), the same prior and the same ANALYSIS_VERSION; else decoded,
 * analysed and written there (temp, then rename).
 */
export function trackAnalysis(file: string, prior: number | null): { analysis: Analysis; env: Envelope; cached: boolean } {
  const st = statSync(file);
  const cacheFile = `${file}.beats.json`;
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8")) as Cached;
    if (c.version === ANALYSIS_VERSION && c.bytes === st.size && Math.round(c.mtimeMs) === Math.round(st.mtimeMs) && c.prior === prior)
      return { analysis: c.analysis, env: { sr: c.env.sr, hop: c.env.hop, seconds: c.env.seconds, onset: unb64(c.env.onset), low: unb64(c.env.low), energy: unb64(c.env.energy) }, cached: true };
  } catch { /* none or unreadable: analyse */ }
  const env = envelope(decodeMono(file));
  const analysis = analyse(env, prior);
  const c: Cached = { version: ANALYSIS_VERSION, bytes: st.size, mtimeMs: st.mtimeMs, prior, analysis, env: { sr: env.sr, hop: env.hop, seconds: env.seconds, onset: b64(env.onset), low: b64(env.low), energy: b64(env.energy) } };
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(c)); renameSync(tmp, cacheFile); } catch { /* a cache that cannot be written costs only time */ } finally { rmSync(tmp, { force: true }); }
  return { analysis, env, cached: false };
}
