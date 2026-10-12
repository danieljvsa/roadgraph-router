/* Measures what an application would actually pay for a route: the bytes a
 * CDN would serve over HTTP Range, the tiles that implies, and the time and
 * memory spent turning them into a route. Each route gets a fresh bundle
 * reader so nothing is reused between measurements. */
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { openRoadGraphBundle, route } from "../dist/index.js";

const EFR2_MAGIC = 0x32524645;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 40;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function options(name) {
  return process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1]] : []);
}

function coordinate(value) {
  const values = value?.split(",").map(Number);
  if (!values || values.length !== 2 || values.some((item) => !Number.isFinite(item))) throw new Error(`"${value}" is not a latitude,longitude pair.`);
  return { lat: values[0], lng: values[1] };
}

/** `--route "short urban=38.72,-9.14>38.73,-9.13"` */
function parseRoute(value) {
  const [name, pair] = value.includes("=") ? [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)] : ["route", value];
  const [from, to] = pair.split(">");
  if (!from || !to) throw new Error(`Route "${value}" must be written as name=lat,lng>lat,lng.`);
  return { name, origin: coordinate(from), destination: coordinate(to) };
}

const input = process.argv.slice(2).find((argument) => !argument.startsWith("--") && argument.endsWith(".efrb"));
const routes = options("--route").map(parseRoute);
if (!input || (!routes.length && !option("--origin"))) {
  throw new Error('Usage: node scripts/benchmark.mjs region.efrb --route "short urban=lat,lng>lat,lng" [--route ...]');
}
if (option("--origin")) routes.push({ name: "route", origin: coordinate(option("--origin")), destination: coordinate(option("--destination")) });

const filePath = resolve(process.cwd(), input);
const file = await open(filePath);
const metadata = await stat(filePath);

/** A fetcher that mimics a ranged CDN read and records what it served. */
function recordingFetcher(stats) {
  return async (_url, init = {}) => {
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    const match = /bytes=(\d+)-(\d+)/.exec(headers.get("Range") ?? "");
    if (!match) return new Response(null, { status: 416 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = new Uint8Array(end - start + 1);
    await file.read(body, 0, body.byteLength, start);
    stats.bytes += body.byteLength;
    stats.requests += 1;
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}` } });
  };
}

// Whole-bundle totals, read directly rather than through the router.
let totalNodes = 0;
let totalEdges = 0;
let totalRestrictions = 0;
let rawBytes = 0;
const directoryHeader = new Uint8Array(HEADER_BYTES);
await file.read(directoryHeader, 0, HEADER_BYTES, 0);
const tileCount = new DataView(directoryHeader.buffer).getUint32(8, true);
const directory = new Uint8Array(tileCount * DIRECTORY_ENTRY_BYTES);
await file.read(directory, 0, directory.byteLength, HEADER_BYTES);
const directoryView = new DataView(directory.buffer);
for (let index = 0; index < tileCount; index += 1) {
  const entry = index * DIRECTORY_ENTRY_BYTES;
  const offset = directoryView.getUint32(entry + 20, true);
  const byteLength = directoryView.getUint32(entry + 24, true);
  const compressed = directoryView.getUint16(entry + 32, true) === 1;
  const chunk = new Uint8Array(byteLength);
  await file.read(chunk, 0, byteLength, offset);
  const raw = compressed ? gunzipSync(chunk) : chunk;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint16(4, true);
  if (view.getUint32(0, true) !== EFR2_MAGIC || version < 2 || version > 4) throw new Error(`Tile ${index} is not a supported EFR2 graph.`);
  totalNodes += view.getUint32(8, true);
  totalEdges += view.getUint32(12, true);
  if (version >= 4) totalRestrictions += view.getUint32(28, true);
  rawBytes += raw.byteLength;
}

console.log(`\nBundle: ${input}`);
console.table({
  bundle_mb: (metadata.size / 1e6).toFixed(2),
  uncompressed_mb: (rawBytes / 1e6).toFixed(2),
  compression_ratio: (metadata.size / rawBytes).toFixed(4),
  tiles: tileCount,
  nodes: totalNodes.toLocaleString("en-US"),
  edges: totalEdges.toLocaleString("en-US"),
  banned_turn_pairs: totalRestrictions.toLocaleString("en-US"),
});

const results = {};
for (const { name, origin, destination } of routes) {
  const stats = { bytes: 0, requests: 0 };
  global.gc?.();
  const before = process.memoryUsage();
  const openedAt = performance.now();
  const bundle = await openRoadGraphBundle("local://routing.efrb", recordingFetcher(stats));
  const directoryBytes = stats.bytes;
  const loadedAt = performance.now();
  let graph;
  try {
    graph = await bundle.loadForRoute(origin, destination);
  } catch (error) {
    results[name] = { error: error.message };
    continue;
  }
  const loadedMs = performance.now() - loadedAt;
  const routedAt = performance.now();
  let result;
  try {
    result = route(graph, origin, destination);
  } catch (error) {
    results[name] = { tiles_loaded: stats.requests - 2, bytes_loaded: stats.bytes.toLocaleString("en-US"), error: error.message };
    continue;
  }
  const routedMs = performance.now() - routedAt;
  const after = process.memoryUsage();
  results[name] = {
    tiles_loaded: stats.requests - 2,
    range_requests: stats.requests,
    bytes_loaded: stats.bytes.toLocaleString("en-US"),
    mb_loaded: (stats.bytes / 1e6).toFixed(2),
    directory_bytes: directoryBytes,
    open_ms: (loadedAt - openedAt).toFixed(1),
    graph_load_ms: loadedMs.toFixed(1),
    route_ms: routedMs.toFixed(1),
    graph_nodes: graph.nodeLatitudes.length.toLocaleString("en-US"),
    graph_edges: graph.edgeTargets.length.toLocaleString("en-US"),
    rss_delta_mb: ((after.rss - before.rss) / 1e6).toFixed(1),
    heap_delta_mb: ((after.heapUsed - before.heapUsed) / 1e6).toFixed(1),
    distance_km: (result.distanceMeters / 1000).toFixed(2),
    duration_min: (result.durationSeconds / 60).toFixed(1),
  };
}
await file.close();

console.log("\nRoutes");
console.table(results);
