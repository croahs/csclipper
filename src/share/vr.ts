// VR copies: stereo side-by-side copies of library clips for a VR headset (left eye | right eye),
// at library/vr/<no>-<slug>_sbs.mp4, made by spikes/vr-clips.ts (docs/spikes.md has the
// measurements). Derived output like a share file, never written to library/index.json: the
// directory listing is the truth, so a copy is found by its clip number, never by a slug.
import { readdirSync } from "node:fs";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";

export const VR_DIR = path.join(LIBRARY_DIR, "vr");

// The run's temp files (<no>.<stamp>.tmp.mp4) do not match: no dash after the number, no _sbs.
const VR_NAME = /^(\d+)-.*_sbs\.mp4$/;

/** Clip number -> its VR file name, from a directory's file names; several for one number: the last by name. */
export function vrFiles(names: string[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const name of [...names].sort()) {
    const m = VR_NAME.exec(name);
    if (m) out[Number(m[1])] = name;
  }
  return out;
}

/** The VR copies in library/vr/; a missing directory is none. Any other read error throws, so a page is never written without its VR tags by accident. */
export function readVrFiles(dir = VR_DIR): Record<number, string> {
  try { return vrFiles(readdirSync(dir)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
}

/** The path of clip no's VR copy, or undefined when it has none. */
export function vrPath(no: number, dir = VR_DIR): string | undefined {
  const name = readVrFiles(dir)[no];
  return name === undefined ? undefined : path.join(dir, name);
}
