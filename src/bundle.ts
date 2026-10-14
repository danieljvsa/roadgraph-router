import { compactGraph } from "./compact";
import { decodeGraph, encodeCompactGraph } from "./codec";
import { mergeRoadGraphs } from "./merge";
import { withSpatialIndex } from "./spatial-index";
import { RouterError, type Coordinate, type RoadGraph } from "./types";

const MAGIC = 0x42524645; // EFRB
const VERSION = 1;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 40;
const COORDINATE_SCALE = 10_000_000;
/**
 * Two, because answering one route stitches two corridors: the first guess,
 * and the wider one the confirmation pass asks for. Holding only the second
 * makes the next identical route miss on the first, and measurements on a
 * country-sized bundle show no further gain past two.
 */
const DEFAULT_MERGED_CACHE_SIZE = 2;

export const BundleCompression = {
  none: 0,
  gzip: 1,
} as const;
export type BundleCompression = (typeof BundleCompression)[keyof typeof BundleCompression];

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BundleBounds = { minLat: number; minLng: number; maxLat: number; maxLng: number };
export type BundleTile = { id: number; bounds: BundleBounds; offset: number; byteLength: number; rawByteLength: number; compression: BundleCompression };
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
  /** Merges the given tiles, reusing any chunk already downloaded. */
  loadTiles(tiles: BundleTile[]): Promise<RoadGraph>;
};

export type BundleGraphTile = { id: number; bounds: BundleBounds; graph: RoadGraph };
/**
 * `mergedCacheSize` is how many stitched corridors to keep. Stitching is the
 * most expensive part of answering a route, and consecutive routes usually ask
 * for the same tiles, so one is worth holding. Each entry is a whole merged
 * corridor, so raising this trades memory for repeat speed; `0` keeps none and
 * restores the behaviour of releasing a corridor as soon as the route is done.
 */
export type BundleOpenOptions = { mergedCacheSize?: number };
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

async function decodeChunk(buffer: ArrayBuffer, compression: BundleCompression) {
  if (compression === BundleCompression.none) return withSpatialIndex(decodeGraph(buffer));
  if (compression !== BundleCompression.gzip || !("DecompressionStream" in globalThis)) {
    throw new Error("This browser cannot decompress the routing bundle chunk.");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return withSpatialIndex(decodeGraph(await new Response(stream).arrayBuffer()));
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

function createBundle(tiles: BundleGraphTile[], chunks: BundleChunk[]): ArrayBuffer {
  const directoryBytes = tiles.length * DIRECTORY_ENTRY_BYTES;
  let offset = HEADER_BYTES + directoryBytes;
  const byteLength = offset + chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, tiles.length, true);
  view.setUint32(12, HEADER_BYTES, true);
  view.setUint32(16, directoryBytes, true);
  // Bytes 20-31 have been spare since the format was written, and an older
  // bundle reads them back as zero, which is "unspecified" and so a car.
  const profile = profileOfTiles(tiles);
  view.setUint8(20, profile.profileId);
  view.setUint16(22, Math.round(profile.maxSpeedKph), true);
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const chunk = chunks[index];
    const entry = HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    view.setUint32(entry, tile.id, true);
    view.setInt32(entry + 4, toFixed(tile.bounds.minLat), true);
    view.setInt32(entry + 8, toFixed(tile.bounds.minLng), true);
    view.setInt32(entry + 12, toFixed(tile.bounds.maxLat), true);
    view.setInt32(entry + 16, toFixed(tile.bounds.maxLng), true);
    view.setUint32(entry + 20, offset, true);
    view.setUint32(entry + 24, chunk.data.byteLength, true);
    view.setUint32(entry + 28, chunk.rawByteLength, true);
    view.setUint16(entry + 32, chunk.compression, true);
    new Uint8Array(buffer, offset, chunk.data.byteLength).set(new Uint8Array(chunk.data));
    offset += chunk.data.byteLength;
  }
  return buffer;
}

/** Creates a single, range-addressable bundle from independently readable compact graph tiles. */
export function encodeRoadGraphBundle(tiles: BundleGraphTile[]): ArrayBuffer {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  const chunks = tiles.map((tile) => {
    const data = encodeCompactGraph(compactGraph(tile.graph));
    return { data, rawByteLength: data.byteLength, compression: BundleCompression.none };
  });
  return createBundle(tiles, chunks);
}

/** Creates a bundle with independently gzip-compressed EFR2 chunks. */
export async function encodeCompressedRoadGraphBundle(tiles: BundleGraphTile[], options: BundleEncodeOptions = {}): Promise<ArrayBuffer> {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  if ((options.compression ?? "gzip") === "none") return encodeRoadGraphBundle(tiles);
  const chunks = await Promise.all(tiles.map(async (tile) => {
    const raw = encodeCompactGraph(compactGraph(tile.graph));
    return { data: await gzipChunk(raw), rawByteLength: raw.byteLength, compression: BundleCompression.gzip };
  }));
  return createBundle(tiles, chunks);
}

export async function openRoadGraphBundle(url: string, fetcher: FetchLike = fetch, options: BundleOpenOptions = {}): Promise<RoadGraphBundle> {
  const header = await fetchRange(url, 0, HEADER_BYTES - 1, fetcher);
  const headerView = new DataView(header);
  if (headerView.getUint32(0, true) !== MAGIC || headerView.getUint16(4, true) !== VERSION || headerView.getUint16(6, true) !== HEADER_BYTES) {
    throw new Error("Unsupported routing bundle format.");
  }
  const profileId = headerView.getUint8(20);
  const maxSpeedKph = headerView.getUint16(22, true);
  const tileCount = headerView.getUint32(8, true);
  const directoryOffset = headerView.getUint32(12, true);
  const directoryLength = headerView.getUint32(16, true);
  if (!tileCount || directoryLength !== tileCount * DIRECTORY_ENTRY_BYTES) throw new Error("Invalid routing bundle directory.");
  const directory = await fetchRange(url, directoryOffset, directoryOffset + directoryLength - 1, fetcher);
  const directoryView = new DataView(directory);
  const tiles: BundleTile[] = [];
  for (let index = 0; index < tileCount; index += 1) {
    const entry = index * DIRECTORY_ENTRY_BYTES;
    const compression = directoryView.getUint16(entry + 32, true);
    if (compression !== BundleCompression.none && compression !== BundleCompression.gzip) throw new Error("Unsupported routing bundle chunk compression.");
    tiles.push({
      id: directoryView.getUint32(entry, true),
      bounds: {
        minLat: fromFixed(directoryView.getInt32(entry + 4, true)),
        minLng: fromFixed(directoryView.getInt32(entry + 8, true)),
        maxLat: fromFixed(directoryView.getInt32(entry + 12, true)),
        maxLng: fromFixed(directoryView.getInt32(entry + 16, true)),
      },
      offset: directoryView.getUint32(entry + 20, true),
      byteLength: directoryView.getUint32(entry + 24, true),
      rawByteLength: directoryView.getUint32(entry + 28, true),
      compression,
    });
  }
  const cache = new Map<number, Promise<RoadGraph>>();
  const loadTile = (tile: BundleTile) => {
    let graph = cache.get(tile.id);
    if (!graph) {
      graph = fetchRange(url, tile.offset, tile.offset + tile.byteLength - 1, fetcher).then((buffer) => decodeChunk(buffer, tile.compression));
      cache.set(tile.id, graph);
    }
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
  const mergedLimit = Math.max(0, Math.trunc(options.mergedCacheSize ?? DEFAULT_MERGED_CACHE_SIZE));
  const merged = new Map<string, Promise<RoadGraph>>();
  const loadTiles = async (routeTiles: BundleTile[]) => {
    if (!routeTiles.length) throw new RouterError("ROUTE_ACROSS_TILES", "No local graph tiles cover the route corridor.");
    if (routeTiles.length === 1) return loadTile(routeTiles[0]);
    const key = routeTiles.map((tile) => tile.id).sort((a, b) => a - b).join(",");
    const held = merged.get(key);
    if (held) {
      // Re-insert so the map's own order is least-recently-used.
      merged.delete(key);
      merged.set(key, held);
      return held;
    }
    const graph = Promise.all(routeTiles.map(loadTile)).then(mergeRoadGraphs);
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
    profileId,
    maxSpeedKph,
    tilesWithinBudget(origin, destination, budgetMeters) {
      // A tile holding either endpoint is always a candidate: the route has to
      // start and finish somewhere even when the budget is tiny.
      return tiles.filter((tile) =>
        contains(tile.bounds, origin) || contains(tile.bounds, destination) ||
        distanceToBounds(origin, tile.bounds) + distanceToBounds(destination, tile.bounds) <= budgetMeters);
    },
    loadTiles(requested) {
      return loadTiles(requested);
    },
    async loadForRoute(origin, destination) {
      const originTile = tiles.find((tile) => contains(tile.bounds, origin));
      const destinationTile = tiles.find((tile) => contains(tile.bounds, destination));
      if (!originTile || !destinationTile) throw new RouterError("ROUTE_OUTSIDE_COVERAGE", "The route is outside the available bundle coverage.");
      if (originTile.id === destinationTile.id) return loadTile(originTile);
      return loadTiles(routeTiles(origin, destination, 0));
    },
    async loadExpandedForRoute(origin, destination) {
      return loadTiles(routeTiles(origin, destination, 1));
    },
  };
}
