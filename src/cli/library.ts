// pnpm library [--port <n>]: serve library/ at http://127.0.0.1:<port>/ (default 8765) so the
// page can delete, share, cut and star clips while watching. No dependencies; bound to 127.0.0.1 only.
//   GET  /...          files under library/ (Range requests, so videos can seek)
//   POST /delete/<no>  as pnpm drop <no>; then the page is rewritten
//   POST /share/<no>   as pnpm share <no>, in a child process so the server keeps serving;
//                      answers { file, bytes, caption }. One encode per clip at a time: a second
//                      request while one runs waits for the same result.
//   POST /vertical/<no>  as pnpm vertical <no>, the same way; answers { file, bytes, seconds, caption }
//   POST /cut/<no>     body {"from": <s>, "to": <s>}: two numbers, checked as pnpm cut checks them
//                      (400 otherwise); as pnpm cut <no> <from> <to>, the same way, one encode per
//                      cut at a time; answers { file, bytes, seconds, from, to, reused }
//   POST /reveal/<no>[/vertical | /cut/<name>]  opens Explorer with that clip's share file, its
//                      vertical file, or its cut of that name (a name pnpm cut gives it) selected
//   POST /star/<no>, /unstar/<no>  as pnpm fav / unfav <no>; answers { stars }, then the page is rewritten
//   GET  /stars        { stars }: the current starred clip numbers
//   POST /pick/<no>, /unpick/<no>  as pnpm pick / unpick <no> (the "Film" box, library/film-picks.json);
//                      answers { picks }, then the page is rewritten
//   POST /picks        body {"pick": [<no>...], "unpick": [<no>...]} (either may be absent): the film
//                      picker's bulk change, all or nothing (a number the index does not hold refuses
//                      the whole request); answers { picks }, then the pages are rewritten
//   GET  /picks        { picks }: the current film picks
// The film picker is library/film.html (template src/library/film.html), written with index.html.
// Requests whose Host is not this server, or a POST whose Origin is another site, are refused,
// so no other web page (or DNS rebinding) can delete, share, cut or star clips through it. The POST
// routes take a clip number (a cut also two numbers, a reveal a kind and a checked name), never a path.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { deleteClip, readIndex } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { changePicks, changeStars, readPicks, readStars } from "../library/stars.ts";
import { postPicks, readBody } from "../library/picks-route.ts";
import { CUT_DIR, cutSource, CutRefusal, isCutName, planCut, type CutResult } from "../share/cut.ts";
import { findClip, sharePath, type ShareResult } from "../share/index.ts";
import { verticalPath, type VerticalResult } from "../share/vertical.ts";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8765;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a port number");
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".json": "application/json" };

// No request may stop the server: anything thrown in a handler (a malformed URL, a file deleted
// between the check and the read) ends that response only.
const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) {
    if (!res.headersSent) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(String((e as Error).message)); } else res.destroy();
  }
});

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const send = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(body); };
  if (!hosts.has(req.headers.host ?? "")) return send(403, "wrong host");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^http:\/\//, ""))) return send(403, "wrong origin");
    // An encode outlives a closed tab: answer only a response that is still there.
    const json = (status: number, body: unknown) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const fail = (err: ChildError) => json(err.status ?? 500, { error: err.message });
    const sh = /^\/(share|vertical)\/(\d+)$/.exec(url.pathname);
    if (sh) {
      const no = Number(sh[2]);
      if (!findClip(no)) return send(404, `no clip ${no}`);
      if (sh[1] === "share") runChild<ShareResult>(`share ${no}`, "share.ts", [String(no)]).then((r) => json(200, { file: r.file, bytes: r.bytes, caption: r.caption }), fail);
      else runChild<VerticalResult>(`vertical ${no}`, "vertical.ts", [String(no)]).then((r) => json(200, { file: r.file, bytes: r.bytes, seconds: r.seconds, caption: r.caption }), fail);
      return;
    }
    const ct = /^\/cut\/(\d+)$/.exec(url.pathname);
    if (ct) {
      const no = Number(ct[1]);
      readBody(req, 1024).then((text) => {
        let body: unknown;
        try { body = JSON.parse(text); } catch { return json(400, { error: 'the body must be JSON: {"from": <s>, "to": <s>}' }); }
        const { from, to } = (body ?? {}) as { from?: unknown; to?: unknown };
        if (typeof from !== "number" || typeof to !== "number") return json(400, { error: "from and to must be numbers of seconds" });
        // The same checks as pnpm cut, against the clip's own length, before anything is spawned.
        let c;
        try { c = planCut(from, to, cutSource(no).seconds); } catch (err) {
          const m = (err as Error).message;
          return json(err instanceof CutRefusal ? (/^no clip/.test(m) ? 404 : 400) : 500, { error: m });
        }
        runChild<CutResult>(`cut ${no} ${c.from} ${c.to}`, "cut.ts", [String(no), String(c.from), String(c.to)])
          .then((r) => json(200, { file: r.file, bytes: r.bytes, seconds: r.seconds, from: r.from, to: r.to, reused: r.reused }), fail);
      }, (err: Error) => json(400, { error: err.message }));
      return;
    }
    const rv = /^\/reveal\/(\d+)(?:\/(vertical)|\/cut\/([^/]+))?$/.exec(url.pathname);
    if (rv) {
      const e = findClip(Number(rv[1]));
      let name: string | undefined;
      try { name = rv[3] === undefined ? undefined : decodeURIComponent(rv[3]); } catch { return send(400, "bad name"); }
      // A cut is named, never pathed: only a name pnpm cut could have given this clip, inside library/cuts/.
      if (name !== undefined && (!e || !isCutName(e, name))) return send(400, "not a cut of this clip");
      const kind = name !== undefined ? "cut" : rv[2] ?? "share";
      const file = e && (kind === "cut" ? path.join(CUT_DIR, name!) : kind === "vertical" ? verticalPath(e) : sharePath(e));
      if (!file || !existsSync(file)) return send(404, `no ${kind} file for clip ${rv[1]}`);
      // explorer.exe wants /select,"<path>" as one verbatim argument; it exits 1 even when it worked.
      spawn("explorer.exe", [`/select,"${file}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).on("error", () => {}).unref();
      return json(200, { revealed: path.relative(LIBRARY_DIR, file).replaceAll("\\", "/") });
    }
    const st = /^\/(star|unstar)\/(\d+)$/.exec(url.pathname);
    if (st) {
      const no = Number(st[2]);
      const r = changeStars(st[1] as "star" | "unstar", [no], knownNos());
      if (r.unknown.length) return send(404, `no clip ${no}`);
      console.log(`${st[1]}red clip ${no}`);
      // The star stands even if the page cannot be rewritten; the reply says so.
      let pageError: string | undefined;
      try { writeLibraryPage(); } catch (err) { pageError = (err as Error).message; console.error(`library page not rewritten: ${pageError}`); }
      return json(200, { stars: r.stars, ...(pageError ? { pageError } : {}) });
    }
    if (url.pathname === "/picks") {
      // postPicks never rejects: whatever throws in it answers 500, and the server keeps serving.
      void postPicks(req, json, {
        known: knownNos, log: (l) => console.log(l),
        after: () => { try { writeLibraryPage(); } catch (err) { const m = (err as Error).message; console.error(`library page not rewritten: ${m}`); return m; } },
      });
      return;
    }
    const pk = /^\/(pick|unpick)\/(\d+)$/.exec(url.pathname);
    if (pk) {
      const no = Number(pk[2]);
      const r = changePicks(pk[1] as "pick" | "unpick", [no], knownNos());
      if (r.unknown.length) return send(404, `no clip ${no}`);
      console.log(`${pk[1] === "pick" ? "picked" : "unpicked"} clip ${no} for the film`);
      // The pick stands even if the page cannot be rewritten; the reply says so.
      let pageError: string | undefined;
      try { writeLibraryPage(); } catch (err) { pageError = (err as Error).message; console.error(`library page not rewritten: ${pageError}`); }
      return json(200, { picks: r.picks, ...(pageError ? { pageError } : {}) });
    }
    const m = /^\/delete\/(\d+)$/.exec(url.pathname);
    if (!m) return send(404, "not found");
    let e;
    try { e = deleteClip(Number(m[1])); } catch (err) { return send(500, (err as Error).message); }
    if (!e) return send(404, `no clip ${m[1]}`);
    console.log(`deleted clip ${m[1]}: ${e.title}`);
    // The delete stands even if the page cannot be rewritten; the reply says so.
    let pageError: string | undefined;
    try { writeLibraryPage(); } catch (err) { pageError = (err as Error).message; console.error(`library page not rewritten: ${pageError}`); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ deleted: Number(m[1]), id: e.id, ...(pageError ? { pageError } : {}) }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");
  // The current stars (the page's inlined list may be older than a pnpm fav since).
  if (url.pathname === "/stars") {
    const nos = knownNos();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : JSON.stringify({ stars: readStars().filter((n) => nos.has(n)) }));
  }
  // The current film picks, the same way.
  if (url.pathname === "/picks") {
    const nos = knownNos();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : JSON.stringify({ picks: readPicks().filter((n) => nos.has(n)) }));
  }

  // Static files under library/ only.
  let rel: string;
  try { rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); } catch { return send(400, "bad path"); }
  const file = path.resolve(LIBRARY_DIR, "." + rel);
  if (!file.startsWith(path.resolve(LIBRARY_DIR) + path.sep) || !existsSync(file) || !statSync(file).isFile()) return send(404, "not found");
  const size = statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "cache-control": "no-store" });
    if (req.method === "HEAD") return res.end();
    return stream(file, res, { start, end });
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  stream(file, res);
}

const knownNos = () => new Set(Object.values(readIndex().clips).map((c) => c.no).filter((n): n is number => n !== undefined));

// Share, vertical and cut encodes run as `pnpm <share|vertical|cut> <no> [...] --json` in a child
// process (the same tsx loader as this one): the encode is synchronous FFmpeg work for up to
// minutes. In flight, keyed by what is made ("share 12", "cut 12 4.5 12"): a second identical
// request joins the running one.
type ChildError = Error & { status?: number };
const running = new Map<string, Promise<unknown>>();
function runChild<T>(what: string, script: string, args: string[]): Promise<T> {
  const inFlight = running.get(what);
  if (inFlight) return inFlight as Promise<T>;
  const p = new Promise<T>((resolve, reject) => {
    console.log(`${what}...`);
    const child = spawn(process.execPath, [...process.execArgv, path.join(import.meta.dirname, script), ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try { const r = JSON.parse(out.trim().split(/\r?\n/).pop()!) as T & { file: string }; console.log(`${what}: ${r.file}`); return resolve(r); } catch {}
      }
      // Exit 2: refused (too long for the limit, no such clip, a cut outside the clip); the message is for the page.
      reject(Object.assign(new Error(err.trim() || `pnpm ${what} exited ${code}`), { status: code === 2 ? 422 : 500 }));
    });
  }).finally(() => running.delete(what));
  running.set(what, p);
  return p;
}

// A file can vanish between the check and the read (a delete): end that response, keep serving.
function stream(file: string, res: http.ServerResponse, range?: { start: number; end: number }) {
  createReadStream(file, range).on("error", () => res.destroy()).pipe(res);
}

server.listen(port, "127.0.0.1", () => console.log(`library: http://127.0.0.1:${port}/  film picker: http://127.0.0.1:${port}/film.html (Ctrl+C stops it)`));
