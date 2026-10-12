#!/usr/bin/env node
/* Generic, bounded-pass OSM PBF -> EFRB compiler.  PBF is scanned twice: once
 * for usable ways, turn-restriction relations and topology, and once for the
 * coordinates of referenced nodes.  Every tag decision is delegated to a
 * routing profile, so nothing here is specific to a country or an extract. */
import { createWriteStream, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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

function usage() { console.error("Usage: roadgraph-compile input.osm.pbf --output region.efrb [--profile car] [--tile-size-km 120] [--padding-km 2] [--compression gzip|none] [--shape-tolerance-m 2] [--max-memory-mb 2048] [--bbox minLon,minLat,maxLon,maxLat]"); }
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
/** A growable typed array. Tile graphs hold millions of entries, and one JS
 *  object per edge costs an order of magnitude more memory than four slots. */
class Column {
  constructor(Type, capacity = 1024) { this.Type = Type; this.values = new Type(capacity); this.length = 0; }
  push(value) {
    if (this.length === this.values.length) { const grown = new this.Type(this.values.length * 2); grown.set(this.values); this.values = grown; }
    this.values[this.length++] = value;
    return this.length - 1;
  }
  at(index) { return this.values[index]; }
  view() { return this.values.subarray(0, this.length); }
}

function createTileGraph(tile) {
  return {
    tile,
    ids: new Map(),
    nodeLat: new Column(Int32Array), nodeLon: new Column(Int32Array),
    edgeFrom: new Column(Uint32Array), edgeTo: new Column(Uint32Array),
    edgeDistance: new Column(Float64Array), edgeDuration: new Column(Float64Array),
    edgeWay: new Column(Float64Array), edgeShapeStart: new Column(Uint32Array),
    shapeLat: new Column(Int32Array), shapeLon: new Column(Int32Array),
    wayEdges: new Map(), restrictions: [], runs: [],
  };
}

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
/**
 * Orders a tile's edges by source node and hands the result to the library
 * encoder, so the compiler and the runtime cannot drift apart on the layout.
 */
function encodeEfr2(graph, encodeCompactGraph) {
  const nodes = graph.nodeLat.length, edges = graph.edgeFrom.length;
  const distances = graph.edgeDistance.view(), durations = graph.edgeDuration.view();
  const distanceScale = scaleFor(distances), durationScale = scaleFor(durations);
  const offsets = new Uint32Array(nodes + 1);
  for (let i = 0; i < edges; i += 1) offsets[graph.edgeFrom.at(i) + 1] += 1;
  for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const order = offsets.slice(), targets = new Uint32Array(edges), placement = new Uint32Array(edges);
  const packedDistances = new Uint16Array(edges), packedDurations = new Uint16Array(edges);
  const shapeOffsets = new Uint32Array(edges + 1);
  for (let i = 0; i < edges; i += 1) {
    const index = order[graph.edgeFrom.at(i)]++;
    placement[i] = index;
    targets[index] = graph.edgeTo.at(i);
    packedDistances[index] = Math.round(distances[i] / distanceScale);
    packedDurations[index] = Math.round(durations[i] / durationScale);
  }
  // Shape runs are stored per source edge, so copy them into CSR order.
  const shapeStart = graph.edgeShapeStart.view(), totalPoints = graph.shapeLat.length;
  const lengthOf = (i) => (i + 1 < edges ? shapeStart[i + 1] : totalPoints) - shapeStart[i];
  const sourceOf = new Uint32Array(edges);
  for (let i = 0; i < edges; i += 1) sourceOf[placement[i]] = i;
  for (let index = 0; index < edges; index += 1) shapeOffsets[index + 1] = shapeOffsets[index] + lengthOf(sourceOf[index]);
  const shapeLat = new Int32Array(totalPoints), shapeLon = new Int32Array(totalPoints);
  const sourceLat = graph.shapeLat.view(), sourceLon = graph.shapeLon.view();
  for (let index = 0; index < edges; index += 1) {
    const source = sourceOf[index], from = shapeStart[source], count = lengthOf(source);
    for (let point = 0; point < count; point += 1) { shapeLat[shapeOffsets[index] + point] = sourceLat[from + point]; shapeLon[shapeOffsets[index] + point] = sourceLon[from + point]; }
  }
  // Restrictions are collected against pre-grouping edge positions, so they
  // follow each edge into the CSR layout through the same permutation.
  const banned = [...new Set(graph.restrictions.map(([from, to]) => `${placement[from]}:${placement[to]}`))].map((pair) => pair.split(":").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const runs = [...new Set(graph.runs.map((run) => run.map((edge) => placement[edge]).join(",")))].map((run) => run.split(",").map(Number)).filter((run) => run.length >= 3).sort((a, b) => a[0] - b[0] || a.length - b.length || a[1] - b[1]);
  const runOffsets = new Uint32Array(runs.length + 1);
  for (let i = 0; i < runs.length; i += 1) runOffsets[i + 1] = runOffsets[i] + runs[i].length;
  return encodeCompactGraph({
    nodeLatitudes: graph.nodeLat.view(), nodeLongitudes: graph.nodeLon.view(),
    edgeOffsets: offsets, edgeTargets: targets,
    edgeDistancesMeters: packedDistances, edgeDurationsSeconds: packedDurations,
    coordinateScale: SCALE, edgeDistanceScale: distanceScale, edgeDurationScale: durationScale,
    edgeShapeOffsets: shapeOffsets, edgeShapeLatitudes: shapeLat, edgeShapeLongitudes: shapeLon,
    ...(banned.length ? { turnRestrictionFromEdges: Uint32Array.from(banned, (pair) => pair[0]), turnRestrictionToEdges: Uint32Array.from(banned, (pair) => pair[1]) } : {}),
    ...(runs.length ? { turnRestrictionSequenceOffsets: runOffsets, turnRestrictionSequenceEdges: Uint32Array.from(runs.flat()) } : {}),
  });
}

/** Writes the fixed-size directory, then streams each chunk straight from the
 *  spill file. Neither the chunk list nor the finished bundle is ever held in
 *  memory, so output size no longer bounds how large a region can be built. */
async function writeBundle(output, chunks, compression, spillPath) {
  const directoryBytes = chunks.length * DIRECTORY;
  const head = Buffer.alloc(HEADER + directoryBytes);
  head.writeUInt32LE(EFRB_MAGIC, 0); head.writeUInt16LE(1, 4); head.writeUInt16LE(HEADER, 6);
  head.writeUInt32LE(chunks.length, 8); head.writeUInt32LE(HEADER, 12); head.writeUInt32LE(directoryBytes, 16);
  let offset = HEADER + directoryBytes;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i], at = HEADER + i * DIRECTORY, b = chunk.tile.bounds;
    head.writeUInt32LE(chunk.tile.id, at);
    head.writeInt32LE(fixed(b.minLat), at + 4); head.writeInt32LE(fixed(b.minLon), at + 8);
    head.writeInt32LE(fixed(b.maxLat), at + 12); head.writeInt32LE(fixed(b.maxLon), at + 16);
    head.writeUInt32LE(offset, at + 20); head.writeUInt32LE(chunk.byteLength, at + 24);
    head.writeUInt32LE(chunk.rawBytes, at + 28); head.writeUInt16LE(compression === "gzip" ? 1 : 0, at + 32);
    offset += chunk.byteLength;
  }
  await mkdir(dirname(output), { recursive: true });
  const out = createWriteStream(output);
  await new Promise((resolve, reject) => { out.on("error", reject); out.write(head, (error) => error ? reject(error) : resolve()); });
  await pipeline(createReadStream(spillPath), out, { end: true });
  return offset;
}


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
      if (!from || !to || !via.length) { skippedRestrictions += 1; continue; }
      restrictionWays.add(Number(from.ref)); restrictionWays.add(Number(to.ref));
      if (via.length === 1 && via[0].type === "node") {
        const viaNode = Number(via[0].ref);
        keeperNodes.add(viaNode);
        restrictions.push({ kind: parsed.kind, from: Number(from.ref), to: Number(to.ref), via: viaNode });
        continue;
      }
      // A `via` way names a whole link road, so the ban covers a run of edges
      // rather than one turn. Its ends must stay in the topology for the run
      // to be found again at build time.
      if (!via.every((member) => member.type === "way")) { skippedRestrictions += 1; continue; }
      const viaWays = via.map((member) => Number(member.ref));
      for (const way of viaWays) restrictionWays.add(way);
      restrictions.push({ kind: parsed.kind, from: Number(from.ref), to: Number(to.ref), viaWays });
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
  const usable = restrictions.filter((restriction) => restriction.viaWays || required.has(restriction.via));
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
const MAX_VIA_EDGES = 4, MAX_VIA_CHAINS = 8;

/** Every simple run of edges leaving `start` that stays on the restriction's via ways. */
function viaChains(graph, outgoing, start, viaWays) {
  const chains = [], used = new Set();
  const walk = (node, chain) => {
    if (chain.length >= MAX_VIA_EDGES || chains.length >= MAX_VIA_CHAINS) return;
    for (const edge of outgoing.get(node) ?? []) {
      if (!viaWays.has(graph.edgeWay.at(edge)) || used.has(edge)) continue;
      const extended = [...chain, edge];
      chains.push(extended);
      used.add(edge);
      walk(graph.edgeTo.at(edge), extended);
      used.delete(edge);
    }
  };
  walk(start, []);
  return chains;
}

/**
 * Resolves one tile's OSM turn restrictions. A `via` node becomes a banned
 * (fromEdge, toEdge) pair; a `via` way becomes a banned run covering the whole
 * link. `only_*` relations are expanded here into bans on every other way out,
 * so the runtime never has to know the difference.
 */
function resolveRestrictions(graph, restrictions) {
  if (!graph.wayEdges.size) return { banned: [], runs: [] };
  const outgoing = new Map();
  for (let index = 0; index < graph.edgeFrom.length; index += 1) {
    const list = outgoing.get(graph.edgeFrom.at(index));
    if (list) list.push(index); else outgoing.set(graph.edgeFrom.at(index), [index]);
  }
  const banned = [], runs = [];
  for (const restriction of restrictions) {
    const fromAll = graph.wayEdges.get(restriction.from) ?? [];
    const toAll = graph.wayEdges.get(restriction.to) ?? [];
    if (!fromAll.length || !toAll.length) continue;

    if (!restriction.viaWays) {
      const via = graph.ids.get(restriction.via);
      if (via === undefined) continue;
      const fromEdges = fromAll.filter((index) => graph.edgeTo.at(index) === via);
      const toEdges = toAll.filter((index) => graph.edgeFrom.at(index) === via);
      if (!fromEdges.length || !toEdges.length) continue;
      if (restriction.kind === "no") { for (const from of fromEdges) for (const to of toEdges) banned.push([from, to]); continue; }
      const mandatory = new Set(toEdges);
      for (const from of fromEdges) for (const to of outgoing.get(via) ?? []) if (!mandatory.has(to)) banned.push([from, to]);
      continue;
    }

    const viaWays = new Set(restriction.viaWays);
    for (const from of fromAll) {
      for (const chain of viaChains(graph, outgoing, graph.edgeTo.at(from), viaWays)) {
        if (chain.includes(from)) continue;
        const end = graph.edgeTo.at(chain[chain.length - 1]);
        const toEdges = toAll.filter((index) => graph.edgeFrom.at(index) === end && !chain.includes(index));
        if (!toEdges.length) continue;
        if (restriction.kind === "no") { for (const to of toEdges) runs.push([from, ...chain, to]); continue; }
        const mandatory = new Set(toEdges);
        for (const to of outgoing.get(end) ?? []) if (!mandatory.has(to) && !chain.includes(to)) runs.push([from, ...chain, to]);
      }
    }
  }
  return { banned, runs };
}

async function build(roadFile, coordinates, topology, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes) {
  const { tiles, grid } = layout, ring = Math.max(1, Math.ceil(paddingKm / tileSizeKm));
  const graphs = new Map(tiles.map((tile) => [tile.id, createTileGraph(tile)]));
  const add = (graph, id, point) => {
    let index = graph.ids.get(id);
    if (index === undefined) { index = graph.nodeLat.push(fixed(point.lat)); graph.nodeLon.push(fixed(point.lon)); graph.ids.set(id, index); }
    return index;
  };
  let routingEdges = 0;
  const addSegment = (wayId, ids, points, velocity) => {
    let distance = 0; for (let i = 1; i < points.length; i += 1) distance += metres(points[i - 1], points[i]);
    if (distance < .2) return;
    routingEdges += 1;
    const shape = simplifyShape(points, tolerance).slice(1, -1), tracked = topology.restrictionWays.has(wayId);
    for (const tile of tilesNear(points[0], grid, ring)) {
      if (!inside(points[0], expand(tile.bounds, paddingKm))) continue;
      const graph = graphs.get(tile.id), from = add(graph, ids[0], points[0]), to = add(graph, ids[ids.length - 1], points[points.length - 1]);
      const index = graph.edgeFrom.push(from);
      graph.edgeTo.push(to);
      graph.edgeDistance.push(distance);
      graph.edgeDuration.push(distance / (velocity * (1000 / 3600)));
      graph.edgeWay.push(tracked ? wayId : 0);
      graph.edgeShapeStart.push(graph.shapeLat.length);
      for (const coordinate of shape) { graph.shapeLat.push(fixed(coordinate.lat)); graph.shapeLon.push(fixed(coordinate.lon)); }
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
  let bannedTurns = 0, bannedRuns = 0;
  for (const graph of graphs.values()) {
    const resolved = resolveRestrictions(graph, topology.restrictions);
    graph.restrictions = resolved.banned;
    graph.runs = resolved.runs;
    bannedTurns += resolved.banned.length;
    bannedRuns += resolved.runs.length;
  }
  const result = [...graphs.values()].filter((graph) => graph.edgeFrom.length), routingNodeIds = new Set();
  for (const graph of result) for (const id of graph.ids.keys()) routingNodeIds.add(id);
  for (const graph of graphs.values()) { graph.ids = new Map(); graph.wayEdges = new Map(); graph.edgeWay = null; }
  return { graphs: result, routingEdges, routingNodes: routingNodeIds.size, bannedTurns, bannedRuns };
}

const input = inputArg(), outputOption = opt("--output"), profileName = opt("--profile", "car"), compression = opt("--compression", "gzip"), tileSizeKm = Number(opt("--tile-size-km", "120")), paddingKm = Number(opt("--padding-km", "2")), tolerance = Number(opt("--shape-tolerance-m", "2")), requested = parseBounds(opt("--bbox"));
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
    const built = await build(resolve(workspace, "ways.ndjson"), coordinates, first, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes); const storedNodes = coordinates.storedNodes; coordinates.close();
    // Encode, compress and spill each tile in turn, releasing it immediately,
    // so peak memory tracks the largest single tile rather than the region.
    const { encodeCompactGraph } = await import(new URL("../dist/index.js", import.meta.url).href);
    const spillPath = resolve(workspace, "chunks.bin"), spill = createWriteStream(spillPath), chunks = [];
    for (let index = 0; index < built.graphs.length; index += 1) {
      const graph = built.graphs[index];
      const raw = new Uint8Array(encodeEfr2(graph, encodeCompactGraph));
      const data = compression === "gzip" ? gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) : raw;
      chunks.push({ tile: graph.tile, byteLength: data.byteLength, rawBytes: raw.byteLength });
      if (!spill.write(data)) await new Promise((done) => spill.once("drain", done));
      built.graphs[index] = null;
      memoryGuard(limitBytes, "writing compressed tiles", 1000);
    }
    await new Promise((done, fail) => spill.end((error) => error ? fail(error) : done()));
    const bundleBytes = await writeBundle(output, chunks, compression, spillPath);
    await verifyBundle(output, chunks.length);
    const nodesBefore = storedNodes, nodesAfter = built.routingNodes, edges = built.routingEdges, rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
    const report = { formatVersion: 1, input: file, inputBytes: source.size, profile: profile.name, compression: `${compression}-per-tile`, tileSizeKm, paddingKm, pbfPasses: 2, tiles: chunks.length, relevantOsmWays: first.ways, relevantOsmNodes, relevantOsmNodesExact: false, routingNodesBeforeSimplification: nodesBefore, routingNodesAfterSimplification: nodesAfter, reductionPercent: Number((100 * (1 - nodesAfter / Math.max(1, nodesBefore))).toFixed(2)), routingEdges: edges, turnRestrictionsRead: first.restrictions.length, turnRestrictionsSkipped: first.skippedRestrictions, bannedTurnPairs: built.bannedTurns, bannedTurnRuns: built.bannedRuns, uncompressedGraphBytes: rawBytes, bundleBytes, compressionRatio: Number((bundleBytes / Math.max(1, rawBytes)).toFixed(4)), peakRssBytes: Math.max(observedPeakRss, process.memoryUsage().rss), elapsedMilliseconds: Math.round(performance.now() - started) };
    await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.table({ input_mb: (source.size / 1e6).toFixed(1), pbf_passes: report.pbfPasses, relevant_ways: first.ways.toLocaleString(), relevant_nodes: relevantOsmNodes.toLocaleString(), nodes_before: nodesBefore.toLocaleString(), nodes_after: nodesAfter.toLocaleString(), reduction_percent: report.reductionPercent, routing_edges: edges.toLocaleString(), turn_restrictions: first.restrictions.length.toLocaleString(), banned_turn_pairs: built.bannedTurns.toLocaleString(), banned_turn_runs: built.bannedRuns.toLocaleString(), tiles: chunks.length, raw_mb: (rawBytes / 1e6).toFixed(1), efrb_mb: (bundleBytes / 1e6).toFixed(1), compression_ratio: report.compressionRatio, peak_rss_mb: (report.peakRssBytes / 1e6).toFixed(1), elapsed_seconds: (report.elapsedMilliseconds / 1000).toFixed(1) });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
