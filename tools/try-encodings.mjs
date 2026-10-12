/* Tries alternative encodings for the heaviest sections on real tile data,
 * so the format change is chosen from measurements rather than intuition. */
import { open } from "node:fs/promises";
import { gunzipSync, gzipSync, constants } from "node:zlib";

const gz = (b) => gzipSync(b, { level: constants.Z_BEST_COMPRESSION }).byteLength;
const file = await open(process.argv[2]);
const header = new Uint8Array(32); await file.read(header, 0, 32, 0);
const tileCount = new DataView(header.buffer).getUint32(8, true);
const directory = new Uint8Array(tileCount * 40); await file.read(directory, 0, directory.byteLength, 32);
const dv = new DataView(directory.buffer);

// Profile the few densest tiles: they dominate the bundle.
const order = [...Array(tileCount).keys()].sort((a, b) => dv.getUint32(b * 40 + 28, true) - dv.getUint32(a * 40 + 28, true));
const sample = order.slice(0, Number(process.argv[3] ?? 3));

const zigzag = (n) => (n << 1) ^ (n >> 31);
function varints(values) {
  const out = []; // plain array is fine for a measurement
  for (const value of values) {
    let v = zigzag(value) >>> 0;
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
  }
  return Uint8Array.from(out);
}

let totals = {};
const bump = (k, v) => totals[k] = (totals[k] ?? 0) + v;

for (const index of sample) {
  const at = index * 40;
  const chunk = new Uint8Array(dv.getUint32(at + 24, true));
  await file.read(chunk, 0, chunk.byteLength, dv.getUint32(at + 20, true));
  const raw = dv.getUint16(at + 32, true) === 1 ? gunzipSync(chunk) : chunk;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = v.getUint32(8, true), e = v.getUint32(12, true), p = v.getUint32(24, true);
  let o = raw.byteOffset + 40;
  const take = (Type, count) => { const a = new Type(raw.buffer.slice(o, o + count * Type.BYTES_PER_ELEMENT)); o += count * Type.BYTES_PER_ELEMENT; return a; };
  const nodeLat = take(Int32Array, n), nodeLng = take(Int32Array, n);
  const edgeOffsets = take(Uint32Array, n + 1), edgeTargets = take(Uint32Array, e);
  take(Uint16Array, e); take(Uint16Array, e);
  const shapeOffsets = take(Uint32Array, e + 1);
  const shapeLat = take(Int32Array, p), shapeLng = take(Int32Array, p);

  bump("nodes", n); bump("edges", e); bump("points", p);
  bump("A. shape coords today (gz)", gz(new Uint8Array(shapeLat.buffer)) + gz(new Uint8Array(shapeLng.buffer)));

  // B. Per-edge delta: first point relative to the edge's source node, then
  //    each following point relative to the previous one.
  const dLat = new Int32Array(p), dLng = new Int32Array(p);
  for (let edge = 0; edge < e; edge += 1) {
    let prevLat = 0, prevLng = 0, started = false;
    for (let i = shapeOffsets[edge]; i < shapeOffsets[edge + 1]; i += 1) {
      if (!started) { // anchor on the source node, found via the CSR offsets
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (edgeOffsets[mid] <= edge) lo = mid; else hi = mid - 1; }
        prevLat = nodeLat[lo]; prevLng = nodeLng[lo]; started = true;
      }
      dLat[i] = shapeLat[i] - prevLat; dLng[i] = shapeLng[i] - prevLng;
      prevLat = shapeLat[i]; prevLng = shapeLng[i];
    }
  }
  bump("B. +delta (gz)", gz(new Uint8Array(dLat.buffer)) + gz(new Uint8Array(dLng.buffer)));
  bump("C. +delta +varint (gz)", gz(varints(dLat)) + gz(varints(dLng)));
  bump("C. +delta +varint (raw)", varints(dLat).byteLength + varints(dLng).byteLength);

  // D. How much geometry is a mirror of the opposite direction?
  const key = new Map(); let shared = 0, sharedPoints = 0;
  for (let edge = 0; edge < e; edge += 1) {
    const count = shapeOffsets[edge + 1] - shapeOffsets[edge];
    if (!count) continue;
    const pts = [];
    for (let i = shapeOffsets[edge]; i < shapeOffsets[edge + 1]; i += 1) pts.push(shapeLat[i], shapeLng[i]);
    const forward = pts.join(","), backward = pts.slice().reverse();
    // reverse point order (pairs), not the flat list
    const rev = []; for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    const revKey = rev.join(",");
    if (key.has(revKey) || key.has(forward)) { shared += 1; sharedPoints += count; }
    else key.set(forward, edge);
  }
  bump("edges whose geometry mirrors another", shared);
  bump("points saved by mirroring", sharedPoints);
  bump("edge targets today (gz)", gz(new Uint8Array(edgeTargets.buffer)));
  const targetDelta = new Int32Array(e);
  for (let node = 0; node < n; node += 1) for (let edge = edgeOffsets[node]; edge < edgeOffsets[node + 1]; edge += 1) targetDelta[edge] = edgeTargets[edge] - node;
  bump("edge targets delta+varint (gz)", gz(varints(targetDelta)));
  const degrees = new Uint8Array(n);
  for (let node = 0; node < n; node += 1) degrees[node] = Math.min(255, edgeOffsets[node + 1] - edgeOffsets[node]);
  bump("edge offsets today (gz)", gz(new Uint8Array(edgeOffsets.buffer)));
  bump("edge offsets as degrees (gz)", gz(degrees));
}
await file.close();

console.log(`\nsampled ${sample.length} densest tiles: ${totals.nodes.toLocaleString()} nodes, ${totals.edges.toLocaleString()} edges, ${totals.points.toLocaleString()} shape points\n`);
const base = totals["A. shape coords today (gz)"];
for (const [k, v] of Object.entries(totals)) {
  if (k === "nodes" || k === "edges" || k === "points") continue;
  const pct = k.startsWith("A.") || k.startsWith("B.") || k.startsWith("C.") ? `  (${((100 * v) / base).toFixed(0)}% of today's geometry)` : "";
  console.log(`${k.padEnd(42)} ${(v / 1e6).toFixed(2).padStart(8)} MB${pct}`);
}
console.log(`\nmirrored geometry: ${totals["edges whose geometry mirrors another"].toLocaleString()} of ${totals.edges.toLocaleString()} edges, ${totals["points saved by mirroring"].toLocaleString()} of ${totals.points.toLocaleString()} points (${((100 * totals["points saved by mirroring"]) / totals.points).toFixed(1)}%)`);
