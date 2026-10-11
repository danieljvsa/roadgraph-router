import type { Coordinate, NodeSpatialIndex, RoadGraph } from "./types";

function cellKey(latitude: number, longitude: number, cellSizeDegrees: number) {
  return `${Math.floor(latitude / cellSizeDegrees)}:${Math.floor(longitude / cellSizeDegrees)}`;
}

function coordinateFor(graph: RoadGraph, nodeId: number): Coordinate {
  const scale = graph.coordinateScale ?? 1;
  return { lat: graph.nodeLatitudes[nodeId] / scale, lng: graph.nodeLongitudes[nodeId] / scale };
}

/** Builds a uniform-grid index. It can be created after decoding without changing the graph format. */
export function createSpatialIndex(graph: RoadGraph, cellSizeDegrees = 0.02): NodeSpatialIndex {
  if (!Number.isFinite(cellSizeDegrees) || cellSizeDegrees <= 0) throw new Error("Spatial index cell size must be positive.");
  const buckets = new Map<string, number[]>();
  for (let nodeId = 0; nodeId < graph.nodeLatitudes.length; nodeId += 1) {
    const coordinate = coordinateFor(graph, nodeId);
    const key = cellKey(coordinate.lat, coordinate.lng, cellSizeDegrees);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(nodeId);
    else buckets.set(key, [nodeId]);
  }
  return {
    cellSizeDegrees,
    cells: new Map([...buckets].map(([key, ids]) => [key, Uint32Array.from(ids)])),
  };
}

export function withSpatialIndex(graph: RoadGraph, cellSizeDegrees?: number): RoadGraph {
  return { ...graph, spatialIndex: createSpatialIndex(graph, cellSizeDegrees) };
}

export function nearbyNodeIds(index: NodeSpatialIndex, coordinate: Coordinate, maxDistanceMeters: number) {
  const latitudeDelta = maxDistanceMeters / 110_574;
  const longitudeDelta = maxDistanceMeters / Math.max(1, 111_320 * Math.cos(coordinate.lat * Math.PI / 180));
  const minLatitudeCell = Math.floor((coordinate.lat - latitudeDelta) / index.cellSizeDegrees);
  const maxLatitudeCell = Math.floor((coordinate.lat + latitudeDelta) / index.cellSizeDegrees);
  const minLongitudeCell = Math.floor((coordinate.lng - longitudeDelta) / index.cellSizeDegrees);
  const maxLongitudeCell = Math.floor((coordinate.lng + longitudeDelta) / index.cellSizeDegrees);
  const ids: number[] = [];
  for (let latitudeCell = minLatitudeCell; latitudeCell <= maxLatitudeCell; latitudeCell += 1) {
    for (let longitudeCell = minLongitudeCell; longitudeCell <= maxLongitudeCell; longitudeCell += 1) {
      const bucket = index.cells.get(`${latitudeCell}:${longitudeCell}`);
      if (bucket) ids.push(...bucket);
    }
  }
  return ids;
}
