// Process identity, ownership and killing. Only processes this controller
// started are ever killed: the HLAE loader (by spawn pid, created after the
// spawn) and every descendant found while the job runs (cs2.exe, HLAE's FFmpeg
// encoder). Identity = pid + creation time + image name, so a reused pid is
// never mistaken for one of ours.
import { execFileSync } from "node:child_process";

export type Proc = { pid: number; ppid: number; name: string; created: string };

const ps = (script: string) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 15_000 }).trim();

export function imageRunning(image: string): boolean {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 15_000 });
  return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

// One Win32_Process snapshot per call. Fails closed: any PowerShell/CIM error
// throws, and a snapshot that does not contain this controller is rejected
// rather than read as "nothing running".
export function snapshot(): Proc[] {
  const out = ps("$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }) } }) | ConvertTo-Json -Compress");
  const v = out ? JSON.parse(out) : [];
  const list: Proc[] = Array.isArray(v) ? v : [v];
  if (!list.some((x) => x.pid === process.pid)) throw new Error("process snapshot does not contain the controller itself");
  return list;
}

export const sameProc = (a: Proc, b: Proc) => a.pid === b.pid && a.created === b.created && a.name.toLowerCase() === b.name.toLowerCase();
export const isRunning = (p: Proc, snap: Proc[]) => snap.some((x) => sameProc(x, p));

/**
 * Kill exactly this process, or nothing. The PowerShell script opens a handle
 * first (a pid cannot be reused while a handle to its process is open), then
 * re-checks the identity, then kills through that handle, so the check and the
 * kill always refer to the same process.
 */
export function killExact(p: Proc): "killed" | "gone" {
  const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const out = ps([
    "$ErrorActionPreference = 'Stop'",
    // Only "no such process" / "has exited" count as gone; anything else (access denied) throws.
    `try { $p = [System.Diagnostics.Process]::GetProcessById(${p.pid}) } catch [System.ArgumentException] { 'gone'; exit 0 }`,
    "try { $null = $p.Handle } catch [System.InvalidOperationException] { 'gone'; exit 0 }",
    `$c = Get-CimInstance Win32_Process -Filter 'ProcessId = ${p.pid}'`,
    `if (-not $c -or $c.Name -ne ${lit(p.name)} -or -not $c.CreationDate -or $c.CreationDate.ToString('o') -ne ${lit(p.created)}) { 'gone'; exit 0 }`,
    "$p.Kill(); [void]$p.WaitForExit(5000); 'killed'",
  ].join("; "));
  if (out !== "killed" && out !== "gone") throw new Error(`kill ${p.name} pid ${p.pid}: unexpected output ${JSON.stringify(out)}`);
  return out;
}

export const key = (p: Proc) => `${p.pid}|${p.created}|${p.name.toLowerCase()}`;

/** The HLAE loader this controller spawned and everything descended from it. */
export class OwnedTree {
  // Keyed by full identity, so a later process reusing an owned pid is a new entry, never "already known".
  readonly procs = new Map<string, Proc>();
  private rootKey: string | undefined;
  /** spawnedAt: taken immediately before the spawn call. */
  constructor(readonly rootPid: number, readonly rootImage: string, readonly spawnedAt: number) {}

  /** False until the loader itself has been seen; without it nothing is ever adopted. */
  get rooted() { return this.rootKey !== undefined; }

  discover(snap: Proc[] = snapshot()): Proc[] {
    // The loader is adopted only as this controller's own child, created inside
    // the spawn window, so a later process reusing its pid can never be the root.
    if (!this.rooted) {
      const p = snap.find((x) => x.pid === this.rootPid);
      const created = p ? Date.parse(p.created) : NaN;
      if (p && p.ppid === process.pid && p.name.toLowerCase() === this.rootImage.toLowerCase() && created >= this.spawnedAt - 1000 && created <= this.spawnedAt + 5000) {
        this.rootKey = key(p);
        this.procs.set(this.rootKey, p);
      }
    }
    // A child is adopted only while its parent is in the same snapshot with the
    // exact identity recorded for it, so a reused parent pid cannot pass ownership on.
    let grew = true;
    while (grew) {
      grew = false;
      for (const parent of [...this.procs.values()]) {
        if (!isRunning(parent, snap)) continue;
        for (const c of snap.filter((x) => x.ppid === parent.pid)) {
          if (!this.procs.has(key(c)) && c.created >= parent.created) { this.procs.set(key(c), c); grew = true; }
        }
      }
    }
    return snap;
  }

  /**
   * Processes that may have been started by an owned process that has since
   * died, and so cannot be adopted: the parent pid is an owned one, the child
   * is younger than that owned process, and no process holds the pid now, or
   * the holder is younger than the child (so it is not the child's parent).
   * These are never killed; while any is running, cleanup is not verified.
   */
  suspects(snap: Proc[]): Proc[] {
    const owned = [...this.procs.values()];
    return snap.filter((c) => !this.procs.has(key(c)) && owned.some((o) => {
      if (c.ppid !== o.pid || c.created < o.created || isRunning(o, snap)) return false;
      const holder = snap.find((x) => x.pid === o.pid);
      return !holder || holder.created > c.created;
    }));
  }

  games = () => [...this.procs.values()].filter((p) => p.name.toLowerCase() === "cs2.exe");
  list = () => [...this.procs.values()].map((p) => `${p.name}:${p.pid}`);
}
