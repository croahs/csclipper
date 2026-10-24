// Valve matchmaking source with a fake Steam Web API, a fake Game Coordinator
// and fake downloads. No network, no Steam login, no game.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { NEXT_CODE_API, replayStem, valveHttp, valveSource, type GcOpener, type ValveTransport } from "../src/ingest/sources/valve.ts";
import type { SourceContext } from "../src/ingest/sources.ts";

const STEAM = "76561190000000001"; // fake
const C = ["CSGO-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", "CSGO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB", "CSGO-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC"]; // C[0] is the known start
const NOW = 1_800_000_000_000;
const url = (code: string) => `http://replay183.valve.net/730/0037${code.charCodeAt(5)}0000000000_0123456789.dem.bz2`;
const stem = (code: string) => replayStem(url(code));

function setup(opts: { dryRun?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "valve-"));
  const lines: string[] = [];
  const ctx: SourceContext = { inbox: path.join(dir, "inbox"), stateFile: path.join(dir, "state", "valve.json"), dryRun: !!opts.dryRun, log: (l) => lines.push(l) };
  const state = () => (existsSync(ctx.stateFile) ? JSON.parse(readFileSync(ctx.stateFile, "utf8")) : undefined);
  const inbox = () => (existsSync(ctx.inbox) ? readdirSync(ctx.inbox).sort() : []);
  return { ctx, lines, state, inbox };
}

function transport(opts: { codes?: string[]; status?: number; fail?: string; gone?: string } = {}): ValveTransport & { downloads: string[] } {
  const chain = opts.codes ?? C;
  const downloads: string[] = [];
  return {
    downloads,
    async getJson(u) {
      const q = new URL(u);
      assert.equal(`${q.origin}${q.pathname}`, NEXT_CODE_API);
      assert.equal(q.searchParams.get("steamid"), STEAM);
      if (opts.status) return { status: opts.status, body: {} };
      const i = chain.indexOf(q.searchParams.get("knowncode")!);
      assert.ok(i >= 0, "walked from an unknown code");
      return i + 1 < chain.length ? { status: 200, body: { result: { nextcode: chain[i + 1] } } } : { status: 202, body: { result: { nextcode: "n/a" } } };
    },
    async download(u, dest) {
      downloads.push(u);
      if (u === opts.gone) throw new Error("download HTTP 404");
      if (u === opts.fail) { writeFileSync(dest, "half"); throw new Error("download HTTP 500"); }
      writeFileSync(dest, Buffer.concat([Buffer.from("BZh91AY&SY"), Buffer.alloc(16)]));
    },
  };
}

function gc(opts: { blocked?: string; noUrl?: string; age?: number; noTime?: boolean } = {}): GcOpener & { opened: number; closed: number } {
  const g = Object.assign(async () => {
    g.opened++;
    if (opts.blocked) return { blocked: opts.blocked };
    return {
      async resolve(code: string) { return { url: code === opts.noUrl ? undefined : url(code), matchTime: opts.noTime ? undefined : NOW / 1000 - (opts.age ?? 600) }; },
      async close() { g.closed++; },
    };
  }, { opened: 0, closed: 0 });
  return g;
}

const base = { apiKey: "k", authCode: "AAAA-AAAAA-AAAA", startShareCode: C[0], steamId64: STEAM, maxMatchesPerRun: 5, now: () => NOW };

test("no keys: skipped, nothing written", async () => {
  const s = setup();
  const r = await valveSource({ ...base, apiKey: undefined, openGc: gc() }).fetch(s.ctx);
  assert.ok(r.skipped);
  assert.equal(s.state(), undefined);
});

test("first run walks forward from the start code and fetches oldest first", async () => {
  const s = setup();
  const t = transport();
  const g = gc();
  const r = await valveSource({ ...base, transport: t, openGc: g }).fetch(s.ctx);
  assert.deepEqual(t.downloads, [url(C[1]), url(C[2])]);
  assert.deepEqual(s.inbox(), [`valve-${stem(C[1])}.dem.bz2`, `valve-${stem(C[2])}.dem.bz2`].sort());
  assert.equal(r.fetched.length, 2);
  assert.equal(s.state().lastShareCode, C[2]);
  assert.equal(g.closed, 1);
  // Up to date: no GC login on the next run.
  const again = await valveSource({ ...base, transport: t, openGc: g }).fetch(s.ctx);
  assert.equal(again.fetched.length, 0);
  assert.equal(g.opened, 1);
});

test("dry run lists codes, opens no GC session, writes nothing", async () => {
  const s = setup({ dryRun: true });
  const g = gc();
  await valveSource({ ...base, transport: transport(), openGc: g }).fetch(s.ctx);
  assert.equal(g.opened, 0);
  assert.equal(s.state(), undefined);
  assert.ok(s.lines.some((l) => l.includes(`would download match ${C[1]}`)));
});

test("per-run limit: the rest waits for the next run", async () => {
  const s = setup();
  const t = transport();
  await valveSource({ ...base, maxMatchesPerRun: 1, transport: t, openGc: gc() }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[1]);
  await valveSource({ ...base, maxMatchesPerRun: 1, transport: t, openGc: gc() }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[2]);
  assert.deepEqual(t.downloads, [url(C[1]), url(C[2])]);
});

test("GC blocked: every code pending, checkpoint unchanged, not a failure", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport(), openGc: gc({ blocked: "CS2 is running" }) }).fetch(s.ctx);
  assert.equal(r.blocked, "CS2 is running");
  assert.deepEqual(r.pending.map((p) => p.item), [C[1], C[2]]);
  assert.ok(!r.failed);
  assert.equal(s.state().lastShareCode, C[0]);
});

test("a failed download stops the run before the checkpoint passes it, and leaves no partial file", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport({ fail: url(C[1]) }), openGc: gc() }).fetch(s.ctx);
  assert.ok(r.failed);
  assert.equal(s.state().lastShareCode, C[0]);
  assert.deepEqual(s.inbox(), []);
  assert.deepEqual(r.pending.map((p) => p.item), [C[1], C[2]]);
});

test("a recent match without a demo yet waits; an old one is skipped", async () => {
  const fresh = setup();
  const r = await valveSource({ ...base, transport: transport(), openGc: gc({ noUrl: C[1] }) }).fetch(fresh.ctx);
  assert.equal(fresh.state().lastShareCode, C[0]);
  assert.equal(r.pending[0].item, C[1]);
  const old = setup();
  await valveSource({ ...base, transport: transport(), openGc: gc({ noUrl: C[1], age: 5 * 3600 }) }).fetch(old.ctx);
  assert.equal(old.state().lastShareCode, C[2]);
  assert.deepEqual(old.inbox(), [`valve-${stem(C[2])}.dem.bz2`]);
});

test("demos past Valve's ~30 days, or gone (404 on an old match), are skipped; already stored ones too", async () => {
  const s = setup();
  await valveSource({ ...base, transport: transport(), openGc: gc({ age: 31 * 24 * 3600 }) }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[2]);
  assert.deepEqual(s.inbox(), []);
  const g = setup();
  await valveSource({ ...base, transport: transport({ gone: url(C[1]) }), openGc: gc({ age: 3 * 24 * 3600 }) }).fetch(g.ctx);
  assert.equal(g.state().lastShareCode, C[2]);
  assert.deepEqual(g.inbox(), [`valve-${stem(C[2])}.dem.bz2`]);
  const h = setup();
  const t = transport();
  await valveSource({ ...base, transport: t, openGc: gc(), haveDemo: (x) => x === stem(C[1]) }).fetch(h.ctx);
  assert.deepEqual(t.downloads, [url(C[2])]);
});

test("Web API errors fail with a message; state of another STEAM_ID64 is refused", async () => {
  const s = setup();
  await assert.rejects(valveSource({ ...base, transport: transport({ status: 403 }), openGc: gc() }).fetch(s.ctx), /403/);
  await assert.rejects(valveSource({ ...base, steamId64: "76561190000000002", transport: transport(), openGc: gc() }).fetch(s.ctx), /another STEAM_ID64/);
});

test("replay URLs only from Valve's replay servers", () => {
  assert.equal(replayStem("http://replay183.valve.net/730/003712345678901234567_0123456789.dem.bz2"), "003712345678901234567_0123456789");
  assert.throws(() => replayStem("http://evil.example/730/0037123456_01.dem.bz2"), /replay servers/);
  assert.throws(() => replayStem("http://replay1.valve.net/730/../x.dem.bz2"), /unexpected path/);
});

test("a 404 on a match of unknown age waits instead of being skipped", async () => {
  const s = setup();
  const r = await valveSource({ ...base, transport: transport({ gone: url(C[1]) }), openGc: gc({ noTime: true }) }).fetch(s.ctx);
  assert.equal(s.state().lastShareCode, C[0]);
  assert.equal(r.pending[0].item, C[1]);
  assert.ok(!r.failed);
});

test("downloads refuse redirects and bodies without a Content-Length", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" }); res.end(); return; }
    if (req.url === "/chunked") { res.writeHead(200, { "Transfer-Encoding": "chunked" }); res.write("BZh9"); res.end(); return; }
    const body = Buffer.from("BZh91AY&SY0000");
    res.writeHead(200, { "Content-Length": body.length }); res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(path.join(tmpdir(), "valve-dl-"));
  try {
    await assert.rejects(valveHttp.download(`http://127.0.0.1:${port}/redirect`, path.join(dir, "a"), 1 << 20));
    await assert.rejects(valveHttp.download(`http://127.0.0.1:${port}/chunked`, path.join(dir, "b"), 1 << 20), /Content-Length/);
    await valveHttp.download(`http://127.0.0.1:${port}/ok`, path.join(dir, "c"), 1 << 20);
    assert.equal(readFileSync(path.join(dir, "c"), "latin1").slice(0, 3), "BZh");
  } finally { server.close(); }
});
