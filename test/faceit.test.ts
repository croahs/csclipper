// FACEIT source against recorded fixtures (test/fixtures/faceit, shaped like
// the documented API responses; docs/faceit-api.md). No network, no game.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import http from "node:http";
import { API, DOWNLOAD_API, demoFileName, faceitSource, httpTransport, type Transport } from "../src/ingest/sources/faceit.ts";
import type { SourceContext } from "../src/ingest/sources.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "faceit");
const fixture = (n: string) => JSON.parse(readFileSync(path.join(FIX, n), "utf8"));
const STEAM = "76561190000000001"; // fake
const KEY = "test-key";
const ids = (fixture("history.json").items as { match_id: string }[]).map((i) => i.match_id); // newest first: d, c, b, a

type Fake = Transport & { calls: string[]; downloads: string[] };
type Item = { match_id: string; status?: string; finished_at?: number };
function fakeTransport(opts: { history?: string[]; items?: Item[]; failDownload?: string; noDemo?: string; demoUrlValue?: unknown; demoBody?: Buffer; status?: number; noScope?: boolean } = {}): Fake {
  const historyIds = opts.history ?? ids;
  const calls: string[] = [];
  const downloads: string[] = [];
  return {
    calls, downloads,
    async getJson(url, key) {
      calls.push(url);
      assert.equal(key, KEY);
      if (opts.status) return { status: opts.status, body: { errors: [{ message: "forbidden" }] } };
      const u = new URL(url);
      if (u.pathname === "/data/v4/players") {
        assert.equal(u.searchParams.get("game"), "cs2");
        assert.equal(u.searchParams.get("game_player_id"), STEAM);
        return { status: 200, body: fixture("player.json") };
      }
      if (u.pathname.endsWith("/history")) {
        const offset = Number(u.searchParams.get("offset"));
        const limit = Number(u.searchParams.get("limit"));
        const all = opts.items ?? fixture("history.json").items.filter((i: { match_id: string }) => historyIds.includes(i.match_id));
        return { status: 200, body: { ...fixture("history.json"), items: all.slice(offset, offset + limit) } };
      }
      const m = u.pathname.match(/\/matches\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const demoUrl = "demoUrlValue" in opts ? opts.demoUrlValue : id === opts.noDemo ? [] : [`https://demos-europe-central-faceit-cdn.s3.amazonaws.com/cs2/${id}-1-1.dem.gz`];
        const body = { ...fixture("match.json"), match_id: id, demo_url: demoUrl };
        return { status: 200, body };
      }
      return { status: 404, body: {} };
    },
    async postJson(url, key, payload) {
      assert.equal(url, DOWNLOAD_API);
      assert.equal(key, KEY);
      if (opts.noScope) return { status: 403, body: { errors: [{ code: "err_f0", message: "no valid scope provided" }] } };
      const resource = (payload as { resource_url: string }).resource_url;
      return { status: 200, body: { payload: { download_url: `${resource}?X-Amz-Signature=example` } } };
    },
    async download(url, dest) {
      downloads.push(url);
      if (opts.failDownload && url.includes(opts.failDownload)) { writeFileSync(dest, "partial"); throw new Error("connection reset"); }
      writeFileSync(dest, opts.demoBody ?? zlib.gzipSync(Buffer.concat([Buffer.from("PBDEMS2\0", "latin1"), Buffer.alloc(64)])));
    },
  };
}

function ctx(dryRun = false): SourceContext & { lines: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "croclip-faceit-"));
  const lines: string[] = [];
  return { inbox: path.join(dir, "inbox"), stateFile: path.join(dir, "state", "faceit.json"), dryRun, log: (l) => lines.push(l), lines };
}
const mk = (c: SourceContext) => mkdirSync(c.inbox, { recursive: true });

test("no API key: skipped with a message, nothing written, no network", async () => {
  const t = fakeTransport();
  const c = ctx();
  const r = await faceitSource({ steamId64: STEAM, maxMatchesPerRun: 5, transport: t }).fetch(c);
  assert.match(r.skipped ?? "", /FACEIT_API_KEY is not set/);
  assert.equal(t.calls.length, 0);
  assert.equal(existsSync(c.stateFile), false);
});

test("first run: the newest N matches, oldest first, renamed complete, state advanced", async () => {
  const t = fakeTransport();
  const c = ctx(); mk(c);
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 2, transport: t }).fetch(c);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[1]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]);
  assert.deepEqual(readdirSync(c.inbox).sort(), [`faceit-${ids[1]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]); // no .part left
  const state = JSON.parse(readFileSync(c.stateFile, "utf8"));
  assert.equal(state.lastMatchId, ids[0]);
  assert.equal(state.playerId, fixture("player.json").player_id);
  assert.equal(zlib.gunzipSync(readFileSync(r.fetched[0])).subarray(0, 8).toString("latin1"), "PBDEMS2\0");
});

test("next run: only matches newer than the last fetched one", async () => {
  const c = ctx(); mk(c);
  // Run 1 sees a, b only; run 2 sees all four and must fetch c, d (oldest first).
  await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 5, transport: fakeTransport({ history: [ids[2], ids[3]] }) }).fetch(c);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, ids[2]);
  const t2 = fakeTransport();
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 5, transport: t2 }).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[1]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]);
  assert.equal(t2.calls.filter((u) => u.startsWith(`${API}/players?`)).length, 0, "player id is cached in state");
});

test("more new matches than one run takes: the oldest first, the rest next run", async () => {
  const c = ctx(); mk(c);
  await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 5, transport: fakeTransport({ history: [ids[3]] }) }).fetch(c);
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 2, transport: fakeTransport() }).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[2]}.dem.gz`, `faceit-${ids[1]}.dem.gz`]);
  const r2 = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 2, transport: fakeTransport() }).fetch(c);
  assert.deepEqual(r2.fetched.map((f) => path.basename(f)), [`faceit-${ids[0]}.dem.gz`]);
});

test("a failed download stops the run; no partial file; state stays before it", async () => {
  const c = ctx(); mk(c);
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 4, transport: fakeTransport({ failDownload: ids[2] }) }).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[3]}.dem.gz`]);
  assert.equal(r.pending[0].item, ids[2]);
  assert.match(r.pending[0].reason, /connection reset/);
  assert.deepEqual(readdirSync(c.inbox), [`faceit-${ids[3]}.dem.gz`]);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, ids[3]);
});

const finishedOf = (id: string) => (fixture("history.json").items as { match_id: string; finished_at: number }[]).find((i) => i.match_id === id)!.finished_at;

test("a match without a demo yet waits for the next run", async () => {
  const c = ctx(); mk(c);
  const now = () => (finishedOf(ids[1]) + 3600) * 1000; // an hour after it finished
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 4, transport: fakeTransport({ noDemo: ids[1] }), now }).fetch(c);
  assert.deepEqual(r.fetched.length, 2);
  assert.equal(r.pending[0].item, ids[1]);
  assert.match(r.pending[0].reason, /no demo_url/);
});

test("a match still without a demo a day after it finished is skipped, not waited on forever", async () => {
  const c = ctx(); mk(c);
  const now = () => (finishedOf(ids[1]) + 25 * 3600) * 1000;
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 4, transport: fakeTransport({ noDemo: ids[1] }), now }).fetch(c);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[3]}.dem.gz`, `faceit-${ids[2]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]);
  assert.ok(c.lines.some((l) => l.includes("no demo") && l.includes("skipped")));
});

test("a rejected key says so", async () => {
  const c = ctx(); mk(c);
  await assert.rejects(faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 2, transport: fakeTransport({ status: 403 }) }).fetch(c), /HTTP 403 \(API key rejected or lacks access\)/);
});

test("dry run: lists, writes nothing", async () => {
  const c = ctx(true); mk(c);
  const t = fakeTransport();
  const r = await faceitSource({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 2, transport: t }).fetch(c);
  assert.equal(r.fetched.length, 0);
  assert.equal(t.downloads.length, 0);
  assert.equal(readdirSync(c.inbox).length, 0);
  assert.equal(existsSync(c.stateFile), false);
  assert.equal(c.lines.filter((l) => l.includes("would download")).length, 2);
});

test("demo file names keep the compression; unexpected match ids are refused", () => {
  assert.equal(demoFileName("1-abc", "https://x/cs2/1-abc-1-1.dem.gz?sig=1"), "faceit-1-abc.dem.gz");
  assert.equal(demoFileName("1-abc", "https://x/cs2/1-abc-1-1.dem.zst"), "faceit-1-abc.dem.zst");
  assert.throws(() => demoFileName("../evil", "https://x/a.dem"), /unexpected form/);
  assert.throws(() => demoFileName("a?b", "https://x/a.dem"), /unexpected form/);
});

const opts = (t: Transport, extra: Partial<Parameters<typeof faceitSource>[0]> = {}) => ({ apiKey: KEY, steamId64: STEAM, maxMatchesPerRun: 5, transport: t, ...extra });
const many = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ match_id: `1-m${String(n - i).padStart(3, "0")}`, status: "finished", finished_at: 1791900000 + (n - i) * 3600 }));
const steamHash = createHash("sha256").update(STEAM).digest("hex").slice(0, 16);
function seedState(c: SourceContext, state: object) {
  mkdirSync(path.dirname(c.stateFile), { recursive: true });
  writeFileSync(c.stateFile, JSON.stringify({ playerId: fixture("player.json").player_id, steamIdHash: steamHash, ...state }));
}

test("history over several pages: every match newer than the checkpoint is found", async () => {
  const c = ctx(); mk(c);
  seedState(c, { lastMatchId: "1-m010" });
  const t = fakeTransport({ items: many(45) }); // newest first: 1-m045 … 1-m001
  const r = await faceitSource(opts(t, { maxMatchesPerRun: 50 })).fetch(c);
  assert.equal(r.fetched.length, 35);
  assert.equal(path.basename(r.fetched[0]), "faceit-1-m011.dem.gz");
  assert.ok(t.calls.some((u) => u.includes("offset=20")), "reads the second page");
  assert.ok(!t.calls.some((u) => u.includes("offset=40")), "stops paging once the checkpoint is found");
});

test("a checkpoint not in history fetches nothing and keeps the checkpoint", async () => {
  const c = ctx(); mk(c);
  seedState(c, { lastMatchId: "1-gone" });
  await assert.rejects(faceitSource(opts(fakeTransport({ items: many(5) }))).fetch(c), /not among the newest/);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, "1-gone");
  assert.equal(readdirSync(c.inbox).length, 0);
});

test("a first run that fails is retried on the next run, even after newer matches arrive", async () => {
  const c = ctx(); mk(c);
  // First run, limit 2: c and d selected (b is the boundary); c fails.
  const r1 = await faceitSource(opts(fakeTransport({ failDownload: ids[1] }), { maxMatchesPerRun: 2 })).fetch(c);
  assert.equal(r1.fetched.length, 0);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, ids[2]);
  // A newer match e arrives; the next run still starts at c.
  const items = [{ match_id: "1-0000000e-0000-4000-8000-00000000000e", status: "finished", finished_at: 1792018400 }, ...fixture("history.json").items];
  const r2 = await faceitSource(opts(fakeTransport({ items }), { maxMatchesPerRun: 2 })).fetch(c);
  assert.deepEqual(r2.fetched.map((f) => path.basename(f)), [`faceit-${ids[1]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]);
});

test("a malformed demo_url is an error, not a skipped match", async () => {
  for (const bad of [{ url: "x" }, [123], [""]]) {
    const c = ctx(); mk(c);
    const now = () => (finishedOf(ids[3]) + 48 * 3600) * 1000;
    const r = await faceitSource(opts(fakeTransport({ history: [ids[3]], demoUrlValue: bad }), { now })).fetch(c);
    assert.match(r.pending[0]?.reason ?? "", /demo_url" is not a list/);
    assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, "(start)");
  }
});

test("a download that is not a CS2 demo is removed and the checkpoint stays", async () => {
  const c = ctx(); mk(c);
  const r = await faceitSource(opts(fakeTransport({ history: [ids[3]], demoBody: Buffer.from("<html>error</html>") }))).fetch(c);
  assert.match(r.pending[0].reason, /not a CS2 demo/);
  assert.equal(readdirSync(c.inbox).length, 0);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, "(start)");
});

test("state for another STEAM_ID64 is refused", async () => {
  const c = ctx(); mk(c);
  await faceitSource(opts(fakeTransport({ history: [ids[3]] }))).fetch(c);
  await assert.rejects(faceitSource({ ...opts(fakeTransport()), steamId64: "76561190000000002" }).fetch(c), /belongs to another STEAM_ID64/);
});

test("maxMatchesPerRun must be a sane integer", async () => {
  for (const bad of [0, -1, 1.5, "3" as unknown as number, 1000]) {
    await assert.rejects(faceitSource(opts(fakeTransport(), { maxMatchesPerRun: bad })).fetch(ctx()), /maxMatchesPerRun/);
  }
});

test("the real streaming download stops past the size limit (no Content-Length)", async () => {
  const server = http.createServer((_q, res) => { res.writeHead(200); res.write(Buffer.alloc(800)); res.end(Buffer.alloc(800)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "croclip-dl-")), "x.part");
  try {
    await assert.rejects(httpTransport.download(`http://127.0.0.1:${port}/d.dem.gz`, dest, 1000), /size limit/);
    await httpTransport.download(`http://127.0.0.1:${port}/d.dem.gz`, dest, 5000);
    assert.equal(readFileSync(dest).length, 1600);
  } finally { server.close(); }
});

test("an unfinished match stops the run instead of being stepped over", async () => {
  const c = ctx(); mk(c);
  const items = (fixture("history.json").items as Item[]).map((i) => (i.match_id === ids[1] ? { ...i, status: "ongoing" } : i));
  const r = await faceitSource(opts(fakeTransport({ items }))).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[3]}.dem.gz`, `faceit-${ids[2]}.dem.gz`]);
  assert.match(r.pending[0].reason, /not finished yet/);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, ids[2]);
});

test("a null demo_url means not uploaded yet", async () => {
  const c = ctx(); mk(c);
  const now = () => (finishedOf(ids[3]) + 3600) * 1000;
  const r = await faceitSource(opts(fakeTransport({ history: [ids[3]], demoUrlValue: null }), { now })).fetch(c);
  assert.match(r.pending[0].reason, /no demo_url yet/);
});

test("a truncated gzip download is rejected before the checkpoint moves", async () => {
  const c = ctx(); mk(c);
  const whole = zlib.gzipSync(Buffer.concat([Buffer.from("PBDEMS2\0", "latin1"), Buffer.alloc(200000, 7)]));
  const r = await faceitSource(opts(fakeTransport({ history: [ids[3]], demoBody: whole.subarray(0, whole.length - 200) }))).fetch(c);
  assert.match(r.pending[0].reason, /not a CS2 demo/);
  assert.equal(readdirSync(c.inbox).length, 0);
});

test("state written without the identity hash keeps its progress when it is this player's", async () => {
  const c = ctx(); mk(c);
  mkdirSync(path.dirname(c.stateFile), { recursive: true });
  writeFileSync(c.stateFile, JSON.stringify({ playerId: fixture("player.json").player_id, lastMatchId: ids[1] }));
  const r = await faceitSource(opts(fakeTransport())).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[0]}.dem.gz`]);
  writeFileSync(c.stateFile, JSON.stringify({ playerId: "someone-else", lastMatchId: ids[1] }));
  await assert.rejects(faceitSource(opts(fakeTransport())).fetch(c), /another FACEIT player/);
});

test("a cancelled match is skipped and the next finished one is fetched", async () => {
  const c = ctx(); mk(c);
  const items = (fixture("history.json").items as Item[]).map((i) => (i.match_id === ids[2] ? { ...i, status: "cancelled" } : i));
  const r = await faceitSource(opts(fakeTransport({ items }))).fetch(c);
  assert.deepEqual(r.fetched.map((f) => path.basename(f)), [`faceit-${ids[3]}.dem.gz`, `faceit-${ids[1]}.dem.gz`, `faceit-${ids[0]}.dem.gz`]);
  assert.deepEqual(r.pending, []);
  assert.ok(c.lines.some((l) => l.includes("cancelled; skipped")));
});

test("no Downloads API scope: every new match is pending, nothing skipped, the checkpoint stays", async () => {
  const c = ctx(); mk(c);
  const r = await faceitSource(opts(fakeTransport({ noScope: true }))).fetch(c);
  assert.match(r.blocked ?? "", /lacks the Downloads API scope.*fce\.gg\/downloads-api-application/);
  assert.deepEqual(r.pending.map((p) => p.item), [ids[3], ids[2], ids[1], ids[0]]);
  assert.ok(r.pending.every((p) => /Downloads API scope/.test(p.reason)));
  assert.equal(r.fetched.length, 0);
  assert.equal(readdirSync(c.inbox).length, 0);
  assert.equal(JSON.parse(readFileSync(c.stateFile, "utf8")).lastMatchId, "(start)");
  // With the scope granted later, the same matches are fetched.
  const r2 = await faceitSource(opts(fakeTransport())).fetch(c);
  assert.equal(r2.fetched.length, 4);
});

test("another 403 from the download endpoint is a normal failure, not the scope message", async () => {
  const c = ctx(); mk(c);
  const t = fakeTransport();
  t.postJson = async () => ({ status: 403, body: { errors: [{ code: "err_other", message: "forbidden" }] } });
  const r = await faceitSource(opts(t)).fetch(c);
  assert.equal(r.blocked, undefined);
  assert.equal(r.pending.length, 1);
  assert.match(r.pending[0].reason, /HTTP 403/);
});

test("the download endpoint is /download/v2/demos/download", () => {
  assert.equal(DOWNLOAD_API, "https://open.faceit.com/download/v2/demos/download");
});
