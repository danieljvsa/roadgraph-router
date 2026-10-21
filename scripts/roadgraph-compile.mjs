#!/usr/bin/env node
/* Generic, bounded-pass OSM PBF -> EFRB compiler.  PBF is scanned twice: once
 * for usable ways, turn-restriction relations and topology, and once for the
 * coordinates of referenced nodes.  Every tag decision is delegated to a
 * routing profile, so nothing here is specific to a country or an extract. */
import { createWriteStream, createReadStream, rmSync } from "node:fs";
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

async function loadLibrary() {
  try {
    return await import(new URL("../dist/index.js", import.meta.url).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw new Error("roadgraph-compile needs the package build. Run `npm run build` first.");
    throw error;
  }
}

/**
 * `--profile car,truck` compiles one bundle both vehicles can be routed on.
 *
 * A road and a railway share no topology beyond the ground they cross, so a
 * bundle may hold several road profiles or several railway profiles but never
 * both: a shared chunk holding both networks would make every road-routing
 * user download the track, which is exactly what this refuses.
 */
async function loadProfiles(names, include) {
  const library = await loadLibrary();
  const wanted = names.split(",").map((name) => name.trim()).filter(Boolean);
  if (!wanted.length) throw new Error("--profile needs at least one vehicle.");
  if (new Set(wanted).size !== wanted.length) throw new Error("--profile lists the same vehicle twice.");
  const profiles = wanted.map((name) => {
    if (name === "train") return library.createTrainProfile({ include });
    if (name === "metro") return library.createMetroProfile({ include });
    return library.getRoutingProfile(name);
  });
  const networks = new Set(profiles.map((entry) => entry.networkKind));
  if (networks.size > 1) {
    throw new Error("--profile cannot mix road and railway profiles in one bundle: they share no topology, and a combined bundle would make every road user download the track. Compile them separately.");
  }
  if (include?.length && networks.has("road")) throw new Error("--railway-include only applies to the train and metro profiles.");
  return { library, profiles, networkKind: profiles[0].networkKind };
}

/** Reports a problem the way a command-line tool should, without a stack trace. */
function fail(message) { console.error(`roadgraph-compile: ${message}`); process.exit(1); }

function usage() { console.error("Usage: roadgraph-compile input.osm.pbf --output region.efrb [--profile car,truck,motorcycle|train|metro] [--railway-include disused,narrow_gauge] [--default-vehicle articulated] [--tile-size-km 120] [--padding-km 2] [--compression gzip|none] [--shape-tolerance-m 2] [--max-memory-mb 2048] [--bbox minLon,minLat,maxLon,maxLat]"); }
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

function createTileGraph(tile, profileCount) {
  const perProfile = (make) => Array.from({ length: profileCount }, make);
  return {
    tile,
    ids: new Map(),
    nodeLat: new Column(Int32Array), nodeLon: new Column(Int32Array),
    edgeFrom: new Column(Uint32Array), edgeTo: new Column(Uint32Array),
    edgeDistance: new Column(Float64Array),
    edgeWay: new Column(Float64Array), edgeShapeStart: new Column(Uint32Array),
    shapeLat: new Column(Int32Array), shapeLon: new Column(Int32Array),
    wayEdges: new Map(),
    // The road network is shared; everything below it belongs to one vehicle.
    edgeDurations: perProfile(() => new Column(Float64Array)),
    edgeUsable: perProfile(() => new Column(Uint8Array)),
    // Sparse: almost no road states a height or a weight.
    edgeLimits: perProfile(() => new Map()),
    edgeConditions: perProfile(() => []),
    // What the track is, for a railway profile. Keyed by edge because an edge
    // states one set of facts whichever way it is run over.
    edgeRailway: perProfile(() => new Map()),
    restrictions: perProfile(() => []),
    runs: perProfile(() => []),
  };
}

function tilesFor(input, km) {
  // A region with no height or no width — a single straight line of track, or
  // a one-street extract — would produce no rows at all, and the compile would
  // fail later with a directory of zero tiles rather than with anything that
  // explains itself. Giving a degenerate side the smallest span the coordinate
  // scale can represent yields the one tile such a region should have.
  const span = 1 / SCALE;
  const bounds = {
    minLat: input.minLat, minLon: input.minLon,
    maxLat: input.maxLat > input.minLat ? input.maxLat : input.minLat + span,
    maxLon: input.maxLon > input.minLon ? input.maxLon : input.minLon + span,
  };
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
/**
 * Orders a tile's edges by source node and hands the result to the library
 * encoder, so the compiler and the runtime cannot drift apart on the layout.
 *
 * One vehicle with no physical limits still writes the single-chunk layout it
 * always has. Anything else writes the road network once and a small chunk per
 * vehicle, because that is the only layout with room for an access mask, a
 * restriction mask and a limit table.
 */
function encodeEfr2(graph, library, profiles) {
  const nodes = graph.nodeLat.length, edges = graph.edgeFrom.length;
  const distances = graph.edgeDistance.view();
  const distanceScale = scaleFor(distances);
  const offsets = new Uint32Array(nodes + 1);
  for (let i = 0; i < edges; i += 1) offsets[graph.edgeFrom.at(i) + 1] += 1;
  for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const order = offsets.slice(), targets = new Uint32Array(edges), placement = new Uint32Array(edges);
  const packedDistances = new Uint16Array(edges);
  const shapeOffsets = new Uint32Array(edges + 1);
  for (let i = 0; i < edges; i += 1) {
    const at = order[graph.edgeFrom.at(i)]++;
    placement[i] = at;
    targets[at] = graph.edgeTo.at(i);
    packedDistances[at] = Math.round(distances[i] / distanceScale);
    const start = graph.edgeShapeStart.at(i);
    const stop = i + 1 < edges ? graph.edgeShapeStart.at(i + 1) : graph.shapeLat.length;
    shapeOffsets[at + 1] = stop - start;
  }
  for (let i = 1; i <= edges; i += 1) shapeOffsets[i] += shapeOffsets[i - 1];
  const shapeLat = new Int32Array(graph.shapeLat.length), shapeLon = new Int32Array(graph.shapeLon.length);
  for (let i = 0; i < edges; i += 1) {
    const start = graph.edgeShapeStart.at(i);
    const stop = i + 1 < edges ? graph.edgeShapeStart.at(i + 1) : graph.shapeLat.length;
    let out = shapeOffsets[placement[i]];
    for (let point = start; point < stop; point += 1, out += 1) { shapeLat[out] = graph.shapeLat.at(point); shapeLon[out] = graph.shapeLon.at(point); }
  }

  // Restrictions are collected against pre-grouping edge positions, so they
  // follow each edge into the CSR layout through the same permutation. Every
  // vehicle's bans go into one list, with a bit each saying who obeys which.
  const pairKeys = new Map(), runKeys = new Map();
  const pairOwners = [], runOwners = [];
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    for (const [from, to] of graph.restrictions[profileIndex]) {
      const key = `${placement[from]}:${placement[to]}`;
      let row = pairKeys.get(key);
      if (row === undefined) { row = pairKeys.size; pairKeys.set(key, row); pairOwners.push(new Set()); }
      pairOwners[row].add(profileIndex);
    }
    for (const run of graph.runs[profileIndex]) {
      const key = run.map((edge) => placement[edge]).join(",");
      let row = runKeys.get(key);
      if (row === undefined) { row = runKeys.size; runKeys.set(key, row); runOwners.push(new Set()); }
      runOwners[row].add(profileIndex);
    }
  }
  const pairRows = [...pairKeys.keys()].map((key) => key.split(":").map(Number));
  const runRows = [...runKeys.keys()].map((key) => key.split(",").map(Number)).filter((run) => run.length >= 3);
  const pairOrder = pairRows.map((pair, index) => index).sort((a, b) => pairRows[a][0] - pairRows[b][0] || pairRows[a][1] - pairRows[b][1]);
  const runOrder = runRows.map((run, index) => index).sort((a, b) => runRows[a][0] - runRows[b][0] || runRows[a].length - runRows[b].length || runRows[a][1] - runRows[b][1]);
  const banned = pairOrder.map((index) => pairRows[index]);
  const runs = runOrder.map((index) => runRows[index]);
  const runOffsets = new Uint32Array(runs.length + 1);
  for (let i = 0; i < runs.length; i += 1) runOffsets[i + 1] = runOffsets[i] + runs[i].length;

  const durationScales = profiles.map((_, index) => scaleFor(graph.edgeDurations[index].view()));
  const durationColumns = profiles.map((_, index) => {
    const source = graph.edgeDurations[index].view(), packed = new Uint16Array(edges);
    const scale = durationScales[index];
    // Durations are whole units, and rounding one down can leave a short edge
    // costing nothing at all or implying a speed no vehicle of this class can
    // reach. A free edge is a shortcut the search will take, and a speed above
    // the profile's ceiling makes the A* heuristic inadmissible, which lets it
    // settle for a route that is not the best one. So no edge is ever stored
    // as quicker than its own length at the profile's top speed.
    const ceilingMps = (profiles[index].maxSpeedKph * 1000) / 3600;
    for (let i = 0; i < edges; i += 1) {
      const atCeiling = distances[i] / ceilingMps;
      packed[placement[i]] = Math.max(Math.round(source[i] / scale), Math.ceil(atCeiling / scale));
    }
    return packed;
  });

  const assembled = {
    nodeLatitudes: graph.nodeLat.view(), nodeLongitudes: graph.nodeLon.view(),
    edgeOffsets: offsets, edgeTargets: targets,
    edgeDistancesMeters: packedDistances, edgeDurationsSeconds: durationColumns[0],
    coordinateScale: SCALE, edgeDistanceScale: distanceScale, edgeDurationScale: durationScales[0],
    // Without this a bundle compiled for one vehicle reads back as a car,
    // which is the one mistake the profile metadata exists to prevent.
    profileId: profiles[0].id, maxSpeedKph: profiles[0].maxSpeedKph,
    edgeShapeOffsets: shapeOffsets, edgeShapeLatitudes: shapeLat, edgeShapeLongitudes: shapeLon,
    ...(banned.length ? { turnRestrictionFromEdges: Uint32Array.from(banned, (pair) => pair[0]), turnRestrictionToEdges: Uint32Array.from(banned, (pair) => pair[1]) } : {}),
    ...(runs.length ? { turnRestrictionSequenceOffsets: runOffsets, turnRestrictionSequenceEdges: Uint32Array.from(runs.flat()) } : {}),
  };

  const split = profiles.length > 1 || profiles.some((entry) => entry.usesPhysicalLimits || entry.usesRailwayAttributes);
  if (!split) {
    // One vehicle writes one chunk, and that chunk is its whole graph, so the
    // conditional restrictions belong in it. Without this a bundle compiled
    // for a single vehicle would read as though no road were ever shut.
    const onlyConditions = library.packEdgeConditions(
      graph.edgeConditions[0].map((row) => ({ ...row, edge: placement[row.edge] })),
    );
    const encoded = library.encodeCompactGraph(onlyConditions ? { ...assembled, edgeConditions: onlyConditions } : assembled);
    return { shared: encoded, profiles: [], limitedEdges: 0, conditionalEdges: onlyConditions?.edges.length ?? 0, railwayRows: 0 };
  }

  const restrictionCount = banned.length + runs.length;
  let limitedEdges = 0;
  let conditionalEdges = 0;
  let railwayRows = 0;
  const chunks = profiles.map((entry, profileIndex) => {
    const usable = graph.edgeUsable[profileIndex].view();
    // `placement` maps a built edge to its stored position, so the mask is
    // opened for everything and then closed at the stored index of each road
    // this vehicle cannot use.
    const edgeAccess = library.accessMaskFor(edges, () => true);
    for (let i = 0; i < edges; i += 1) if (!usable[i]) edgeAccess[placement[i] >> 3] &= ~(1 << (placement[i] & 7));
    const entries = [];
    for (const [edge, limits] of graph.edgeLimits[profileIndex]) entries.push({ edge: placement[edge], limits });
    const edgeLimits = library.packEdgeLimits(entries);
    limitedEdges += edgeLimits?.edges.length ?? 0;
    const edgeConditions = library.packEdgeConditions(
      graph.edgeConditions[profileIndex].map((row) => ({ ...row, edge: placement[row.edge] })),
    );
    conditionalEdges += edgeConditions?.edges.length ?? 0;
    const railwayEntries = [];
    for (const [edge, railway] of graph.edgeRailway[profileIndex]) railwayEntries.push({ edge: placement[edge], railway });
    const edgeRailway = railwayEntries.length ? library.packEdgeRailway(railwayEntries, edges) : undefined;
    railwayRows = Math.max(railwayRows, edgeRailway?.gaugeMm.length ?? 0);
    const restrictionMask = library.accessMaskFor(restrictionCount, (index) => index < banned.length
      ? pairOwners[pairOrder[index]].has(profileIndex)
      : runOwners[runOrder[index - banned.length]].has(profileIndex));
    return library.encodeProfileChunk({
      profileId: entry.id,
      maxSpeedKph: entry.maxSpeedKph,
      edgeDurationScale: durationScales[profileIndex],
      edgeDurationsSeconds: durationColumns[profileIndex],
      edgeAccess,
      ...(edgeConditions ? { edgeConditions } : {}),
      ...(edgeLimits ? { edgeLimits } : {}),
      ...(edgeRailway ? { edgeRailway } : {}),
      ...(restrictionCount ? { restrictionCount, restrictionMask } : {}),
    });
  });
  return { shared: library.encodeSharedGraph(assembled), profiles: chunks, limitedEdges, conditionalEdges, railwayRows };
}

/** Writes the fixed-size directory, then streams each chunk straight from the
 *  spill file. Neither the chunk list nor the finished bundle is ever held in
 *  memory, so output size no longer bounds how large a region can be built. */
async function writeBundle(output, chunks, compression, spillPath, profiles, split, defaultVehicle, VEHICLE_PRESET_IDS) {
  const directoryBytes = chunks.length * DIRECTORY;
  const head = Buffer.alloc(HEADER + directoryBytes);
  head.writeUInt32LE(EFRB_MAGIC, 0); head.writeUInt16LE(split ? 2 : 1, 4); head.writeUInt16LE(HEADER, 6);
  head.writeUInt32LE(chunks.length, 8); head.writeUInt32LE(HEADER, 12); head.writeUInt32LE(directoryBytes, 16);
  // The vehicle, in the header as well as in every chunk, so a reader knows it
  // before downloading a tile and can size its tile budget accordingly.
  head.writeUInt8(profiles[0].id, 20);
  head.writeUInt8(defaultVehicle ? VEHICLE_PRESET_IDS[defaultVehicle] ?? 0 : 0, 21);
  head.writeUInt16LE(Math.round(Math.max(...profiles.map((entry) => entry.maxSpeedKph))), 22);
  head.writeUInt32LE(profiles.reduce((mask, entry) => mask | (1 << (entry.id - 1)), 0) >>> 0, 24);
  head.writeUInt32LE(split ? chunks.length / (profiles.length + 1) : chunks.length, 28);
  let offset = HEADER + directoryBytes;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i], at = HEADER + i * DIRECTORY, b = chunk.tile.bounds;
    head.writeUInt32LE(chunk.tile.id, at);
    head.writeInt32LE(fixed(b.minLat), at + 4); head.writeInt32LE(fixed(b.minLon), at + 8);
    head.writeInt32LE(fixed(b.maxLat), at + 12); head.writeInt32LE(fixed(b.maxLon), at + 16);
    head.writeUInt32LE(offset, at + 20); head.writeUInt32LE(chunk.byteLength, at + 24);
    head.writeUInt32LE(chunk.rawBytes, at + 28); head.writeUInt16LE(compression === "gzip" ? 1 : 0, at + 32);
    head.writeUInt8(chunk.profileId ?? 0, at + 34);
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
async function firstPass(file, roadFile, limitBytes, profiles) {
  const required = approximateIds(), keeperNodes = approximateIds(), stream = createWriteStream(roadFile), bounds = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  const restrictions = [], restrictionWays = new Set(), barriers = [];
  let ways = 0, entities = 0, skippedRestrictions = 0, barrierCount = 0, conditionalRestrictions = 0;
  // One pass serves every vehicle: the reader is asked for the union of the
  // tags they read, and each way is offered to all of them.
  const wayTags = [...new Set(profiles.flatMap((entry) => entry.wayTagKeys))];
  const relationTags = [...new Set(profiles.flatMap((entry) => entry.relationTagKeys))];
  // Barriers live on nodes, so the reader is asked for their tags too. Only
  // nodes carrying one of these keys arrive with tags, which is a small
  // fraction of a country.
  const nodeTags = [...new Set(profiles.flatMap((entry) => entry.nodeTagKeys ?? []))];
  for await (const entity of createOSMStream(file, { withTags: { node: nodeTags.length ? nodeTags : false, way: wayTags, relation: relationTags } })) {
    memoryGuard(limitBytes, "scanning PBF topology", ++entities);
    if (entity.type === "node") {
      bounds.minLat = Math.min(bounds.minLat, entity.lat); bounds.minLon = Math.min(bounds.minLon, entity.lon);
      bounds.maxLat = Math.max(bounds.maxLat, entity.lat); bounds.maxLon = Math.max(bounds.maxLon, entity.lon);
      // A node that stops somebody is remembered against the profiles it
      // stops. Most nodes carry no tags at all and cost nothing here.
      const tags = entity.tags;
      if (tags?.barrier) {
        for (let index = 0; index < profiles.length; index += 1) {
          if (profiles[index].evaluateBarrier?.(tags) === false) {
            (barriers[index] ??= new Set()).add(entity.id);
            barrierCount += 1;
          }
        }
      }
      continue;
    }
    if (entity.type === "relation") {
      // A restriction can apply to one vehicle and not another, and can even
      // mean something different to each, so every vehicle's answer is kept.
      const perProfile = profiles.map((entry) => entry.evaluateTurnRestriction(entity.tags ?? {}));
      const parsed = perProfile.find(Boolean) ?? null;
      if (!parsed) continue;
      // A turn banned only at certain hours is banned at every hour here.
      // Counting them says how much of a region that costs rather than
      // leaving it to be discovered: in Portugal it is 1 relation in 26,599.
      if (Object.keys(entity.tags ?? {}).some((key) => key.endsWith(":conditional"))) conditionalRestrictions += 1;
      const members = entity.members ?? [];
      const from = members.find((member) => member.role === "from" && member.type === "way");
      const to = members.find((member) => member.role === "to" && member.type === "way");
      const via = members.filter((member) => member.role === "via");
      if (!from || !to || !via.length) { skippedRestrictions += 1; continue; }
      restrictionWays.add(Number(from.ref)); restrictionWays.add(Number(to.ref));
      if (via.length === 1 && via[0].type === "node") {
        const viaNode = Number(via[0].ref);
        keeperNodes.add(viaNode);
        restrictions.push({ kinds: perProfile.map((entry) => entry?.kind ?? null), from: Number(from.ref), to: Number(to.ref), via: viaNode });
        continue;
      }
      // A `via` way names a whole link road, so the ban covers a run of edges
      // rather than one turn. Its ends must stay in the topology for the run
      // to be found again at build time.
      if (!via.every((member) => member.type === "way")) { skippedRestrictions += 1; continue; }
      const viaWays = via.map((member) => Number(member.ref));
      for (const way of viaWays) restrictionWays.add(way);
      restrictions.push({ kinds: perProfile.map((entry) => entry?.kind ?? null), from: Number(from.ref), to: Number(to.ref), viaWays });
      continue;
    }
    if (entity.type !== "way") continue;
    const tags = entity.tags ?? {}, refs = entity.refs ?? [];
    if (refs.length < 2) continue;
    const lanes = profiles.map((entry) => entry.evaluateWay(tags));
    if (!lanes.some(Boolean)) continue;
    ways += 1;
    for (const id of refs) { if (required.has(id)) keeperNodes.add(id); else required.add(id); }
    keeperNodes.add(refs[0]); keeperNodes.add(refs[refs.length - 1]);
    await write(stream, {
      id: entity.id, refs,
      forward: lanes.map((lane) => lane?.forward ? { speed: lane.forwardSpeedKph, limits: lane.forwardLimits ?? null, conditions: lane.conditions ?? null, railway: lane.railway ?? null } : null),
      reverse: lanes.map((lane) => lane?.backward ? { speed: lane.backwardSpeedKph, limits: lane.backwardLimits ?? null, conditions: lane.conditions ?? null, railway: lane.railway ?? null } : null),
    });
  }
  await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  if (!Number.isFinite(bounds.minLat)) throw new Error("The input contains no OSM nodes.");
  // Drop restrictions whose ways were filtered out by the profile; they can
  // never produce a banned pair and would only cost memory downstream.
  const usable = restrictions.filter((restriction) => restriction.viaWays || required.has(restriction.via));
  // A barrier can only matter where a road passes through it, and the node
  // has to survive simplification for the ban to have edges to name.
  for (const blocked of barriers) { if (blocked) for (const id of blocked) if (required.has(id)) keeperNodes.add(id); }
  return { required, keeperNodes, bounds, ways, restrictions: usable, restrictionWays, skippedRestrictions, conditionalRestrictions, barriers, barrierCount };
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
function resolveRestrictions(graph, restrictions, profileIndex) {
  if (!graph.wayEdges.size) return { banned: [], runs: [] };
  const outgoing = new Map();
  for (let index = 0; index < graph.edgeFrom.length; index += 1) {
    const list = outgoing.get(graph.edgeFrom.at(index));
    if (list) list.push(index); else outgoing.set(graph.edgeFrom.at(index), [index]);
  }
  const banned = [], runs = [];
  for (const restriction of restrictions) {
    // What this relation means to this vehicle, which may be nothing at all.
    const kind = restriction.kinds[profileIndex];
    if (!kind) continue;
    const fromAll = graph.wayEdges.get(restriction.from) ?? [];
    const toAll = graph.wayEdges.get(restriction.to) ?? [];
    if (!fromAll.length || !toAll.length) continue;

    if (!restriction.viaWays) {
      const via = graph.ids.get(restriction.via);
      if (via === undefined) continue;
      const fromEdges = fromAll.filter((index) => graph.edgeTo.at(index) === via);
      const toEdges = toAll.filter((index) => graph.edgeFrom.at(index) === via);
      if (!fromEdges.length || !toEdges.length) continue;
      if (kind === "no") { for (const from of fromEdges) for (const to of toEdges) banned.push([from, to]); continue; }
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
        if (kind === "no") { for (const to of toEdges) runs.push([from, ...chain, to]); continue; }
        const mandatory = new Set(toEdges);
        for (const to of outgoing.get(end) ?? []) if (!mandatory.has(to) && !chain.includes(to)) runs.push([from, ...chain, to]);
      }
    }
  }
  return { banned, runs };
}

async function build(roadFile, coordinates, topology, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes, profileCount) {
  const { tiles, grid } = layout, ring = Math.max(1, Math.ceil(paddingKm / tileSizeKm));
  const graphs = new Map(tiles.map((tile) => [tile.id, createTileGraph(tile, profileCount)]));
  const add = (graph, id, point) => {
    let index = graph.ids.get(id);
    if (index === undefined) { index = graph.nodeLat.push(fixed(point.lat)); graph.nodeLon.push(fixed(point.lon)); graph.ids.set(id, index); }
    return index;
  };
  let routingEdges = 0;
  /**
   * One directed edge, shared by every vehicle that can drive it. `lanes[i]`
   * is that vehicle's speed and limits for this direction, or null where it
   * cannot use the road at all: the edge still exists, with its bit clear.
   */
  const addSegment = (wayId, ids, points, lanes) => {
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
      for (let profileIndex = 0; profileIndex < lanes.length; profileIndex += 1) {
        const lane = lanes[profileIndex];
        // An edge this vehicle cannot use still needs a duration, because the
        // column has one slot per edge. Walking pace makes it expensive rather
        // than free, so a lost access bit cannot turn it into a shortcut.
        const speed = lane ? lane.speed : 5;
        graph.edgeDurations[profileIndex].push(distance / (speed * (1000 / 3600)));
        graph.edgeUsable[profileIndex].push(lane ? 1 : 0);
        if (lane?.limits) graph.edgeLimits[profileIndex].set(index, lane.limits);
        if (lane?.railway) graph.edgeRailway[profileIndex].set(index, lane.railway);
        if (lane?.conditions) for (const condition of lane.conditions) graph.edgeConditions[profileIndex].push({ edge: index, ...condition });
      }
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
        if (way.forward.some(Boolean)) addSegment(way.id, ids, segment, way.forward);
        if (way.reverse.some(Boolean)) addSegment(way.id, ids.slice().reverse(), segment.slice().reverse(), way.reverse);
      }
      start = i;
    }
  }
  let bannedTurns = 0, bannedRuns = 0, barrierBans = 0;
  for (const graph of graphs.values()) {
    // Incoming and outgoing edges per node, for turning a barrier into bans.
    const incoming = new Map(), outgoing = new Map();
    if (topology.barriers?.some(Boolean)) {
      for (let edge = 0; edge < graph.edgeFrom.length; edge += 1) {
        const from = graph.edgeFrom.at(edge), to = graph.edgeTo.at(edge);
        const out = outgoing.get(from); if (out) out.push(edge); else outgoing.set(from, [edge]);
        const into = incoming.get(to); if (into) into.push(edge); else incoming.set(to, [edge]);
      }
    }

    for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
      const resolved = resolveRestrictions(graph, topology.restrictions, profileIndex);
      // A barrier stops you passing through a node, which is a ban on every
      // movement across it. Turning back the way you came is still allowed:
      // you can drive up to a locked gate and reverse out again.
      const blocked = topology.barriers?.[profileIndex];
      if (blocked) {
        for (const id of blocked) {
          const node = graph.ids.get(id);
          if (node === undefined) continue;
          for (const into of incoming.get(node) ?? []) {
            for (const out of outgoing.get(node) ?? []) {
              if (graph.edgeTo.at(out) === graph.edgeFrom.at(into)) continue;
              resolved.banned.push([into, out]);
              barrierBans += 1;
            }
          }
        }
      }
      graph.restrictions[profileIndex] = resolved.banned;
      graph.runs[profileIndex] = resolved.runs;
      bannedTurns += resolved.banned.length;
      bannedRuns += resolved.runs.length;
    }
  }
  const result = [...graphs.values()].filter((graph) => graph.edgeFrom.length), routingNodeIds = new Set();
  for (const graph of result) for (const id of graph.ids.keys()) routingNodeIds.add(id);
  for (const graph of graphs.values()) { graph.ids = new Map(); graph.wayEdges = new Map(); graph.edgeWay = null; }
  return { graphs: result, routingEdges, routingNodes: routingNodeIds.size, bannedTurns, bannedRuns, barrierBans };
}

const input = inputArg(), outputOption = opt("--output"), profileName = opt("--profile", "car"), compression = opt("--compression", "gzip"), tileSizeKm = Number(opt("--tile-size-km", "120")), paddingKm = Number(opt("--padding-km", "2")), tolerance = Number(opt("--shape-tolerance-m", "2")), requested = parseBounds(opt("--bbox"));
const maxMemoryMb = Number(opt("--max-memory-mb", "2048")), defaultVehicle = opt("--default-vehicle");
const railwayInclude = (opt("--railway-include") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
/**
 * The coordinate index needs `node:sqlite`, which arrived in Node 22.5. The
 * import itself sits in the second pass, by which point the first pass has
 * already streamed the whole extract — minutes of work before an older Node
 * is told it cannot finish. Ask here instead, before anything is read.
 */
async function assertCompilerRuntime() {
  try { await import("node:sqlite"); } catch {
    fail(`The roadgraph-compile CLI needs Node.js 22.5 or newer for its built-in SQLite coordinate index; this is ${process.version}. The routing library itself runs on Node.js 18 and in the browser.`);
  }
}

if (!input || !outputOption || !["gzip", "none"].includes(compression) || !(tileSizeKm > 0) || !(paddingKm >= 0) || !(tolerance >= 0) || !(maxMemoryMb > 0 && maxMemoryMb <= 3072) || (opt("--bbox") && !requested)) { usage(); process.exitCode = 1; }
else if (!process.env.ROADGRAPH_HEAP_LIMITED) {
  await assertCompilerRuntime();
  const result = spawnSync(process.execPath, [`--max-old-space-size=${Math.floor(maxMemoryMb)}`, import.meta.filename, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ROADGRAPH_HEAP_LIMITED: "1" } });
  process.exitCode = result.status ?? 1;
}
else {
  // Choosing the profiles is the first thing that can go wrong, and an
  // unknown name or an impossible combination is a user's mistake rather than
  // a crash — so it is reported the way every other mistake here is.
  const { library, profiles, networkKind } = await loadProfiles(profileName, railwayInclude)
    .catch((error) => fail(error instanceof Error ? error.message : String(error)));
  const profile = profiles[0];
  if (defaultVehicle && !profiles.some((entry) => entry.usesPhysicalLimits)) fail("--default-vehicle only applies to a profile whose routes depend on the vehicle's size, such as truck.");
  if (defaultVehicle) library.vehiclePreset(defaultVehicle);
  const started = performance.now(), file = resolve(process.cwd(), input), output = resolve(process.cwd(), outputOption);
  if (!file.endsWith(".pbf")) fail("roadgraph-compile accepts .osm.pbf files so compilation stays streaming at country scale.");
  const source = await stat(file).catch(() => fail(`Cannot read "${input}". Check the path and that the file exists.`));
  // A PBF starts with a length-prefixed header block; anything this small
  // cannot be one, and says so more clearly than the parser would.
  if (source.size < 128) fail(`"${input}" is too small to be an OSM PBF file.`);
  observedPeakRss = process.memoryUsage().rss;
  const workspace = await mkdtemp(resolve(tmpdir(), "roadgraph-"));
  // The scratch directory holds hundreds of megabytes mid-compile. `finally`
  // covers a thrown error, but not Ctrl-C, so the common interruptions clean
  // up too rather than leaving the spill behind.
  const sweep = () => { try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort on the way out */ } };
  const onSignal = (signal) => { sweep(); process.exit(signal === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    const limitBytes = maxMemoryMb * 1024 * 1024, first = await firstPass(file, resolve(workspace, "ways.ndjson"), limitBytes, profiles), relevantOsmNodes = first.required.count, bounds = requested ?? first.bounds, layout = tilesFor(bounds, tileSizeKm), coordinates = await secondPass(file, first.required, limitBytes, resolve(workspace, "coordinates.sqlite")); first.required.clear();
    const built = await build(resolve(workspace, "ways.ndjson"), coordinates, first, layout, bounds, tolerance, paddingKm, tileSizeKm, limitBytes, profiles.length); const storedNodes = coordinates.storedNodes; coordinates.close();
    // Encode, compress and spill each tile in turn, releasing it immediately,
    // so peak memory tracks the largest single tile rather than the region.
    const spillPath = resolve(workspace, "chunks.bin"), spill = createWriteStream(spillPath), chunks = [];
    let limitedEdges = 0;
    let conditionalEdges = 0;
    let railwayRows = 0;
    for (let index = 0; index < built.graphs.length; index += 1) {
      const graph = built.graphs[index];
      const encoded = encodeEfr2(graph, library, profiles);
      // The shared half first, then each vehicle's: the reader needs a tile's
      // shared row before the rows that depend on it.
      limitedEdges += encoded.limitedEdges ?? 0;
      conditionalEdges += encoded.conditionalEdges ?? 0;
      railwayRows = Math.max(railwayRows, encoded.railwayRows ?? 0);
      for (const [profileId, buffer] of [[0, encoded.shared], ...encoded.profiles.map((chunk, at) => [profiles[at].id, chunk])]) {
        const raw = new Uint8Array(buffer);
        const data = compression === "gzip" ? gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }) : raw;
        chunks.push({ tile: graph.tile, profileId, byteLength: data.byteLength, rawBytes: raw.byteLength });
        if (!spill.write(data)) await new Promise((done) => spill.once("drain", done));
      }
      built.graphs[index] = null;
      memoryGuard(limitBytes, "writing compressed tiles", 1000);
    }
    await new Promise((done, fail) => spill.end((error) => error ? fail(error) : done()));
    const split = profiles.length > 1 || profiles.some((entry) => entry.usesPhysicalLimits || entry.usesRailwayAttributes);
    const bundleBytes = await writeBundle(output, chunks, compression, spillPath, profiles, split, defaultVehicle, library.VehiclePresetId);
    await verifyBundle(output, built.graphs.length);
    const nodesBefore = storedNodes, nodesAfter = built.routingNodes, edges = built.routingEdges, rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
    const report = { formatVersion: 1, input: file, inputBytes: source.size, profile: profiles.map((entry) => entry.name).join(","), compression: `${compression}-per-tile`, tileSizeKm, paddingKm, pbfPasses: 2, tiles: built.graphs.length, relevantOsmWays: first.ways, relevantOsmNodes, relevantOsmNodesExact: false, routingNodesBeforeSimplification: nodesBefore, routingNodesAfterSimplification: nodesAfter, reductionPercent: Number((100 * (1 - nodesAfter / Math.max(1, nodesBefore))).toFixed(2)), routingEdges: edges, turnRestrictionsRead: first.restrictions.length, turnRestrictionsSkipped: first.skippedRestrictions, conditionalTurnRestrictionsIgnored: first.conditionalRestrictions, barriersRead: first.barrierCount, barrierBans: built.barrierBans, bannedTurnPairs: built.bannedTurns, bannedTurnRuns: built.bannedRuns, layout: split ? "shared-plus-profile" : "single-chunk", profiles: profiles.map((entry) => entry.name), defaultVehicle: defaultVehicle ?? null, networkKind, railwayInclude, distinctRailwayAttributeRows: railwayRows, edgesWithPhysicalLimits: limitedEdges, edgesWithConditionalRestrictions: conditionalEdges, uncompressedGraphBytes: rawBytes, bundleBytes, compressionRatio: Number((bundleBytes / Math.max(1, rawBytes)).toFixed(4)), peakRssBytes: Math.max(observedPeakRss, process.memoryUsage().rss), elapsedMilliseconds: Math.round(performance.now() - started) };
    await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.table({ input_mb: (source.size / 1e6).toFixed(1), pbf_passes: report.pbfPasses, relevant_ways: first.ways.toLocaleString(), relevant_nodes: relevantOsmNodes.toLocaleString(), nodes_before: nodesBefore.toLocaleString(), nodes_after: nodesAfter.toLocaleString(), reduction_percent: report.reductionPercent, routing_edges: edges.toLocaleString(), turn_restrictions: first.restrictions.length.toLocaleString(), barriers: first.barrierCount.toLocaleString(), banned_turn_pairs: built.bannedTurns.toLocaleString(), banned_turn_runs: built.bannedRuns.toLocaleString(), tiles: built.graphs.length, raw_mb: (rawBytes / 1e6).toFixed(1), efrb_mb: (bundleBytes / 1e6).toFixed(1), compression_ratio: report.compressionRatio, peak_rss_mb: (report.peakRssBytes / 1e6).toFixed(1), elapsed_seconds: (report.elapsedMilliseconds / 1000).toFixed(1) });
  } catch (error) {
    // A truncated or non-PBF file surfaces as a parser or stream error deep in
    // the pipeline; report it as a problem with the input, not as a crash.
    sweep();
    fail(`Could not compile "${input}": ${error instanceof Error ? error.message : error}`);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
