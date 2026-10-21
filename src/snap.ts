import type { Coordinate, RoadGraph } from "./types";
import { edgePolyline, edgeSource, edgeSpatialIndexFor, nearbyEdgeIds } from "./edge-index";
import { nearbyNodeIds } from "./spatial-index";
import { edgeAllowed } from "./access";
import { RailService } from "./railway";

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

/**
 * The same thing for a railway, where it has to be far wider.
 *
 * A two-way road is one carriageway carrying a forward and a reverse edge at
 * exactly the same distance, so half a metre is enough to keep both. A railway
 * is not built that way: the two directions are usually separate parallel
 * tracks several metres apart, each one-way, and half a metre keeps only
 * whichever happens to be marginally nearer. A route then has to leave in that
 * track's direction whether or not its destination lies that way — Trindade to
 * Senhor de Matosinhos came back as 16.1 km instead of 11.9 because the
 * southbound track was 3 m closer than the northbound one.
 *
 * Twelve metres covers the two tracks of a double-track line and stops there.
 * It is deliberately not wide enough to reach across a station to another
 * line's platform: at Trindade a 25 m tolerance put the route on the Linha D
 * track, 27 m away, and it then crossed back through the depot.
 *
 * Offering more starting points cannot make a route worse — each carries the
 * cost of reaching it, and the search still returns the cheapest — but
 * offering the wrong platform makes it answer a different question.
 */
const PARALLEL_TRACK_TOLERANCE_METERS = 12;

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
/**
 * How much further than it really is a track counts when choosing where to
 * start or finish, so that a running line wins a near tie against a siding.
 *
 * Every platform at a station has a yard or a crossover a few metres beside
 * it, and nearest-wins puts the route in the depot: at Trindade the yard track
 * is 4.6 m from the station node and the running line 6.7 m, so a Metro do
 * Porto route began in the sidings and had to cross out, which looks exactly
 * like a routing fault and is really a snapping one.
 *
 * It is a preference, not a ban. A point genuinely inside a yard is far closer
 * to that yard than this, and still snaps to it; the constraint that removes
 * service track altogether is `excludeServiceTracks`. The penalty is used only
 * to rank candidates — the distance reported back is the true one.
 */
const SERVICE_TRACK_SNAP_PENALTY_METERS = 30;

/** Zero for a road graph, which describes no track and must not change. */
function snapPenaltyFor(graph: RoadGraph, edge: number) {
  const table = graph.edgeRailway;
  if (!table) return 0;
  const row = table.edgeRows[edge];
  return row && table.service[row] !== RailService.running ? SERVICE_TRACK_SNAP_PENALTY_METERS : 0;
}

export function snapToGraph(graph: RoadGraph, coordinate: Coordinate, maxDistanceMeters = DEFAULT_SNAP_RADIUS_METERS, access: Uint8Array | undefined = graph.edgeAccess, accept?: (node: number) => boolean, everyNearbyRoad = false): GraphSnap | null {
  const candidates = graph.edgeTargets.length
    ? nearbyEdgeIds(edgeSpatialIndexFor(graph), coordinate, maxDistanceMeters)
    : new Set<number>();

  let best: EdgeProjection | null = null;
  let bestRank = Infinity;
  // The ranking distance for each candidate, which is its true distance plus
  // whatever the track it lies on is penalised by.
  const rankOf = new Map<number, number>();
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
    const rank = projection.distanceMeters + snapPenaltyFor(graph, edge);
    rankOf.set(edge, rank);
    if (!best || rank < bestRank) { best = projection; bestRank = rank; }
  }

  if (!best) {
    // A graph with no edges at all can still answer with its nearest node.
    const node = nearestNodeWithin(graph, coordinate, maxDistanceMeters, accept);
    return node === null ? null : { kind: "node", node, point: coordinateFor(graph, node), distanceMeters: haversineMeters(coordinate, coordinateFor(graph, node)) };
  }

  // Landing on a junction is reported as that node, which keeps routes between
  // exact node coordinates behaving as they always have. A caller asking for
  // every nearby road wants the choice, so it is not collapsed to one node.
  //
  // A railway station is the exception, and it is not a small one. A station
  // node sits on one of the platform tracks, and the others — the opposite
  // direction among them — are separate ways a few metres away. Collapsing to
  // the node throws them away and the route has to leave in whatever direction
  // that one track runs: 36 of Metro do Porto's 49 stations collapsed this
  // way, and Aliados to Faria Guimarães, two stops apart on one line, came
  // back as 7.4 km one way and 1.0 km the other. Track keeps its projections,
  // and the node remains reachable as the projection at the end of its own edge.
  const collapseToNode = !everyNearbyRoad && !graph.edgeRailway;
  const startMeters = best.fraction * totalLengthOf(best);
  const endMeters = (1 - best.fraction) * totalLengthOf(best);
  if (collapseToNode && startMeters <= NODE_SNAP_TOLERANCE_METERS) return { kind: "node", node: best.source, point: best.polyline[0], distanceMeters: best.distanceMeters };
  if (collapseToNode && endMeters <= NODE_SNAP_TOLERANCE_METERS) return { kind: "node", node: best.target, point: best.polyline[best.polyline.length - 1], distanceMeters: best.distanceMeters };

  // Normally only the nearest road is offered, as the forward and reverse copy
  // of one stretch: a route should begin on the road you are standing on, not
  // on whichever road within the radius happens to make the sums work out.
  //
  // `everyNearbyRoad` lifts that, because the nearest road is sometimes one
  // the rest of the network cannot legally reach — a pocket of one-way streets
  // behind banned turns, or an island of service roads. Offering the search
  // every road in range lets it finish on one it can actually get to.
  const rank = (projection: EdgeProjection) => rankOf.get(projection.edge) ?? projection.distanceMeters;
  const tolerance = graph.edgeRailway ? PARALLEL_TRACK_TOLERANCE_METERS : TIE_TOLERANCE_METERS;
  const sameRoad = everyNearbyRoad
    ? projections.sort((left, right) => rank(left) - rank(right))
    : projections.filter((projection) => rank(projection) <= bestRank + tolerance).sort((left, right) => rank(left) - rank(right));
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
