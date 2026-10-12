/* v6 records each variable section's length in its header, so the split is
 * read directly rather than reconstructed. */
import { open } from "node:fs/promises";
import { gunzipSync, gzipSync, constants } from "node:zlib";
const gz = (b) => gzipSync(b, { level: constants.Z_BEST_COMPRESSION }).byteLength;
const file = await open(process.argv[2]);
const head = new Uint8Array(32); await file.read(head, 0, 32, 0);
const tiles = new DataView(head.buffer).getUint32(8, true);
const dir = new Uint8Array(tiles * 40); await file.read(dir, 0, dir.byteLength, 32);
const dv = new DataView(dir.buffer);
const totals = {}; let nodes = 0, edges = 0, shapes = 0;
const bump = (k, v) => totals[k] = (totals[k] ?? 0) + v;
for (let i = 0; i < tiles; i += 1) {
  const at = i * 40;
  const chunk = new Uint8Array(dv.getUint32(at + 24, true));
  await file.read(chunk, 0, chunk.byteLength, dv.getUint32(at + 20, true));
  const raw = dv.getUint16(at + 32, true) === 1 ? gunzipSync(chunk) : chunk;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (v.getUint16(4, true) !== 6) throw new Error("expected a v6 chunk");
  const n = v.getUint32(8, true), e = v.getUint32(12, true), s = v.getUint32(24, true);
  nodes += n; edges += e; shapes += s;
  const lens = [0, 1, 2, 3, 4].map((k) => v.getUint32(40 + k * 4, true));
  let o = raw.byteOffset + 64;
  const slice = (bytes) => { const out = new Uint8Array(raw.buffer, o, bytes); o += bytes; return out; };
  bump("node coordinates", gz(slice(n * 8)));
  bump("edge distances+durations", gz(slice(e * 4)));
  const names = ["edge degrees", "edge targets", "shape references", "shape sizes", "shape points"];
  lens.forEach((len, k) => bump(names[k], gz(slice(len))));
  bump("restrictions", gz(new Uint8Array(raw.buffer, o, Math.max(0, raw.byteOffset + raw.byteLength - o))));
}
await file.close();
const total = Object.values(totals).reduce((a, b) => a + b, 0);
console.log(`\n${nodes.toLocaleString()} nodes, ${edges.toLocaleString()} edges, ${shapes.toLocaleString()} distinct shapes\n`);
console.log("section                      gz MB    share");
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(26)} ${(v / 1e6).toFixed(2).padStart(7)} ${((100 * v) / total).toFixed(1).padStart(7)}%`);
}
console.log(`${"TOTAL".padEnd(26)} ${(total / 1e6).toFixed(2).padStart(7)}`);
const geometry = totals["shape points"] + totals["shape references"] + totals["shape sizes"];
console.log(`\ngeometry overall: ${(geometry / 1e6).toFixed(2)} MB (${((100 * geometry) / total).toFixed(1)}% of a chunk)`);
