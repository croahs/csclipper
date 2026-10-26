// Raw captures: HLAE's intermediate video and audio per take, about 700 MB per clip. They
// exist so a failed post never costs another launch (job.ts, completedCapture). Once the
// clip is in the library they are dead weight: a held clip is never re-rendered from them
// (AGENTS.md; pnpm clip --rerender always renders afresh), and a deleted one is never made
// again. pruneTakes runs right after a unit's publish; pruneHeldCaptures (pnpm tidy, and
// the end of every pnpm go) sweeps what earlier runs left: every capture.json under
// state/render/<id>/ for an id the library holds or state/deleted.json lists. capture.json,
// console.log, the cfgs and render.json stay, for forensics and the issue template.
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, Refusal, STATE_DIR } from "../config.ts";
import { readDeleted, readIndex } from "../library/index.ts";
import { RenderLock } from "../render/controller/guards.ts";
import { tailUnder } from "../state-paths.ts";

export const RENDER_DIR = path.join(STATE_DIR, "render");
const CLIP_LOCK = path.join(STATE_DIR, ".clip.lock");

/** Only these are ever deleted, whatever a capture.json says (the capture pipe's names, capture/hlae.ts). */
const MEDIA = /^(video\d*\.mp4|audio\.wav)$/i;

/**
 * A capture's media path under renderDir: the record names it relative to the repo
 * (state-paths.ts), or, from before that rule, absolute in a folder the repo may have left, so
 * the part after state/render/ is re-rooted. A path without that part is resolved as it is.
 */
export function localRenderPath(recorded: string, renderDir = RENDER_DIR): string {
  const tail = tailUnder(recorded, "state/render");
  return tail ? path.join(renderDir, ...tail) : path.resolve(ROOT, recorded);
}

export type Pruned = { files: number; bytes: number; problems: string[] };

/**
 * Deletes the take media a capture record names. A file already gone counts as done; a file
 * that cannot be deleted (open in a player) or a path that is not a capture file under
 * renderDir is a problem, never a throw: the clip is published either way.
 */
export function pruneTakes(takes: { video: string; audio: string }[], renderDir = RENDER_DIR): Pruned {
  const out: Pruned = { files: 0, bytes: 0, problems: [] };
  if (!existsSync(renderDir)) return out;
  const root = realpathSync.native(renderDir) + path.sep;
  for (const f of takes.flatMap((t) => [t.video, t.audio])) {
    const local = localRenderPath(f, renderDir);
    if (!existsSync(local)) continue;
    // Physically under renderDir (a junction or link inside it does not count), and named like capture media.
    let inside = false;
    try { inside = realpathSync.native(path.dirname(local)).startsWith(root); } catch {}
    if (!inside || !MEDIA.test(path.basename(local))) { out.problems.push(`not a capture file under ${renderDir}, left alone: ${f}`); continue; }
    try {
      const bytes = statSync(local).size;
      rmSync(local);
      out.files++;
      out.bytes += bytes;
    } catch (e) {
      out.problems.push(`${local}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Media of every capture under renderDir/<id>/ whose id is held (default: the library's clips and the deleted ones). */
export function pruneHeldCaptures(o: { renderDir?: string; held?: Set<string> } = {}): Pruned & { clips: number } {
  const renderDir = o.renderDir ?? RENDER_DIR;
  const held = o.held ?? new Set([...Object.keys(readIndex().clips), ...Object.keys(readDeleted())]);
  const out = { files: 0, bytes: 0, problems: [] as string[], clips: 0 };
  if (!existsSync(renderDir)) return out;
  for (const id of readdirSync(renderDir)) {
    if (!held.has(id)) continue;
    const dir = path.join(renderDir, id);
    let attempts: string[];
    try { attempts = readdirSync(dir); } catch { continue; }
    let any = false;
    for (const attempt of attempts) {
      const file = path.join(dir, attempt, "capture.json");
      if (!existsSync(file)) continue;
      let takes: { video: string; audio: string }[];
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        // Records written before reels hold a single take's fields at the top level (job.ts).
        takes = (Array.isArray(raw.takes) ? raw.takes : [raw]).filter((t: { video?: unknown; audio?: unknown }) => typeof t.video === "string" && typeof t.audio === "string");
      } catch (e) {
        out.problems.push(`${file}: ${(e as Error).message}`);
        continue;
      }
      const p = pruneTakes(takes, renderDir);
      out.files += p.files;
      out.bytes += p.bytes;
      out.problems.push(...p.problems);
      if (p.files) any = true;
    }
    if (any) out.clips++;
  }
  return out;
}

/**
 * The sweep under the clip lock, which every render run holds from its resume check to its index
 * write: a same-id pnpm clip --rerender writes its fresh capture while the old entry is still
 * held, and a sweep meanwhile would delete it before post reads it. Undefined when the lock is
 * held: the sweep is skipped, nothing waits (a dead run's lock is reported, never taken over).
 */
export function sweepUnderClipLock(o: { renderDir?: string; held?: Set<string>; lockFile?: string } = {}): (Pruned & { clips: number }) | undefined {
  const lock = new RenderLock(o.lockFile ?? CLIP_LOCK);
  try { lock.acquire(); } catch (e) { if (e instanceof Refusal) return undefined; throw e; }
  try { return pruneHeldCaptures(o); } finally { lock.release(); }
}

export const prunedLine = (p: Pruned & { clips?: number }) =>
  `raw captures removed: ${p.files} file(s)${p.clips !== undefined ? ` of ${p.clips} clip(s)` : ""}, ${(p.bytes / 1e9).toFixed(1)} GB freed`;
