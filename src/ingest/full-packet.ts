// The first DEM_FullPacket of some demos carries a string-table snapshot with the instancebaseline
// and AnimAssetData tables. CS2 seeks back to that packet when playback starts, before any scheduled
// command, and crashes re-applying it (access violation in client.dll, every launch, 2026-10-27 and
// -31; docs/spikes.md, "First full packet crash"). Demos that play carry only userinfo there. Ingest
// writes a copy without those two tables before hashing, so the store holds the playable demo.
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

const DEM_FULL_PACKET = 13;
const DEM_IS_COMPRESSED = 64;
const DROP = new Set(["instancebaseline", "AnimAssetData"]);
const MAX_FRAME = 64 * 1024 ** 2; // a full packet is a few hundred KB; anything near this is not one we rewrite
const COPY_CHUNK = 16 * 1024 ** 2;

/** The demo's bytes are not what this fix understands: the demo is left as it came. */
class Unreadable extends Error {}

/** Raw snappy block decoding (the format of a compressed demo frame), at most `limit` bytes out. */
export function unsnappy(src: Buffer, limit = MAX_FRAME): Buffer {
  let p = 0, len = 0, s = 0, b: number;
  do { if (p >= src.length || s > 35) throw new Unreadable("snappy length"); b = src[p++]; len += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
  if (len > limit) throw new Unreadable("snappy length over the limit");
  const out = Buffer.alloc(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let l = tag >> 2;
      if (l >= 60) { const n = l - 59; l = 0; for (let i = 0; i < n; i++) l += src[p++] * 2 ** (8 * i); }
      l += 1;
      if (p + l > src.length || o + l > len) throw new Unreadable("snappy literal overruns");
      src.copy(out, o, p, p + l); p += l; o += l;
      continue;
    }
    let l: number, off: number;
    if (kind === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
    else if (kind === 2) { if (p + 2 > src.length) throw new Unreadable("snappy truncated"); l = (tag >> 2) + 1; off = src.readUInt16LE(p); p += 2; }
    else { if (p + 4 > src.length) throw new Unreadable("snappy truncated"); l = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
    if (!(off >= 1 && off <= o) || o + l > len) throw new Unreadable("snappy copy out of range");
    for (let i = 0; i < l; i++, o++) out[o] = out[o - off];
  }
  if (o !== len) throw new Unreadable("snappy length mismatch");
  return out;
}

const varint = (n: number) => { const a: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; a.push(b); } while (n); return Buffer.from(a); };
/** Top-level protobuf fields, each with its exact bytes; `v` is the payload of a length-delimited field. */
function fields(b: Buffer): { f: number; v?: Buffer; raw: Buffer }[] {
  const r: { f: number; v?: Buffer; raw: Buffer }[] = [];
  let p = 0;
  const vi = () => { let x = 0, s = 0, c: number; do { if (p >= b.length || s > 63) throw new Unreadable("protobuf truncated"); c = b[p++]; x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return x; };
  while (p < b.length) {
    const start = p, key = vi(), wt = key & 7;
    let v: Buffer | undefined;
    if (wt === 0) vi();
    else if (wt === 2) { const l = vi(); if (p + l > b.length) throw new Unreadable("protobuf truncated"); v = b.subarray(p, p + l); p += l; }
    else if (wt === 5) p += 4;
    else if (wt === 1) p += 8;
    else throw new Unreadable(`protobuf wire type ${wt}`);
    if (p > b.length) throw new Unreadable("protobuf truncated");
    r.push({ f: Math.floor(key / 8), v, raw: b.subarray(start, p) });
  }
  return r;
}

function readAll(fd: number, n: number, pos: number): Buffer {
  const b = Buffer.alloc(n);
  for (let o = 0, got; o < n; o += got) if ((got = readSync(fd, b, o, n - o, pos + o)) === 0) throw new Unreadable("short read");
  return b;
}
function writeAll(fd: number, b: Buffer, n = b.length) {
  for (let o = 0; o < n;) o += writeSync(fd, b, o, n - o);
}

/** The first full packet's frame, walked to from the start of the file one frame header at a time. */
function firstFullPacket(fd: number): { at: number; end: number; tick: number; body: Buffer } | undefined {
  const size = fstatSync(fd).size;
  const hb = Buffer.alloc(30);
  for (let at = 16; at < size;) {
    const n = readSync(fd, hb, 0, hb.length, at);
    let p = 0;
    const vi = () => { let x = 0, s = 0, c: number; do { if (p >= n || s > 35) throw new Unreadable("frame header"); c = hb[p++]; x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return x; };
    const cmd = vi(), tick = vi(), len = vi(), end = at + p + len;
    if (end > size) throw new Unreadable("frame overruns the file");
    if ((cmd & ~DEM_IS_COMPRESSED) === DEM_FULL_PACKET) {
      if (len > MAX_FRAME) throw new Unreadable("full packet over the limit");
      const body = readAll(fd, len, at + p);
      return { at, end, tick, body: cmd & DEM_IS_COMPRESSED ? unsnappy(body) : body };
    }
    if ((cmd & ~DEM_IS_COMPRESSED) === 0) return undefined; // DEM_Stop
    at = end;
  }
  return undefined;
}

/** The full packet body without the dropped tables, and their names; undefined when there is nothing to drop. */
function rewrite(body: Buffer): { body: Buffer; dropped: string[] } | undefined {
  const dropped: string[] = [];
  const parts = fields(body).map((x) => {
    if (x.f !== 1 || !x.v) return x.raw; // 1: string_table (CDemoStringTables), 2: packet
    const kept = fields(x.v).filter((t) => {
      const name = t.f === 1 && t.v ? fields(t.v).find((y) => y.f === 1)?.v?.toString() : undefined; // table_t.table_name
      if (name && DROP.has(name)) { dropped.push(name); return false; }
      return true;
    });
    const tables = Buffer.concat(kept.map((t) => t.raw));
    return Buffer.concat([varint(1 * 8 + 2), varint(tables.length), tables]);
  });
  return dropped.length ? { body: Buffer.concat(parts), dropped } : undefined;
}

/**
 * When `file`'s first DEM_FullPacket carries the tables CS2 crashes on, write a copy without them to
 * `out` (the frame stored uncompressed, the header's offsets moved by the size change) and return
 * the dropped table names; otherwise write nothing and return []. Every other byte is unchanged.
 * Bytes this does not understand leave the demo as it came ([]); a file-system error throws.
 */
export function fixFirstFullPacket(file: string, out: string): string[] {
  const fd = openSync(file, "r");
  try {
    let fp, fixed;
    try {
      fp = firstFullPacket(fd);
      fixed = fp && rewrite(fp.body);
    } catch (e) {
      if (e instanceof Unreadable) return [];
      throw e;
    }
    if (!fp || !fixed) return [];
    const frame = Buffer.concat([varint(DEM_FULL_PACKET), varint(fp.tick), varint(fixed.body.length), fixed.body]);
    const delta = frame.length - (fp.end - fp.at);
    const before = readAll(fd, fp.at, 0);
    for (const o of [8, 12]) { const v = before.readInt32LE(o); if (v > fp.at) before.writeInt32LE(v + delta, o); } // DEM_FileInfo, spawn groups
    const w = openSync(out, "w");
    try {
      writeAll(w, before);
      writeAll(w, frame);
      const buf = Buffer.alloc(COPY_CHUNK);
      for (let pos = fp.end, n; (n = readSync(fd, buf, 0, COPY_CHUNK, pos)) > 0; pos += n) writeAll(w, buf, n);
    } finally { closeSync(w); }
    return fixed.dropped;
  } finally { closeSync(fd); }
}
