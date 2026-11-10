// pnpm deathmap: write library/deaths.html (src/deathmap/) from the registry and the parse caches.
// Parses a demo still in the store when its cache is stale or has no positions (no launch); writes
// nothing else, and never deletes or invalidates a cache.
import { writeDeathMap } from "../deathmap/index.ts";

const t0 = Date.now();
const r = await writeDeathMap();
for (const m of r.data.maps) console.log(`${m.map}: ${m.rows.length} deaths; ${m.coverage.withPositions} of ${m.coverage.total} match(es) have positions`);
const l = r.loaded;
console.log(`ok: ${r.file} (${l.demos.length} demo(s) plotted, ${l.reparsed.length} re-parsed, ${l.noPositions.length} without positions, ${l.unread.length} unread; ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
