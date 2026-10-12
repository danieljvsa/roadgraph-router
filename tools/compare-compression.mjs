/* Compares codecs on real chunk payloads, including decode cost, since a
 * bundle is only useful if a browser can open it quickly. */
import { open } from "node:fs/promises";
import { gunzipSync, gzipSync, brotliCompressSync, brotliDecompressSync, zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";
import { performance } from "node:perf_hooks";

const file = await open(process.argv[2]);
const header = new Uint8Array(32); await file.read(header, 0, 32, 0);
const tileCount = new DataView(header.buffer).getUint32(8, true);
const directory = new Uint8Array(tileCount * 40); await file.read(directory, 0, directory.byteLength, 32);
const dv = new DataView(directory.buffer);
const order = [...Array(tileCount).keys()].sort((a, b) => dv.getUint32(b * 40 + 28, true) - dv.getUint32(a * 40 + 28, true));

const codecs = {
  "gzip -9 (current)": { pack: (b) => gzipSync(b, { level: constants.Z_BEST_COMPRESSION }), unpack: gunzipSync },
  "brotli q5": { pack: (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), unpack: brotliDecompressSync },
  "brotli q11": { pack: (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }), unpack: brotliDecompressSync },
  "zstd l3": { pack: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }), unpack: zstdDecompressSync },
  "zstd l19": { pack: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }), unpack: zstdDecompressSync },
};
const totals = {};
let rawTotal = 0;
for (const index of order.slice(0, 3)) {
  const at = index * 40;
  const chunk = new Uint8Array(dv.getUint32(at + 24, true));
  await file.read(chunk, 0, chunk.byteLength, dv.getUint32(at + 20, true));
  const raw = dv.getUint16(at + 32, true) === 1 ? gunzipSync(chunk) : chunk;
  rawTotal += raw.byteLength;
  for (const [name, codec] of Object.entries(codecs)) {
    const packStart = performance.now();
    const packed = codec.pack(raw);
    const packMs = performance.now() - packStart;
    const unpackStart = performance.now();
    codec.unpack(packed);
    const unpackMs = performance.now() - unpackStart;
    const row = totals[name] ??= { bytes: 0, packMs: 0, unpackMs: 0 };
    row.bytes += packed.byteLength; row.packMs += packMs; row.unpackMs += unpackMs;
  }
}
await file.close();
console.log(`\n3 densest tiles, ${(rawTotal / 1e6).toFixed(1)} MB uncompressed\n`);
console.log("codec                 size MB   vs gzip   compress s   decompress ms   browser-native");
const base = totals["gzip -9 (current)"].bytes;
for (const [name, row] of Object.entries(totals)) {
  const native = name.startsWith("gzip") ? "yes (DecompressionStream)" : name.startsWith("brotli") ? "no (not in DecompressionStream)" : "no";
  console.log(`${name.padEnd(20)} ${(row.bytes / 1e6).toFixed(2).padStart(8)} ${((100 * row.bytes) / base - 100).toFixed(1).padStart(8)}% ${(row.packMs / 1000).toFixed(1).padStart(11)} ${row.unpackMs.toFixed(0).padStart(14)}   ${native}`);
}
