// Paths in state files (state/demos.json, capture.json) are stored relative to the repo root,
// with forward slashes, so the folder can move: on 2026-10-26, 49 of 55 registry entries still
// pointed at the folder the repo had left. Readers resolve a relative path under the root. An
// absolute path (from before this rule, or a file outside the repo) is used as it is whenever it
// exists; never swapped for a file of the same name here. Only when it is gone is it re-rooted:
// a registry entry by its own sha (demos/store/<sha>.dem, ingest/index.ts), a capture's media by
// the components after the last state/render/ in it (fromStored), so an error names the place
// the file should be, and a moved folder's captures are found.
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.ts";

/** How a path is written into a state file: relative to root when under it, else as it is. */
export function toStored(abs: string, root = ROOT): string {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
}

/**
 * The path a state file names, as this checkout sees it. An absolute path that exists is itself;
 * one that is gone is re-rooted under `under` ("state/render") by its tail, when it has one.
 */
export function fromStored(stored: string, under: string, root = ROOT): string {
  if (!path.isAbsolute(stored)) return path.resolve(root, stored);
  if (existsSync(stored)) return stored;
  const tail = tailUnder(stored, under);
  return tail ? path.join(root, ...under.split("/"), ...tail) : stored;
}

/** The path's components after the last occurrence of `under` ("state/render") in it, or undefined. */
export function tailUnder(p: string, under: string): string[] | undefined {
  const parts = p.split(/[\\/]/);
  const u = under.split("/");
  for (let i = parts.length - u.length - 1; i >= 0; i--) {
    if (u.every((s, k) => parts[i + k].toLowerCase() === s)) return parts.slice(i + u.length);
  }
  return undefined;
}
