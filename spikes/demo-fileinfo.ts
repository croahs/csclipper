// CS2 demo CDemoFileInfo reader (copy of the one in m0-1-parse.ts): playback_time, playback_ticks, playback_frames.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export function readFileInfo(file: string) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    if (head.subarray(0, 8).toString("latin1") !== "PBDEMS2\0") throw new Error("not a CS2 demo");
    const offset = head.readInt32LE(8);
    const buf = Buffer.alloc(Math.min(4096, fstatSync(fd).size - offset));
    readSync(fd, buf, 0, buf.length, offset);
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
      if (wire === 5) { if (p + 4 > end) throw new Error("DEM_FileInfo truncated"); if (field === 1) out.playback_time = buf.readFloatLE(p); p += 4; }
      else if (wire === 0) { const v = varint(); if (field === 2) out.playback_ticks = v; if (field === 3) out.playback_frames = v; }
      else if (wire === 2) { const length = varint(); p += length; }
      else throw new Error(`unexpected wire type ${wire}`);
    }
    if (p !== end) throw new Error("DEM_FileInfo fields overran the frame");
    return out;
  } finally {
    closeSync(fd);
  }
}
