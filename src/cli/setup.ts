// pnpm prep [--check]: make this PC ready to render (PLAN.md M5), or with --check (pnpm check)
// only report. pnpm's own `setup` and `doctor` commands take the obvious names.
//   prep   finds Steam and CS2 (registry, libraryfolders.vdf), downloads the pinned HLAE and
//          FFmpeg into tools/ (sha256-checked; skipped when already there), writes ffmpeg.ini
//          next to the HLAE in use when there is none, and fills .env: HLAE_EXE and CS2_EXE
//          from what it found, STEAM_ID64 and RENDER_STEAM_ID64 asked for when empty. A value
//          that is set is never changed, so a working install is never altered.
//   check  writes nothing: one line per requirement, then exit 1 when a required one is missing.
// Neither prints a SteamID or a key: the output is meant to be pasted into an issue.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ROOT, accountId } from "../config.ts";
import { type EnvFile, envText, isSteamId64, librariesFromVdf, parseEnvFile, parseSteamId64, roundTrips, setLine } from "../prep.ts";
import { activeSteamId64, steamPath } from "../steam.ts";
import { PINNED_FFMPEG, ffmpegVersion, nvencFfmpeg, postFfmpeg } from "../post/ffmpeg.ts";
import { toolVersions } from "../render/versions.ts";
import { imageRunning } from "../render/controller/processes.ts";
import { findBrowser } from "../ingest/sources/faceit-browser.ts";
import { sha256File } from "../parse/clip-facts.ts";

const checkOnly = process.argv.includes("--check");
const TOOLS = path.join(ROOT, "tools");
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"); // bsdtar: reads zip
const ENV_FILE = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const HLAE_DIR = path.join(TOOLS, "hlae");
const HLAE_EXE = path.join(HLAE_DIR, "HLAE.exe");
/** What an HLAE install must have for a CS2 capture; an install missing one is incomplete, whatever else is there. */
const HLAE_FILES = ["HLAE.exe", path.join("x64", "AfxHookSource2.dll")];

// The pinned tools (docs/spikes.md M0.2; docs/modules.md, Final encode). Neither project
// publishes a checksum; each sha256 here is of the file as downloaded on 2026-10-14/15.
// HLAE breaks on CS2 updates: when a render fails after one, this pin moves (and docs/spikes.md).
const HLAE = {
  version: "2.192.8",
  url: "https://github.com/advancedfx/advancedfx/releases/download/v2.192.8/hlae_2_192_8.zip",
  zip: path.join(TOOLS, "dl", "hlae_2_192_8.zip"),
  bytes: 9_000_995,
  sha256: "f28a2d7cbd4accb236e114975044bedbe3d3b6d44d4eecfc099bf2dd7e9f69b1",
};
const FFMPEG = {
  version: "7.1.1",
  url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip",
  zip: path.join(TOOLS, "ffmpeg-dl", "ffmpeg-7.1.1-essentials_build.zip"),
  bytes: 92_234_348,
  sha256: "04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4",
  exe: "ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe",
  exeSha256: "b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997",
  license: "ffmpeg-7.1.1-essentials_build/LICENSE",
};

const REQUIRED_KEYS = ["STEAM_ID64", "RENDER_STEAM_ID64", "HLAE_EXE", "CS2_EXE"] as const;
const OPTIONAL_KEYS = ["FACEIT_API_KEY", "STEAM_WEB_API_KEY", "STEAM_MATCH_AUTH_CODE", "STEAM_LAST_SHARE_CODE"] as const;

// --- Steam ---------------------------------------------------------------------------------

function steamLibraries(steam: string): string[] {
  const vdf = path.join(steam, "steamapps", "libraryfolders.vdf");
  return librariesFromVdf(steam, existsSync(vdf) ? readFileSync(vdf, "utf8") : undefined);
}

const CS2_REL = path.join("steamapps", "common", "Counter-Strike Global Offensive", "game", "bin", "win64", "cs2.exe");
const findCs2 = (steam: string) => steamLibraries(steam).map((l) => path.join(l, CS2_REL)).find((f) => existsSync(f));

// --- Downloads -------------------------------------------------------------------------------

/** Fetch url into dest unless dest already matches the pin; the size and sha256 must both match, else nothing is kept. */
async function download(name: string, url: string, dest: string, bytes: number, sha256: string): Promise<void> {
  if (existsSync(dest) && (await sha256File(dest)) === sha256) { console.log(`${name}: ${path.relative(ROOT, dest)} present`); return; }
  console.log(`${name}: downloading ${(bytes / 1e6).toFixed(1)} MB from ${new URL(url).host}${new URL(url).pathname}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  rmSync(part, { force: true }); // an earlier interrupted run
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len !== bytes) throw new Error(`${name}: the server offers ${len} bytes, the pin is ${bytes}; the release changed or the download is not what it should be`);
    const hash = createHash("sha256");
    let got = 0;
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      async function* (src: AsyncIterable<Buffer | Uint8Array>) {
        for await (const chunk of src) {
          got += chunk.length;
          if (got > bytes) throw new Error(`${name}: more than ${bytes} bytes`);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    if (got !== bytes || hash.digest("hex") !== sha256) throw new Error(`${name}: the downloaded file does not match the pin (sha256 ${sha256}); nothing installed`);
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

const extractAll = (zip: string, dir: string) => { mkdirSync(dir, { recursive: true }); execFileSync(TAR, ["-xf", zip, "-C", dir], { timeout: 600_000 }); };
const extractOne = (zip: string, member: string, out: string) => { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, execFileSync(TAR, ["-xOf", zip, "--", member], { maxBuffer: 1 << 28, timeout: 600_000 })); };

const hlaeComplete = (exe: string) => HLAE_FILES.every((f) => existsSync(path.join(path.dirname(exe), f)));

/** The HLAE in tools/hlae: unpacked into a staging folder and moved into place only when complete. An ffmpeg.ini of an incomplete install is carried over. */
async function installHlae() {
  if (hlaeComplete(HLAE_EXE)) { console.log(`HLAE: ${path.relative(ROOT, HLAE_DIR)} present`); return; }
  await download(`HLAE ${HLAE.version}`, HLAE.url, HLAE.zip, HLAE.bytes, HLAE.sha256);
  const staging = `${HLAE_DIR}.part`;
  rmSync(staging, { recursive: true, force: true });
  extractAll(HLAE.zip, staging); // the zip is flat: HLAE.exe and its dlls at the root
  const missing = HLAE_FILES.filter((f) => !existsSync(path.join(staging, f)));
  if (missing.length) { rmSync(staging, { recursive: true, force: true }); throw new Error(`HLAE: ${missing.join(", ")} missing after unpacking ${HLAE.zip}; nothing installed`); }
  const oldIni = path.join(HLAE_DIR, "ffmpeg", "ffmpeg.ini");
  if (existsSync(oldIni)) { mkdirSync(path.join(staging, "ffmpeg"), { recursive: true }); writeFileSync(path.join(staging, "ffmpeg", "ffmpeg.ini"), readFileSync(oldIni)); }
  if (existsSync(HLAE_DIR)) { console.log(`HLAE: replacing the incomplete install in ${path.relative(ROOT, HLAE_DIR)}`); rmSync(HLAE_DIR, { recursive: true, force: true }); }
  renameSync(staging, HLAE_DIR);
  console.log(`HLAE: unpacked to ${path.relative(ROOT, HLAE_DIR)}`);
}

async function installFfmpeg() {
  if (existsSync(PINNED_FFMPEG) && (await sha256File(PINNED_FFMPEG)) === FFMPEG.exeSha256) { console.log(`FFmpeg: ${path.relative(ROOT, PINNED_FFMPEG)} present`); return; }
  await download(`FFmpeg ${FFMPEG.version}`, FFMPEG.url, FFMPEG.zip, FFMPEG.bytes, FFMPEG.sha256);
  const part = `${PINNED_FFMPEG}.part`;
  extractOne(FFMPEG.zip, FFMPEG.exe, part);
  if ((await sha256File(part)) !== FFMPEG.exeSha256) { rmSync(part, { force: true }); throw new Error("FFmpeg: the unpacked ffmpeg.exe does not match the pin; nothing installed"); }
  extractOne(FFMPEG.zip, FFMPEG.license, path.join(path.dirname(PINNED_FFMPEG), "LICENSE"));
  renameSync(part, PINNED_FFMPEG);
  console.log(`FFmpeg: unpacked to ${path.relative(ROOT, PINNED_FFMPEG)}`);
}

/** HLAE's capture pipe reads the FFmpeg path from ffmpeg/ffmpeg.ini next to HLAE.exe (tools/hlae/ffmpeg/readme.advancedfx.txt). */
const iniFile = (hlaeExe: string) => path.join(path.dirname(hlaeExe), "ffmpeg", "ffmpeg.ini");
const iniPath = (ini: string): string | undefined => existsSync(ini) ? readFileSync(ini, "utf8").match(/^\s*Path\s*=\s*(.+?)\s*$/m)?.[1] : undefined;

/** Written only when there is none: an existing file, whatever it points at, is kept. */
function writeFfmpegIni(hlaeExe: string) {
  const ini = iniFile(hlaeExe);
  if (existsSync(ini)) { console.log(`ffmpeg.ini: present (${iniPath(ini) ?? "no Path= line"})`); return; }
  mkdirSync(path.dirname(ini), { recursive: true });
  writeFileSync(ini, `[Ffmpeg]\r\nPath=${PINNED_FFMPEG}\r\n`);
  console.log(`ffmpeg.ini: written, HLAE captures through ${path.relative(ROOT, PINNED_FFMPEG)}`);
}

// --- .env ------------------------------------------------------------------------------------

const readEnv = (): EnvFile => parseEnvFile(existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "");
/** The HLAE the renders use: .env's HLAE_EXE when set (wherever it points), else the one in tools/. */
const effectiveHlae = (env: EnvFile) => env.values.HLAE_EXE || HLAE_EXE;

async function fillEnv(env: EnvFile, found: { cs2?: string }) {
  const set = (k: string, v: string, how: string) => { setLine(env, k, v); console.log(`.env: ${k} set (${how})`); };
  if (!env.values.HLAE_EXE && hlaeComplete(HLAE_EXE)) set("HLAE_EXE", HLAE_EXE, path.relative(ROOT, HLAE_EXE));
  if (!env.values.CS2_EXE && found.cs2) set("CS2_EXE", found.cs2, "found in the Steam library");
  const missing = ["STEAM_ID64", "RENDER_STEAM_ID64"].filter((k) => !env.values[k]);
  if (missing.length && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q: string, dflt?: string): Promise<string | undefined> => {
      for (;;) {
        const a = (await rl.question(q)).trim();
        if (!a && dflt) return dflt;
        if (!a) return undefined;
        const id = parseSteamId64(a);
        if (id) return id;
        console.log("  Not a SteamID64. Paste the 17-digit number, or your profile link in the steamcommunity.com/profiles/<number> form.");
      }
    };
    try {
      if (!env.values.STEAM_ID64) {
        console.log("\nYour own account, the one you play on. Clips are of this player.");
        const id = await ask("STEAM_ID64 (17 digits, or your profile link; Enter to skip): ");
        if (id) set("STEAM_ID64", id, "typed");
      }
      if (!env.values.RENDER_STEAM_ID64) {
        const active = activeSteamId64();
        const dflt = active && active !== "0" && active !== env.values.STEAM_ID64 ? active : undefined;
        console.log("\nThe render account: a second Steam account, never your main. CS2 is launched on it with HLAE while clips render (README, Why a second Steam account).");
        const id = await ask(`RENDER_STEAM_ID64 (17 digits or profile link${dflt ? "; Enter = the account logged in to Steam right now" : "; Enter to skip"}): `, dflt);
        if (id) set("RENDER_STEAM_ID64", id, dflt && id === dflt ? "the account logged in now" : "typed");
      }
    } finally {
      rl.close();
    }
  } else if (missing.length) console.log(`.env: ${missing.join(", ")} empty; no terminal to ask in, fill them in by hand`);
  if (!env.changed) return;
  // What is about to be written must read back as intended through the parser the identities use.
  if (!roundTrips(env)) throw new Error(".env: the edit does not read back as written (a quoted multi-line value in the way?); nothing written, edit the file by hand");
  writeFileSync(ENV_FILE, envText(env));
}

// --- The report ------------------------------------------------------------------------------

type Row = { status: "ok" | "missing" | "warn" | "info"; text: string };

function report(env: EnvFile, found: { steam?: string; cs2?: string }): Row[] {
  const rows: Row[] = [];
  const ok = (t: string) => rows.push({ status: "ok", text: t });
  const missing = (t: string) => rows.push({ status: "missing", text: t });
  const warn = (t: string) => rows.push({ status: "warn", text: t });
  const info = (t: string) => rows.push({ status: "info", text: t });

  const major = Number(process.versions.node.split(".")[0]);
  (major >= 22 ? ok : missing)(`Node ${process.version}${major >= 22 ? "" : " (22 or newer needed)"}`);
  const ua = process.env.npm_config_user_agent?.match(/pnpm\/\S+/)?.[0];
  (ua ? ok : warn)(ua ?? "not run through pnpm (use pnpm prep / pnpm check)");

  (found.steam ? ok : missing)(found.steam ? `Steam at ${found.steam}` : "Steam not found in the registry (install Steam)");
  (found.cs2 ? ok : missing)(found.cs2 ? `CS2 at ${found.cs2}` : "CS2 not found in any Steam library (install Counter-Strike 2)");

  if (!existsSync(ENV_FILE)) missing(".env missing (pnpm prep creates it)");
  const ids = { pov: isSteamId64(env.values.STEAM_ID64 ?? "") ? env.values.STEAM_ID64 : undefined, render: isSteamId64(env.values.RENDER_STEAM_ID64 ?? "") ? env.values.RENDER_STEAM_ID64 : undefined };
  for (const k of REQUIRED_KEYS) {
    const v = env.values[k];
    if (!v) { missing(`.env ${k} empty`); continue; }
    if (k === "STEAM_ID64" || k === "RENDER_STEAM_ID64") (isSteamId64(v) ? ok : missing)(`.env ${k} ${isSteamId64(v) ? "set" : "is not a bare 17-digit SteamID64"}`);
    else (existsSync(v) ? ok : missing)(`.env ${k} ${existsSync(v) ? "set, file exists" : `points at a missing file: ${v}`}`);
  }
  if (ids.pov && ids.pov === ids.render) missing(".env STEAM_ID64 and RENDER_STEAM_ID64 are the same account; rendering on the main account is refused (README, Why a second Steam account)");
  for (const k of OPTIONAL_KEYS) info(`.env ${k} ${env.values[k] ? "set" : "not set (optional)"}`);

  const hlae = effectiveHlae(env);
  const cs2 = env.values.CS2_EXE || found.cs2;
  if (hlaeComplete(hlae)) {
    const v = cs2 && existsSync(cs2) ? toolVersions(cs2, hlae) : toolVersions("", hlae);
    info(`HLAE ${v.hlae} at ${path.dirname(hlae)}, CS2 ${v.cs2}, demoparser2 ${v.demoparser2}`);
  } else if (existsSync(hlae)) missing(`HLAE at ${path.dirname(hlae)} is incomplete (${HLAE_FILES.filter((f) => !existsSync(path.join(path.dirname(hlae), f))).join(", ")} missing)${hlae === HLAE_EXE ? "; pnpm prep replaces it" : ""}`);
  else missing(`HLAE missing at ${hlae} (pnpm prep downloads it)`);

  const ini = iniFile(hlae);
  const target = iniPath(ini);
  if (!existsSync(ini)) missing(`${ini} missing (pnpm prep writes it)`);
  else (target && existsSync(target) ? ok : missing)(target && existsSync(target) ? `HLAE captures through ${target}` : `${ini} points at a missing FFmpeg: ${target ?? "(no Path= line)"}`);
  const post = postFfmpeg();
  const ver = ffmpegVersion();
  (ver !== "unknown" ? ok : missing)(ver !== "unknown" ? `post encodes with ${post === "ffmpeg" ? "the FFmpeg in PATH" : path.relative(ROOT, post)}: ${ver}` : `no FFmpeg: none in PATH and ${path.relative(ROOT, PINNED_FFMPEG)} missing (pnpm prep downloads it)`);
  if (ver !== "unknown") {
    const nv = nvencFfmpeg();
    info(nv ? `NVENC available (${nv === "ffmpeg" ? "PATH FFmpeg" : path.relative(ROOT, nv)})` : "NVENC not available: final encodes use x264 (slower, same quality)");
  }

  // The look cfg reads the POV account's saved convars from the Steam install's userdata (src/render/controller/cfg.ts).
  if (found.steam && ids.pov) {
    const dir = path.join(found.steam, "userdata", accountId(ids.pov), "730", "local", "cfg");
    const have = ["cs2_user_convars_0_slot0.vcfg", "cs2_machine_convars.vcfg"].every((f) => existsSync(path.join(dir, f)));
    // The folder is named without its account part: that number is the SteamID64 minus a constant.
    const shown = path.join(found.steam, "userdata", "<your account>", "730", "local", "cfg");
    (have ? ok : missing)(have ? "your CS2 settings (crosshair, viewmodel) found for the POV account" : `your CS2 settings not found for the POV account (${shown}): launch CS2 once on your main account on this PC`);
  }

  const active = activeSteamId64();
  if (active === undefined) warn("could not read the logged-in Steam user from the registry");
  else if (active === "0") warn("nobody is logged in to Steam; log in with the render account before pnpm go");
  else if (ids.render && active === ids.render) ok("Steam is logged in with the render account");
  else if (ids.pov && active === ids.pov) warn("Steam is logged in with your main account; rendering refuses until the render account is logged in");
  else warn("Steam is logged in with an account that is neither STEAM_ID64 nor RENDER_STEAM_ID64");
  for (const img of ["cs2.exe", "HLAE.exe"]) if (imageRunning(img)) warn(`${img} is running; close it before pnpm go`);

  const b = findBrowser();
  info(b ? `${b.name} found (for pnpm grab --login)` : "no Chrome or Edge found (only pnpm grab --login needs one)");
  return rows;
}

async function main(): Promise<number> {
  const steam = steamPath();
  const cs2 = steam ? findCs2(steam) : undefined;
  if (!checkOnly) {
    const env = readEnv();
    if (!existsSync(ENV_FILE)) { writeFileSync(ENV_FILE, readFileSync(ENV_EXAMPLE)); console.log(".env: created from .env.example"); }
    // An HLAE named in .env that is not tools/hlae is the user's own: nothing is downloaded for it.
    if (env.values.HLAE_EXE && path.resolve(env.values.HLAE_EXE) !== HLAE_EXE) console.log(`HLAE: .env names ${env.values.HLAE_EXE}; tools/hlae is not touched`);
    else await installHlae();
    await installFfmpeg();
    writeFfmpegIni(effectiveHlae(env));
    await fillEnv(readEnv(), { cs2 });
    console.log("");
  }
  const rows = report(readEnv(), { steam, cs2 });
  const label = { ok: "ok     ", missing: "MISSING", warn: "warn   ", info: "       " };
  for (const r of rows) console.log(`${label[r.status]} ${r.text}`);
  const bad = rows.filter((r) => r.status === "missing").length;
  console.log(bad ? `\n${bad} requirement(s) missing.` : checkOnly ? "\nReady." : "\nReady. Drop a demo into demos/inbox/ and run pnpm go with the render account logged in to Steam.");
  return bad ? 1 : 0;
}

main().then((c) => { process.exitCode = c; }, (e: Error) => { console.error(e.message); process.exitCode = 1; });
