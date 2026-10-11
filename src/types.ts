export type Coordinate = { lat: number; lng: number };

export type RoutePreference = "fastest" | "shortest";

export type CoordinateStorage = Float64Array | Int32Array;
export type EdgeWeightStorage = Float32Array | Uint16Array;

/** A local, uniform-grid lookup table for road-node snapping. */
export type NodeSpatialIndex = {
  cellSizeDegrees: number;
  cells: Map<string, Uint32Array>;
};

/**
 * A compact directed road graph. Edge arrays are grouped by source node using
 * edgeOffsets: edges for node n occupy [edgeOffsets[n], edgeOffsets[n + 1]).
 */
export interface RoadGraph {
  nodeLatitudes: CoordinateStorage;
  nodeLongitudes: CoordinateStorage;
  edgeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeDistancesMeters: EdgeWeightStorage;
  edgeDurationsSeconds: EdgeWeightStorage;
  /** Coordinates are divided by this scale. Omitted means degrees are stored directly. */
  coordinateScale?: number;
  /** Edge distance values are multiplied by this scale. Omitted means metres. */
  edgeDistanceScale?: number;
  /** Edge duration values are multiplied by this scale. Omitted means seconds. */
  edgeDurationScale?: number;
  /** Optional intermediate vertices per directed edge, stored using coordinateScale. */
  edgeShapeOffsets?: Uint32Array;
  edgeShapeLatitudes?: Int32Array;
  edgeShapeLongitudes?: Int32Array;
  spatialIndex?: NodeSpatialIndex;
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
