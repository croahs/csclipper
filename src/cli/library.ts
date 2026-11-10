// pnpm library [--port <n>]: serve library/ at http://127.0.0.1:<port>/ (default 8765) so the
// page can delete and share clips while watching. No dependencies; bound to 127.0.0.1 only.
//   GET  /...          files under library/ (Range requests, so videos can seek)
//   POST /delete/<no>  as pnpm drop <no>; then the page is rewritten
//   POST /share/<no>   as pnpm share <no>, in a child process so the server keeps serving;
//                      answers { file, bytes, caption }. One encode per clip at a time: a second
//                      request while one runs waits for the same result.
//   POST /reveal/<no>  opens Explorer with that clip's share file selected
// Requests whose Host is not this server, or a POST whose Origin is another site, are refused,
// so no other web page (or DNS rebinding) can delete or share clips through it. The POST routes
// take a clip number only, never a path.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { LIBRARY_DIR } from "../config.ts";
import { deleteClip } from "../library/index.ts";
import { writeLibraryPage } from "../library/page.ts";
import { findClip, sharePath, type ShareResult } from "../share/index.ts";

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
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const sh = /^\/(share|reveal)\/(\d+)$/.exec(url.pathname);
    if (sh?.[1] === "share") {
      if (!findClip(Number(sh[2]))) return send(404, `no clip ${sh[2]}`);
      share(Number(sh[2])).then((r) => json(200, { file: r.file, bytes: r.bytes, caption: r.caption }), (err: ShareError) => json(err.status ?? 500, { error: err.message }));
      return;
    }
    if (sh?.[1] === "reveal") {
      const e = findClip(Number(sh[2]));
      const file = e && sharePath(e);
      if (!file || !existsSync(file)) return send(404, `no share file for clip ${sh[2]}`);
      // explorer.exe wants /select,"<path>" as one verbatim argument; it exits 1 even when it worked.
      spawn("explorer.exe", [`/select,"${file}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).on("error", () => {}).unref();
      return json(200, { revealed: path.relative(LIBRARY_DIR, file).replaceAll("\\", "/") });
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

// Share encodes run as `pnpm share <no> --json` in a child process (the same tsx loader as this
// one): the encode is synchronous FFmpeg work for up to minutes. In flight, keyed by clip number.
type ShareError = Error & { status?: number };
const sharing = new Map<number, Promise<ShareResult>>();
function share(no: number): Promise<ShareResult> {
  const running = sharing.get(no);
  if (running) return running;
  const p = new Promise<ShareResult>((resolve, reject) => {
    console.log(`sharing clip ${no}...`);
    const child = spawn(process.execPath, [...process.execArgv, path.join(import.meta.dirname, "share.ts"), String(no), "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try { const r = JSON.parse(out.trim().split(/\r?\n/).pop()!) as ShareResult; console.log(`shared clip ${no}: ${r.file}`); return resolve(r); } catch {}
      }
      // Exit 2: refused (too long for the limit, no such clip); the message is for the page.
      reject(Object.assign(new Error(err.trim() || `pnpm share ${no} exited ${code}`), { status: code === 2 ? 422 : 500 }));
    });
  }).finally(() => sharing.delete(no));
  sharing.set(no, p);
  return p;
}

// A file can vanish between the check and the read (a delete): end that response, keep serving.
function stream(file: string, res: http.ServerResponse, range?: { start: number; end: number }) {
  createReadStream(file, range).on("error", () => res.destroy()).pipe(res);
}

server.listen(port, "127.0.0.1", () => console.log(`library: http://127.0.0.1:${port}/ (Ctrl+C stops it)`));
