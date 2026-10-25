// HLAE's hidden error dialog. HLAE runs with -noGui and is spawned hidden, so when its
// loader cannot create cs2.exe, the WinForms "HLAE Error" box it shows is never seen and
// the launch just sits until the "launched" timeout. On 2026-10-25 that cost hours of
// silent 60 s timeouts under the FACEIT client's anti-cheat (code 2002, "Access is
// denied"). So on a timeout before the demo has loaded, the controller reads the texts
// of every top-level window of the owned processes, visible or not, and puts the dialog's
// into the failure reason. Read-only: user32 EnumWindows / GetWindowText through
// PowerShell, like the process snapshots in processes.ts.
import { execFileSync } from "node:child_process";

/** One top-level window: its title, class, visibility and the texts of its child controls. */
export type WindowTexts = { pid: number; title: string; className: string; visible: boolean; texts: string[] };

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$pids = @(__PIDS__)
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CroclipWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
"@
Add-Type -TypeDefinition $src
$tops = New-Object System.Collections.ArrayList
[void][CroclipWin]::EnumWindows({ param($w, $l) $p = [uint32]0; [void][CroclipWin]::GetWindowThreadProcessId($w, [ref]$p); if ($pids -contains [int]$p) { [void]$tops.Add(@{ h = $w; pid = [int]$p }) }; $true }, [IntPtr]::Zero)
$out = New-Object System.Collections.ArrayList
foreach ($t in $tops) {
  $texts = New-Object System.Collections.ArrayList
  [void][CroclipWin]::EnumChildWindows($t.h, { param($c, $l) $s = [CroclipWin]::Text($c); if ($s) { [void]$texts.Add($s) }; $true }, [IntPtr]::Zero)
  [void]$out.Add([pscustomobject]@{ pid = $t.pid; title = [CroclipWin]::Text($t.h); className = [CroclipWin]::Cls($t.h); visible = [CroclipWin]::IsWindowVisible($t.h); texts = @($texts) })
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`;

/** Every top-level window of these processes, visible or not, with its child controls' texts. Throws when PowerShell fails. */
export function windowTexts(pids: number[]): WindowTexts[] {
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return [];
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT.replace("__PIDS__", list.join(","))], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 15_000 }).trim();
  const v = out ? JSON.parse(out) : [];
  return Array.isArray(v) ? v : [v];
}

const BUTTONS = new Set(["ok", "cancel", "close", "yes", "no", "abort", "retry", "ignore", "continue", "help"]);

/**
 * HLAE's dialogs as one line, e.g. "HLAE error 2002: Loader could not create requested process.
 * GetLastWin32Error = 5: Access is denied. Solution: Make sure to close any anti-cheat software
 * and that the path to the game .exe is correct." A dialog is a window titled with "HLAE" that
 * has child controls with text (the main window has none under -noGui); buttons are dropped, a
 * "Code: N" control becomes the head, the rest are joined as sentences. Several dialogs are
 * joined with " | ". Undefined when no window looks like one.
 */
export function hlaeDialogLine(windows: WindowTexts[]): string | undefined {
  const lines: string[] = [];
  for (const w of windows) {
    if (!/hlae/i.test(w.title)) continue;
    const texts = w.texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !BUTTONS.has(t.replace(/^&/, "").toLowerCase()));
    if (!texts.length) continue;
    let head = `HLAE dialog "${w.title}"`;
    const body: string[] = [];
    for (const t of texts) {
      const code = t.match(/^code:?\s*(\d+)$/i);
      if (code) head = `HLAE error ${code[1]}`;
      else body.push(/[.!?]$/.test(t) ? t : `${t}.`);
    }
    lines.push(body.length ? `${head}: ${body.join(" ")}` : head);
  }
  return lines.length ? lines.join(" | ") : undefined;
}
