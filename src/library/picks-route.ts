// pnpm library's request body reader and its POST /picks route (the film picker's bulk change), apart
// from src/cli/library.ts (which listens on import) so tests can drive them on a server of their own.
import type { Readable } from "node:stream";
import { changePicksBulk } from "./stars.ts";

/** A request body of at most max bytes (counted before decoding), as UTF-8 text; a longer one is refused. */
export function readBody(req: Readable, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0, over = false;
    req.on("data", (d: Buffer | string) => {
      if (over) return;
      const b = typeof d === "string" ? Buffer.from(d) : d;
      bytes += b.length;
      if (bytes > max) { over = true; reject(new Error("body too large")); req.destroy(); return; }
      parts.push(b);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(parts).toString("utf8")); });
    req.on("error", (e) => { if (!over) reject(e); });
  });
}

export const PICKS_BODY_MAX = 64 * 1024;
const SHAPE = 'the body must be JSON: {"pick": [<no>...], "unpick": [<no>...]}';

/**
 * POST /picks: body { pick?: number[], unpick?: number[] }, all or nothing (changePicksBulk); answers
 * { picks } and then runs after() (the pages rewritten; its message, if any, comes back as pageError).
 * Never rejects: anything thrown (reading the index, writing the file) answers 500 with its message.
 */
export async function postPicks(req: Readable, reply: (status: number, body: unknown) => void, o: { known: () => Set<number>; file?: string; after?: () => string | undefined; log?: (line: string) => void }): Promise<void> {
  try {
    let text: string;
    try { text = await readBody(req, PICKS_BODY_MAX); } catch (e) { return reply(400, { error: (e as Error).message }); }
    let body: unknown;
    try { body = text.trim() ? JSON.parse(text) : {}; } catch { return reply(400, { error: SHAPE }); }
    const r = changePicksBulk(body, o.known(), o.file);
    if ("error" in r) return reply(r.status, { error: r.error });
    const b = body as { pick?: number[]; unpick?: number[] };
    o.log?.(`film picks: ${b.pick?.length ?? 0} picked, ${b.unpick?.length ?? 0} unpicked`);
    // The picks stand even if the pages cannot be rewritten; the reply says so.
    const pageError = o.after?.();
    reply(200, { picks: r.picks, ...(pageError ? { pageError } : {}) });
  } catch (e) {
    reply(500, { error: (e as Error).message });
  }
}
