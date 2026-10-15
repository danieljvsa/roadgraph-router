import type { Coordinate, RoadGraph } from "./types";
import { edgePolyline, edgeSource, edgeSpatialIndexFor, nearbyEdgeIds } from "./edge-index";
import { nearbyNodeIds } from "./spatial-index";
import { edgeAllowed } from "./access";

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_DEGREE_LATITUDE = 110_574;
const METERS_PER_DEGREE_LONGITUDE = 111_320;

/**
 * How close to an edge's endpoint a projection has to land before the snap is
 * reported as that node instead. Starting a route from a junction is both
 * simpler and what a caller passing exact node coordinates expects.
 */
const NODE_SNAP_TOLERANCE_METERS = 1;

/** Two directed edges this much closer than the best are treated as the same road. */
const TIE_TOLERANCE_METERS = 0.5;

/** How far from a point a road may be and still count as the road you are on. */
export const DEFAULT_SNAP_RADIUS_METERS = 500;

/**
 * How far a last-resort snap will look when the roads nearby turn out to be
 * unreachable. A route ending this far from the point asked for is a poor
 * answer, but it is a better one than refusing to route at all, and
 * `RouteResult.destinationSnap.distanceMeters` says how far off it is.
 */
export const FALLBACK_SNAP_RADIUS_METERS = 1_000;

export function haversineMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const latA = a.lat * radians;
  const latB = b.lat * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function coordinateFor(graph: RoadGraph, nodeId: number): Coordinate {
  const scale = graph.coordinateScale ?? 1;
  return { lat: graph.nodeLatitudes[nodeId] / scale, lng: graph.nodeLongitudes[nodeId] / scale };
}

/** Where a coordinate lands on one directed edge. */
export type EdgeProjection = {
  edge: number;
  source: number;
  target: number;
  /** How far along the edge the projection sits, 0 at the source and 1 at the target. */
  fraction: number;
  /** The point on the road itself. */
  point: Coordinate;
  /** Distance from the queried coordinate to that point. */
  distanceMeters: number;
  /** Index of the polyline vertex the projection follows, for slicing geometry. */
  vertexIndex: number;
  polyline: Coordinate[];
};

/**
 * Snapping a coordinate onto the graph. A `node` snap behaves exactly as this
 * package always has; an `edge` snap carries one projection per directed edge
 * covering the same stretch of road, so a two-way road offers both directions
 * and a one-way road offers only the legal one.
 */
export type GraphSnap =
  | { kind: "node"; node: number; point: Coordinate; distanceMeters: number }
  | { kind: "edge"; projections: EdgeProjection[]; point: Coordinate; distanceMeters: number };

/**
 * Projects onto a polyline using a local planar approximation around the query
 * point, which is accurate well past the snapping radius, while segment lengths
 * stay haversine so the reported fraction matches the edge's stored length.
 */
function projectOntoPolyline(points: Coordinate[], query: Coordinate) {
  const longitudeScale = METERS_PER_DEGREE_LONGITUDE * Math.cos(query.lat * Math.PI / 180);
  const x = (point: Coordinate) => (point.lng - query.lng) * longitudeScale;
  const y = (point: Coordinate) => (point.lat - query.lat) * METERS_PER_DEGREE_LATITUDE;

  let best = { distanceMeters: Infinity, vertexIndex: 0, along: 0, point: points[0] };
  let travelled = 0;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentMeters = haversineMeters(start, end);
    const dx = x(end) - x(start);
    const dy = y(end) - y(start);
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, (-x(start) * dx + -y(start) * dy) / lengthSquared)) : 0;
    const closest = { lat: start.lat + (end.lat - start.lat) * t, lng: start.lng + (end.lng - start.lng) * t };
    const distanceMeters = haversineMeters(query, closest);
    if (distanceMeters < best.distanceMeters) {
      best = { distanceMeters, vertexIndex: index - 1, along: travelled + segmentMeters * t, point: closest };
    }
    travelled += segmentMeters;
    total += segmentMeters;
  }
  return { ...best, totalMeters: total };
}

/**
 * Finds the road nearest to a coordinate. Returns null when nothing routable
 * lies within `maxDistanceMeters` of the coordinate — measured to the road
 * surface, not to the nearest junction.
 */
export function snapToGraph(graph: RoadGraph, coordinate: Coordinate, maxDistanceMeters = DEFAULT_SNAP_RADIUS_METERS, access: Uint8Array | undefined = graph.edgeAccess, accept?: (node: number) => boolean, everyNearbyRoad = false): GraphSnap | null {
  const candidates = graph.edgeTargets.length
    ? nearbyEdgeIds(edgeSpatialIndexFor(graph), coordinate, maxDistanceMeters)
    : new Set<number>();

  let best: EdgeProjection | null = null;
  const projections: EdgeProjection[] = [];
  for (const edge of candidates) {
    // A road this vehicle may not use is not a road to start or finish on.
    if (!edgeAllowed(access, edge)) continue;
    const source = edgeSource(graph, edge);
    // A caller that already knows the route failed can rule out the piece of
    // the network the other end cannot be reached from.
    if (accept && !(accept(source) && accept(graph.edgeTargets[edge]))) continue;
    const polyline = edgePolyline(graph, edge, source);
    const projected = projectOntoPolyline(polyline, coordinate);
    if (projected.distanceMeters > maxDistanceMeters) continue;
    const projection: EdgeProjection = {
      edge,
      source,
      target: graph.edgeTargets[edge],
      fraction: projected.totalMeters ? projected.along / projected.totalMeters : 0,
      point: projected.point,
      distanceMeters: projected.distanceMeters,
      vertexIndex: projected.vertexIndex,
      polyline,
    };
    projections.push(projection);
    if (!best || projection.distanceMeters < best.distanceMeters) best = projection;
  }

  if (!best) {
    // A graph with no edges at all can still answer with its nearest node.
    const node = nearestNodeWithin(graph, coordinate, maxDistanceMeters, accept);
    return node === null ? null : { kind: "node", node, point: coordinateFor(graph, node), distanceMeters: haversineMeters(coordinate, coordinateFor(graph, node)) };
  }

  // Landing on a junction is reported as that node, which keeps routes between
  // exact node coordinates behaving as they always have. A caller asking for
  // every nearby road wants the choice, so it is not collapsed to one node.
  const startMeters = best.fraction * totalLengthOf(best);
  const endMeters = (1 - best.fraction) * totalLengthOf(best);
  if (!everyNearbyRoad && startMeters <= NODE_SNAP_TOLERANCE_METERS) return { kind: "node", node: best.source, point: best.polyline[0], distanceMeters: best.distanceMeters };
  if (!everyNearbyRoad && endMeters <= NODE_SNAP_TOLERANCE_METERS) return { kind: "node", node: best.target, point: best.polyline[best.polyline.length - 1], distanceMeters: best.distanceMeters };

  // Normally only the nearest road is offered, as the forward and reverse copy
  // of one stretch: a route should begin on the road you are standing on, not
  // on whichever road within the radius happens to make the sums work out.
  //
  // `everyNearbyRoad` lifts that, because the nearest road is sometimes one
  // the rest of the network cannot legally reach — a pocket of one-way streets
  // behind banned turns, or an island of service roads. Offering the search
  // every road in range lets it finish on one it can actually get to.
  const sameRoad = everyNearbyRoad
    ? projections.sort((left, right) => left.distanceMeters - right.distanceMeters)
    : projections.filter((projection) => projection.distanceMeters <= best!.distanceMeters + TIE_TOLERANCE_METERS);
  return { kind: "edge", projections: sameRoad, point: best.point, distanceMeters: best.distanceMeters };
}

function totalLengthOf(projection: EdgeProjection) {
  let total = 0;
  for (let index = 1; index < projection.polyline.length; index += 1) total += haversineMeters(projection.polyline[index - 1], projection.polyline[index]);
  return total;
}

function nearestNodeWithin(graph: RoadGraph, coordinate: Coordinate, maxDistanceMeters: number, accept?: (node: number) => boolean) {
  let closest: number | null = null;
  let closestDistance = maxDistanceMeters;
  const check = (nodeId: number) => {
    if (accept && !accept(nodeId)) return;
    const distance = haversineMeters(coordinate, coordinateFor(graph, nodeId));
    if (distance <= closestDistance) { closest = nodeId; closestDistance = distance; }
  };
  if (graph.spatialIndex) for (const nodeId of nearbyNodeIds(graph.spatialIndex, coordinate, maxDistanceMeters)) check(nodeId);
  else for (let nodeId = 0; nodeId < graph.nodeLatitudes.length; nodeId += 1) check(nodeId);
  return closest;
}

/** The part of an edge's geometry from the projection onwards, excluding the target node. */
export function geometryAfter(projection: EdgeProjection) {
  return [projection.point, ...projection.polyline.slice(projection.vertexIndex + 1, projection.polyline.length - 1)];
}

/** The part of an edge's geometry up to the projection, excluding the source node. */
export function geometryBefore(projection: EdgeProjection) {
  return [...projection.polyline.slice(1, projection.vertexIndex + 1), projection.point];
}

/** The geometry strictly between two projections on the same edge. */
export function geometryBetween(from: EdgeProjection, to: EdgeProjection) {
  return [from.point, ...from.polyline.slice(from.vertexIndex + 1, to.vertexIndex + 1), to.point];
}
