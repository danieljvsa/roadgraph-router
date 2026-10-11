#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync, constants } from "node:zlib";
import { createOSMStream } from "osm-pbf-parser-node";

const EFR2_MAGIC = 0x32524645;
const EFRB_MAGIC = 0x42524645;
const SCALE = 10_000_000;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 40;
const HIGHWAYS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road"]);
const SPEEDS = { motorway: 110, motorway_link: 50, trunk: 90, trunk_link: 50, primary: 70, primary_link: 45, secondary: 60, secondary_link: 40, tertiary: 50, tertiary_link: 35, unclassified: 35, residential: 30, living_street: 10, service: 20, road: 25 };

function usage() {
  console.error("Usage: roadgraph-compile input.osm.pbf --output region.efrb [--profile car] [--tile-size-km 120] [--padding-km 8] [--compression gzip|none] [--shape-tolerance-m 2]");
}
function option(name, fallback) { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1]; }
function positional() { return process.argv.slice(2).find((value) => !value.startsWith("--") && !process.argv.includes(value, process.argv.indexOf("--output") + 1)); }
function denied(tags) { return [tags.motor_vehicle, tags.vehicle, tags.access].some((value) => value === "no" || value === "private"); }
function forwardOnly(tags) { return tags.oneway === "yes" || tags.oneway === "1" || tags.junction === "roundabout"; }
function reverseOnly(tags) { return tags.oneway === "-1"; }
function speed(tags) { const match = tags.maxspeed?.match(/\d+(?:\.\d+)?/); return Math.max(5, match ? Number(match[0]) : SPEEDS[tags.highway] ?? 25); }
function distance(a, b) { const r = Math.PI / 180; const dy = (b.lat - a.lat) * r; const dx = (b.lon - a.lon) * r; const h = Math.sin(dy / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dx / 2) ** 2; return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }
function expand(bbox, paddingKm) { const lat = paddingKm / 110.574; const lng = paddingKm / (111.320 * Math.max(.05, Math.cos(((bbox.minLat + bbox.maxLat) / 2) * Math.PI / 180))); return { minLat: bbox.minLat - lat, maxLat: bbox.maxLat + lat, minLon: bbox.minLon - lng, maxLon: bbox.maxLon + lng }; }
function within(point, bbox) { return point.lat >= bbox.minLat && point.lat <= bbox.maxLat && point.lon >= bbox.minLon && point.lon <= bbox.maxLon; }
function fixed(value) { return Math.round(value * SCALE); }
function parseBounds(value) { const parts = value?.split(",").map(Number); if (!parts || parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return undefined; const [minLon, minLat, maxLon, maxLat] = parts; return minLon < maxLon && minLat < maxLat ? { minLon, minLat, maxLon, maxLat } : undefined; }
function deviation(point, start, end) { const latitude = (point.lat + start.lat + end.lat) * Math.PI / 540, x = (point.lon - start.lon) * 111_320 * Math.cos(latitude), y = (point.lat - start.lat) * 110_574, ex = (end.lon - start.lon) * 111_320 * Math.cos(latitude), ey = (end.lat - start.lat) * 110_574, length = ex * ex + ey * ey; if (!length) return Math.hypot(x, y); const t = Math.max(0, Math.min(1, (x * ex + y * ey) / length)); return Math.hypot(x - t * ex, y - t * ey); }
function simplifyStraight(edges, latitudes, longitudes, tolerance) {
  if (!tolerance || !edges.length) return { edges, latitudes, longitudes, before: latitudes.length };
  const incoming = new Int32Array(latitudes.length).fill(-1), outgoing = new Int32Array(latitudes.length).fill(-1), inCount = new Uint8Array(latitudes.length), outCount = new Uint8Array(latitudes.length);
  for (let index = 0; index < edges.length; index += 1) { const edge = edges[index]; inCount[edge.to] += inCount[edge.to] < 255; outCount[edge.from] += outCount[edge.from] < 255; incoming[edge.to] = index; outgoing[edge.from] = index; }
  const removable = new Uint8Array(latitudes.length);
  for (let node = 0; node < latitudes.length; node += 1) if (inCount[node] === 1 && outCount[node] === 1) { const previous = edges[incoming[node]], next = edges[outgoing[node]]; if (previous.from !== next.to && deviation({ lat: latitudes[node], lon: longitudes[node] }, { lat: latitudes[previous.from], lon: longitudes[previous.from] }, { lat: latitudes[next.to], lon: longitudes[next.to] }) <= tolerance) removable[node] = 1; }
  const used = new Uint8Array(edges.length), simplified = [];
  for (let index = 0; index < edges.length; index += 1) { if (used[index] || removable[edges[index].from]) continue; const first = edges[index]; let target = first.to, distanceMetres = first.distance, duration = first.duration; used[index] = 1; while (removable[target] && !used[outgoing[target]]) { const next = edges[outgoing[target]]; used[outgoing[target]] = 1; target = next.to; distanceMetres += next.distance; duration += next.duration; } simplified.push({ from: first.from, to: target, distance: distanceMetres, duration }); }
  for (let index = 0; index < edges.length; index += 1) if (!used[index]) simplified.push(edges[index]);
  const remap = new Int32Array(latitudes.length).fill(-1), nextLatitudes = [], nextLongitudes = [];
  const map = (node) => { let mapped = remap[node]; if (mapped === -1) { mapped = nextLatitudes.length; remap[node] = mapped; nextLatitudes.push(latitudes[node]); nextLongitudes.push(longitudes[node]); } return mapped; };
  for (const edge of simplified) { edge.from = map(edge.from); edge.to = map(edge.to); }
  return { edges: simplified, latitudes: nextLatitudes, longitudes: nextLongitudes, before: latitudes.length };
}

function createIdSet() {
  const bits = 1 << 20, words = bits / 32, pages = new Map(); let count = 0;
  return { add(id) { const pageId = Math.floor(id / bits); let page = pages.get(pageId); if (!page) { page = new Uint32Array(words); pages.set(pageId, page); } const offset = id - pageId * bits; const word = offset >>> 5, mask = 1 << (offset & 31); if (!(page[word] & mask)) { page[word] |= mask; count += 1; } }, has(id) { const page = pages.get(Math.floor(id / bits)); if (!page) return false; const offset = id % bits; return Boolean(page[offset >>> 5] & (1 << (offset & 31))); }, get count() { return count; } };
}

async function discoverBounds(file) {
  const bounds = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  for await (const entity of createOSMStream(file, { withTags: false })) if (entity.type === "node") { bounds.minLat = Math.min(bounds.minLat, entity.lat); bounds.minLon = Math.min(bounds.minLon, entity.lon); bounds.maxLat = Math.max(bounds.maxLat, entity.lat); bounds.maxLon = Math.max(bounds.maxLon, entity.lon); }
  if (!Number.isFinite(bounds.minLat)) throw new Error("The input contains no OSM nodes.");
  return bounds;
}

function tilesFor(bounds, sizeKm) {
  const latStep = sizeKm / 110.574, tiles = [];
  for (let minLat = bounds.minLat, row = 0; minLat < bounds.maxLat; minLat += latStep, row += 1) {
    const maxLat = Math.min(bounds.maxLat, minLat + latStep);
    const lonStep = sizeKm / (111.320 * Math.max(.05, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)));
    for (let minLon = bounds.minLon, column = 0; minLon < bounds.maxLon; minLon += lonStep, column += 1) tiles.push({ id: tiles.length, name: `tile-${row}-${column}`, bounds: { minLat, minLon, maxLat, maxLon: Math.min(bounds.maxLon, minLon + lonStep) } });
  }
  return tiles;
}

function scaleFor(values) { let max = 0; for (const value of values) max = Math.max(max, value); return Math.max(1, Math.ceil(max / 65_535)); }
function encodeEfr2(graph) {
  const nodes = graph.latitudes.length, edges = graph.targets.length, distanceScale = scaleFor(graph.distances), durationScale = scaleFor(graph.durations);
  const buffer = new ArrayBuffer(32 + nodes * 8 + (nodes + 1) * 4 + edges * 8), view = new DataView(buffer);
  view.setUint32(0, EFR2_MAGIC, true); view.setUint16(4, 2, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true); view.setUint32(16, SCALE, true); view.setUint16(20, distanceScale, true); view.setUint16(22, durationScale, true);
  let offset = 32; const latitudes = new Int32Array(buffer, offset, nodes); offset += latitudes.byteLength; const longitudes = new Int32Array(buffer, offset, nodes); offset += longitudes.byteLength;
  for (let index = 0; index < nodes; index += 1) { latitudes[index] = fixed(graph.latitudes[index]); longitudes[index] = fixed(graph.longitudes[index]); }
  new Uint32Array(buffer, offset, nodes + 1).set(graph.offsets); offset += (nodes + 1) * 4; new Uint32Array(buffer, offset, edges).set(graph.targets); offset += edges * 4;
  const distances = new Uint16Array(buffer, offset, edges); offset += distances.byteLength; const durations = new Uint16Array(buffer, offset, edges);
  for (let index = 0; index < edges; index += 1) { distances[index] = Math.round(graph.distances[index] / distanceScale); durations[index] = Math.round(graph.durations[index] / durationScale); }
  return buffer;
}

async function compileTile(file, tile, paddingKm, shapeToleranceMeters) {
  const buffered = expand(tile.bounds, paddingKm), ids = createIdSet(); let roadWays = 0;
  for await (const entity of createOSMStream(file, { withTags: { node: false, way: ["highway", "access", "vehicle", "motor_vehicle"], relation: false } })) {
    if (entity.type !== "way") continue; const tags = entity.tags ?? {}; if (!HIGHWAYS.has(tags.highway) || denied(tags) || entity.refs.length < 2) continue;
    roadWays += 1; for (const id of entity.refs) ids.add(id);
  }
  const coordinates = new Map();
  for await (const entity of createOSMStream(file, { withTags: false })) if (entity.type === "node" && ids.has(entity.id) && within(entity, buffered)) coordinates.set(entity.id, [entity.lat, entity.lon]);
  const indexes = new Map(), latitudes = [], longitudes = [], edges = [];
  const add = (id, coordinate) => { let index = indexes.get(id); if (index === undefined) { index = latitudes.length; indexes.set(id, index); latitudes.push(coordinate[0]); longitudes.push(coordinate[1]); } return index; };
  const addEdge = (fromId, toId, velocity) => { const from = coordinates.get(fromId), to = coordinates.get(toId); if (!from || !to) return; const metres = distance({ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }); if (metres < .2) return; edges.push({ from: add(fromId, from), to: add(toId, to), distance: metres, duration: metres / (velocity * (1000 / 3600)) }); };
  for await (const entity of createOSMStream(file, { withTags: { node: false, way: ["highway", "oneway", "junction", "access", "vehicle", "motor_vehicle", "maxspeed"], relation: false } })) {
    if (entity.type !== "way") continue; const tags = entity.tags ?? {}; if (!HIGHWAYS.has(tags.highway) || denied(tags) || entity.refs.length < 2) continue; const velocity = speed(tags);
    for (let index = 1; index < entity.refs.length; index += 1) { const from = entity.refs[index - 1], to = entity.refs[index]; if (!reverseOnly(tags)) addEdge(from, to, velocity); if (!forwardOnly(tags)) addEdge(to, from, velocity); }
  }
  const simplified = simplifyStraight(edges, latitudes, longitudes, shapeToleranceMeters);
  const offsets = new Uint32Array(simplified.latitudes.length + 1); for (const edge of simplified.edges) offsets[edge.from + 1] += 1; for (let index = 1; index < offsets.length; index += 1) offsets[index] += offsets[index - 1];
  const write = offsets.slice(), targets = new Uint32Array(simplified.edges.length), distances = new Float32Array(simplified.edges.length), durations = new Float32Array(simplified.edges.length);
  for (const edge of simplified.edges) { const index = write[edge.from]++; targets[index] = edge.to; distances[index] = edge.distance; durations[index] = edge.duration; }
  return { tile, data: encodeEfr2({ latitudes: simplified.latitudes, longitudes: simplified.longitudes, offsets, targets, distances, durations }), metrics: { roadNodes: ids.count, roadWays, nodesBefore: simplified.before, nodesAfter: simplified.latitudes.length, edges: simplified.edges.length } };
}

function assemble(chunks, compression) {
  const directoryBytes = chunks.length * DIRECTORY_ENTRY_BYTES; let offset = HEADER_BYTES + directoryBytes;
  const output = new ArrayBuffer(offset + chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0)), view = new DataView(output);
  view.setUint32(0, EFRB_MAGIC, true); view.setUint16(4, 1, true); view.setUint16(6, HEADER_BYTES, true); view.setUint32(8, chunks.length, true); view.setUint32(12, HEADER_BYTES, true); view.setUint32(16, directoryBytes, true);
  for (let index = 0; index < chunks.length; index += 1) { const chunk = chunks[index], entry = HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES, bounds = chunk.tile.bounds; view.setUint32(entry, chunk.tile.id, true); view.setInt32(entry + 4, fixed(bounds.minLat), true); view.setInt32(entry + 8, fixed(bounds.minLon), true); view.setInt32(entry + 12, fixed(bounds.maxLat), true); view.setInt32(entry + 16, fixed(bounds.maxLon), true); view.setUint32(entry + 20, offset, true); view.setUint32(entry + 24, chunk.data.byteLength, true); view.setUint32(entry + 28, chunk.rawBytes, true); view.setUint16(entry + 32, compression === "gzip" ? 1 : 0, true); new Uint8Array(output, offset, chunk.data.byteLength).set(chunk.data); offset += chunk.data.byteLength; }
  return output;
}

const input = positional(), outputOption = option("--output"), profile = option("--profile", "car"), compression = option("--compression", "gzip"), tileSizeKm = Number(option("--tile-size-km", "120")), paddingKm = Number(option("--padding-km", "8")), shapeToleranceMeters = Number(option("--shape-tolerance-m", "2")), requestedBounds = parseBounds(option("--bbox"));
if (!input || !outputOption || profile !== "car" || !["gzip", "none"].includes(compression) || !Number.isFinite(tileSizeKm) || tileSizeKm <= 0 || !Number.isFinite(paddingKm) || paddingKm < 0 || !Number.isFinite(shapeToleranceMeters) || shapeToleranceMeters < 0 || (option("--bbox") && !requestedBounds)) { usage(); process.exitCode = 1; }
else {
  const started = performance.now(), file = resolve(process.cwd(), input), output = resolve(process.cwd(), outputOption), source = await stat(file), before = process.memoryUsage().rss;
  if (!file.endsWith(".pbf")) throw new Error("This initial streaming importer accepts .osm.pbf files. Convert XML .osm extracts to PBF first to retain country-scale memory behaviour.");
  const bounds = requestedBounds ?? await discoverBounds(file), tiles = tilesFor(bounds, tileSizeKm), chunks = [], totals = { roadNodes: 0, roadWays: 0, nodesBefore: 0, nodesAfter: 0, edges: 0 }; let peakRss = before;
  console.log(`Discovered ${tiles.length} automatic tiles; compiling with ${tileSizeKm} km tiles and ${paddingKm} km overlap.`);
  for (const tile of tiles) { const compiled = await compileTile(file, tile, paddingKm, shapeToleranceMeters); const raw = new Uint8Array(compiled.data); const data = compression === "gzip" ? gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) : raw; chunks.push({ tile, data, rawBytes: raw.byteLength }); for (const key of Object.keys(totals)) totals[key] += compiled.metrics[key]; peakRss = Math.max(peakRss, process.memoryUsage().rss); console.log(`${tile.name}: ${compiled.metrics.nodesAfter.toLocaleString()} nodes, ${compiled.metrics.edges.toLocaleString()} edges, ${(data.byteLength / 1e6).toFixed(1)} MB`); }
  const bundle = assemble(chunks, compression); await mkdir(dirname(output), { recursive: true }); await writeFile(output, new Uint8Array(bundle));
  const report = { formatVersion: 1, input: file, inputBytes: source.size, profile, compression: `${compression}-per-tile`, tileSizeKm, paddingKm, tiles: tiles.length, ...totals, bundleBytes: bundle.byteLength, compressionRatio: Number((bundle.byteLength / Math.max(1, chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0))).toFixed(4)), peakRssBytes: peakRss, elapsedMilliseconds: Math.round(performance.now() - started) };
  await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`); console.table({ input_mb: (source.size / 1e6).toFixed(1), tiles: tiles.length, road_nodes: totals.roadNodes.toLocaleString(), routing_nodes: totals.nodesAfter.toLocaleString(), routing_edges: totals.edges.toLocaleString(), efrb_mb: (bundle.byteLength / 1e6).toFixed(1), compression_ratio: report.compressionRatio, peak_rss_mb: (peakRss / 1e6).toFixed(1), elapsed_seconds: (report.elapsedMilliseconds / 1000).toFixed(1) });
}
