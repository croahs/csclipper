// Valve matchmaking source with a fake Steam Web API and a fake fetcher (codes in,
// outcomes out, files written into a temp inbox), plus the fetch launch's pure
// pieces. No network, no game launch.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NEXT_CODE_API, decodeShareCode, valveSource, type ValveTransport } from "../src/ingest/sources/valve.ts";
import { childEnv, fetchLauncher, infoMatchId, launchArgs, repairOrphanInfo, type DemoFetcher, type FetchOutcome, type FetchResult } from "../src/ingest/sources/valve-fetch.ts";
import type { SourceContext } from "../src/ingest/sources.ts";
import { demoBytes, truncatedDemo } from "./demo-bytes.ts";

const STEAM = "76561190000000001"; // fake
// C[0] is the known start; the others decode to distinct outcome ids.
const C = ["CSGO-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", "CSGO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB", "CSGO-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC", "CSGO-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD"];
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const padded = (code: string) => decodeShareCode(code).paddedOutcomeId;
const demoName = (code: string) => `match730_${padded(code)}_0309642818_187.dem`;

function setup(opts: { dryRun?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "valve-"));
  const lines: string[] = [];
  const ctx: SourceContext = { inbox: path.join(dir, "inbox"), stateFile: path.join(dir, "state", "valve.json"), dryRun: !!opts.dryRun, log: (l) => lines.push(l) };
  const state = () => (existsSync(ctx.stateFile) ? JSON.parse(readFileSync(ctx.stateFile, "utf8")) : undefined);
  const inbox = () => (existsSync(ctx.inbox) ? readdirSync(ctx.inbox).sort() : []);
  return { ctx, lines, state, inbox };
}

function transport(opts: { codes?: string[]; status?: number } = {}): ValveTransport {
  const chain = opts.codes ?? C;
  return {
    async getJson(u) {
      const q = new URL(u);
      assert.equal(`${q.origin}${q.pathname}`, NEXT_CODE_API);
      assert.equal(q.searchParams.get("steamid"), STEAM);
      if (opts.status) return { status: opts.status, body: {} };
      const i = chain.indexOf(q.searchParams.get("knowncode")!);
      assert.ok(i >= 0, "walked from an unknown code");
      return i + 1 < chain.length ? { status: 200, body: { result: { nextcode: chain[i + 1] } } } : { status: 202, body: { result: { nextcode: "n/a" } } };
    },
  };
}

/** A fake fetcher with the real one's order rule: one code at a time, stopping at the first pending or failed. */
function fetcher(outcomes: Record<string, FetchOutcome> = {}, opts: { blocked?: string; unverified?: string } = {}): DemoFetcher & { calls: { codes: string[]; dryRun: boolean }[] } {
  const calls: { codes: string[]; dryRun: boolean }[] = [];
  return {
    calls,
    async fetch(codes, ctx): Promise<FetchResult> {
      calls.push({ codes: [...codes], dryRun: ctx.dryRun });
      if (ctx.dryRun) return { results: codes.map((code) => ({ code, outcome: "pending", reason: "dry run" })), cleanupVerified: true };
      if (opts.blocked) return { results: codes.map((code) => ({ code, outcome: "pending", reason: opts.blocked })), blocked: opts.blocked, cleanupVerified: true };
      const results: FetchResult["results"] = [];
      for (const [i, code] of codes.entries()) {
        if (code === opts.unverified) {
          results.push({ code, outcome: "failed", reason: "cleanup not verified" }, ...codes.slice(i + 1).map((c) => ({ code: c, outcome: "pending" as const })));
          return { results, cleanupVerified: false };
        }
        const outcome = outcomes[code] ?? "done";
        if (outcome === "done") {
          mkdirSync(ctx.inbox, { recursive: true });
          const file = path.join(ctx.inbox, demoName(code));
          writeFileSync(file, "PBDEMS2\0");
          results.push({ code, outcome, file });
          continue;
        }
        results.push({ code, outcome, reason: `fake ${outcome}` });
        if (outcome === "pending" || outcome === "failed") { results.push(...codes.slice(i + 1).map((c) => ({ code: c, outcome: "pending" as const }))); break; }
      }
      return { results, cleanupVerified: true };
    },
  };
}

const base = { apiKey: "k", authCode: "AAAA-AAAAA-AAAA", startShareCode: C[0], steamId64: STEAM, maxMatchesPerRun: 5, now: () => NOW };

test("no keys: skipped, nothing written, nothing fetched", async () => {
  const s = setup();
  const f = fetcher();
  const r = await valveSource({ ...base, apiKey: undefined, fetcher: f }).fetch(s.ctx);
  assert.ok(r.skipped);
  assert.equal(s.state(), undefined);
  assert.equal(f.calls.length, 0);
});

test("three new codes, all done: fetched oldest first, checkpoint at the newest", async () => {
  const s = setup();
  const f = fetcher();
  const r = await valveSource({ ...base, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.deepEqual(f.calls, [{ codes: [C[1], C[2], C[3]], dryRun: false }]);
  assert.deepEqual(s.inbox(), [demoName(C[1]), demoName(C[2]), demoName(C[3])].sort());
  assert.equal(r.fetched.length, 3);
  assert.equal(r.pending.length, 0);
  assert.equal(s.state().lastShareCode, C[3]);
  assert.deepEqual(s.state().pending, {});
  // Up to date: the next run asks the fetcher for nothing.
  const again = await valveSource({ ...base, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.equal(again.fetched.length, 0);
  assert.equal(f.calls.length, 1);
});

test("a pending code stops the checkpoint and starts its 30-day clock", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), fetcher: fetcher({ [C[2]]: "pending" }) }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[1]);
  assert.deepEqual(r.pending.map((p) => p.item), [C[2], C[3]]);
  assert.equal(r.pending[0].reason, "fake pending");
  assert.ok(!r.failed);
  assert.equal(s.state().pending[C[2]].firstSeenAt, new Date(NOW).toISOString());
  // Still pending a day later: the clock keeps its first value; done clears it.
  await valveSource({ ...base, now: () => NOW + DAY, transport: transport(), fetcher: fetcher({ [C[2]]: "pending" }) }).fetch(s.ctx);
  assert.equal(s.state().pending[C[2]].firstSeenAt, new Date(NOW).toISOString());
  await valveSource({ ...base, now: () => NOW + 2 * DAY, transport: transport(), fetcher: fetcher() }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[3]);
  assert.deepEqual(s.state().pending, {});
});

test("a gone code is skipped over", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), fetcher: fetcher({ [C[1]]: "gone" }) }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[3]);
  assert.deepEqual(s.inbox(), [demoName(C[2]), demoName(C[3])].sort());
  assert.ok(!r.failed);
});

test("a code pending for over 30 days is gone without a launch", async () => {
  const s = setup();
  mkdirSync(path.dirname(s.ctx.stateFile), { recursive: true });
  // The checkpoint's STEAM_ID64 hash is taken from a first run with nothing new.
  await valveSource({ ...base, transport: transport({ codes: [C[0]] }), fetcher: fetcher() }).fetch(s.ctx);
  const st = s.state();
  writeFileSync(s.ctx.stateFile, JSON.stringify({ ...st, pending: { [C[1]]: { firstSeenAt: new Date(NOW - 31 * DAY).toISOString() }, [C[2]]: { firstSeenAt: new Date(NOW - 29 * DAY).toISOString() } } }));
  const f = fetcher({ [C[2]]: "pending" });
  await valveSource({ ...base, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.deepEqual(f.calls[0].codes, [C[2], C[3]]);
  assert.equal(s.state().lastShareCode, C[1]);
  assert.equal(s.state().pending[C[1]], undefined);
  assert.ok(s.state().pending[C[2]]);
});

test("dry run calls the fetcher with dryRun and writes nothing", async () => {
  const s = setup({ dryRun: true });
  const f = fetcher();
  const r = await valveSource({ ...base, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.deepEqual(f.calls, [{ codes: [C[1], C[2], C[3]], dryRun: true }]);
  assert.equal(s.state(), undefined);
  assert.deepEqual(s.inbox(), []);
  assert.equal(r.fetched.length, 0);
});

test("the real fetcher's dry run launches nothing and touches nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "valve-fetch-"));
  const lockFile = path.join(dir, "state", ".render.lock");
  const lines: string[] = [];
  const ids = { pov: STEAM, renderAccount: "76561190000000002", hlaeExe: path.join(dir, "HLAE.exe"), cs2Exe: path.join(dir, "game", "bin", "win64", "cs2.exe") };
  const r = await fetchLauncher(ids, { lockFile }).fetch([C[1], C[2]], { inbox: path.join(dir, "inbox"), dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(r.results.map((x) => x.outcome), ["pending", "pending"]);
  assert.ok(r.cleanupVerified);
  assert.ok(lines.some((l) => l.includes(`would launch CS2 to download match ${C[1]}`)));
  assert.deepEqual(readdirSync(dir), []);
  await assert.rejects(fetchLauncher(ids, { lockFile }).fetch(["CSGO-IIIII-AAAAA-AAAAA-AAAAA-AAAAA"], { inbox: dir, dryRun: true, log: () => {} }), /characters no share code uses/);
});

test("a blocked fetcher (lock held, guard refused) reports every code pending, not a failure", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), fetcher: fetcher({}, { blocked: "refusing: CS2 is already running" }) }).fetch(s.ctx);
  assert.equal(r.blocked, "refusing: CS2 is already running");
  assert.deepEqual(r.pending.map((p) => [p.item, p.reason]), [C[1], C[2], C[3]].map((c) => [c, "refusing: CS2 is already running"]));
  assert.ok(!r.failed);
  assert.equal(s.state().lastShareCode, C[0]);
});

test("a failed launch sets failed and stops before the checkpoint passes it", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), fetcher: fetcher({ [C[2]]: "failed" }) }).fetch(s.ctx);
  assert.ok(r.failed);
  assert.ok(!r.cleanupUnverified);
  assert.equal(s.state().lastShareCode, C[1]);
  assert.deepEqual(r.pending.map((p) => p.item), [C[2], C[3]]);
});

test("an unverified cleanup is reported to pnpm grab and fails the run", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), fetcher: fetcher({}, { unverified: C[1] }) }).fetch(s.ctx);
  assert.ok(r.cleanupUnverified);
  assert.ok(r.failed);
  assert.equal(s.state().lastShareCode, C[0]);
});

test("a code whose demo is stored is not re-requested; the checkpoint passes it", async () => {
  const s = setup();
  const f = fetcher();
  await valveSource({ ...base, transport: transport(), fetcher: f, haveDemo: (p) => p === padded(C[2]) }).fetch(s.ctx);
  assert.deepEqual(f.calls[0].codes, [C[1], C[3]]);
  assert.equal(s.state().lastShareCode, C[3]);
});

test("per-run limit: the rest waits for the next run", async () => {
  const s = setup();
  const f = fetcher();
  await valveSource({ ...base, maxMatchesPerRun: 1, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[1]);
  await valveSource({ ...base, maxMatchesPerRun: 1, transport: transport(), fetcher: f }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[2]);
  assert.deepEqual(f.calls.map((c) => c.codes), [[C[1]], [C[2]]]);
});

test("Web API errors fail with a message; state of another STEAM_ID64 is refused", async () => {
  const s = setup();
  await assert.rejects(valveSource({ ...base, transport: transport({ status: 403 }), fetcher: fetcher() }).fetch(s.ctx), /403/);
  await valveSource({ ...base, transport: transport({ codes: [C[0]] }), fetcher: fetcher() }).fetch(s.ctx);
  await assert.rejects(valveSource({ ...base, steamId64: "76561190000000002", transport: transport(), fetcher: fetcher() }).fetch(s.ctx), /another STEAM_ID64/);
});

test("share codes: decoded to string ids, padded outcome id; off-alphabet codes refused", () => {
  // The gate's real code (docs/spikes.md, M0.4) and its Watch-tab file name.
  const d = decodeShareCode("CSGO-xFRvu-ZkHam-ssK4s-ujdiL-mHHnK");
  assert.deepEqual(d, { matchId: "3850166708866122393", outcomeId: "3850170963031228525", paddedOutcomeId: "003850170963031228525" });
  assert.throws(() => decodeShareCode("CSGO-0AAAA-AAAAA-AAAAA-AAAAA-AAAAA"), /characters no share code uses/);
  assert.throws(() => decodeShareCode("CSGO-AAAAA-AAAAA"), /not a share code/);
});

test("the launch line is exactly the contract's; USRLOCALCSGO is dropped in any casing", () => {
  assert.deepEqual(launchArgs(C[1], 123), ["-insecure", "-novid", "-sw", "-width", "1280", "-height", "720", "-condebug", "+echo", "croclip_fetch_123", "+csgo_download_match", C[1]]);
  assert.throws(() => launchArgs("CSGO-AAAAA-AAAAA-AAAAA-AAAAA-AAAA; quit", 1));
  assert.deepEqual(childEnv({ PATH: "x", usrLocalCsgo: "y", USRLOCALCSGO: "z" }), { PATH: "x" });
});

test("infoMatchId: field 1 by protobuf wire rules, wherever it sits; malformed framing throws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "valve-info-"));
  const varint = (v: bigint) => { const out: number[] = []; for (;;) { const b = Number(v & 127n); v >>= 7n; if (v) out.push(b | 128); else { out.push(b); return out; } } };
  const id = "3850170963031228525";
  const read = (bytes: number[]) => { const f = path.join(dir, "x.dem.info"); writeFileSync(f, Buffer.from(bytes)); return infoMatchId(f); };
  const field1 = [0x08, ...varint(BigInt(id))];
  const lenDelim = [0x12, 0x03, 0x08, 0x01, 0x10]; // field 2, 3 bytes (a nested message)
  const fixed64 = [0x19, 1, 2, 3, 4, 5, 6, 7, 8]; // field 3
  const fixed32 = [0x25, 1, 2, 3, 4]; // field 4
  const otherVarint = [0x28, 0x96, 0x01]; // field 5
  assert.equal(read(field1), id);
  assert.equal(read([...otherVarint, ...fixed32, ...fixed64, ...field1]), id); // reordered: field 1 last
  assert.equal(read([...lenDelim, ...field1, ...fixed32]), id); // after a length-delimited field
  assert.throws(() => read(field1.slice(0, -1)), /truncated varint/); // cut inside field 1
  assert.throws(() => read([...field1, 0x12, 0x05, 0x01]), /past the end/); // a length past the end
  assert.throws(() => read([...field1, ...fixed64.slice(0, 5)]), /past the end/);
  assert.throws(() => read([...lenDelim, ...fixed32]), /no field 1/);
  assert.throws(() => read([0x12, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02, 0x01]), /over 64 bits/); // a 2^64 length
  assert.throws(() => read([...varint((536_870_912n << 3n) | 0n), 0x01]), /outside protobuf's range/); // field 2^29
  assert.throws(() => read([0x0b, ...field1]), /field 1 is not a varint/); // a group start on field 1
  assert.throws(() => read([...field1, 0x13]), /wire type 3/); // a group on field 2
  assert.throws(() => read([...field1, 0x16]), /wire type 6/);
  assert.throws(() => read([0x00, 0x01, ...field1]), /field number 0/);
  assert.throws(() => read([0x08, ...Array(10).fill(0xff), 0x01]), /longer than 10 bytes/);
});

test("orphan .info repair: only a matching .info without a complete .dem beside it goes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "valve-replays-"));
  const code = decodeShareCode(C[1]);
  // A .dem.info: field 1 (varint) = matchid, as CS2 writes it.
  const info = (matchId: string) => {
    const out = [0x08];
    for (let v = BigInt(matchId); ; ) { const b = Number(v & 127n); v >>= 7n; if (v) out.push(b | 128); else { out.push(b); break; } }
    return Buffer.concat([Buffer.from(out), Buffer.from([0x12, 0x00])]);
  };
  const orphan = `match730_${code.paddedOutcomeId}_1_2.dem.info`;
  const otherMatch = `match730_${code.paddedOutcomeId}_3_4.dem.info`;
  const otherCode = `match730_${padded(C[2])}_5_6.dem.info`;
  const pair = `match730_${code.paddedOutcomeId}_7_8.dem`; // complete: its .info stays
  const halfPair = `match730_${code.paddedOutcomeId}_9_10.dem`; // cut short: its .info goes
  writeFileSync(path.join(dir, pair), demoBytes(1));
  writeFileSync(path.join(dir, `${pair}.info`), info(code.matchId));
  writeFileSync(path.join(dir, halfPair), truncatedDemo(1));
  writeFileSync(path.join(dir, `${halfPair}.info`), info(code.matchId));
  writeFileSync(path.join(dir, orphan), info(code.matchId));
  writeFileSync(path.join(dir, otherMatch), info("12345"));
  writeFileSync(path.join(dir, otherCode), info(decodeShareCode(C[2]).matchId));
  assert.equal(infoMatchId(path.join(dir, orphan)), code.matchId);
  assert.deepEqual(repairOrphanInfo(dir, code).sort(), [orphan, `${halfPair}.info`].sort());
  assert.deepEqual(readdirSync(dir).sort(), [otherCode, otherMatch, pair, `${pair}.info`, halfPair].sort());
  assert.deepEqual(repairOrphanInfo(path.join(dir, "missing"), code), []);
});
