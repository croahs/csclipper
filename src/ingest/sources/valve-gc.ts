// The Game Coordinator side of the Valve source (PLAN.md §1): a headless Steam
// login on the alt (RENDER_STEAM_ID64, never the main account) that "launches"
// CS2 just long enough to ask the GC for replay URLs by share code.
//
// Login is a QR code scanned once with the alt's Steam app (pnpm grab
// --steam-login); the refresh token it yields is kept in
// state/sources/valve-session.json (gitignored) and renewed by Steam as it
// goes. No password is stored. Deleting that file, or "Deauthorize all
// devices" on the alt, revokes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import SteamUser from "steam-user";
import GlobalOffensive from "globaloffensive";
import steamSession from "steam-session";
import { ShareCode } from "globaloffensive-sharecode";
import qrcode from "qrcode-terminal";
import { Refusal, STATE_DIR, type Identities } from "../../config.ts";
import { RenderLock } from "../../render/controller/guards.ts";
import { imageRunning } from "../../render/controller/processes.ts";
import type { GcOpener, GcSession } from "./valve.ts";

const { LoginSession, EAuthTokenPlatformType } = steamSession;
export const SESSION_FILE = path.join(STATE_DIR, "sources", "valve-session.json");
const CS2_APPID = 730;
const RENDER_LOCK = path.join(STATE_DIR, ".render.lock");
const OTHER_LOCKS = [".clip.lock", ".go.lock"].map((f) => path.join(STATE_DIR, f));
// Steam replaces a session that has the same public IP and logonID (steam-user README). The default
// is 0, which other headless tools share; a fixed, arbitrary value of croclipper's own makes such a
// collision unlikely, not impossible (nothing reserves it). Two croclipper logins cannot overlap here:
// pnpm grab runs one at a time (state/.grab.lock).
const LOGON_ID = 0x63726f63; // "croc"
const LOGIN_MS = 30_000;
const GC_MS = 45_000;
const MATCH_MS = 20_000;

function saveToken(file: string, refreshToken: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** The SteamID64 a refresh token belongs to: its JWT "sub" claim. */
function tokenAccount(token: string): string | undefined {
  try {
    const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub;
    return typeof sub === "string" && /^\d{17}$/.test(sub) ? sub : undefined;
  } catch { return undefined; }
}

function refuseUnlessAlt(steamId64: string | undefined, ids: Identities) {
  if (!steamId64) throw new Refusal("refusing: cannot tell which Steam account this is");
  if (steamId64 === ids.pov) throw new Refusal("refusing: that is the main account (STEAM_ID64); the GC login is only ever the alt");
  if (steamId64 !== ids.renderAccount) throw new Refusal("refusing: that Steam account is not RENDER_STEAM_ID64");
}

// steam-session logs whole login responses, refresh token included, through the debug package; its
// patterns take wildcards (DEBUG=s* matches too), so any DEBUG at all is refused.
function refuseSteamDebug() {
  if (process.env.DEBUG?.trim()) throw new Refusal("refusing: DEBUG is set, and steam-session could log the refresh token under it; unset it");
}

/** pnpm grab --steam-login: a QR code for the alt's Steam app; the refresh token is saved only if it is the alt's. */
export async function steamLogin(ids: Identities, file = SESSION_FILE): Promise<void> {
  refuseSteamDebug();
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = 5 * 60_000;
  const start = await session.startWithQR();
  if (!start.qrChallengeUrl) throw new Error("Steam returned no QR challenge");
  const show = (url: string) => {
    console.log("\nScan this with the Steam app signed in as the ALT account (RENDER_STEAM_ID64), not the main one:\n");
    qrcode.generate(url, { small: true });
  };
  show(start.qrChallengeUrl);
  // Steam replaces the challenge every ~20 s; steam-session only passes the new URL on in its
  // "poll response" debug event, so a stale code ("Failed to load QR info") is redrawn from there.
  // Only newChallengeUrl is read from that body, never logged.
  let current = start.qrChallengeUrl;
  let scanned = false;
  const redraw = (msg: string, body?: { newChallengeUrl?: string }) => {
    const next = msg === "poll response" && !scanned ? body?.newChallengeUrl : undefined;
    if (next && next !== current) { current = next; show(next); }
  };
  session.on("debug", redraw);
  await new Promise<void>((resolve, reject) => {
    session.on("remoteInteraction", () => { scanned = true; console.log("Scanned; approve the login in the app."); });
    session.on("authenticated", () => resolve());
    session.on("timeout", () => reject(new Error("the QR login timed out after 5 minutes; run pnpm grab --steam-login again")));
    session.on("error", (e: Error) => reject(e));
  }).finally(() => session.off("debug", redraw));
  refuseUnlessAlt(session.steamID?.getSteamID64(), ids);
  refuseUnlessAlt(tokenAccount(session.refreshToken), ids);
  saveToken(file, session.refreshToken);
}

function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: no answer within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}

/** The real GC opener for valve.ts. Refuses while a render or CS2 runs: both use the alt. */
export function gcOpener(ids: Identities, file = SESSION_FILE): GcOpener {
  return async (log) => {
    if (!existsSync(file)) return { blocked: "no Steam login for the alt yet: run pnpm grab --steam-login once (QR code, scanned in the alt's Steam app)" };
    refuseSteamDebug();
    const { refreshToken } = JSON.parse(readFileSync(file, "utf8")) as { refreshToken?: string };
    if (!refreshToken) return { blocked: `${file} holds no refresh token: run pnpm grab --steam-login` };
    // Checked before the token is ever sent: a copied or stale file for another account is never used.
    refuseUnlessAlt(tokenAccount(refreshToken), ids);
    const held = OTHER_LOCKS.find((l) => existsSync(l));
    if (held) return { blocked: `a render run holds ${path.basename(held)}; the GC login would collide with it. Run pnpm grab after it finishes` };
    // The render lock is held until the logoff has finished (or timed out after the library's own
    // forced disconnect), so no render starts on the alt meanwhile. Every exit after this releases it
    // through close(), exactly once.
    const lock = new RenderLock(RENDER_LOCK);
    try { lock.acquire(); } catch (e) {
      if (e instanceof Refusal) return { blocked: "a render holds .render.lock; run pnpm grab after it finishes" };
      throw e;
    }
    let client: SteamUser | undefined;
    let csgo: GlobalOffensive | undefined;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        if (client?.steamID) {
          const c = client;
          const gone = new Promise<void>((resolve) => c.once("disconnected", () => resolve()));
          try { c.gamesPlayed([]); } finally {
            c.logOff();
            await within(10_000, "Steam logoff", gone).catch(() => {});
          }
        } else client?.logOff(); // also stops a login still connecting
      } finally {
        try { client?.removeAllListeners(); csgo?.removeAllListeners(); } finally { lock.release(); }
      }
    };
    // Fatal Steam or GC errors, and a failed token save, reject whatever is in flight instead of crashing the process.
    let failWith: (e: Error) => void = () => {};
    const failed = new Promise<never>((_, rej) => { failWith = rej; });
    failed.catch(() => {});
    let session: GcSession;
    try {
      if (imageRunning("cs2.exe")) { await close(); return { blocked: "CS2 is running; close it and run pnpm grab again" }; }
      const c = client = new SteamUser({ autoRelogin: false, renewRefreshTokens: true });
      const gc = csgo = new GlobalOffensive(c);
      c.on("error", (e) => failWith(e));
      // Emitted on a GC logon fatal error (handlers.js); missing from @types/globaloffensive.
      (gc as unknown as NodeJS.EventEmitter).on("error", (e: Error) => failWith(e));
      c.on("refreshToken", (t: string) => {
        try { if (tokenAccount(t) === ids.renderAccount) saveToken(file, t); } catch (e) { failWith(e as Error); }
      });
      try {
        await within(LOGIN_MS, "Steam login", Promise.race([failed, new Promise<void>((resolve) => {
          c.once("loggedOn", () => resolve());
          c.logOn({ refreshToken, logonID: LOGON_ID });
        })]));
      } catch (e) {
        const r = (e as { eresult?: number }).eresult;
        if (r === SteamUser.EResult.AccessDenied || r === SteamUser.EResult.InvalidPassword || r === SteamUser.EResult.Expired) {
          await close();
          return { blocked: "the alt's saved Steam login is no longer valid: run pnpm grab --steam-login" };
        }
        throw e;
      }
      refuseUnlessAlt(c.steamID?.getSteamID64(), ids);

      // Another session on the alt playing a game blocks ours; it is never kicked (no force).
      // The state may have come with the login already, so the cached value counts first.
      const cached = (c as unknown as { playingState?: { blocked?: boolean } }).playingState;
      const blocked = cached ? !!cached.blocked : await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5_000);
        c.once("playingState", (b: boolean) => { clearTimeout(t); resolve(b); });
      });
      if (blocked) { await close(); return { blocked: "the alt is playing a game elsewhere; the GC login does not kick it. Run pnpm grab when it is free" }; }
      await within(GC_MS, "Game Coordinator", Promise.race([failed, new Promise<void>((resolve) => { gc.once("connectedToGC", () => resolve()); c.gamesPlayed([CS2_APPID]); })]));
      log("valve: Game Coordinator session open on the alt");
      session = {
        async resolve(code) {
          const { matchId } = new ShareCode(code).decode();
          let onList: (matches: GlobalOffensive.Match[]) => void = () => {};
          return within(MATCH_MS, `GC match info for ${code}`, Promise.race([failed, new Promise<{ url?: string; matchTime?: number }>((resolve) => {
            onList = (matches) => {
              const m = matches.find((x) => String(x.matchid) === matchId);
              if (!m) return;
              // The last round's stats carry the replay URL in "map" (CS2 keeps the CS:GO message).
              const url = [...(m.roundstatsall ?? [])].reverse().find((r) => typeof r.map === "string" && r.map)?.map ?? undefined;
              resolve({ url, matchTime: typeof m.matchtime === "number" && m.matchtime > 0 ? m.matchtime : undefined });
            };
            gc.on("matchList", onList);
            gc.requestGame(code);
          })])).finally(() => gc.off("matchList", onList));
        },
        close,
      };
    } catch (e) { await close(); throw e; }
    return session;
  };
}
