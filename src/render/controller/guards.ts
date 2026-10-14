// Hard guards (AGENTS.md): render only on the alt account, never with a CS2 or
// HLAE already running, one controller at a time.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Refusal, accountId, type Identities } from "../../config.ts";
import { imageRunning } from "./processes.ts";

function activeSteamAccountId(): string {
  // ActiveUser is the 32-bit account id of the logged-in Steam user, 0 when nobody is logged in.
  const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess", "/v", "ActiveUser"], { encoding: "utf8", timeout: 15_000 });
  const m = out.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (!m) throw new Refusal("refusing: could not read Steam ActiveUser from the registry");
  return BigInt("0x" + m[1]).toString();
}

export function guard(ids: Identities) {
  const want = accountId(ids.renderAccount);
  const main = accountId(ids.pov);
  const have = activeSteamAccountId();
  if (have === "0") throw new Refusal("refusing: no Steam user logged in");
  if (have === main || want === main) throw new Refusal("refusing: never render on the main account");
  if (have !== want) throw new Refusal("refusing: logged-in Steam account is not RENDER_STEAM_ID64");
  if (imageRunning("cs2.exe")) throw new Refusal("refusing: CS2 is already running");
  if (imageRunning("HLAE.exe")) throw new Refusal("refusing: HLAE is already running");
}

// An exclusive lock file holding the controller's pid. Any existing lock
// refuses; a stale one is removed by hand after checking that no cs2.exe /
// HLAE.exe is left (never automatically: two controllers could race).
export class RenderLock {
  constructor(readonly file: string) {}

  acquire() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const fd = openSync(this.file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = "";
      try { holder = readFileSync(this.file, "utf8"); } catch {}
      throw new Refusal(`refusing: ${this.file} exists (pid ${holder || "?"}); if no controller is running and no cs2.exe/HLAE.exe is left, delete it by hand`);
    }
  }

  release() {
    try { if (readFileSync(this.file, "utf8") === String(process.pid)) rmSync(this.file); } catch {}
  }
}
