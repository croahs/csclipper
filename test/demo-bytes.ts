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

/** The same demo cut short: the header names a DEM_FileInfo offset past the end of the file. */
export const truncatedDemo = (fill: number) => demoBytes(fill).subarray(0, 16 + 2048);
