export type Coordinate = { lat: number; lng: number };

/**
 * The GeoJSON shapes this package returns, declared here rather than taken
 * from `@types/geojson`. They are structurally identical, so a consumer can
 * still assign a result straight to a `GeoJSON.LineString`, but a plain
 * JavaScript or TypeScript project needs no extra types package installed.
 */
export type GeoJsonPosition = number[];
export type GeoJsonLineString = { type: "LineString"; coordinates: GeoJsonPosition[] };

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
  /**
   * The routing profile this graph was compiled for, as a `ProfileId`. Absent
   * means the graph predates profile metadata, and every such graph is a car
   * graph. A graph only answers for the vehicle it was compiled for: a car
   * graph has no footpaths in it to walk along.
   */
  profileId?: number;
  /**
   * The profile's speed ceiling in km/h, carried so a reader can bound its A*
   * heuristic and its tile budget without knowing the profile's rules. Absent
   * falls back to the profile's own ceiling.
   */
  maxSpeedKph?: number;
  /**
   * One bit per edge saying whether this profile may use it, present only on a
   * graph assembled from a shared topology that several profiles share. Absent
   * means every edge is usable. See `./access`.
   */
  edgeAccess?: Uint8Array;
  /**
   * The physical limits in force on the few edges that state any. Present only
   * for a profile whose routes depend on the vehicle's size. See `./limits`.
   */
  edgeLimits?: EdgeLimits;
  /**
   * One bit per turn restriction, saying whether this vehicle obeys it. The
   * pairs come first, then the sequences. Absent means all of them apply.
   */
  restrictionMask?: Uint8Array;
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
  geometry: GeoJsonLineString;
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

/**
 * Signed height, width, length and weight limits, for the edges that have them.
 *
 * A side table rather than four columns over every edge: the overwhelming
 * majority of roads state no limit at all, so columns would spend four bytes
 * per edge saying nothing nearly everywhere. `edges` is sorted, and the four
 * arrays run alongside it. A zero means the limit is not stated, which is not
 * the same as a limit of zero.
 */
export interface EdgeLimits {
  edges: Uint32Array;
  /** Tenths of a metre. */
  heightDecimetres: Uint8Array;
  widthDecimetres: Uint8Array;
  lengthDecimetres: Uint8Array;
  /** Half-tonnes. */
  weightHalfTonnes: Uint8Array;
}

/**
 * A tile's vehicle-independent half: everything a v7 `shared` chunk holds.
 * It is not routable on its own — a profile supplies the durations.
 */
export type SharedRoadGraph = Omit<RoadGraph, "edgeDurationsSeconds" | "edgeDurationScale" | "profileId" | "maxSpeedKph" | "edgeAccess">;

/** A tile's vehicle-dependent half: what a v7 `profile` chunk holds. */
export interface ProfileChunk {
  profileId: number;
  maxSpeedKph: number;
  edgeDurationScale: number;
  edgeDurationsSeconds: Uint16Array;
  /** One bit per edge; absent means this profile may use every road in the tile. */
  edgeAccess?: Uint8Array;
  /** Signed limits for the few edges that state any; absent for vehicles whose size does not matter. */
  edgeLimits?: EdgeLimits;
  /**
   * One bit per turn restriction the shared chunk holds, saying whether this
   * vehicle obeys it. `except=hgv` lifts a restriction for lorries and not for
   * cars, so a shared restriction list needs a per-vehicle answer. Absent
   * means every restriction applies.
   */
  restrictionMask?: Uint8Array;
  /** How many restrictions that mask covers: the pairs, then the sequences. */
  restrictionCount?: number;
}
