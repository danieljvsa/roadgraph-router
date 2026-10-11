import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { openRoadGraphBundle, route } from "../dist/index.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function coordinate(value) {
  const values = value?.split(",").map(Number);
  if (!values || values.length !== 2 || values.some((item) => !Number.isFinite(item))) throw new Error("Coordinates must be latitude,longitude.");
  return { lat: values[0], lng: values[1] };
}

const input = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
if (!input || !option("--origin") || !option("--destination")) {
  throw new Error("Usage: npm run benchmark -- path/to/portugal.efrb --origin 37.0194,-7.9304 --destination 37.0340,-7.8900");
}

const origin = coordinate(option("--origin"));
const destination = coordinate(option("--destination"));
const filePath = resolve(process.cwd(), input);
const file = await open(filePath);
let bytesDownloaded = 0;
const fetcher = async (_url, init = {}) => {
  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  const range = headers.get("Range");
  const match = range && /bytes=(\d+)-(\d+)/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const start = Number(match[1]);
  const end = Number(match[2]);
  const body = new Uint8Array(end - start + 1);
  await file.read(body, 0, body.byteLength, start);
  bytesDownloaded += body.byteLength;
  return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}` } });
};

const before = process.memoryUsage();
const openedAt = performance.now();
const bundle = await openRoadGraphBundle("local://routing.efrb", fetcher);
const openedMs = performance.now() - openedAt;
const loadedAt = performance.now();
const graph = await bundle.loadForRoute(origin, destination);
const loadedMs = performance.now() - loadedAt;
const routedAt = performance.now();
const result = route(graph, origin, destination);
const routedMs = performance.now() - routedAt;
const after = process.memoryUsage();
const metadata = await stat(filePath);
let totalNodes = 0;
let totalEdges = 0;
for (const tile of bundle.tiles) {
  const chunk = new Uint8Array(tile.byteLength);
  await file.read(chunk, 0, chunk.byteLength, tile.offset);
  const raw = tile.compression === 1 ? gunzipSync(chunk) : chunk;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== 0x32524645 || view.getUint16(4, true) !== 2) throw new Error(`Tile ${tile.id} is not an EFR2 graph.`);
  totalNodes += view.getUint32(8, true);
  totalEdges += view.getUint32(12, true);
}
await file.close();

console.table({
  bundle_mb: (metadata.size / 1_000_000).toFixed(1),
  tiles: bundle.tiles.length,
  total_nodes: totalNodes.toLocaleString("en-US"),
  total_edges: totalEdges.toLocaleString("en-US"),
  loaded_nodes: graph.nodeLatitudes.length.toLocaleString("en-US"),
  loaded_edges: graph.edgeTargets.length.toLocaleString("en-US"),
  bytes_downloaded: bytesDownloaded.toLocaleString("en-US"),
  bytes_downloaded_mb: (bytesDownloaded / 1_000_000).toFixed(2),
  bundle_open_ms: openedMs.toFixed(1),
  tile_load_ms: loadedMs.toFixed(1),
  route_ms: routedMs.toFixed(1),
  route_km: (result.distanceMeters / 1_000).toFixed(2),
  route_minutes: (result.durationSeconds / 60).toFixed(1),
  rss_delta_mb: ((after.rss - before.rss) / 1_000_000).toFixed(1),
  heap_delta_mb: ((after.heapUsed - before.heapUsed) / 1_000_000).toFixed(1),
});
