#!/usr/bin/env node
/* Generic, bounded-pass OSM PBF -> EFRB compiler.  PBF is scanned twice: once
 * for usable ways, turn-restriction relations and topology, and once for the
 * coordinates of referenced nodes.  Every tag decision is delegated to a
 * routing profile, so nothing here is specific to a country or an extract. */
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, mkdtemp, open as nodeOpen, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, constants } from "node:zlib";
import { createOSMStream } from "osm-pbf-parser-node";
import { spawnSync } from "node:child_process";

const EFR2_MAGIC = 0x32524645, EFRB_MAGIC = 0x42524645, SCALE = 10_000_000, HEADER = 32, DIRECTORY = 40;
let observedPeakRss = 0;

async function loadProfile(name) {
  try {
    const { getRoutingProfile } = await import(new URL("../dist/index.js", import.meta.url).href);
    return getRoutingProfile(name);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw new Error("roadgraph-compile needs the package build. Run `npm run build` first.");
    throw error;
  }
}

function usage() { console.error("Usage: roadgraph-compile input.osm.pbf --output region.efrb [--profile car] [--tile-size-km 120] [--padding-km 8] [--compression gzip|none] [--shape-tolerance-m 2] [--max-memory-mb 2048] [--bbox minLon,minLat,maxLon,maxLat]"); }
function opt(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
function inputArg() { const values = process.argv.slice(2); for (let i = 0; i < values.length; i += 1) { if (values[i].startsWith("--")) { i += 1; continue; } return values[i]; } return undefined; }
function parseBounds(value) { const p = value?.split(",").map(Number); return p?.length === 4 && p.every(Number.isFinite) && p[0] < p[2] && p[1] < p[3] ? { minLon: p[0], minLat: p[1], maxLon: p[2], maxLat: p[3] } : undefined; }
function fixed(value) { return Math.round(value * SCALE); }
function inside(point, bounds) { return point.lat >= bounds.minLat && point.lat <= bounds.maxLat && point.lon >= bounds.minLon && point.lon <= bounds.maxLon; }
function metres(a, b) { const r = Math.PI / 180, dy = (b.lat - a.lat) * r, dx = (b.lon - a.lon) * r, h = Math.sin(dy / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dx / 2) ** 2; return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)); }
function pointDeviation(p, a, b) { const latitude = (p.lat + a.lat + b.lat) * Math.PI / 540, x = (p.lon - a.lon) * 111_320 * Math.cos(latitude), y = (p.lat - a.lat) * 110_574, ex = (b.lon - a.lon) * 111_320 * Math.cos(latitude), ey = (b.lat - a.lat) * 110_574, l = ex * ex + ey * ey; if (!l) return Math.hypot(x, y); const t = Math.max(0, Math.min(1, (x * ex + y * ey) / l)); return Math.hypot(x - t * ex, y - t * ey); }
function simplifyShape(points, tolerance) { if (points.length < 3 || !tolerance) return points; const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1; const visit = (start, end) => { let greatest = tolerance, at = -1; for (let i = start + 1; i < end; i += 1) { const d = pointDeviation(points[i], points[start], points[end]); if (d > greatest) { greatest = d; at = i; } } if (at >= 0) { keep[at] = 1; visit(start, at); visit(at, end); } }; visit(0, points.length - 1); return points.filter((_, index) => keep[index]); }

// Sparse paged stores avoid a JavaScript Map entry for every OSM node.
// Fixed-size Bloom filters keep country-wide OSM IDs bounded in memory. False
// positives are safe here: they only preserve an extra node/coordinate.
function approximateIds() { const bitCount = 1 << 29, mask = bitCount - 1; let words = new Uint32Array(bitCount >>> 5), setBits = 0; const slot = (id) => (Math.imul(id >>> 0, 0x9e3779b1) >>> 0) & mask; return { add(id) { const value = slot(id), word = value >>> 5, bit = 1 << (value & 31); if (!(words[word] & bit)) { words[word] |= bit; setBits += 1; } }, has(id) { const value = slot(id); return Boolean(words[value >>> 5] & (1 << (value & 31))); }, clear() { words = new Uint32Array(0); }, get count() { return Math.round(-bitCount * Math.log(Math.max(Number.EPSILON, 1 - setBits / bitCount))); } }; }

/**
 * Lays the region out as a regular grid: rows of equal latitude height, each
 * with its own longitude step so tiles stay roughly square away from the
 * equator. The returned grid lets a point be mapped to its tile arithmetically
 * instead of by scanning, which keeps build time flat as tile counts grow.
 */
function tilesFor(bounds, km) {
  const latStep = km / 110.574, tiles = [], rows = [];
  for (let minLat = bounds.minLat, row = 0; minLat < bounds.maxLat; minLat += latStep, row += 1) {
    const maxLat = Math.min(bounds.maxLat, minLat + latStep), lonStep = km / (111.32 * Math.max(.05, Math.cos(((minLat + maxLat) / 2) * Math.PI / 180))), inRow = [];
    for (let minLon = bounds.minLon, col = 0; minLon < bounds.maxLon; minLon += lonStep, col += 1) { const tile = { id: tiles.length, name: `tile-${row}-${col}`, bounds: { minLat, minLon, maxLat, maxLon: Math.min(bounds.maxLon, minLon + lonStep) } }; tiles.push(tile); inRow.push(tile); }
    rows.push({ lonStep, tiles: inRow });
  }
  return { tiles, grid: { origin: bounds, latStep, rows } };
}
function tileFor(point, grid) { const row = grid.rows[Math.floor((point.lat - grid.origin.minLat) / grid.latStep)]; if (!row) return undefined; const tile = row.tiles[Math.floor((point.lon - grid.origin.minLon) / row.lonStep)]; return tile && inside(point, tile.bounds) ? tile : undefined; }
/** Every tile whose padded bounds can contain the point: its own, plus `ring` neighbours. */
function tilesNear(point, grid, ring) {
  const row = Math.floor((point.lat - grid.origin.minLat) / grid.latStep), found = [];
  for (let r = row - ring; r <= row + ring; r += 1) {
    const bucket = grid.rows[r];
    if (!bucket) continue;
    const col = Math.floor((point.lon - grid.origin.minLon) / bucket.lonStep);
    for (let c = col - ring; c <= col + ring; c += 1) if (bucket.tiles[c]) found.push(bucket.tiles[c]);
  }
  return found;
}
function expand(bounds, km) { const latitude = km / 110.574, longitude = km / (111.32 * Math.max(.05, Math.cos(((bounds.minLat + bounds.maxLat) / 2) * Math.PI / 180))); return { minLat: bounds.minLat - latitude, maxLat: bounds.maxLat + latitude, minLon: bounds.minLon - longitude, maxLon: bounds.maxLon + longitude }; }
function scaleFor(values) { let greatest = 0; for (const value of values) greatest = Math.max(greatest, value); return Math.max(1, Math.ceil(greatest / 65535)); }

/** Writes an EFR2 chunk: v3 when the tile has geometry only, v4 once it carries banned turns. */
function encodeEfr2(graph) {
  const nodes = graph.nodes.length, edges = graph.edges.length, distanceScale = scaleFor(graph.edges.map((edge) => edge.distance)), durationScale = scaleFor(graph.edges.map((edge) => edge.duration));
  const offsets = new Uint32Array(nodes + 1); for (const edge of graph.edges) offsets[edge.from + 1] += 1; for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const order = offsets.slice(), targets = new Uint32Array(edges), distances = new Uint16Array(edges), durations = new Uint16Array(edges), shapes = new Array(edges), placement = new Uint32Array(edges);
  for (let i = 0; i < edges; i += 1) { const edge = graph.edges[i], index = order[edge.from]++; placement[i] = index; targets[index] = edge.to; distances[index] = Math.round(edge.distance / distanceScale); durations[index] = Math.round(edge.duration / durationScale); shapes[index] = edge.shape; }
  // Restrictions are collected against pre-grouping edge positions, so they
  // follow each edge into the CSR layout through the same permutation.
  const banned = [...new Set((graph.restrictions ?? []).map(([from, to]) => `${placement[from]}:${placement[to]}`))].map((pair) => pair.split(":").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const shapeOffsets = new Uint32Array(edges + 1); for (let i = 0; i < edges; i += 1) shapeOffsets[i + 1] = shapeOffsets[i] + shapes[i].length;
  const points = shapeOffsets[edges], version = banned.length ? 4 : 3;
  const bytes = 40 + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (edges + 1) * 4 + points * 8 + banned.length * 8, buffer = new ArrayBuffer(bytes), view = new DataView(buffer);
  view.setUint32(0, EFR2_MAGIC, true); view.setUint16(4, version, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true); view.setUint32(16, SCALE, true); view.setUint16(20, distanceScale, true); view.setUint16(22, durationScale, true); view.setUint32(24, points, true); view.setUint32(28, banned.length, true);
  let offset = 40; const latitudes = new Int32Array(buffer, offset, nodes); offset += latitudes.byteLength; const longitudes = new Int32Array(buffer, offset, nodes); offset += longitudes.byteLength; for (let i = 0; i < nodes; i += 1) { latitudes[i] = fixed(graph.nodes[i].lat); longitudes[i] = fixed(graph.nodes[i].lon); }
  new Uint32Array(buffer, offset, nodes + 1).set(offsets); offset += (nodes + 1) * 4; new Uint32Array(buffer, offset, edges).set(targets); offset += edges * 4; new Uint16Array(buffer, offset, edges).set(distances); offset += edges * 2; new Uint16Array(buffer, offset, edges).set(durations); offset += edges * 2; new Uint32Array(buffer, offset, edges + 1).set(shapeOffsets); offset += (edges + 1) * 4;
  const shapeLatitudes = new Int32Array(buffer, offset, points); offset += points * 4; const shapeLongitudes = new Int32Array(buffer, offset, points); offset += points * 4; let point = 0; for (const shape of shapes) for (const coordinate of shape) { shapeLatitudes[point] = fixed(coordinate.lat); shapeLongitudes[point++] = fixed(coordinate.lon); }
  if (banned.length) { new Uint32Array(buffer, offset, banned.length).set(banned.map((pair) => pair[0])); offset += banned.length * 4; new Uint32Array(buffer, offset, banned.length).set(banned.map((pair) => pair[1])); }
  return buffer;
}
function assemble(chunks, compression) { let offset = HEADER + chunks.length * DIRECTORY, size = offset + chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0), out = new ArrayBuffer(size), view = new DataView(out); view.setUint32(0, EFRB_MAGIC, true); view.setUint16(4, 1, true); view.setUint16(6, HEADER, true); view.setUint32(8, chunks.length, true); view.setUint32(12, HEADER, true); view.setUint32(16, chunks.length * DIRECTORY, true); for (let i = 0; i < chunks.length; i += 1) { const chunk = chunks[i], at = HEADER + i * DIRECTORY, b = chunk.tile.bounds; view.setUint32(at, chunk.tile.id, true); view.setInt32(at + 4, fixed(b.minLat), true); view.setInt32(at + 8, fixed(b.minLon), true); view.setInt32(at + 12, fixed(b.maxLat), true); view.setInt32(at + 16, fixed(b.maxLon), true); view.setUint32(at + 20, offset, true); view.setUint32(at + 24, chunk.data.byteLength, true); view.setUint32(at + 28, chunk.rawBytes, true); view.setUint16(at + 32, compression === "gzip" ? 1 : 0, true); new Uint8Array(out, offset, chunk.data.byteLength).set(chunk.data); offset += chunk.data.byteLength; } return out; }

/**
 * Reads the bundle back with the package's own reader before reporting
 * success. The directory is written here by hand, so a header field the
 * runtime cannot parse has to fail the compile rather than a user's first route.
 */
async function verifyBundle(output, expectedTiles) {
  const { openRoadGraphBundle } = await import(new URL("../dist/index.js", import.meta.url).href);
  const handle = await nodeOpen(output, "r");
  try {
    const bundle = await openRoadGraphBundle(output, async (_url, init) => {
      const header = new Headers(init?.headers);
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(header.get("Range") ?? "") ?? [];
      const body = new Uint8Array(Number(end) - Number(start) + 1);
      await handle.read(body, 0, body.byteLength, Number(start));
      return new Response(body, { status: 206 });
    });
    if (bundle.tiles.length !== expectedTiles) throw new Error(`The written bundle lists ${bundle.tiles.length} tiles but ${expectedTiles} were encoded.`);
  } finally { await handle.close(); }
}

async function write(stream, value) { if (!stream.write(`${JSON.stringify(value)}\n`)) await new Promise((resolve) => stream.once("drain", resolve)); }
function memoryGuard(limitBytes, label, count) { if (count % 1_000 !== 0) return; const rss = process.memoryUsage().rss; observedPeakRss = Math.max(observedPeakRss, rss); if (rss > limitBytes) throw new Error(`Compilation exceeded the configured memory limit while ${label}. Use a smaller source extract; the compiler will not exceed --max-memory-mb.`); }

/**
 * Pass 1. Reads routable ways through the profile and collects the turn
 * restrictions that apply to it. Restriction members are kept as OSM ids and
 * resolved to edges later, because the relation may be read before its ways.
 */
async function firstPass(file, roadFile, limitBytes, profile) {
  const required = approximateIds(), keeperNodes = approximateIds(), stream = createWriteStream(roadFile), bounds = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  const restrictions = [], restrictionWays = new Set();
  let ways = 0, entities = 0, skippedRestrictions = 0;
  for await (const entity of createOSMStream(file, { withTags: { node: false, way: [...profile.wayTagKeys], relation: [...profile.relationTagKeys] } })) {
    memoryGuard(limitBytes, "scanning PBF topology", ++entities);
    if (entity.type === "node") { bounds.minLat = Math.min(bounds.minLat, entity.lat); bounds.minLon = Math.min(bounds.minLon, entity.lon); bounds.maxLat = Math.max(bounds.maxLat, entity.lat); bounds.maxLon = Math.max(bounds.maxLon, entity.lon); continue; }
    if (entity.type === "relation") {
      const parsed = profile.evaluateTurnRestriction(entity.tags ?? {});
      if (!parsed) continue;
      const members = entity.members ?? [];
      const from = members.find((member) => member.role === "from" && member.type === "way");
      const to = members.find((member) => member.role === "to" && member.type === "way");
      const via = members.filter((member) => member.role === "via");
      // `via` may be a way for restrictions spanning a whole link road. Those
      // need an edge-path ban rather than a single banned pair, so they are
      // counted and skipped instead of being approximated.
      if (!from || !to || via.length !== 1 || via[0].type !== "node") { skippedRestrictions += 1; continue; }
      const viaNode = Number(via[0].ref);
      keeperNodes.add(viaNode);
      restrictionWays.add(Number(from.ref)); restrictionWays.add(Number(to.ref));
      restrictions.push({ kind: parsed.kind, from: Number(from.ref), to: Number(to.ref), via: viaNode });
      continue;
    }
    if (entity.type !== "way") continue;
    const tags = entity.tags ?? {}, refs = entity.refs ?? [];
    if (refs.length < 2) continue;
    const traversal = profile.evaluateWay(tags);
    if (!traversal) continue;
    ways += 1;
    for (const id of refs) { if (required.has(id)) keeperNodes.add(id); else required.add(id); }
    keeperNodes.add(refs[0]); keeperNodes.add(refs[refs.length - 1]);
    await write(stream, { id: entity.id, refs, forward: traversal.forward, reverse: traversal.backward, forwardSpeed: traversal.forwardSpeedKph, reverseSpeed: traversal.backwardSpeedKph });
  }
  await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  if (!Number.isFinite(bounds.minLat)) throw new Error("The input contains no OSM nodes.");
  // Drop restrictions whose ways were filtered out by the profile; they can
  // never produce a banned pair and would only cost memory downstream.
  const usable = restrictions.filter((restriction) => required.has(restriction.via));
  return { required, keeperNodes, bounds, ways, restrictions: usable, restrictionWays, skippedRestrictions };
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
  return { storedNodes: writes, get(id) { const cached = cache.get(id); if (cached !== undefined) return cached || undefined; const row = lookup.get(id); const point = row ? { lat: row.lat / SCALE, lon: row.lon / SCALE } : null; cache.set(id, point); if (cache.size > cacheLimit) cache.delete(cache.keys().next().value); return point || undefined; }, close() { database.close(); } };
}

/**
 * Resolves one tile's OSM turn restrictions into banned (fromEdge, toEdge)
 * pairs over that tile's own edge indices. `only_*` relations are expanded
 * here into the equivalent bans on every other way out of the via node, so the
 * runtime never has to know the difference.
 */
function resolveRestrictions(graph, restrictions) {
  if (!graph.wayEdges.size) return [];
  const outgoing = new Map();
  for (let index = 0; index < graph.edges.length; index += 1) {
    const list = outgoing.get(graph.edges[index].from);
    if (list) list.push(index); else outgoing.set(graph.edges[index].from, [index]);
  }
  const banned = [];
  for (const restriction of restrictions) {
    const via = graph.ids.get(restriction.via);
    if (via === undefined) continue;
    const fromEdges = (graph.wayEdges.get(restriction.from) ?? []).filter((index) => graph.edges[index].to === via);
    const toEdges = (graph.wayEdges.get(restriction.to) ?? []).filter((index) => graph.edges[index].from === via);
    if (!fromEdges.length || !toEdges.length) continue;
    if (restriction.kind === "no") { for (const from of fromEdges) for (const to of toEdges) banned.push([from, to]); continue; }
    const mandatory = new Set(toEdges);
    for (const from of fromEdges) for (const to of outgoing.get(via) ?? []) if (!mandatory.has(to)) banned.push([from, to]);
  }
  return banned;
}

async function build(roadFile, coordinates, topology, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes) {
  const { tiles, grid } = layout, ring = Math.max(1, Math.ceil(paddingKm / tileSizeKm));
  const graphs = new Map(tiles.map((tile) => [tile.id, { tile, ids: new Map(), nodes: [], edges: [], wayEdges: new Map() }]));
  const add = (graph, id, point) => { let index = graph.ids.get(id); if (index === undefined) { index = graph.nodes.length; graph.ids.set(id, index); graph.nodes.push(point); } return index; };
  let routingEdges = 0;
  const addSegment = (wayId, ids, points, velocity) => {
    let distance = 0; for (let i = 1; i < points.length; i += 1) distance += metres(points[i - 1], points[i]);
    if (distance < .2) return;
    routingEdges += 1;
    const shape = simplifyShape(points, tolerance).slice(1, -1), tracked = topology.restrictionWays.has(wayId);
    for (const tile of tilesNear(points[0], grid, ring)) {
      if (!inside(points[0], expand(tile.bounds, paddingKm))) continue;
      const graph = graphs.get(tile.id), from = add(graph, ids[0], points[0]), to = add(graph, ids[ids.length - 1], points[points.length - 1]);
      const index = graph.edges.length;
      graph.edges.push({ from, to, distance, duration: distance / (velocity * (1000 / 3600)), shape });
      // Only ways named by a restriction need a reverse index, which keeps the
      // lookup table proportional to the restrictions rather than to the graph.
      if (tracked) { const list = graph.wayEdges.get(wayId); if (list) list.push(index); else graph.wayEdges.set(wayId, [index]); }
    }
  };
  const line = createInterface({ input: createReadStream(roadFile) });
  let ways = 0;
  for await (const raw of line) {
    memoryGuard(limitBytes, "building compact routing topology", ++ways);
    const way = JSON.parse(raw), points = way.refs.map((id) => coordinates.get(id));
    if (points.some((point) => !point)) continue;
    const keep = (id, point, index, last) => index === 0 || index === last || topology.keeperNodes.has(id) || !tileFor(point, grid);
    let start = 0;
    for (let i = 1; i < way.refs.length; i += 1) {
      if (!keep(way.refs[i], points[i], i, way.refs.length - 1)) continue;
      const ids = way.refs.slice(start, i + 1), segment = points.slice(start, i + 1);
      if (inside(segment[0], bounds)) {
        if (way.forward) addSegment(way.id, ids, segment, way.forwardSpeed);
        if (way.reverse) addSegment(way.id, ids.slice().reverse(), segment.slice().reverse(), way.reverseSpeed);
      }
      start = i;
    }
  }
  let bannedTurns = 0;
  for (const graph of graphs.values()) { graph.restrictions = resolveRestrictions(graph, topology.restrictions); bannedTurns += graph.restrictions.length; }
  const result = [...graphs.values()].filter((graph) => graph.edges.length), routingNodeIds = new Set();
  for (const graph of result) for (const id of graph.ids.keys()) routingNodeIds.add(id);
  return { graphs: result, routingEdges, routingNodes: routingNodeIds.size, bannedTurns };
}

const input = inputArg(), outputOption = opt("--output"), profileName = opt("--profile", "car"), compression = opt("--compression", "gzip"), tileSizeKm = Number(opt("--tile-size-km", "120")), paddingKm = Number(opt("--padding-km", "8")), tolerance = Number(opt("--shape-tolerance-m", "2")), requested = parseBounds(opt("--bbox"));
const maxMemoryMb = Number(opt("--max-memory-mb", "2048"));
if (!input || !outputOption || !["gzip", "none"].includes(compression) || !(tileSizeKm > 0) || !(paddingKm >= 0) || !(tolerance >= 0) || !(maxMemoryMb > 0 && maxMemoryMb <= 3072) || (opt("--bbox") && !requested)) { usage(); process.exitCode = 1; }
else if (!process.env.ROADGRAPH_HEAP_LIMITED) {
  const result = spawnSync(process.execPath, [`--max-old-space-size=${Math.floor(maxMemoryMb)}`, import.meta.filename, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ROADGRAPH_HEAP_LIMITED: "1" } });
  process.exitCode = result.status ?? 1;
}
else {
  const profile = await loadProfile(profileName);
  const started = performance.now(), file = resolve(process.cwd(), input), output = resolve(process.cwd(), outputOption), source = await stat(file); observedPeakRss = process.memoryUsage().rss;
  if (!file.endsWith(".pbf")) throw new Error("roadgraph-compile accepts .osm.pbf files so compilation stays streaming at country scale.");
  const workspace = await mkdtemp(resolve(tmpdir(), "roadgraph-"));
  try {
    const limitBytes = maxMemoryMb * 1024 * 1024, first = await firstPass(file, resolve(workspace, "ways.ndjson"), limitBytes, profile), relevantOsmNodes = first.required.count, bounds = requested ?? first.bounds, layout = tilesFor(bounds, tileSizeKm), coordinates = await secondPass(file, first.required, limitBytes, resolve(workspace, "coordinates.sqlite")); first.required.clear();
    const built = await build(resolve(workspace, "ways.ndjson"), coordinates, first, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes); const storedNodes = coordinates.storedNodes; coordinates.close(); const chunks = [];
    for (const graph of built.graphs) { const raw = new Uint8Array(encodeEfr2(graph)), data = compression === "gzip" ? gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) : raw; chunks.push({ tile: graph.tile, data, rawBytes: raw.byteLength }); }
    const bundle = assemble(chunks, compression); await mkdir(dirname(output), { recursive: true }); await writeFile(output, new Uint8Array(bundle));
    await verifyBundle(output, chunks.length);
    const nodesBefore = storedNodes, nodesAfter = built.routingNodes, edges = built.routingEdges, rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
    const report = { formatVersion: 1, input: file, inputBytes: source.size, profile: profile.name, compression: `${compression}-per-tile`, tileSizeKm, paddingKm, pbfPasses: 2, tiles: chunks.length, relevantOsmWays: first.ways, relevantOsmNodes, relevantOsmNodesExact: false, routingNodesBeforeSimplification: nodesBefore, routingNodesAfterSimplification: nodesAfter, reductionPercent: Number((100 * (1 - nodesAfter / Math.max(1, nodesBefore))).toFixed(2)), routingEdges: edges, turnRestrictionsRead: first.restrictions.length, turnRestrictionsSkipped: first.skippedRestrictions, bannedTurnPairs: built.bannedTurns, uncompressedGraphBytes: rawBytes, bundleBytes: bundle.byteLength, compressionRatio: Number((bundle.byteLength / Math.max(1, rawBytes)).toFixed(4)), peakRssBytes: Math.max(observedPeakRss, process.memoryUsage().rss), elapsedMilliseconds: Math.round(performance.now() - started) };
    await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.table({ input_mb: (source.size / 1e6).toFixed(1), pbf_passes: report.pbfPasses, relevant_ways: first.ways.toLocaleString(), relevant_nodes: relevantOsmNodes.toLocaleString(), nodes_before: nodesBefore.toLocaleString(), nodes_after: nodesAfter.toLocaleString(), reduction_percent: report.reductionPercent, routing_edges: edges.toLocaleString(), turn_restrictions: first.restrictions.length.toLocaleString(), banned_turn_pairs: built.bannedTurns.toLocaleString(), tiles: chunks.length, raw_mb: (rawBytes / 1e6).toFixed(1), efrb_mb: (bundle.byteLength / 1e6).toFixed(1), compression_ratio: report.compressionRatio, peak_rss_mb: (report.peakRssBytes / 1e6).toFixed(1), elapsed_seconds: (report.elapsedMilliseconds / 1000).toFixed(1) });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
