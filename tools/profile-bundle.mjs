/* Breaks an EFRB bundle down by section, raw and gzipped, so the biggest
 * contributors to file size are measurable rather than guessed at. */
import { open, stat } from "node:fs/promises";
import { gunzipSync, gzipSync, constants } from "node:zlib";

const path = process.argv[2];
if (!path) throw new Error("Usage: node tools/profile-bundle.mjs region.efrb");
const file = await open(path);
const size = (await stat(path)).size;

const header = new Uint8Array(32);
await file.read(header, 0, 32, 0);
const tileCount = new DataView(header.buffer).getUint32(8, true);
const directory = new Uint8Array(tileCount * 40);
await file.read(directory, 0, directory.byteLength, 32);
const dv = new DataView(directory.buffer);

const totals = {};
const add = (name, rawBytes, buffer) => {
  const row = totals[name] ??= { raw: 0, gz: 0 };
  row.raw += rawBytes;
  if (buffer) row.gz += gzipSync(buffer, { level: constants.Z_BEST_COMPRESSION }).byteLength;
};

let nodes = 0, edges = 0, points = 0, chunkBytes = 0;
const limit = Number(process.argv[3] ?? tileCount);
for (let index = 0; index < Math.min(tileCount, limit); index += 1) {
  const at = index * 40;
  const offset = dv.getUint32(at + 20, true), byteLength = dv.getUint32(at + 24, true);
  const chunk = new Uint8Array(byteLength);
  await file.read(chunk, 0, byteLength, offset);
  chunkBytes += byteLength;
  const raw = dv.getUint16(at + 32, true) === 1 ? gunzipSync(chunk) : chunk;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = v.getUint16(4, true);
  const n = v.getUint32(8, true), e = v.getUint32(12, true);
  const p = version >= 3 ? v.getUint32(24, true) : 0;
  const pairs = version >= 4 ? v.getUint32(28, true) : 0;
  const runs = version >= 5 ? v.getUint32(32, true) : 0;
  const runEdges = version >= 5 ? v.getUint32(36, true) : 0;
  nodes += n; edges += e; points += p;
  const head = version >= 3 ? 40 : 32;
  let o = raw.byteOffset + head;
  const slice = (bytes) => { const s = new Uint8Array(raw.buffer, o, bytes); o += bytes; return s; };
  add("node latitudes", n * 4, slice(n * 4));
  add("node longitudes", n * 4, slice(n * 4));
  add("edge offsets", (n + 1) * 4, slice((n + 1) * 4));
  add("edge targets", e * 4, slice(e * 4));
  add("edge distances", e * 2, slice(e * 2));
  add("edge durations", e * 2, slice(e * 2));
  if (version >= 3) {
    add("shape offsets", (e + 1) * 4, slice((e + 1) * 4));
    add("shape latitudes", p * 4, slice(p * 4));
    add("shape longitudes", p * 4, slice(p * 4));
  }
  if (pairs) add("turn pairs", pairs * 8, slice(pairs * 8));
  if (runs) add("turn runs", (runs + 1) * 4 + runEdges * 4, slice((runs + 1) * 4 + runEdges * 4));
}
await file.close();

const rawTotal = Object.values(totals).reduce((s, r) => s + r.raw, 0);
const gzTotal = Object.values(totals).reduce((s, r) => s + r.gz, 0);
console.log(`\n${path.split("/").pop()}  ${(size / 1e6).toFixed(1)} MB on disk, ${Math.min(tileCount, limit)}/${tileCount} tiles profiled`);
console.log(`${nodes.toLocaleString()} nodes, ${edges.toLocaleString()} edges, ${points.toLocaleString()} shape points\n`);
const rows = Object.entries(totals).sort((a, b) => b[1].gz - a[1].gz);
console.log("section                raw MB   gz MB   gz%   bytes/item");
for (const [name, row] of rows) {
  const per = name.includes("shape lat") || name.includes("shape lon") ? row.gz / points
    : name.includes("node") ? row.gz / nodes : row.gz / edges;
  console.log(`${name.padEnd(20)} ${(row.raw / 1e6).toFixed(1).padStart(7)} ${(row.gz / 1e6).toFixed(1).padStart(7)} ${((100 * row.gz) / gzTotal).toFixed(1).padStart(5)}%  ${per.toFixed(2)}`);
}
console.log(`${"TOTAL".padEnd(20)} ${(rawTotal / 1e6).toFixed(1).padStart(7)} ${(gzTotal / 1e6).toFixed(1).padStart(7)}`);
console.log(`actual gzipped chunk bytes in file: ${(chunkBytes / 1e6).toFixed(1)} MB (sections gzipped separately compress worse than the whole chunk)`);
