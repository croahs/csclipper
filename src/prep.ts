// The pure pieces of pnpm prep / pnpm check (src/cli/setup.ts), apart so they are testable
// without a registry, a download or a terminal: Steam library paths from libraryfolders.vdf,
// SteamID64 parsing from what a person pastes, and .env editing that keeps comments and order.
import { parseEnv } from "node:util";
import path from "node:path";
import { STEAMID64_BASE } from "./config.ts";

/** Every Steam library: the install itself plus the "path" entries of its libraryfolders.vdf (undefined when there is none). */
export function librariesFromVdf(steam: string, vdf: string | undefined): string[] {
  const libs = vdf ? [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => path.win32.normalize(m[1].replaceAll("\\\\", "\\"))) : [];
  const out: string[] = [];
  for (const p of [steam, ...libs]) if (!out.some((q) => q.toLowerCase() === p.toLowerCase())) out.push(p);
  return out;
}

/** A stored SteamID64 as src/config.ts accepts it: 17 digits above the base. */
export const isSteamId64 = (s: string) => /^\d{17}$/.test(s) && BigInt(s) > STEAMID64_BASE;

/** A SteamID64 from what a person pastes: the 17 digits, or a steamcommunity.com/profiles/<id> link. */
export function parseSteamId64(s: string): string | undefined {
  const m = s.trim().match(/^(\d{17})$/) ?? s.trim().match(/\/profiles\/(\d{17})(?!\d)/);
  return m && isSteamId64(m[1]) ? m[1] : undefined;
}

export type EnvFile = { lines: string[]; values: Record<string, string>; eol: "\n" | "\r\n"; changed: boolean };

export function parseEnvFile(text: string): EnvFile {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseEnv(text))) values[k] = (v ?? "").trim();
  return { lines: text.split(/\r?\n/), values, eol: text.includes("\r\n") ? "\r\n" : "\n", changed: false };
}

/**
 * Set key: the first `KEY=` line is replaced, else the line is appended before the trailing
 * newline. The value is written bare, as node's parseEnv reads an unquoted value to the end of
 * the line, spaces and parentheses included; a `#` would start a comment there, so a value with
 * one is single-quoted (single quotes keep backslashes; double quotes turn \n into a newline,
 * which no Windows path survives). A value no line can hold (a quote, a newline) is refused.
 * roundTrips() below is the check that what was written reads back as intended.
 */
export function setLine(env: EnvFile, key: string, value: string): void {
  if (/[\r\n']/.test(value) || value !== value.trim()) throw new Error(`${key}: cannot be written to .env: ${JSON.stringify(value)}`);
  const line = `${key}=${value.includes("#") ? `'${value}'` : value}`;
  const i = env.lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (i >= 0) env.lines[i] = line;
  else if (env.lines.length && env.lines[env.lines.length - 1] === "") env.lines.splice(env.lines.length - 1, 0, line);
  else env.lines.push(line, "");
  env.values[key] = value;
  env.changed = true;
}

export const envText = (env: EnvFile) => env.lines.join(env.eol);

/** Whether the text as it would be written parses back to exactly env.values (so no edit landed inside a quoted multi-line value). */
export function roundTrips(env: EnvFile): boolean {
  const back = parseEnv(envText(env));
  const keys = new Set([...Object.keys(back), ...Object.keys(env.values)]);
  for (const k of keys) if ((back[k] ?? "").trim() !== (env.values[k] ?? "")) return false;
  return true;
}
