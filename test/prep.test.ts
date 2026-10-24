// pnpm prep's pure pieces: library paths, SteamID64 parsing, .env editing.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { envText, isSteamId64, librariesFromVdf, parseEnvFile, parseSteamId64, roundTrips, setLine } from "../src/prep.ts";

test("libraries: the install plus every vdf path, unescaped, deduped case-insensitively", () => {
  const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}\n`;
  assert.deepEqual(librariesFromVdf("c:\\program files (x86)\\steam", vdf), ["c:\\program files (x86)\\steam", "D:\\SteamLibrary"]);
  assert.deepEqual(librariesFromVdf("C:\\Steam", undefined), ["C:\\Steam"]);
});

test("SteamID64: digits or a /profiles/ link when typed; only bare digits when stored", () => {
  assert.equal(parseSteamId64(" 76561198000000001 "), "76561198000000001");
  assert.equal(parseSteamId64("https://steamcommunity.com/profiles/76561198000000001/"), "76561198000000001");
  assert.equal(parseSteamId64("https://steamcommunity.com/profiles/76561198000000001"), "76561198000000001");
  assert.equal(parseSteamId64("https://steamcommunity.com/id/someone/"), undefined); // a vanity link carries no id
  assert.equal(parseSteamId64("7656119800000000"), undefined); // 16 digits
  assert.equal(parseSteamId64("76561197960265728"), undefined); // the base itself is no account
  assert.equal(parseSteamId64("STEAM_1:0:12345"), undefined);
  assert.equal(isSteamId64("76561198000000001"), true);
  assert.equal(isSteamId64("https://steamcommunity.com/profiles/76561198000000001"), false); // src/config.ts would refuse it too
});

test(".env editing: comments, order and line endings kept, set lines replaced in place, new keys appended, paths bare or single-quoted", () => {
  const env = parseEnvFile("# a comment\r\nSTEAM_ID64=\r\nRENDER_STEAM_ID64=1\r\n");
  assert.equal(env.changed, false);
  setLine(env, "STEAM_ID64", "76561198000000001");
  setLine(env, "CS2_EXE", "C:\\Program Files (x86)\\Steam\\new\\cs2.exe");
  setLine(env, "HLAE_EXE", "C:\\Games#1\\hlae\\HLAE.exe");
  assert.equal(env.changed, true);
  assert.equal(envText(env), "# a comment\r\nSTEAM_ID64=76561198000000001\r\nRENDER_STEAM_ID64=1\r\nCS2_EXE=C:\\Program Files (x86)\\Steam\\new\\cs2.exe\r\nHLAE_EXE='C:\\Games#1\\hlae\\HLAE.exe'\r\n");
  // What was written reads back as the same values, through the parser the identities use (config.ts).
  assert.deepEqual(parseEnv(envText(env)), { STEAM_ID64: "76561198000000001", RENDER_STEAM_ID64: "1", CS2_EXE: "C:\\Program Files (x86)\\Steam\\new\\cs2.exe", HLAE_EXE: "C:\\Games#1\\hlae\\HLAE.exe" });
  assert.equal(roundTrips(env), true);
  // What no line can carry is refused rather than written wrong.
  assert.throws(() => setLine(env, "HLAE_EXE", "C:\\it's\\HLAE.exe"), /cannot be written/);
  assert.throws(() => setLine(env, "HLAE_EXE", "C:\\a\nb"), /cannot be written/);
  // An empty file gets the line and a trailing newline.
  const empty = parseEnvFile("");
  setLine(empty, "HLAE_EXE", "C:\\x\\HLAE.exe");
  assert.equal(envText(empty), "HLAE_EXE=C:\\x\\HLAE.exe\n");
});

test(".env editing: an edit that lands inside a quoted multi-line value is caught by the round-trip check", () => {
  const env = parseEnvFile('NOTES="first\nHLAE_EXE=\nlast"\nHLAE_EXE=\n');
  assert.equal(env.values.HLAE_EXE, "");
  setLine(env, "HLAE_EXE", "C:\\x\\HLAE.exe"); // replaces the line inside NOTES, not the real assignment
  assert.equal(roundTrips(env), false);
});
