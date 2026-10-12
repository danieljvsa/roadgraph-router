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
  /**
   * Banned ordered edge pairs: having arrived along `turnRestrictionFromEdges[i]`,
   * a vehicle may not continue along `turnRestrictionToEdges[i]`. Both arrays
   * have the same length and are sorted by source edge.
   */
  turnRestrictionFromEdges?: Uint32Array;
  turnRestrictionToEdges?: Uint32Array;
  /**
   * Banned edge *sequences*, for OSM restrictions whose `via` is a way rather
   * than a node. Sequence i occupies
   * turnRestrictionSequenceEdges[offsets[i] .. offsets[i + 1]) and forbids
   * traversing those directed edges one after another, in that order. Pairs
   * above are the two-edge case and stay separate because they need no search
   * state to enforce.
   */
  turnRestrictionSequenceOffsets?: Uint32Array;
  turnRestrictionSequenceEdges?: Uint32Array;
  spatialIndex?: NodeSpatialIndex;
}

/** Where a requested coordinate met the road network. */
export interface RouteSnap {
  /** The node snapped to, or -1 when the point landed part-way along an edge. */
  node: number;
  /** The directed edge snapped to, or -1 when the point landed on a node. */
  edge: number;
  /** The point on the road itself, which is where the route geometry starts or ends. */
  point: Coordinate;
  /** How far the requested coordinate was from that road. */
  distanceMeters: number;
}

export interface RouteResult {
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationSeconds: number;
  nodeIds: number[];
  /** The directed edges traversed, in order. `edgeIds[i]` joins `nodeIds[i]` to `nodeIds[i + 1]`. */
  edgeIds: number[];
  /**
   * The partial edges a route enters and leaves on are not listed in `edgeIds`,
   * because they are not hops between two nodes. These describe them, and the
   * geometry always begins and ends at the snapped points rather than at a node.
   */
  originSnap: RouteSnap;
  destinationSnap: RouteSnap;
}

export type RouterErrorCode = "ORIGIN_NOT_ON_GRAPH" | "DESTINATION_NOT_ON_GRAPH" | "NO_ROUTE" | "ROUTE_OUTSIDE_COVERAGE" | "ROUTE_ACROSS_TILES";

export class RouterError extends Error {
  constructor(public readonly code: RouterErrorCode, message: string) {
    super(message);
    this.name = "RouterError";
  }
}
