#!/usr/bin/env node
/* Generic, bounded-pass OSM PBF -> EFRB compiler.  PBF is scanned twice: once
 * for usable ways/topology and once for coordinates of referenced nodes. */
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, constants } from "node:zlib";
import { createOSMStream } from "osm-pbf-parser-node";
import { spawnSync } from "node:child_process";

const EFR2_MAGIC = 0x32524645, EFRB_MAGIC = 0x42524645, SCALE = 10_000_000, HEADER = 32, DIRECTORY = 40;
let observedPeakRss = 0;
const HIGHWAYS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road"]);
const SPEEDS = { motorway: 110, motorway_link: 50, trunk: 90, trunk_link: 50, primary: 70, primary_link: 45, secondary: 60, secondary_link: 40, tertiary: 50, tertiary_link: 35, unclassified: 35, residential: 30, living_street: 10, service: 20, road: 25 };

function usage() { console.error("Usage: roadgraph-compile input.osm.pbf --output region.efrb [--profile car] [--tile-size-km 120] [--padding-km 8] [--compression gzip|none] [--shape-tolerance-m 2] [--max-memory-mb 2048] [--bbox minLon,minLat,maxLon,maxLat]"); }
function opt(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
function inputArg() { const values = process.argv.slice(2); for (let i = 0; i < values.length; i += 1) { if (values[i].startsWith("--")) { i += 1; continue; } return values[i]; } return undefined; }
function parseBounds(value) { const p = value?.split(",").map(Number); return p?.length === 4 && p.every(Number.isFinite) && p[0] < p[2] && p[1] < p[3] ? { minLon: p[0], minLat: p[1], maxLon: p[2], maxLat: p[3] } : undefined; }
function denied(tags) { return [tags.access, tags.vehicle, tags.motor_vehicle].some((value) => ["no", "private", "agricultural", "forestry", "customers"].includes(value)); }
function forwardOnly(tags) { return tags.oneway === "yes" || tags.oneway === "1" || tags.junction === "roundabout"; }
function reverseOnly(tags) { return tags.oneway === "-1"; }
function speed(tags) { const match = tags.maxspeed?.match(/(\d+(?:\.\d+)?)\s*(mph)?/i); const value = match ? Number(match[1]) * (match[2] ? 1.609344 : 1) : SPEEDS[tags.highway] ?? 25; return Math.max(5, value); }
function fixed(value) { return Math.round(value * SCALE); }
function inside(point, bounds) { return point.lat >= bounds.minLat && point.lat <= bounds.maxLat && point.lon >= bounds.minLon && point.lon <= bounds.maxLon; }
function metres(a, b) { const r = Math.PI / 180, dy = (b.lat - a.lat) * r, dx = (b.lon - a.lon) * r, h = Math.sin(dy / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dx / 2) ** 2; return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }
function pointDeviation(p, a, b) { const latitude = (p.lat + a.lat + b.lat) * Math.PI / 540, x = (p.lon - a.lon) * 111_320 * Math.cos(latitude), y = (p.lat - a.lat) * 110_574, ex = (b.lon - a.lon) * 111_320 * Math.cos(latitude), ey = (b.lat - a.lat) * 110_574, l = ex * ex + ey * ey; if (!l) return Math.hypot(x, y); const t = Math.max(0, Math.min(1, (x * ex + y * ey) / l)); return Math.hypot(x - t * ex, y - t * ey); }
function simplifyShape(points, tolerance) { if (points.length < 3 || !tolerance) return points; const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1; const visit = (start, end) => { let greatest = tolerance, at = -1; for (let i = start + 1; i < end; i += 1) { const d = pointDeviation(points[i], points[start], points[end]); if (d > greatest) { greatest = d; at = i; } } if (at >= 0) { keep[at] = 1; visit(start, at); visit(at, end); } }; visit(0, points.length - 1); return points.filter((_, index) => keep[index]); }

// Sparse paged stores avoid a JavaScript Map entry for every OSM node.
// Fixed-size Bloom filters keep country-wide OSM IDs bounded in memory. False
// positives are safe here: they only preserve an extra node/coordinate.
function approximateIds() { const bitCount = 1 << 29, mask = bitCount - 1; let words = new Uint32Array(bitCount >>> 5), setBits = 0; const slot = (id) => (Math.imul(id >>> 0, 0x9e3779b1) >>> 0) & mask; return { add(id) { const value = slot(id), word = value >>> 5, bit = 1 << (value & 31); if (!(words[word] & bit)) { words[word] |= bit; setBits += 1; } }, has(id) { const value = slot(id); return Boolean(words[value >>> 5] & (1 << (value & 31))); }, clear() { words = new Uint32Array(0); }, get count() { return Math.round(-bitCount * Math.log(Math.max(Number.EPSILON, 1 - setBits / bitCount))); } }; }

function tilesFor(bounds, km) { const latStep = km / 110.574, result = []; for (let minLat = bounds.minLat, row = 0; minLat < bounds.maxLat; minLat += latStep, row += 1) { const maxLat = Math.min(bounds.maxLat, minLat + latStep), lonStep = km / (111.32 * Math.max(.05, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180))); for (let minLon = bounds.minLon, col = 0; minLon < bounds.maxLon; minLon += lonStep, col += 1) result.push({ id: result.length, name: `tile-${row}-${col}`, bounds: { minLat, minLon, maxLat, maxLon: Math.min(bounds.maxLon, minLon + lonStep) } }); } return result; }
function tileFor(point, tiles) { return tiles.find((tile) => inside(point, tile.bounds)); }
function expand(bounds, km) { const latitude = km / 110.574, longitude = km / (111.32 * Math.max(.05, Math.cos(((bounds.minLat + bounds.maxLat) / 2) * Math.PI / 180))); return { minLat: bounds.minLat - latitude, maxLat: bounds.maxLat + latitude, minLon: bounds.minLon - longitude, maxLon: bounds.maxLon + longitude }; }
function scaleFor(values) { let greatest = 0; for (const value of values) greatest = Math.max(greatest, value); return Math.max(1, Math.ceil(greatest / 65535)); }

function encodeEfr2(graph) {
  const nodes = graph.nodes.length, edges = graph.edges.length, distanceScale = scaleFor(graph.edges.map((edge) => edge.distance)), durationScale = scaleFor(graph.edges.map((edge) => edge.duration));
  const offsets = new Uint32Array(nodes + 1); for (const edge of graph.edges) offsets[edge.from + 1] += 1; for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const order = offsets.slice(), targets = new Uint32Array(edges), distances = new Uint16Array(edges), durations = new Uint16Array(edges), shapes = new Array(edges);
  for (const edge of graph.edges) { const index = order[edge.from]++; targets[index] = edge.to; distances[index] = Math.round(edge.distance / distanceScale); durations[index] = Math.round(edge.duration / durationScale); shapes[index] = edge.shape; }
  const shapeOffsets = new Uint32Array(edges + 1); for (let i = 0; i < edges; i += 1) shapeOffsets[i + 1] = shapeOffsets[i] + shapes[i].length;
  const points = shapeOffsets[edges], bytes = 40 + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (edges + 1) * 4 + points * 8, buffer = new ArrayBuffer(bytes), view = new DataView(buffer);
  view.setUint32(0, EFR2_MAGIC, true); view.setUint16(4, 3, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true); view.setUint32(16, SCALE, true); view.setUint16(20, distanceScale, true); view.setUint16(22, durationScale, true); view.setUint32(24, points, true);
  let offset = 40, latitudes = new Int32Array(buffer, offset, nodes); offset += latitudes.byteLength; const longitudes = new Int32Array(buffer, offset, nodes); offset += longitudes.byteLength; for (let i = 0; i < nodes; i += 1) { latitudes[i] = fixed(graph.nodes[i].lat); longitudes[i] = fixed(graph.nodes[i].lon); }
  new Uint32Array(buffer, offset, nodes + 1).set(offsets); offset += (nodes + 1) * 4; new Uint32Array(buffer, offset, edges).set(targets); offset += edges * 4; new Uint16Array(buffer, offset, edges).set(distances); offset += edges * 2; new Uint16Array(buffer, offset, edges).set(durations); offset += edges * 2; new Uint32Array(buffer, offset, edges + 1).set(shapeOffsets); offset += (edges + 1) * 4;
  const shapeLatitudes = new Int32Array(buffer, offset, points); offset += points * 4, shapeLongitudes = new Int32Array(buffer, offset, points); let point = 0; for (const shape of shapes) for (const coordinate of shape) { shapeLatitudes[point] = fixed(coordinate.lat); shapeLongitudes[point++] = fixed(coordinate.lon); }
  return buffer;
}
function assemble(chunks, compression) { let offset = HEADER + chunks.length * DIRECTORY, size = offset + chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0), out = new ArrayBuffer(size), view = new DataView(out); view.setUint32(0, EFRB_MAGIC, true); view.setUint16(4, 1, true); view.setUint16(6, HEADER, true); view.setUint32(8, chunks.length, true); view.setUint32(12, HEADER, true); view.setUint32(16, chunks.length * DIRECTORY, true); for (let i = 0; i < chunks.length; i += 1) { const chunk = chunks[i], at = HEADER + i * DIRECTORY, b = chunk.tile.bounds; view.setUint32(at, chunk.tile.id, true); view.setInt32(at + 4, fixed(b.minLat), true); view.setInt32(at + 8, fixed(b.minLon), true); view.setInt32(at + 12, fixed(b.maxLat), true); view.setInt32(at + 16, fixed(b.maxLon), true); view.setUint32(at + 20, offset, true); view.setUint32(at + 24, chunk.data.byteLength, true); view.setUint32(at + 28, chunk.rawBytes, true); view.setUint16(at + 32, compression === "gzip" ? 1 : 0); new Uint8Array(out, offset, chunk.data.byteLength).set(chunk.data); offset += chunk.data.byteLength; } return out; }

async function write(stream, value) { if (!stream.write(`${JSON.stringify(value)}\n`)) await new Promise((resolve) => stream.once("drain", resolve)); }
function memoryGuard(limitBytes, label, count) { if (count % 1_000 !== 0) return; const rss = process.memoryUsage().rss; observedPeakRss = Math.max(observedPeakRss, rss); if (rss > limitBytes) throw new Error(`Compilation exceeded the configured memory limit while ${label}. Use a smaller source extract; the compiler will not exceed --max-memory-mb.`); }
async function firstPass(file, roadFile, limitBytes) {
  const required = approximateIds(), keeperNodes = approximateIds(), stream = createWriteStream(roadFile), bounds = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity }; let ways = 0, entities = 0;
  for await (const entity of createOSMStream(file, { withTags: { node: false, way: ["highway", "oneway", "junction", "access", "vehicle", "motor_vehicle", "maxspeed"], relation: ["type", "restriction"] } })) {
    memoryGuard(limitBytes, "scanning PBF topology", ++entities);
    if (entity.type === "node") { bounds.minLat = Math.min(bounds.minLat, entity.lat); bounds.minLon = Math.min(bounds.minLon, entity.lon); bounds.maxLat = Math.max(bounds.maxLat, entity.lat); bounds.maxLon = Math.max(bounds.maxLon, entity.lon); continue; }
    if (entity.type === "relation" && entity.tags?.type === "restriction") { for (const member of entity.members ?? []) if (member.type === "node" || member.role === "via") keeperNodes.add(Number(member.ref)); continue; }
    if (entity.type !== "way") continue; const tags = entity.tags ?? {}, refs = entity.refs ?? [];
    if (!HIGHWAYS.has(tags.highway) || denied(tags) || refs.length < 2) continue;
    ways += 1; for (const id of refs) { if (required.has(id)) keeperNodes.add(id); else required.add(id); } keeperNodes.add(refs[0]); keeperNodes.add(refs[refs.length - 1]);
    await write(stream, { refs, forward: !reverseOnly(tags), reverse: !forwardOnly(tags), speed: speed(tags) });
  }
  await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  if (!Number.isFinite(bounds.minLat)) throw new Error("The input contains no OSM nodes.");
  return { required, keeperNodes, bounds, ways };
}
async function secondPass(file, required, limitBytes, databasePath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { throw new Error("The disk-backed compiler index requires Node.js 22.5 or newer."); }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768; CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat INTEGER NOT NULL, lon INTEGER NOT NULL) WITHOUT ROWID;");
  const insert = database.prepare("INSERT OR REPLACE INTO nodes (id, lat, lon) VALUES (?, ?, ?)");
  database.exec("BEGIN");
  let entities = 0, writes = 0;
  for await (const entity of createOSMStream(file, { withTags: false })) {
    memoryGuard(limitBytes, "resolving road-node coordinates", ++entities);
    if (entity.type !== "node" || !required.has(entity.id)) continue;
    insert.run(entity.id, fixed(entity.lat), fixed(entity.lon));
    if (++writes % 25_000 === 0) { database.exec("COMMIT; BEGIN"); }
  }
  database.exec("COMMIT");
  const lookup = database.prepare("SELECT lat, lon FROM nodes WHERE id = ?"), cache = new Map(), cacheLimit = 100_000;
  return { get(id) { const cached = cache.get(id); if (cached !== undefined) return cached || undefined; const row = lookup.get(id); const point = row ? { lat: row.lat / SCALE, lon: row.lon / SCALE } : null; cache.set(id, point); if (cache.size > cacheLimit) cache.delete(cache.keys().next().value); return point || undefined; }, close() { database.close(); } };
}
async function build(roadFile, coordinates, topology, tiles, bounds, tolerance, paddingKm, limitBytes) {
  const graphs = new Map(tiles.map((tile) => [tile.id, { tile, ids: new Map(), nodes: [], edges: [] }]));
  const add = (graph, id, point) => { let index = graph.ids.get(id); if (index === undefined) { index = graph.nodes.length; graph.ids.set(id, index); graph.nodes.push(point); } return index; };
  let routingEdges = 0;
  const addSegment = (ids, points, velocity) => { let distance = 0; for (let i = 1; i < points.length; i += 1) distance += metres(points[i - 1], points[i]); if (distance < .2) return; routingEdges += 1; const shape = simplifyShape(points, tolerance).slice(1, -1); for (const tile of tiles) { if (!inside(points[0], expand(tile.bounds, paddingKm))) continue; const graph = graphs.get(tile.id), from = add(graph, ids[0], points[0]), to = add(graph, ids[ids.length - 1], points[points.length - 1]); graph.edges.push({ from, to, distance, duration: distance / (velocity * (1000 / 3600)), shape }); } };
  const line = createInterface({ input: createReadStream(roadFile) });
  let ways = 0; for await (const raw of line) { memoryGuard(limitBytes, "building compact routing topology", ++ways); const way = JSON.parse(raw), points = way.refs.map((id) => coordinates.get(id)); if (points.some((point) => !point)) continue; const keep = (id, point, index, last) => index === 0 || index === last || topology.keeperNodes.has(id) || !tileFor(point, tiles); let start = 0;
    for (let i = 1; i < way.refs.length; i += 1) { if (!keep(way.refs[i], points[i], i, way.refs.length - 1)) continue; const ids = way.refs.slice(start, i + 1), segment = points.slice(start, i + 1); if (inside(segment[0], bounds)) { if (way.forward) addSegment(ids, segment, way.speed); if (way.reverse) addSegment(ids.slice().reverse(), segment.slice().reverse(), way.speed); } start = i; }
  }
  const result = [...graphs.values()].filter((graph) => graph.edges.length), routingNodeIds = new Set(); for (const graph of result) for (const id of graph.ids.keys()) routingNodeIds.add(id);
  return { graphs: result, routingEdges, routingNodes: routingNodeIds.size };
}

const input = inputArg(), outputOption = opt("--output"), profile = opt("--profile", "car"), compression = opt("--compression", "gzip"), tileSizeKm = Number(opt("--tile-size-km", "120")), paddingKm = Number(opt("--padding-km", "8")), tolerance = Number(opt("--shape-tolerance-m", "2")), requested = parseBounds(opt("--bbox"));
const maxMemoryMb = Number(opt("--max-memory-mb", "2048"));
if (!input || !outputOption || profile !== "car" || !["gzip", "none"].includes(compression) || !(tileSizeKm > 0) || !(paddingKm >= 0) || !(tolerance >= 0) || !(maxMemoryMb > 0 && maxMemoryMb <= 3072) || (opt("--bbox") && !requested)) { usage(); process.exitCode = 1; }
else if (!process.env.ROADGRAPH_HEAP_LIMITED) {
  const result = spawnSync(process.execPath, [`--max-old-space-size=${Math.floor(maxMemoryMb)}`, import.meta.filename, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ROADGRAPH_HEAP_LIMITED: "1" } });
  process.exitCode = result.status ?? 1;
}
else {
  const started = performance.now(), file = resolve(process.cwd(), input), output = resolve(process.cwd(), outputOption), source = await stat(file), before = process.memoryUsage().rss; observedPeakRss = before; if (!file.endsWith(".pbf")) throw new Error("roadgraph-compile accepts .osm.pbf files so compilation stays streaming at country scale.");
  const workspace = await mkdtemp(resolve(tmpdir(), "roadgraph-"));
  try {
    const limitBytes = maxMemoryMb * 1024 * 1024, first = await firstPass(file, resolve(workspace, "ways.ndjson"), limitBytes), relevantOsmNodes = first.required.count, bounds = requested ?? first.bounds, tiles = tilesFor(bounds, tileSizeKm), coordinates = await secondPass(file, first.required, limitBytes, resolve(workspace, "coordinates.sqlite")); first.required.clear();
    const built = await build(resolve(workspace, "ways.ndjson"), coordinates, first, tiles, bounds, tolerance, paddingKm, limitBytes); coordinates.close(); const chunks = [];
    for (const graph of built.graphs) { const raw = new Uint8Array(encodeEfr2(graph)), data = compression === "gzip" ? gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) : raw; chunks.push({ tile: graph.tile, data, rawBytes: raw.byteLength, graph }); }
    const bundle = assemble(chunks, compression); await mkdir(dirname(output), { recursive: true }); await writeFile(output, new Uint8Array(bundle));
    const nodesBefore = relevantOsmNodes, nodesAfter = built.routingNodes, edges = built.routingEdges, rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0), report = { formatVersion: 1, input: file, inputBytes: source.size, profile, compression: `${compression}-per-tile`, tileSizeKm, paddingKm, pbfPasses: 2, tiles: chunks.length, relevantOsmWays: first.ways, relevantOsmNodes, relevantOsmNodesExact: false, routingNodesBeforeSimplification: nodesBefore, routingNodesAfterSimplification: nodesAfter, reductionPercent: Number((100 * (1 - nodesAfter / Math.max(1, nodesBefore))).toFixed(2)), routingEdges: edges, bundleBytes: bundle.byteLength, compressionRatio: Number((bundle.byteLength / Math.max(1, rawBytes)).toFixed(4)), peakRssBytes: Math.max(observedPeakRss, process.memoryUsage().rss), elapsedMilliseconds: Math.round(performance.now() - started) };
    await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`); console.table({ input_mb: (source.size / 1e6).toFixed(1), pbf_passes: report.pbfPasses, relevant_ways: first.ways.toLocaleString(), relevant_nodes: first.required.count.toLocaleString(), routing_nodes: nodesAfter.toLocaleString(), reduction_percent: report.reductionPercent, routing_edges: edges.toLocaleString(), efrb_mb: (bundle.byteLength / 1e6).toFixed(1), peak_rss_mb: (report.peakRssBytes / 1e6).toFixed(1), elapsed_seconds: (report.elapsedMilliseconds / 1000).toFixed(1) });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
