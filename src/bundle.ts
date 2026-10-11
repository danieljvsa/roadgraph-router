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
  loadForRoute(origin: Coordinate, destination: Coordinate): Promise<RoadGraph>;
};

export type BundleGraphTile = { id: number; bounds: BundleBounds; graph: RoadGraph };

function contains(bounds: BundleBounds, coordinate: Coordinate) {
  return coordinate.lat >= bounds.minLat && coordinate.lat <= bounds.maxLat && coordinate.lng >= bounds.minLng && coordinate.lng <= bounds.maxLng;
}

function intersects(first: BundleBounds, second: BundleBounds) {
  return first.minLat <= second.maxLat && first.maxLat >= second.minLat && first.minLng <= second.maxLng && first.maxLng >= second.minLng;
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

/** Creates a single, range-addressable bundle from independently readable compact graph tiles. */
export function encodeRoadGraphBundle(tiles: BundleGraphTile[]): ArrayBuffer {
  if (!tiles.length) throw new Error("A routing bundle requires at least one tile.");
  const chunks = tiles.map((tile) => encodeCompactGraph(compactGraph(tile.graph)));
  const directoryBytes = tiles.length * DIRECTORY_ENTRY_BYTES;
  let offset = HEADER_BYTES + directoryBytes;
  const byteLength = offset + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, tiles.length, true);
  view.setUint32(12, HEADER_BYTES, true);
  view.setUint32(16, directoryBytes, true);
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
    view.setUint32(entry + 24, chunk.byteLength, true);
    view.setUint32(entry + 28, chunk.byteLength, true);
    view.setUint16(entry + 32, BundleCompression.none, true);
    new Uint8Array(buffer, offset, chunk.byteLength).set(new Uint8Array(chunk));
    offset += chunk.byteLength;
  }
  return buffer;
}

export async function openRoadGraphBundle(url: string, fetcher: FetchLike = fetch): Promise<RoadGraphBundle> {
  const header = await fetchRange(url, 0, HEADER_BYTES - 1, fetcher);
  const headerView = new DataView(header);
  if (headerView.getUint32(0, true) !== MAGIC || headerView.getUint16(4, true) !== VERSION || headerView.getUint16(6, true) !== HEADER_BYTES) {
    throw new Error("Unsupported routing bundle format.");
  }
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
  return {
    url,
    tiles,
    async loadForRoute(origin, destination) {
      const originTile = tiles.find((tile) => contains(tile.bounds, origin));
      const destinationTile = tiles.find((tile) => contains(tile.bounds, destination));
      if (!originTile || !destinationTile) throw new RouterError("ROUTE_OUTSIDE_COVERAGE", "The route is outside the available bundle coverage.");
      if (originTile.id === destinationTile.id) return loadTile(originTile);
      const corridor: BundleBounds = {
        minLat: Math.min(origin.lat, destination.lat), minLng: Math.min(origin.lng, destination.lng),
        maxLat: Math.max(origin.lat, destination.lat), maxLng: Math.max(origin.lng, destination.lng),
      };
      const corridorTiles = tiles.filter((tile) => intersects(tile.bounds, corridor));
      return mergeRoadGraphs(await Promise.all(corridorTiles.map(loadTile)));
    },
  };
}
