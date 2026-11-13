// The film picker: the selection snapshot (library/film-selection.json), the bulk pick change behind
// POST /picks, the picker page's data and its template. Pure functions and a temp directory; no
// library, no browser, no server.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { cardTitle, filmPageData, pickStoreSource } from "../src/library/film-page.ts";
import { filmSelection, parseFilmSelection, readFilmSelection, writeFilmSelection, type SelectionDraft } from "../src/library/film-selection.ts";
import { libraryThenFilm } from "../src/library/page.ts";
import { postPicks, readBody } from "../src/library/picks-route.ts";
import type { ClipEntry } from "../src/library/index.ts";
import { changePicks, changePicksBulk, readPicks } from "../src/library/stars.ts";

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-picker-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const draft: SelectionDraft = [
  { name: "Peder", me: true, highlights: [{ id: "a", no: 4, score: 180.5, title: "de_nuke · R3 · 4k AK-47" }, { id: "b", score: 120, title: "de_nuke · R9 · 3k AK-47", stretch: "2 of 3 kills, 1.2 s apart" }, { id: "gone", score: 90, title: "de_nuke · R1 · 3k USP-S" }], bloopers: [] },
  { name: "friend", me: false, highlights: [{ id: "c", no: 7, score: 99, title: "friend · de_dust2 · R2 · 3k Glock" }], bloopers: [{ id: "d", score: 70, title: "friend · de_dust2 · R5 · fell to his death", type: "selfkill" }] },
];
// "b" and "d" were rendered during the run (found by id); "gone" never made it into the library.
const clipsById = { a: { no: 4 }, b: { no: 11 }, c: { no: 7 }, d: { no: 12 } };

test("filmSelection: roster order, rank order, only held clips, each by its number", () => {
  const s = filmSelection(draft, clipsById, new Date("2026-11-13T12:00:00Z"));
  assert.equal(s.version, 1);
  assert.equal(s.at, "2026-11-13T12:00:00.000Z");
  assert.deepEqual(s.players.map((p) => [p.name, p.me]), [["Peder", true], ["friend", false]]);
  assert.deepEqual(s.players[0].highlights, [
    { no: 4, score: 180.5, title: "de_nuke · R3 · 4k AK-47" },
    { no: 11, score: 120, title: "de_nuke · R9 · 3k AK-47", stretch: "2 of 3 kills, 1.2 s apart" },
  ]);
  assert.deepEqual(s.players[1].bloopers, [{ no: 12, score: 70, title: "friend · de_dust2 · R5 · fell to his death", type: "selfkill" }]);
  for (const p of s.players) for (const x of [...p.highlights, ...p.bloopers]) assert.equal("id" in x, false);
});

test("writeFilmSelection: atomic, read back, and no 17-digit number (a SteamID64) anywhere in the file", () => withDir((dir) => {
  const f = path.join(dir, "film-selection.json");
  const s = filmSelection(draft, clipsById);
  writeFilmSelection(s, f);
  assert.deepEqual(readdirSync(dir), ["film-selection.json"]);
  const text = readFileSync(f, "utf8");
  assert.doesNotMatch(text, /\d{17}/);
  assert.deepEqual(readFilmSelection(f), s);
  assert.equal(readFilmSelection(path.join(dir, "missing.json")), undefined);
}));

test("changePicksBulk (POST /picks): picks and unpicks in one change", () => withDir((dir) => {
  const f = path.join(dir, "film-picks.json");
  const known = new Set([1, 2, 3, 4, 5]);
  changePicks("pick", [1, 2], known, f);
  assert.deepEqual(changePicksBulk({ pick: [3, 4], unpick: [1] }, known, f), { picks: [2, 3, 4] });
  assert.deepEqual(readPicks(f), [2, 3, 4]);
}));

test("changePicksBulk: a number the index does not hold refuses the whole request", () => withDir((dir) => {
  const f = path.join(dir, "film-picks.json");
  const known = new Set([1, 2, 3]);
  changePicks("pick", [1], known, f);
  const r = changePicksBulk({ pick: [2, 99], unpick: [1] }, known, f);
  assert.deepEqual(r, { status: 404, error: "no clip 99" });
  assert.deepEqual(readPicks(f), [1]);
  for (const bad of [null, [], "x", { pick: "2" }, { pick: [2.5] }, { unpick: [0] }]) {
    const b = changePicksBulk(bad, known, f);
    assert.ok("error" in b && b.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(readPicks(f), [1]);
}));

test("changePicksBulk: an empty body changes nothing and answers the current picks", () => withDir((dir) => {
  const f = path.join(dir, "film-picks.json");
  const known = new Set([1, 2]);
  assert.deepEqual(changePicksBulk({}, known, f), { picks: [] });
  changePicks("pick", [2], known, f);
  assert.deepEqual(changePicksBulk({ pick: [], unpick: [] }, known, f), { picks: [2] });
}));

const entry = (no: number, title: string, o: Partial<ClipEntry> = {}): ClipEntry => ({
  id: `id${no}`, no, file: `clips/id${no}.mp4`, title, map: "de_dust2", demo: "", demoSha256: "", round: 1, startTick: 0, endTick: 1, seconds: 12.34, frames: 1, createdAt: "", renderKey: "", render: {}, ...o,
});

test("filmPageData: the lists per player, then every pick in none of them; deleted clips left out", () => {
  const entries = [
    entry(4, "de_dust2 · R3 · 4k AK-47", { moment: { score: 150 } }),
    entry(7, "friend · de_dust2 · R2 · 3k Glock", { player: { name: "friend", key: "abcd1234" } }),
    entry(12, "friend · de_dust2 · R5 · fell to his death", { kind: "blooper", player: { name: "friend", key: "abcd1234" }, blooper: { type: "selfkill", score: 70, detail: {} } }),
    entry(20, "de_dust2 · R8 · 3k M4A1-S", { moment: { score: 61.2 } }),
    entry(21, "friend · de_dust2 · R9 · 2k AK-47", { player: { name: "friend", key: "abcd1234" }, moment: { score: 33 } }),
  ];
  const sel = filmSelection(draft, clipsById); // 11 is not in the entries: deleted since
  const d = filmPageData(sel, entries, [4, 20, 21, 99]);
  assert.deepEqual(d.groups.map((g) => g.heading), ["Me", "friend", "Picked, not in the current lists"]);
  assert.equal(d.groups[0].sub, "Peder");
  assert.deepEqual(d.groups[0].sections[0].cards.map((c) => [c.no, c.rank, c.score]), [[4, 1, 180.5]]);
  assert.deepEqual(d.groups[1].sections[1].cards.map((c) => [c.no, c.blooper, c.title]), [[12, "Own grenade / fall", "R5 · fell to his death"]]);
  const unlisted = d.groups[2].sections[0].cards;
  assert.deepEqual(unlisted.map((c) => [c.no, c.who, c.score]), [[20, "Me", 61.2], [21, "friend", 33]]);
  assert.deepEqual(d.picks, [4, 20, 21]);
  assert.doesNotMatch(JSON.stringify(d), /abcd1234/);
});

test("filmPageData: no snapshot yet shows the picks alone", () => {
  const d = filmPageData(undefined, [entry(3, "de_dust2 · R1 · 3k USP-S")], [3]);
  assert.equal(d.at, null);
  assert.deepEqual(d.groups.map((g) => [g.heading, g.sections[0].cards.map((c) => c.no)]), [["Picked, not in the current lists", [3]]]);
});

test("cardTitle: drops the player prefix and the map", () => {
  assert.equal(cardTitle({ title: "arney_ · de_nuke · R13 · 5k Glock", map: "de_nuke", player: { name: "arney_", key: "k" } }), "R13 · 5k Glock");
  assert.equal(cardTitle({ title: "de_cache · R13 · 4k Glock", map: "de_cache" }), "R13 · 4k Glock");
});

test("the picker template: the inline-data placeholder, no external URL", () => {
  const html = readFileSync(path.join(import.meta.dirname, "..", "src", "library", "film.html"), "utf8");
  assert.ok(html.includes('<script type="application/json" id="film">/*__FILM__*/{}</script>'));
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i);
  assert.doesNotMatch(html, /fetch\(\s*["']https?:/i);
});

// Review fixes (2026-11-13).

test("filmSelection: a draft number the index no longer holds is left out (deleted during the pass)", () => {
  const d: SelectionDraft = [{ name: "x", me: true, highlights: [{ id: "a", no: 4, score: 1, title: "t" }, { id: "z", no: 5, score: 1, title: "t" }], bloopers: [] }];
  assert.deepEqual(filmSelection(d, { a: { no: 4 } }).players[0].highlights.map((h) => h.no), [4]);
});

test("parseFilmSelection: the whole shape is checked; anything else is no snapshot", () => {
  const ok = { version: 1, at: "2026-11-13T00:00:00Z", players: [{ name: "n", me: true, highlights: [{ no: 1, score: 2, title: "t" }], bloopers: [{ no: 2, score: 60, title: "b", type: "spray" }] }] };
  assert.deepEqual(parseFilmSelection(JSON.stringify(ok)), ok);
  for (const bad of [
    '{"version":1,"players":[{}]}', "{", "null", '{"version":2,"at":"x","players":[]}', '{"version":1,"players":[]}',
    JSON.stringify({ ...ok, players: [{ ...ok.players[0], me: "yes" }] }),
    JSON.stringify({ ...ok, players: [{ ...ok.players[0], highlights: [{ no: 1.5, score: 2, title: "t" }] }] }),
    JSON.stringify({ ...ok, players: [{ ...ok.players[0], bloopers: [{ no: 1, score: "60", title: "t" }] }] }),
    JSON.stringify({ ...ok, players: [{ ...ok.players[0], highlights: null }] }),
  ]) assert.equal(parseFilmSelection(bad), undefined, bad);
});

test("filmPageData: the owner's section is 'Me' with whatever name the snapshot holds", () => {
  const sel = filmSelection([{ name: "SomeOne", me: true, highlights: [], bloopers: [] }], {});
  assert.deepEqual([filmPageData(sel, [], []).groups[0].heading, filmPageData(sel, [], []).groups[0].sub], ["Me", "SomeOne"]);
});

test("libraryThenFilm: the library page first; a film picker failure is one logged line, never a throw", () => {
  const order: string[] = [], logs: string[] = [];
  const page = libraryThenFilm(() => { order.push("library"); return "index.html"; }, () => { order.push("film"); throw new Error("disk full"); }, (l) => logs.push(l));
  assert.equal(page, "index.html");
  assert.deepEqual(order, ["library", "film"]);
  assert.deepEqual(logs, ["film picker not rewritten: disk full"]);
  assert.throws(() => libraryThenFilm(() => { throw new Error("no"); }, () => order.push("film again")), /no/);
  assert.equal(order.includes("film again"), false);
});

test("changePicksBulk: pick and unpick together are one write of the final set", () => withDir((dir) => {
  const f = path.join(dir, "film-picks.json");
  const known = new Set([1, 2]);
  changePicks("pick", [1], known, f);
  const writes: number[][] = [];
  const r = changePicksBulk({ pick: [2], unpick: [1] }, known, f, (nos) => { writes.push(nos); });
  assert.deepEqual(r, { picks: [2] });
  assert.deepEqual(writes, [[2]]);
  assert.deepEqual(changePicksBulk({}, known, f, (nos) => { writes.push(nos); }), { picks: [1] }); // nothing written: the file still says [1]
  assert.equal(writes.length, 1);
}));

test("readBody: counts bytes, not characters; a multibyte body just over the limit is refused", async () => {
  const feed = (buf: Buffer) => { const s = new PassThrough(); s.end(buf); return s; };
  const max = 65536;
  const over = Buffer.from("é".repeat(max / 2) + "a"); // 65537 bytes, 32769 characters
  await assert.rejects(readBody(feed(over), max), /body too large/);
  const at = Buffer.from("é".repeat(max / 2)); // exactly 65536 bytes
  assert.equal((await readBody(feed(at), max)).length, max / 2);
});

test("POST /picks (postPicks): a picks file that cannot be written answers 500 and the server keeps answering", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "croclipper-picker-"));
  const file = path.join(dir, "film-picks.json");
  mkdirSync(file); // a directory where the file should be: the rename fails
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST") void postPicks(req, json, { known: () => new Set([1, 2]), file });
    else json(200, { picks: readPicks(file) });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/picks`, { method: "POST", body: '{"pick":[1]}' });
    assert.equal(r.status, 500);
    assert.ok(((await r.json()) as { error: string }).error);
    const thrower = http.createServer((req, res) => void postPicks(req, (s, b) => { res.writeHead(s); res.end(JSON.stringify(b)); }, { known: () => { throw new Error("index unreadable"); } }));
    await new Promise<void>((r2) => thrower.listen(0, "127.0.0.1", r2));
    const t = await fetch(`http://127.0.0.1:${(thrower.address() as AddressInfo).port}/picks`, { method: "POST", body: "{}" });
    assert.deepEqual([t.status, await t.json()], [500, { error: "index unreadable" }]);
    thrower.close();
    const g = await fetch(`${base}/picks`);
    assert.deepEqual([g.status, await g.json()], [200, { picks: [] }]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The film-picks store both pages run (src/library/pick-store.js), evaluated from the very text the writers inline.
type Store = { has(n: number): boolean; toggle(n: number): Promise<unknown>; change(p: number[], u: number[]): Promise<unknown>; pending(): { pick: number[]; unpick: number[] }; commands(): string[]; unsaved(n: number): boolean; load(): Promise<unknown> };
const createPickStore = new Function(`return ${pickStoreSource()};`)() as (o: { served: boolean; initial: number[]; fetch?: unknown; onChange?: () => void; onError?: (t: string) => void }) => Store;

test("pick store, served: a failed change drops out and what is shown follows the server's last answer", async () => {
  let server = new Set<number>([1]);
  let calls = 0;
  const fakeFetch = async (url: string) => {
    calls++;
    if (calls > 1) throw new TypeError("aborted"); // the second and third requests never reach the server
    const m = /^\/(un)?pick\/(\d+)$/.exec(url)!;
    m[1] ? server.delete(Number(m[2])) : server.add(Number(m[2]));
    return { ok: true, json: async () => ({ picks: [...server] }), text: async () => "" };
  };
  const errors: string[] = [];
  const s = createPickStore({ served: true, initial: [1], fetch: fakeFetch, onError: (t) => { if (t) errors.push(t); } });
  s.toggle(5); // pick: saved
  assert.equal(s.has(5), true);
  s.toggle(5); // unpick: fails
  assert.equal(s.has(5), false);
  const last = s.toggle(5); // pick: fails
  await last;
  assert.equal(s.has(5), true, "the server has 5 picked, and so does the page");
  assert.equal(errors.length, 2);
  assert.deepEqual(s.pending(), { pick: [], unpick: [] });
  server = new Set();
});

test("pick store, from disk: changes collect as commands; a clip toggled twice drops out", () => {
  const s = createPickStore({ served: false, initial: [3, 4] });
  s.toggle(7); s.toggle(3); s.toggle(9); s.toggle(9);
  assert.deepEqual(s.pending(), { pick: [7], unpick: [3] });
  assert.deepEqual(s.commands(), ["pnpm pick 7", "pnpm unpick 3"]);
  assert.equal(s.unsaved(7), true);
  assert.equal(s.unsaved(4), false);
  s.toggle(7); s.toggle(3);
  assert.deepEqual(s.commands(), []);
});

test("the library page template: the film toggle replaces the Film checkbox, with the shared store", () => {
  const html = readFileSync(path.join(import.meta.dirname, "..", "src", "library", "page.html"), "utf8");
  assert.ok(html.includes("const createPickStore = /*__PICKSTORE__*/null;"));
  assert.ok(html.includes('el("button", "filmtog")'));
  assert.ok(html.includes("act.append(filmControl(c), starControl(c), exportGroup(c));"), "the film toggle is the first control in the row");
  assert.doesNotMatch(html, /label\.film|el\("label", "film"\)|box\.type = "checkbox"/);
  assert.ok(html.includes('id="pending"') && html.includes('href="http://127.0.0.1:8765/"'));
  assert.ok(html.includes('e.key === "f"'));
  const picker = readFileSync(path.join(import.meta.dirname, "..", "src", "library", "film.html"), "utf8");
  assert.ok(picker.includes("const createPickStore = /*__PICKSTORE__*/null;"));
  assert.doesNotMatch(pickStoreSource(), /__PICKSTORE__|\bimport\b|\brequire\(/);
});
