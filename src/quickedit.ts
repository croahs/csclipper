// QuickEdit off for the console window this run writes to (Windows). With QuickEdit on, a click in a
// classic console window starts a selection that blocks every write to the window until Esc; Node
// writes to a console synchronously, so the whole run stops, a launch's timers and game cleanup
// included. It has to happen from inside the run: cmd.exe sets its own console mode again around every
// program it starts, so a line in Make clips.cmd is undone before pnpm starts (measured 2026-10-27).
// cmd.exe's own mode comes back when the run ends. Best effort: a failure leaves the window as it was
// and says so in one line. Only an interactive stdin is handled (pnpm go < NUL keeps QuickEdit).
import { spawnSync } from "node:child_process";
import { isatty } from "node:tty";

const SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `$k = Add-Type -Name Console -Namespace CroClip -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);'`,
  // STD_INPUT_HANDLE; clear ENABLE_QUICK_EDIT_MODE (0x40), set ENABLE_EXTENDED_FLAGS (0x80) so the change takes.
  `$h = $k::GetStdHandle(-10); $m = [uint32]0`,
  `if (-not ($k::GetConsoleMode($h, [ref]$m) -and $k::SetConsoleMode($h, ($m -band 0xFFBF) -bor 0x80))) { exit 1 }`,
].join("; ");

export function quickEditOff(): void {
  if (process.platform !== "win32" || !isatty(0)) return;
  // stdin inherited: the child changes the mode of this console's input buffer, which the window shares.
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { stdio: ["inherit", "ignore", "ignore"], timeout: 15_000 });
  if (r.error || r.status !== 0) console.log("note: could not turn off click-to-select for this window; a click in it pauses the run until Esc");
}
