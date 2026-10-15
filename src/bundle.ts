import { compactGraph } from "./compact";
import { combineProfiledGraph, decodeGraph, decodeProfileChunk, decodeSharedGraph, encodeCompactGraph, encodeProfileChunk, encodeSharedGraph } from "./codec";
import { mergeRoadGraphs } from "./merge";
import { withSpatialIndex } from "./spatial-index";
import { RouterError, type Coordinate, type ProfileChunk, type RoadGraph, type SharedRoadGraph } from "./types";
import { ProfileId, getRoutingProfile, getRoutingProfileById } from "./routing-profile";
import { vehiclePresetName } from "./vehicle";

const MAGIC = 0x42524645; // EFRB
/** A bundle holding one graph per tile, which is every bundle published so far. */
const VERSION = 1;
/**
 * v2 splits each tile into a shared chunk and one chunk per vehicle, and lists
 * them separately in the directory. A reader fetches the shared chunk plus the
 * one vehicle it wants and never downloads the others.
 */
const PROFILED_VERSION = 2;
/** Directory entries carrying a profile id of zero hold a tile's shared chunk. */
const SHARED_CHUNK = 0;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 40;
const COORDINATE_SCALE = 10_000_000;
/**
 * Two, because answering one route stitches two corridors: the first guess,
 * and the wider one the confirmation pass asks for. Holding only the second
 * makes the next identical route miss on the first, and measurements on a
 * country-sized bundle show no further gain past two for one vehicle. A
 * multi-vehicle bundle raises it to the number of vehicles it holds, since
 * each keeps its own corridor and switching between them would otherwise
 * discard the stitching every time.
 */
const DEFAULT_MERGED_CACHE_SIZE = 2;

export const BundleCompression = {
  none: 0,
  gzip: 1,
} as const;
export type BundleCompression = (typeof BundleCompression)[keyof typeof BundleCompression];

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BundleBounds = { minLat: number; minLng: number; maxLat: number; maxLng: number };
/** Where one chunk sits in the file. */
export type BundleChunkRef = { offset: number; byteLength: number; rawByteLength: number; compression: BundleCompression };
/**
 * A tile. The flat chunk fields address its graph in a v1 bundle and its
 * shared chunk in a v2 one; `profileChunks` is present only in v2 and holds
 * the per-vehicle half, keyed by profile id.
 */
export type BundleTile = BundleChunkRef & { id: number; bounds: BundleBounds; profileChunks?: Map<number, BundleChunkRef> };
export type RoadGraphBundle = {
  url: string;
  tiles: BundleTile[];
  /**
   * The profile every tile in this bundle was compiled for, read from the
   * header so a caller knows the vehicle before downloading a single tile.
   * `0` means a bundle written before profiles were recorded: a car bundle.
   */
  profileId: number;
  /** The profile's speed ceiling in km/h, or 0 when the bundle predates it. */
  maxSpeedKph: number;
  /** Every profile this bundle can route, by id. A v1 bundle lists its one. */
  profiles: number[];
  /**
   * The vehicle class this bundle was compiled to suggest, where it names one.
   * Whoever compiled the extract chose it knowingly; a caller's own `vehicle`
   * still wins, and the library's default applies when neither says anything.
   */
  defaultVehicle?: string;
  loadForRoute(origin: Coordinate, destination: Coordinate): Promise<RoadGraph>;
  loadExpandedForRoute(origin: Coordinate, destination: Coordinate): Promise<RoadGraph>;
  /**
   * Every tile that a route of at most `budgetMeters` of travel could reach.
   * A path through a tile is at least `distance(origin, tile) +
   * distance(tile, destination)` long, so tiles failing that test cannot hold
   * a better route and need never be downloaded. The test is a ground
   * distance, which is what makes it independent of how the bundle was tiled.
   */
  tilesWithinBudget(origin: Coordinate, destination: Coordinate, budgetMeters: number): BundleTile[];
  /**
   * Merges the given tiles, reusing any chunk already downloaded. `profileId`
   * picks the vehicle in a multi-profile bundle; the bundle's own default is
   * used when it is left out.
   */
  loadTiles(tiles: BundleTile[], profileId?: number): Promise<RoadGraph>;
};

export type BundleGraphTile = { id: number; bounds: BundleBounds; graph: RoadGraph };
/**
 * One tile of a multi-profile bundle: the road network once, and the
 * vehicle-dependent columns once per vehicle.
 */
export type BundleProfiledTile = { id: number; bounds: BundleBounds; graph: RoadGraph; profiles: ProfileChunk[] };
/**
 * `mergedCacheSize` is how many stitched corridors to keep. Stitching is the
 * most expensive part of answering a route, and consecutive routes usually ask
 * for the same tiles, so one is worth holding. Each entry is a whole merged
 * corridor, so raising this trades memory for repeat speed; `0` keeps none and
 * restores the behaviour of releasing a corridor as soon as the route is done.
 */
export type BundleOpenOptions = {
  mergedCacheSize?: number;
  /**
   * Which vehicle to route as, by profile name. Only a multi-profile bundle
   * offers a choice; leaving it out uses the bundle's own default.
   */
  profile?: string;
};
export type BundleEncodeOptions = { compression?: "none" | "gzip" };
type BundleChunk = { data: ArrayBuffer; rawByteLength: number; compression: BundleCompression };

function contains(bounds: BundleBounds, coordinate: Coordinate) {
  return coordinate.lat >= bounds.minLat && coordinate.lat <= bounds.maxLat && coordinate.lng >= bounds.minLng && coordinate.lng <= bounds.maxLng;
}

function intersects(first: BundleBounds, second: BundleBounds) {
  return first.minLat <= second.maxLat && first.maxLat >= second.minLat && first.minLng <= second.maxLng && first.maxLng >= second.minLng;
}

const EARTH_RADIUS_METERS = 6_371_000;

function haversineMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

/** Ground distance from a coordinate to the nearest point of a tile, 0 inside it. */
export function distanceToBounds(coordinate: Coordinate, bounds: BundleBounds) {
  return haversineMeters(coordinate, {
    lat: Math.max(bounds.minLat, Math.min(coordinate.lat, bounds.maxLat)),
    lng: Math.max(bounds.minLng, Math.min(coordinate.lng, bounds.maxLng)),
  });
}

function toFixed(value: number) {
  return Math.round(value * COORDINATE_SCALE);
}

function fromFixed(value: number) {
  return value / COORDINATE_SCALE;
}

async function fetchRange(url: string, start: number, end: number, fetcher: FetchLike) {
  const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!response.ok) throw new Error(`Unable to load routing bundle range ${start}-${end}.`);
  const buffer = await response.arrayBuffer();
  const expected = end - start + 1;
  if (buffer.byteLength === expected) return buffer;
  // Development servers and simple static hosts can ignore Range. Fall back to
  // slicing their full response while production CDNs retain range efficiency.
  if (response.status === 200 && buffer.byteLength >= end + 1) return buffer.slice(start, end + 1);
  throw new Error("Routing bundle server returned an invalid byte range.");
}

/** Undoes a chunk's compression, whatever the chunk turns out to hold. */
async function decompressChunk(buffer: ArrayBuffer, compression: BundleCompression) {
  if (compression === BundleCompression.none) return buffer;
  if (compression !== BundleCompression.gzip || !("DecompressionStream" in globalThis)) {
    throw new Error("This browser cannot decompress the routing bundle chunk.");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function decodeChunk(buffer: ArrayBuffer, compression: BundleCompression) {
  return withSpatialIndex(decodeGraph(await decompressChunk(buffer, compression)));
}

async function gzipChunk(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!("CompressionStream" in globalThis)) throw new Error("This runtime cannot create gzip-compressed routing bundles.");
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * Every tile must describe the same vehicle: a bundle is one graph split up,
 * and a corridor merged from a car tile and a bicycle tile is neither.
 */
function profileOfTiles(tiles: BundleGraphTile[]) {
  const profileId = tiles[0].graph.profileId ?? 0;
  const maxSpeedKph = tiles[0].graph.maxSpeedKph ?? 0;
  for (const tile of tiles) {
    if ((tile.graph.profileId ?? 0) !== profileId) throw new Error("A routing bundle cannot mix tiles compiled for different profiles.");
  }
  return { profileId, maxSpeedKph };
}

/** One directory row: which tile, which vehicle, and where its bytes are. */
type DirectoryRow = { tileId: number; bounds: BundleBounds; profileId: number; chunk: BundleChunk };

function createBundle(rows: DirectoryRow[], version: number, header: { defaultProfileId: number; maxSpeedKph: number; profileMask: number; tileCount: number }): ArrayBuffer {
  const directoryBytes = rows.length * DIRECTORY_ENTRY_BYTES;
  let offset = HEADER_BYTES + directoryBytes;
  const byteLength = offset + rows.reduce((sum, row) => sum + row.chunk.data.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, version, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, rows.length, true);
  view.setUint32(12, HEADER_BYTES, true);
  view.setUint32(16, directoryBytes, true);
  // Bytes 20-31 have been spare since the format was written, and an older
  // bundle reads them back as zero, which is "unspecified" and so a car.
  view.setUint8(20, header.defaultProfileId);
  view.setUint16(22, Math.round(header.maxSpeedKph), true);
  view.setUint32(24, header.profileMask, true);
  view.setUint32(28, header.tileCount, true);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const entry = HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    view.setUint32(entry, row.tileId, true);
    view.setInt32(entry + 4, toFixed(row.bounds.minLat), true);
    view.setInt32(entry + 8, toFixed(row.bounds.minLng), true);
    view.setInt32(entry + 12, toFixed(row.bounds.maxLat), true);
    view.setInt32(entry + 16, toFixed(row.bounds.maxLng), true);
    view.setUint32(entry + 20, offset, true);
    view.setUint32(entry + 24, row.chunk.data.byteLength, true);
    view.setUint32(entry + 28, row.chunk.rawByteLength, true);
    view.setUint16(entry + 32, row.chunk.compression, true);
    view.setUint8(entry + 34, row.profileId);
    new Uint8Array(buffer, offset, row.chunk.data.byteLength).set(new Uint8Array(row.chunk.data));
    offset += row.chunk.data.byteLength;
  }
  return buffer;
}

function singleProfileRows(tiles: BundleGraphTile[], chunks: BundleChunk[]): DirectoryRow[] {
  return tiles.map((tile, index) => ({ tileId: tile.id, bounds: tile.bounds, profileId: SHARED_CHUNK, chunk: chunks[index] }));
}

/** Creates a single, range-addressable bundle from independently readable compact graph tiles. */
export function encodeRoadGraphBundle(tiles: BundleGraphTile[]): ArrayBuffer {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  const chunks = tiles.map((tile) => {
    const data = encodeCompactGraph(compactGraph(tile.graph));
    return { data, rawByteLength: data.byteLength, compression: BundleCompression.none };
  });
  const profile = profileOfTiles(tiles);
  return createBundle(singleProfileRows(tiles, chunks), VERSION, { ...profile, defaultProfileId: profile.profileId, profileMask: maskFor([profile.profileId]), tileCount: tiles.length });
}

/** Creates a bundle with independently gzip-compressed EFR2 chunks. */
export async function encodeCompressedRoadGraphBundle(tiles: BundleGraphTile[], options: BundleEncodeOptions = {}): Promise<ArrayBuffer> {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  if ((options.compression ?? "gzip") === "none") return encodeRoadGraphBundle(tiles);
  const chunks = await Promise.all(tiles.map(async (tile) => {
    const raw = encodeCompactGraph(compactGraph(tile.graph));
    return { data: await gzipChunk(raw), rawByteLength: raw.byteLength, compression: BundleCompression.gzip };
  }));
  const profile = profileOfTiles(tiles);
  return createBundle(singleProfileRows(tiles, chunks), VERSION, { ...profile, defaultProfileId: profile.profileId, profileMask: maskFor([profile.profileId]), tileCount: tiles.length });
}

/** A profile id becomes bit `id - 1`, so a header word lists what a bundle holds. */
function maskFor(profileIds: number[]) {
  let mask = 0;
  for (const id of profileIds) if (id > 0 && id <= 32) mask |= 1 << (id - 1);
  return mask >>> 0;
}

function profilesIn(mask: number) {
  const ids: number[] = [];
  for (let bit = 0; bit < 32; bit += 1) if (mask & (1 << bit)) ids.push(bit + 1);
  return ids;
}

/**
 * Creates a bundle serving several vehicles from one copy of the road network.
 * Each tile contributes its shared chunk once and a small chunk per vehicle,
 * and the directory lists them separately so a reader downloads only the
 * vehicle it asked for.
 */
export async function encodeProfiledRoadGraphBundle(tiles: BundleProfiledTile[], options: BundleEncodeOptions = {}): Promise<ArrayBuffer> {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  const wanted = tiles[0].profiles.map((profile) => profile.profileId);
  if (!wanted.length) throw new Error("A multi-profile bundle requires at least one profile.");
  if (new Set(wanted).size !== wanted.length) throw new Error("A multi-profile bundle cannot list the same profile twice.");
  const gzip = (options.compression ?? "gzip") !== "none";

  const rows: DirectoryRow[] = [];
  for (const tile of tiles) {
    const present = tile.profiles.map((profile) => profile.profileId);
    // Every tile has to answer for the same vehicles, or a route that crosses
    // a tile boundary would change vehicle half-way.
    if (present.length !== wanted.length || present.some((id, index) => id !== wanted[index])) {
      throw new Error("Every tile in a multi-profile bundle must carry the same profiles, in the same order.");
    }
    const pack = async (raw: ArrayBuffer): Promise<BundleChunk> => gzip
      ? { data: await gzipChunk(raw), rawByteLength: raw.byteLength, compression: BundleCompression.gzip }
      : { data: raw, rawByteLength: raw.byteLength, compression: BundleCompression.none };
    const shared = compactGraph(tile.graph);
    rows.push({ tileId: tile.id, bounds: tile.bounds, profileId: SHARED_CHUNK, chunk: await pack(encodeSharedGraph(shared)) });
    for (const profile of tile.profiles) {
      rows.push({ tileId: tile.id, bounds: tile.bounds, profileId: profile.profileId, chunk: await pack(encodeProfileChunk(profile)) });
    }
  }
  const fastest = Math.max(...tiles[0].profiles.map((profile) => profile.maxSpeedKph));
  return createBundle(rows, PROFILED_VERSION, { defaultProfileId: wanted[0], maxSpeedKph: fastest, profileMask: maskFor(wanted), tileCount: tiles.length });
}

export async function openRoadGraphBundle(url: string, fetcher: FetchLike = fetch, options: BundleOpenOptions = {}): Promise<RoadGraphBundle> {
  const header = await fetchRange(url, 0, HEADER_BYTES - 1, fetcher);
  const headerView = new DataView(header);
  const bundleVersion = headerView.getUint16(4, true);
  if (headerView.getUint32(0, true) !== MAGIC || (bundleVersion !== VERSION && bundleVersion !== PROFILED_VERSION) || headerView.getUint16(6, true) !== HEADER_BYTES) {
    throw new Error("Unsupported routing bundle format.");
  }
  const profiled = bundleVersion === PROFILED_VERSION;
  const defaultProfileId = headerView.getUint8(20);
  const defaultVehicle = vehiclePresetName(headerView.getUint8(21)) ?? undefined;
  const headerSpeedKph = headerView.getUint16(22, true);
  // A v1 bundle holds exactly one vehicle, and a zero there means it was
  // written before profiles were recorded, which makes it a car.
  const available = profiled ? profilesIn(headerView.getUint32(24, true)) : [defaultProfileId || ProfileId.car];
  for (const id of available) {
    if (id && !getRoutingProfileById(id)) throw new Error(`This routing bundle was compiled for a profile this build does not support (id ${id}).`);
  }
  const chosenId = options.profile ? getRoutingProfile(options.profile).id : defaultProfileId;
  // A profile whose routes depend on the vehicle's size needs somewhere to
  // keep the limits, and only the split layout has it. Opening such a bundle
  // in the single-chunk layout would route a lorry with its dimensions
  // silently ignored, which is the one outcome worth refusing outright.
  if (!profiled && getRoutingProfileById(chosenId)?.usesPhysicalLimits) {
    throw new Error(`A "${getRoutingProfileById(chosenId)!.name}" bundle must carry its physical limits, which this one cannot: it was written in the single-chunk layout. Recompile it.`);
  }
  if (options.profile && !available.includes(chosenId)) {
    const names = available.map((id) => getRoutingProfileById(id)?.name ?? `id ${id}`).join(", ");
    throw new Error(`This routing bundle does not hold the "${options.profile}" profile. It holds: ${names}.`);
  }
  const entryCount = headerView.getUint32(8, true);
  const directoryOffset = headerView.getUint32(12, true);
  const directoryLength = headerView.getUint32(16, true);
  if (!entryCount || directoryLength !== entryCount * DIRECTORY_ENTRY_BYTES) throw new Error("Invalid routing bundle directory.");
  const directory = await fetchRange(url, directoryOffset, directoryOffset + directoryLength - 1, fetcher);
  const directoryView = new DataView(directory);
  const tiles: BundleTile[] = [];
  const byTileId = new Map<number, BundleTile>();
  for (let index = 0; index < entryCount; index += 1) {
    const entry = index * DIRECTORY_ENTRY_BYTES;
    const compression = directoryView.getUint16(entry + 32, true);
    if (compression !== BundleCompression.none && compression !== BundleCompression.gzip) throw new Error("Unsupported routing bundle chunk compression.");
    const chunk: BundleChunkRef = {
      offset: directoryView.getUint32(entry + 20, true),
      byteLength: directoryView.getUint32(entry + 24, true),
      rawByteLength: directoryView.getUint32(entry + 28, true),
      compression,
    };
    const id = directoryView.getUint32(entry, true);
    const rowProfile = profiled ? directoryView.getUint8(entry + 34) : SHARED_CHUNK;
    if (rowProfile !== SHARED_CHUNK) {
      const tile = byTileId.get(id);
      if (!tile) throw new Error("Invalid routing bundle directory: a profile chunk arrives before its tile.");
      (tile.profileChunks ??= new Map()).set(rowProfile, chunk);
      continue;
    }
    const tile: BundleTile = {
      id,
      bounds: {
        minLat: fromFixed(directoryView.getInt32(entry + 4, true)),
        minLng: fromFixed(directoryView.getInt32(entry + 8, true)),
        maxLat: fromFixed(directoryView.getInt32(entry + 12, true)),
        maxLng: fromFixed(directoryView.getInt32(entry + 16, true)),
      },
      ...chunk,
      ...(profiled ? { profileChunks: new Map<number, BundleChunkRef>() } : {}),
    };
    tiles.push(tile);
    byTileId.set(id, tile);
  }
  if (profiled) {
    for (const tile of tiles) {
      if (!tile.profileChunks?.has(chosenId)) throw new Error(`Invalid routing bundle: tile ${tile.id} has no chunk for the selected profile.`);
    }
  }
  const fetchChunk = async (chunk: BundleChunkRef) => decompressChunk(await fetchRange(url, chunk.offset, chunk.offset + chunk.byteLength - 1, fetcher), chunk.compression);

  // The shared half of a tile is held once, whichever vehicles are asked for:
  // switching vehicle then costs only the small per-vehicle chunk.
  const sharedCache = new Map<number, Promise<SharedRoadGraph>>();
  const profileCache = new Map<string, Promise<ProfileChunk>>();
  const cache = new Map<string, Promise<RoadGraph>>();

  const loadTile = (tile: BundleTile, profileId: number) => {
    const key = `${tile.id}:${profileId}`;
    let graph = cache.get(key);
    if (graph) return graph;
    if (!tile.profileChunks) {
      graph = fetchRange(url, tile.offset, tile.offset + tile.byteLength - 1, fetcher).then((buffer) => decodeChunk(buffer, tile.compression));
    } else {
      let shared = sharedCache.get(tile.id);
      if (!shared) {
        shared = fetchChunk(tile).then(decodeSharedGraph);
        sharedCache.set(tile.id, shared);
        shared.catch(() => sharedCache.delete(tile.id));
      }
      let columns = profileCache.get(key);
      if (!columns) {
        columns = fetchChunk(tile.profileChunks.get(profileId)!).then(decodeProfileChunk);
        profileCache.set(key, columns);
        columns.catch(() => profileCache.delete(key));
      }
      graph = Promise.all([shared, columns]).then(([half, vehicle]) => withSpatialIndex(combineProfiledGraph(half, vehicle)));
    }
    cache.set(key, graph);
    graph.catch(() => cache.delete(key));
    return graph;
  };
  const routeTiles = (origin: Coordinate, destination: Coordinate, ring: number) => {
    const corridor: BundleBounds = {
      minLat: Math.min(origin.lat, destination.lat), minLng: Math.min(origin.lng, destination.lng),
      maxLat: Math.max(origin.lat, destination.lat), maxLng: Math.max(origin.lng, destination.lng),
    };
    const direct = tiles.filter((tile) => intersects(tile.bounds, corridor));
    if (!ring || !direct.length) return direct;
    const latitudePadding = Math.max(...direct.map((tile) => tile.bounds.maxLat - tile.bounds.minLat)) * ring;
    const longitudePadding = Math.max(...direct.map((tile) => tile.bounds.maxLng - tile.bounds.minLng)) * ring;
    return tiles.filter((tile) => intersects(tile.bounds, {
      minLat: corridor.minLat - latitudePadding, minLng: corridor.minLng - longitudePadding,
      maxLat: corridor.maxLat + latitudePadding, maxLng: corridor.maxLng + longitudePadding,
    }));
  };
  // Decoded chunks are already cached, but stitching them together is the
  // larger cost and was being repeated for every route over the same corridor.
  // One corridor per vehicle the bundle offers, so moving between them does
  // not throw away the stitching each time; never fewer than the two an
  // ordinary route needs for its own widening.
  const mergedLimit = Math.max(0, Math.trunc(options.mergedCacheSize ?? Math.max(DEFAULT_MERGED_CACHE_SIZE, available.length)));
  const merged = new Map<string, Promise<RoadGraph>>();
  const loadTiles = async (routeTiles: BundleTile[], profileId = chosenId) => {
    if (!routeTiles.length) throw new RouterError("ROUTE_ACROSS_TILES", "No local graph tiles cover the route corridor.");
    if (routeTiles.length === 1) return loadTile(routeTiles[0], profileId);
    const key = `${profileId}/${routeTiles.map((tile) => tile.id).sort((a, b) => a - b).join(",")}`;
    const held = merged.get(key);
    if (held) {
      // Re-insert so the map's own order is least-recently-used.
      merged.delete(key);
      merged.set(key, held);
      return held;
    }
    const graph = Promise.all(routeTiles.map((tile) => loadTile(tile, profileId))).then(mergeRoadGraphs);
    if (mergedLimit) {
      merged.set(key, graph);
      for (const oldest of merged.keys()) {
        if (merged.size <= mergedLimit) break;
        merged.delete(oldest);
      }
      // A corridor that failed to stitch must not be remembered as the answer.
      graph.catch(() => merged.delete(key));
    }
    return graph;
  };
  return {
    url,
    tiles,
    profileId: chosenId,
    maxSpeedKph: headerSpeedKph,
    profiles: available,
    ...(defaultVehicle ? { defaultVehicle } : {}),
    tilesWithinBudget(origin, destination, budgetMeters) {
      // A tile holding either endpoint is always a candidate: the route has to
      // start and finish somewhere even when the budget is tiny.
      return tiles.filter((tile) =>
        contains(tile.bounds, origin) || contains(tile.bounds, destination) ||
        distanceToBounds(origin, tile.bounds) + distanceToBounds(destination, tile.bounds) <= budgetMeters);
    },
    loadTiles(requested, profileId) {
      return loadTiles(requested, profileId ?? chosenId);
    },
    async loadForRoute(origin, destination) {
      const originTile = tiles.find((tile) => contains(tile.bounds, origin));
      const destinationTile = tiles.find((tile) => contains(tile.bounds, destination));
      if (!originTile || !destinationTile) throw new RouterError("ROUTE_OUTSIDE_COVERAGE", "The route is outside the available bundle coverage.");
      if (originTile.id === destinationTile.id) return loadTile(originTile, chosenId);
      return loadTiles(routeTiles(origin, destination, 0));
    },
    async loadExpandedForRoute(origin, destination) {
      return loadTiles(routeTiles(origin, destination, 1));
    },
  };
}
