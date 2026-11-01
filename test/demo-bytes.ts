// Demo-shaped bytes for tests: a CS2 header whose offset names a valid DEM_FileInfo frame
// at the end (what parse/fileinfo.ts's completeness check reads), and a cut-short copy.
const varint = (v: number) => { const out: number[] = []; do { let b = v & 127; v = Math.floor(v / 128); if (v) b |= 128; out.push(b); } while (v); return Buffer.from(out); };

/** A complete demo: PBDEMS2 header, `fill` bytes of body, then the DEM_FileInfo frame the header points at. */
export function demoBytes(fill: number, bodyLen = 4096): Buffer {
  const time = Buffer.alloc(4); time.writeFloatLE(60);
  const payload = Buffer.concat([Buffer.from([0x0d]), time, Buffer.from([0x10]), varint(3840), Buffer.from([0x18]), varint(3840)]);
  const head = Buffer.alloc(16);
  head.write("PBDEMS2\0", 0, "latin1");
  head.writeInt32LE(16 + bodyLen, 8);
  return Buffer.concat([head, Buffer.alloc(bodyLen, fill), varint(2), varint(0), varint(payload.length), payload]);
}

const ld = (field: number, v: Buffer) => Buffer.concat([varint(field * 8 + 2), varint(v.length), v]);
/** Snappy with literals only: a valid compressed block for the decoder to read. */
function snappyLiterals(b: Buffer): Buffer {
  const out: Buffer[] = [varint(b.length)];
  for (let p = 0; p < b.length; p += 256) {
    const chunk = b.subarray(p, p + 256);
    out.push(chunk.length <= 60 ? Buffer.from([(chunk.length - 1) << 2]) : Buffer.from([60 << 2, chunk.length - 1]), chunk);
  }
  return Buffer.concat(out);
}
/** CDemoFullPacket { string_table: tables named `tables` (one item each), packet: { data } }. */
export const fullPacketBody = (tables: string[]) =>
  Buffer.concat([
    ld(1, Buffer.concat(tables.map((t) => ld(1, Buffer.concat([ld(1, Buffer.from(t)), ld(2, ld(1, Buffer.from(`${t}-item`)))]))))),
    ld(2, ld(3, Buffer.alloc(300, 7))),
  ]);

/**
 * A complete demo whose first frames are a packet and a DEM_FullPacket at tick 1 holding the given
 * string tables (snappy-compressed, as CS2 writes it, unless `compressed` is false).
 */
export function demoWithFullPacket(tables: string[], compressed = true): Buffer {
  const body = fullPacketBody(tables);
  const frames = Buffer.concat([
    varint(7), varint(0), varint(5), Buffer.alloc(5, 1),
    varint(13 | (compressed ? 64 : 0)), varint(1), ...(() => { const b = compressed ? snappyLiterals(body) : body; return [varint(b.length), b]; })(),
    varint(7), varint(2), varint(2000), Buffer.alloc(2000, 9),
  ]);
  const time = Buffer.alloc(4); time.writeFloatLE(60);
  const payload = Buffer.concat([Buffer.from([0x0d]), time, Buffer.from([0x10]), varint(3840), Buffer.from([0x18]), varint(3840)]);
  const head = Buffer.alloc(16);
  head.write("PBDEMS2\0", 0, "latin1");
  head.writeInt32LE(16 + frames.length, 8);
  head.writeInt32LE(16 + frames.length + 3 + payload.length, 12);
  return Buffer.concat([head, frames, varint(2), varint(0), varint(payload.length), payload]);
}

/** The same demo cut short: the header names a DEM_FileInfo offset past the end of the file. */
export const truncatedDemo = (fill: number) => demoBytes(fill).subarray(0, 16 + 2048);
