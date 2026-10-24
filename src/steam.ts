// Where Steam is and who is logged in, from the registry (the same keys the guards read).
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { STEAMID64_BASE } from "./config.ts";

export function regValue(key: string, name: string): string | undefined {
  try {
    const out = execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", timeout: 15_000 });
    return out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** The Steam install (userdata/, steamapps/libraryfolders.vdf live here), or undefined when the registry has none. */
export function steamPath(): string | undefined {
  const p = regValue("HKCU\\Software\\Valve\\Steam", "SteamPath") ?? regValue("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  return p && existsSync(p) ? path.win32.normalize(p) : undefined;
}

/** The logged-in Steam user's SteamID64, "0" for nobody, undefined when the registry cannot be read. */
export function activeSteamId64(): string | undefined {
  const v = regValue("HKCU\\Software\\Valve\\Steam\\ActiveProcess", "ActiveUser");
  if (!v || !/^0x[0-9a-f]+$/i.test(v)) return undefined;
  const id = BigInt(v);
  return id === 0n ? "0" : (id + STEAMID64_BASE).toString();
}
