// FACEIT demos through the user's own logged-in browser session (FACEIT does not
// grant the Downloads API for non-commercial use). Two parts:
//
// - login(): starts the installed Google Chrome (else Microsoft Edge) as a
//   plain process, not automated, on a separate profile in
//   state/browser-profile/, and waits for the window to close. The user logs in
//   there and passes FACEIT's human verification.
// - browserDemos(): later runs open that profile with Playwright and only
//   navigate match rooms and click the demo download. If FACEIT shows a
//   verification or a login page, the run stops and says so; nothing here
//   ever tries to answer a verification or retries in a loop.
//
// No credentials are handled or stored; the session lives in the profile.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import type { BrowserContext, Download } from "playwright";
import path from "node:path";
import { STATE_DIR } from "../../config.ts";
import type { DemoOutcome, DemoProvider } from "./faceit.ts";

export const PROFILE_DIR = path.join(STATE_DIR, "browser-profile");
export const ROOM_URL = (matchId: string) => `https://www.faceit.com/en/cs2/room/${encodeURIComponent(matchId)}`;

export type InstalledBrowser = { name: "Google Chrome" | "Microsoft Edge"; channel: "chrome" | "msedge"; exe: string };

/** The installed Chrome, else Edge; undefined when neither is found. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): InstalledBrowser | undefined {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
  for (const root of roots) {
    const exe = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
    if (existsSync(exe)) return { name: "Google Chrome", channel: "chrome", exe };
  }
  for (const root of roots) {
    const exe = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(exe)) return { name: "Microsoft Edge", channel: "msedge", exe };
  }
  return undefined;
}

/** Open the profile in a plain browser window for the user to log in; resolves when the user closes it. */
export function login(b: InstalledBrowser, log: (l: string) => void = console.log): Promise<number> {
  log(`Opening ${b.name} with the croclipper profile (${PROFILE_DIR}).`);
  log("In that window: answer the cookie dialog as you like, click LOG IN, sign in to FACEIT (complete any check it shows),");
  log("then close the window. This command waits until the window is closed. Your normal browser profile is not touched.");
  const child = spawn(b.exe, [`--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "https://www.faceit.com/en"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

// --- downloads through the logged-in session (Playwright) --------------------------
// Locators relied on (docs/faceit-api.md): the room's "Watch demo" button
// (role button, that name), the header's "Profile" button (visible) as the
// logged-in signal, a visible "Log in" control or another host as logged out. Clicking "Watch demo" makes the page request a signed URL
// from FACEIT's own site API and start a browser download of <match>-1-1.dem.zst.

const PAUSE_BETWEEN_MS = 4000; // one match at a time, politely spaced
const PAGE_TIMEOUT_MS = 45_000;
// From the click to the download starting. Downloads began within seconds while the path worked
// (2026-10-15); since the bot check (BOT_CHECK below) none begins, so the wait is short and ends
// as blocked, not failed. If FACEIT drops the check, a download within this window works again.
const DOWNLOAD_START_MS = 30_000;
const DOWNLOAD_DONE_MS = 20 * 60_000; // for the whole transfer
const MAX_DEMO_BYTES = 2 * 1024 ** 3;
export const FAILURES_DIR = path.join(STATE_DIR, "browser-failures");

export const NOT_LOGGED_IN = "The croclipper browser profile is not logged in to FACEIT. Run pnpm grab --login, sign in in the window that opens, close it, then run pnpm grab --browser again.";
export const VERIFICATION = "FACEIT showed a human-verification page to the automated browser. Nothing was answered or retried: run pnpm grab --login, open faceit.com in that window (complete any check yourself), close it, then try again.";
// Since 2026-10-24 the click runs a Cloudflare Turnstile check that fails in the automated
// browser (console: "[Cloudflare Turnstile] Error: 600010"), so no download ever starts. Nothing
// here answers a bot check: the match is left pending with its room link, where the click in
// the user's own browser still works (docs/faceit-api.md).
export const BOT_CHECK = "FACEIT's bot check (Cloudflare Turnstile) fails behind \"Watch demo\" in the automated browser, so no download starts. Download the demo yourself from the room link in your own browser; pnpm grab picks it up from Downloads.";

export type BrowserDemoOptions = { browser: InstalledBrowser; headless?: boolean };

export function browserDemos(o: BrowserDemoOptions): DemoProvider {
  let ctxP: Promise<BrowserContext> | undefined;
  let first = true;
  const open = async () => {
    const { chromium } = await import("playwright");
    return chromium.launchPersistentContext(PROFILE_DIR, {
      channel: o.browser.channel,
      headless: o.headless ?? false,
      args: o.headless ? [] : ["--start-minimized"],
      acceptDownloads: true,
      viewport: { width: 1400, height: 900 },
    });
  };
  return {
    label: `${o.browser.name} session`,
    async get(m, sctx): Promise<DemoOutcome> {
      if (sctx.dryRun) return { kind: "dry" };
      if (!existsSync(PROFILE_DIR)) return { kind: "blocked", message: NOT_LOGGED_IN, pendingReason: "waiting for pnpm grab --login" };
      if (!first) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
      first = false;
      ctxP ??= open();
      const bctx = await ctxP;
      const page = bctx.pages()[0] ?? (await bctx.newPage());
      const url = ROOM_URL(m.matchId);
      // Every failure goes through here: the page URL, and a screenshot if one could be taken.
      const fail = async (msg: string): Promise<never> => {
        mkdirSync(FAILURES_DIR, { recursive: true });
        const shot = path.join(FAILURES_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${m.matchId}.png`);
        const saved = await page.screenshot({ path: shot }).then(() => true, () => false);
        throw new Error(`${msg} (page ${page.url()}, ${saved ? `screenshot ${shot}` : "no screenshot could be taken"})`);
      };
      const visible = (l: ReturnType<typeof page.getByRole>) => l.first().isVisible().catch(() => false);
      const verification = () => page.getByText(/verify(ing)? you are human|just a moment/i).first().isVisible().catch(() => false);
      const loggedOut = async () =>
        new URL(page.url()).host !== "www.faceit.com" || (await visible(page.getByRole("button", { name: /^log ?in$/i }))) || (await visible(page.getByRole("link", { name: /^log ?in$/i })));
      /** A stop the source reports as blocked (all new matches pending); undefined while the page looks fine. */
      const stop = async (): Promise<DemoOutcome | undefined> => {
        if (await verification()) return { kind: "blocked", message: VERIFICATION, pendingReason: "waiting for a browser login check" };
        if (await loggedOut()) return { kind: "blocked", message: NOT_LOGGED_IN, pendingReason: "waiting for pnpm grab --login" };
        return undefined;
      };
      let part: string | undefined;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
        const watch = page.getByRole("button", { name: "Watch demo" });
        // Wait for the demo button, a verification page or a logged-out page, whichever comes first.
        const t0 = Date.now();
        while (Date.now() - t0 < PAGE_TIMEOUT_MS && !(await visible(watch))) {
          const s = await stop();
          if (s) return s;
          await page.waitForTimeout(1000);
        }
        const s0 = await stop();
        if (s0) return s0;
        if (!(await visible(page.getByRole("button", { name: "Profile" })))) return { kind: "blocked", message: NOT_LOGGED_IN, pendingReason: "waiting for pnpm grab --login" };
        // No button is a failure, never "not yet": a changed page must not let a match be skipped.
        if (!(await visible(watch))) return await fail(`no "Watch demo" button in the match room within ${PAGE_TIMEOUT_MS / 1000} s`);

        let downloadError: unknown;
        let d: Download | undefined;
        const started = page.waitForEvent("download", { timeout: DOWNLOAD_START_MS }).then((x) => { d = x; }, (e) => { downloadError = e; });
        let botCheck = false;
        const onConsole = (msg: { text(): string }) => { if (/Cloudflare Turnstile\] Error/i.test(msg.text())) botCheck = true; };
        page.on("console", onConsole);
        try {
          // The download waiter above is armed before the click (a download can begin while the click resolves), so its window starts a moment early.
          try { await watch.click(); } catch (e) { return await fail(`clicking "Watch demo" failed: ${(e as Error).message}`); }
          // Until the download starts, keep watching for a verification, a logout or a failed bot check.
          while (!d && downloadError === undefined) {
            const s = await stop();
            if (s) return s;
            if (botCheck) return { kind: "blocked", message: BOT_CHECK, pendingReason: "FACEIT's bot check blocks the automated download; download it from the room link" };
            await Promise.race([started, page.waitForTimeout(1000)]);
          }
        } finally {
          page.off("console", onConsole);
        }
        // No download after the click. The console line does not show in every run, so this is reported as what was seen, with the bot check as the likely cause.
        if (!d) return { kind: "blocked", message: `No download started within ${DOWNLOAD_START_MS / 1000} s of clicking "Watch demo"; while the path worked, downloads began within seconds. Likely cause: ${BOT_CHECK}`, pendingReason: "no download started after the click (FACEIT's bot check, most likely); download it from the room link" };
        const dl: Download = d;
        // Exactly this match's demo: <match id>-1-1.dem, optionally compressed.
        const suggested = dl.suggestedFilename();
        const ext = suggested.startsWith(`${m.matchId}-1-1.dem`) ? suggested.slice(`${m.matchId}-1-1`.length) : "";
        if (![".dem", ".dem.zst", ".dem.gz", ".dem.bz2"].includes(ext)) {
          await dl.cancel().catch(() => undefined);
          return await fail(`the download is not this match's demo: ${JSON.stringify(suggested.slice(0, 100))}`);
        }
        const name = `faceit-${m.matchId}${ext}`;
        part = path.join(sctx.inbox, `.${name}.part`);
        // A deadline on the whole transfer; the browser writes to its own temp file meanwhile.
        const timer = new Promise<"late">((r) => setTimeout(() => r("late"), DOWNLOAD_DONE_MS).unref());
        const save = dl.saveAs(part).then(() => "ok" as const, (e: unknown) => e);
        const saved = await Promise.race([save, timer]);
        if (saved === "late") {
          // Cancel, then let the save settle before the partial file is removed (in the catch below).
          await dl.cancel().catch(() => undefined);
          await save;
          return await fail(`the download did not finish within ${DOWNLOAD_DONE_MS / 60000} min`);
        }
        if (saved !== "ok") return await fail(`saving the download failed: ${(saved as Error).message ?? saved}`);
        const failure = await dl.failure();
        if (failure) return await fail(`the download failed: ${failure}`);
        if (statSync(part).size > MAX_DEMO_BYTES) return await fail("the download is larger than the demo size limit");
        const done = part;
        part = undefined;
        return { kind: "file", part: done, name };
      } catch (e) {
        if (part) rmSync(part, { force: true });
        // Errors from fail() already carry the URL; anything else (navigation, timeouts) gets it here.
        if ((e as Error).message.includes("(page ")) throw e;
        return await fail((e as Error).message);
      }
    },
    async close() {
      if (ctxP) await (await ctxP).close().catch(() => undefined);
    },
  };
}
