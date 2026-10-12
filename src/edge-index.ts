import type { Coordinate, RoadGraph } from "./types";

/**
 * A uniform-grid index over directed edges. Snapping needs the nearest *road*,
 * not the nearest junction: after topology simplification a rural edge can run
 * for a kilometre without a node, so a node-only index cannot answer "which
 * road am I standing on".
 *
 * Each edge is registered in every cell its bounding box touches, which keeps
 * construction linear and lookups to a handful of cells.
 */
export type EdgeSpatialIndex = {
  cellSizeDegrees: number;
  cells: Map<string, Uint32Array>;
  /** Edges whose extent covers too many cells to list individually. */
  oversized: Uint32Array;
};

/** An edge spanning more cells than this is held aside rather than written into each one. */
const MAX_CELLS_PER_EDGE = 4096;

function cellKey(latitudeCell: number, longitudeCell: number) {
  return `${latitudeCell}:${longitudeCell}`;
}

/** Recovers an edge's source node from the CSR offsets. */
export function edgeSource(graph: RoadGraph, edge: number) {
  let low = 0;
  let high = graph.nodeLatitudes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (graph.edgeOffsets[middle] <= edge) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The full vertex list of a directed edge: source node, shape points, target node. */
export function edgePolyline(graph: RoadGraph, edge: number, source = edgeSource(graph, edge)): Coordinate[] {
  const scale = graph.coordinateScale ?? 1;
  const target = graph.edgeTargets[edge];
  const points: Coordinate[] = [{ lat: graph.nodeLatitudes[source] / scale, lng: graph.nodeLongitudes[source] / scale }];
  if (graph.edgeShapeOffsets && graph.edgeShapeLatitudes && graph.edgeShapeLongitudes) {
    for (let point = graph.edgeShapeOffsets[edge]; point < graph.edgeShapeOffsets[edge + 1]; point += 1) {
      points.push({ lat: graph.edgeShapeLatitudes[point] / scale, lng: graph.edgeShapeLongitudes[point] / scale });
    }
  }
  points.push({ lat: graph.nodeLatitudes[target] / scale, lng: graph.nodeLongitudes[target] / scale });
  return points;
}

export function createEdgeSpatialIndex(graph: RoadGraph, cellSizeDegrees = 0.02): EdgeSpatialIndex {
  if (!Number.isFinite(cellSizeDegrees) || cellSizeDegrees <= 0) throw new Error("Edge index cell size must be positive.");
  const scale = graph.coordinateScale ?? 1;
  const buckets = new Map<string, number[]>();
  const oversized: number[] = [];
  const shapeOffsets = graph.edgeShapeOffsets;
  const shapeLatitudes = graph.edgeShapeLatitudes;
  const shapeLongitudes = graph.edgeShapeLongitudes;
  for (let source = 0; source < graph.nodeLatitudes.length; source += 1) {
    const sourceLat = graph.nodeLatitudes[source] / scale;
    const sourceLng = graph.nodeLongitudes[source] / scale;
    for (let edge = graph.edgeOffsets[source]; edge < graph.edgeOffsets[source + 1]; edge += 1) {
      const target = graph.edgeTargets[edge];
      let minLat = Math.min(sourceLat, graph.nodeLatitudes[target] / scale);
      let maxLat = Math.max(sourceLat, graph.nodeLatitudes[target] / scale);
      let minLng = Math.min(sourceLng, graph.nodeLongitudes[target] / scale);
      let maxLng = Math.max(sourceLng, graph.nodeLongitudes[target] / scale);
      if (shapeOffsets && shapeLatitudes && shapeLongitudes) {
        for (let point = shapeOffsets[edge]; point < shapeOffsets[edge + 1]; point += 1) {
          const lat = shapeLatitudes[point] / scale;
          const lng = shapeLongitudes[point] / scale;
          if (lat < minLat) minLat = lat; else if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng; else if (lng > maxLng) maxLng = lng;
        }
      }
      const minLatCell = Math.floor(minLat / cellSizeDegrees);
      const maxLatCell = Math.floor(maxLat / cellSizeDegrees);
      const minLngCell = Math.floor(minLng / cellSizeDegrees);
      const maxLngCell = Math.floor(maxLng / cellSizeDegrees);
      if (!Number.isFinite(minLatCell) || !Number.isFinite(minLngCell) || (maxLatCell - minLatCell + 1) * (maxLngCell - minLngCell + 1) > MAX_CELLS_PER_EDGE) { oversized.push(edge); continue; }
      for (let latitudeCell = minLatCell; latitudeCell <= maxLatCell; latitudeCell += 1) {
        for (let longitudeCell = minLngCell; longitudeCell <= maxLngCell; longitudeCell += 1) {
          const key = cellKey(latitudeCell, longitudeCell);
          const bucket = buckets.get(key);
          if (bucket) bucket.push(edge);
          else buckets.set(key, [edge]);
        }
      }
    }
  }
  return { cellSizeDegrees, cells: new Map([...buckets].map(([key, ids]) => [key, Uint32Array.from(ids)])), oversized: Uint32Array.from(oversized) };
}

/**
 * Built on first use rather than at decode: a route pays for it, a plain graph
 * load does not. Keyed weakly so a discarded tile's index is collectable.
 */
const indexes = new WeakMap<RoadGraph, EdgeSpatialIndex>();

export function edgeSpatialIndexFor(graph: RoadGraph, cellSizeDegrees?: number) {
  let index = indexes.get(graph);
  if (!index) {
    index = createEdgeSpatialIndex(graph, cellSizeDegrees);
    indexes.set(graph, index);
  }
  return index;
}

export function nearbyEdgeIds(index: EdgeSpatialIndex, coordinate: Coordinate, maxDistanceMeters: number) {
  const latitudeDelta = maxDistanceMeters / 110_574;
  const longitudeDelta = maxDistanceMeters / Math.max(1, 111_320 * Math.cos(coordinate.lat * Math.PI / 180));
  const minLatitudeCell = Math.floor((coordinate.lat - latitudeDelta) / index.cellSizeDegrees);
  const maxLatitudeCell = Math.floor((coordinate.lat + latitudeDelta) / index.cellSizeDegrees);
  const minLongitudeCell = Math.floor((coordinate.lng - longitudeDelta) / index.cellSizeDegrees);
  const maxLongitudeCell = Math.floor((coordinate.lng + longitudeDelta) / index.cellSizeDegrees);
  const ids = new Set<number>(index.oversized);
  for (let latitudeCell = minLatitudeCell; latitudeCell <= maxLatitudeCell; latitudeCell += 1) {
    for (let longitudeCell = minLongitudeCell; longitudeCell <= maxLongitudeCell; longitudeCell += 1) {
      const bucket = index.cells.get(cellKey(latitudeCell, longitudeCell));
      if (bucket) for (const id of bucket) ids.add(id);
    }
  }
  return ids;
}
