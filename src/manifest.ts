import { decodeGraph } from "./codec";
import { mergeRoadGraphs } from "./merge";
import { RouterError, type Coordinate, type RoadGraph } from "./types";

export type GraphBounds = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export type GraphTile = {
  id: string;
  href: string;
  bounds: GraphBounds;
  bytes: number;
  nodes: number;
  edges: number;
  checksum?: string;
};

/** A portable, hostable description of route graph assets. */
export type RouteGraphManifest = {
  formatVersion: 1;
  region: { id: string; name: string };
  profile: "car";
  generatedAt: string;
  tiles: GraphTile[];
};

export type RouteGraphLoader = {
  manifest: RouteGraphManifest;
  loadForRoute(origin: Coordinate, destination: Coordinate): Promise<RoadGraph>;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function decodeTile(buffer: ArrayBuffer, href: string) {
  if (!href.endsWith(".gz")) return decodeGraph(buffer);
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("This browser cannot decompress local routing data.");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return decodeGraph(await new Response(stream).arrayBuffer());
}

function contains(bounds: GraphBounds, coordinate: Coordinate) {
  return coordinate.lat >= bounds.minLat && coordinate.lat <= bounds.maxLat && coordinate.lng >= bounds.minLng && coordinate.lng <= bounds.maxLng;
}

function intersects(first: GraphBounds, second: GraphBounds) {
  return first.minLat <= second.maxLat && first.maxLat >= second.minLat && first.minLng <= second.maxLng && first.maxLng >= second.minLng;
}

/**
 * Loads static graph files hosted alongside an application. The first version
 * Overlapping tiles are stitched through the shared OSM boundary nodes emitted
 * by the compiler, so an app never has to download a whole country's graph.
 */
export async function createRouteGraphLoader(manifestUrl: string, fetcher: FetchLike = fetch): Promise<RouteGraphLoader> {
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) throw new Error("Unable to load the route graph manifest.");
  const manifest = await manifestResponse.json() as RouteGraphManifest;
  if (manifest.formatVersion !== 1 || manifest.profile !== "car" || !Array.isArray(manifest.tiles)) {
    throw new Error("Unsupported route graph manifest.");
  }

  const graphs = new Map<string, Promise<RoadGraph>>();
  const loadTile = (tile: GraphTile) => {
    let graph = graphs.get(tile.href);
    if (!graph) {
      graph = fetcher(tile.href)
        .then((response) => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`Unable to load route tile ${tile.id}.`)))
        .then((buffer) => decodeTile(buffer, tile.href));
      graphs.set(tile.href, graph);
    }
    return graph;
  };

  return {
    manifest,
    async loadForRoute(origin, destination) {
      const originTile = manifest.tiles.find((tile) => contains(tile.bounds, origin));
      const destinationTile = manifest.tiles.find((tile) => contains(tile.bounds, destination));
      if (!originTile || !destinationTile) {
        throw new RouterError("ROUTE_OUTSIDE_COVERAGE", `${manifest.region.name} is outside the available local routing coverage.`);
      }
      if (originTile.href === destinationTile.href) return loadTile(originTile);

      const corridor: GraphBounds = {
        minLat: Math.min(origin.lat, destination.lat),
        minLng: Math.min(origin.lng, destination.lng),
        maxLat: Math.max(origin.lat, destination.lat),
        maxLng: Math.max(origin.lng, destination.lng),
      };
      const corridorTiles = manifest.tiles.filter((tile) => intersects(tile.bounds, corridor));
      if (!corridorTiles.some((tile) => tile.href === originTile.href) || !corridorTiles.some((tile) => tile.href === destinationTile.href)) {
        throw new RouterError("ROUTE_ACROSS_TILES", "The route tiles do not form a connected corridor.");
      }
      return mergeRoadGraphs(await Promise.all(corridorTiles.map(loadTile)));
    },
  };
}
