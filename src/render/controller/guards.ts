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
// refuses; a stale render lock is removed by hand after checking that no
// cs2.exe / HLAE.exe is left (never automatically: two controllers could race,
// and a dead controller can leave the game running). A lock that guards no game
// process (pnpm grab's) may opt into takeOverDead: a lock whose pid is no longer
// running is replaced, and acquire() returns that pid.
/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export class RenderLock {
  constructor(readonly file: string) {}

  acquire(opts: { takeOverDead?: boolean } = {}): number | undefined {
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.claim()) return undefined;
    const holder = this.holder();
    const pid = /^\d+$/.test(holder) ? Number(holder) : undefined;
    // Only for a pid known to be gone: an empty or unreadable lock, or a live pid, refuses.
    if (!opts.takeOverDead || pid === undefined || pid === process.pid || pidAlive(pid)) throw this.refusal(holder);
    // Recovery is serialized by an exclusive .takeover file: only its holder may remove the stale
    // lock, and it writes its own lock before letting go, so a contender that gets the takeover
    // next re-reads a live pid and refuses instead of deleting a lock that was just taken.
    const guard = `${this.file}.takeover`;
    let g: number;
    try { g = openSync(guard, "wx"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Refusal(`refusing: another process is recovering ${this.file} (${guard} exists; if nothing is running, delete both by hand)`);
      throw e;
    }
    try {
      if (this.holder() === holder) { try { rmSync(this.file); } catch {} }
      if (!this.claim()) throw this.refusal(this.holder());
      return pid;
    } finally {
      try { closeSync(g); } catch {}
      try { rmSync(guard); } catch {}
    }
  }

  /** Create the lock with this pid, exclusively; false when it already exists. */
  private claim(): boolean {
    let fd: number;
    try {
      fd = openSync(this.file, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    // The file is ours from here: a failed pid write (a full disk) removes it again rather than
    // leaving a lock nobody holds.
    try {
      writeSync(fd, String(process.pid));
    } catch (e) {
      try { closeSync(fd); } catch {}
      try { rmSync(this.file); } catch {}
      throw e;
    }
    closeSync(fd);
    return true;
  }

  private holder(): string {
    try { return readFileSync(this.file, "utf8"); } catch { return ""; }
  }

  private refusal(holder: string): Refusal {
    return new Refusal(`refusing: ${this.file} exists (pid ${holder || "?"}); if no controller is running and no cs2.exe/HLAE.exe is left, delete it by hand`);
  }

  release() {
    try { if (readFileSync(this.file, "utf8") === String(process.pid)) rmSync(this.file); } catch {}
  }
}
