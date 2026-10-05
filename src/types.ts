export type Coordinate = { lat: number; lng: number };

export type RoutePreference = "fastest" | "shortest";

/**
 * A compact directed road graph. Edge arrays are grouped by source node using
 * edgeOffsets: edges for node n occupy [edgeOffsets[n], edgeOffsets[n + 1]).
 */
export interface RoadGraph {
  nodeLatitudes: Float64Array;
  nodeLongitudes: Float64Array;
  edgeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeDistancesMeters: Float32Array;
  edgeDurationsSeconds: Float32Array;
}

export interface RouteResult {
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationSeconds: number;
  nodeIds: number[];
}

export type RouterErrorCode = "ORIGIN_NOT_ON_GRAPH" | "DESTINATION_NOT_ON_GRAPH" | "NO_ROUTE" | "ROUTE_OUTSIDE_COVERAGE" | "ROUTE_ACROSS_TILES";

export class RouterError extends Error {
  constructor(public readonly code: RouterErrorCode, message: string) {
    super(message);
    this.name = "RouterError";
  }
}
