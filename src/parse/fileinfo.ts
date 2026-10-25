// CS2 demo CDemoFileInfo frame: playback_time, playback_ticks, playback_frames (proven in spikes/m0-1-parse.ts).
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export function readFileInfo(file: string) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error("not a CS2 demo (shorter than its header)");
    if (head.subarray(0, 8).toString("latin1") !== "PBDEMS2\0") throw new Error("not a CS2 demo");
    const offset = head.readInt32LE(8);
    const fileSize = fstatSync(fd).size;
    // The header names where the fileinfo frame sits: at the end, written when the demo is finalized.
    if (offset < 16 || offset >= fileSize) throw new Error(`DEM_FileInfo offset ${offset} is outside the file (${fileSize} bytes)`);
    const buf = Buffer.alloc(Math.min(4096, fileSize - offset));
    if (readSync(fd, buf, 0, buf.length, offset) !== buf.length) throw new Error("DEM_FileInfo: short read");
    let p = 0;
    const varint = () => {
      let r = 0, s = 0, x: number;
      do {
        if (p >= buf.length) throw new Error("DEM_FileInfo truncated");
        x = buf[p++]; r += (x & 127) * 2 ** s; s += 7;
      } while (x & 128);
      return r;
    };
    const cmd = varint(), tick = varint(), size = varint();
    if ((cmd & ~64) !== 2) throw new Error(`frame at fileinfo offset is cmd ${cmd}, expected DEM_FileInfo (2)`);
    if (cmd & 64) throw new Error("compressed DEM_FileInfo not handled");
    const end = p + size;
    if (end > buf.length) throw new Error("DEM_FileInfo larger than the read buffer");
    const out: Record<string, number> = { frame_tick: tick };
    while (p < end) {
      const key = varint(), field = key >> 3, wire = key & 7;
      if (field < 1 || field > 536_870_911) throw new Error(`DEM_FileInfo: field number ${field} outside protobuf's range`);
      if (wire === 5) { if (p + 4 > end) throw new Error("DEM_FileInfo truncated"); if (field === 1) out.playback_time = buf.readFloatLE(p); p += 4; }
      else if (wire === 0) { const v = varint(); if (field === 2) out.playback_ticks = v; if (field === 3) out.playback_frames = v; }
      else if (wire === 2) { const length = varint(); if (p + length > end) throw new Error("DEM_FileInfo truncated"); p += length; }
      else throw new Error(`unexpected wire type ${wire}`);
    }
    if (p !== end) throw new Error("DEM_FileInfo fields overran the frame");
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Why a .dem is not a complete CS2 demo, or undefined when it is: the PBDEMS2 header and a valid
 * DEM_FileInfo frame at the offset the header names. That frame is written last, when the demo
 * is finalized, so a cut-short transfer, a stalled one or a file still being written fails here.
 * One check for the fetch launch, the folders source and ingest (docs/m6-mm-fetch.md).
 */
export function demoIncomplete(file: string): string | undefined {
  try { readFileInfo(file); return undefined; } catch (e) { return (e as Error).message; }
}
