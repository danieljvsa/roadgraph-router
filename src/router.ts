import { MinPriorityQueue } from "./priority-queue";
import type { Coordinate, RoadGraph, RoutePreference, RouteResult, RouteSnap } from "./types";
import { RouterError } from "./types";
import { nearbyNodeIds } from "./spatial-index";
import { buildTurnRestrictionIndex, type TurnRestrictionIndex } from "./turn-restrictions";
import { carRoutingProfile } from "./routing-profile";
import { coordinateFor, geometryAfter, geometryBefore, geometryBetween, haversineMeters, snapToGraph, type EdgeProjection, type GraphSnap } from "./snap";

/** Matches the profile's speed ceiling so the fastest-route heuristic stays admissible. */
const MAX_CAR_SPEED_MPS = (carRoutingProfile.maxSpeedKph * 1000) / 3600;

/** Entering the graph: traverse the tail of `edge` to reach `node`. `edge` is -1 at a junction. */
type Seed = { node: number; edge: number; cost: number };
/** Leaving the graph: from `node`, traverse the head of `edge`. `edge` is -1 at a junction. */
type Finisher = { node: number; edge: number; cost: number };

function assertGraph(graph: RoadGraph) {
  const nodes = graph.nodeLatitudes.length;
  const edges = graph.edgeTargets.length;
  if (!nodes || graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) {
    throw new Error("Invalid road graph");
  }
}

/**
 * The nearest routing node to a coordinate. After topology simplification a
 * node is a junction rather than an arbitrary point on a road, so on a long
 * rural road the nearest node can be far away. `route()` snaps to the nearest
 * road instead; prefer `snapToGraph` for anything position-sensitive.
 */
export function findNearestNode(graph: RoadGraph, coordinate: Coordinate, maxDistanceMeters = 500): number | null {
  let closest: number | null = null;
  let closestDistance = maxDistanceMeters;
  const checkNode = (nodeId: number) => {
    const distance = haversineMeters(coordinate, coordinateFor(graph, nodeId));
    if (distance <= closestDistance) {
      closest = nodeId;
      closestDistance = distance;
    }
  };
  if (graph.spatialIndex) {
    for (const nodeId of nearbyNodeIds(graph.spatialIndex, coordinate, maxDistanceMeters)) checkNode(nodeId);
  } else {
    for (let nodeId = 0; nodeId < graph.nodeLatitudes.length; nodeId += 1) checkNode(nodeId);
  }
  return closest;
}

function searchContext(graph: RoadGraph, destinationPoint: Coordinate, preference: RoutePreference) {
  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  return {
    costOf: (edge: number) => preference === "fastest" ? graph.edgeDurationsSeconds[edge] * durationScale : graph.edgeDistancesMeters[edge] * distanceScale,
    heuristicFor: (node: number) => {
      const remaining = haversineMeters(coordinateFor(graph, node), destinationPoint);
      return preference === "fastest" ? remaining / MAX_CAR_SPEED_MPS : remaining;
    },
  };
}

type SearchOutcome = { edges: number[]; finisher: Finisher; seed: Seed } | null;

/**
 * Node-labelled A*. Valid only when no turn is forbidden, because the cost of
 * reaching a node is then independent of how the node was reached.
 */
function searchByNode(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference);
  const nodeCount = graph.nodeLatitudes.length;
  const costs = new Float64Array(nodeCount).fill(Infinity);
  const previousNode = new Int32Array(nodeCount).fill(-1);
  const previousEdge = new Int32Array(nodeCount).fill(-1);
  const seedAt = new Map<number, Seed>();
  const queue = new MinPriorityQueue<number>();
  for (const seed of seeds) {
    if (seed.cost >= costs[seed.node]) continue;
    costs[seed.node] = seed.cost;
    seedAt.set(seed.node, seed);
    queue.push(seed.node, seed.cost + heuristicFor(seed.node));
  }

  let best = Infinity;
  let bestNode = -1;
  let bestFinisher: Finisher | null = null;
  while (queue.size) {
    if (queue.minimumPriority >= best) break;
    const node = queue.pop()!;
    for (const finisher of finishers.get(node) ?? []) {
      const total = costs[node] + finisher.cost;
      if (total < best) { best = total; bestNode = node; bestFinisher = finisher; }
    }
    for (let edge = graph.edgeOffsets[node]; edge < graph.edgeOffsets[node + 1]; edge += 1) {
      const target = graph.edgeTargets[edge];
      const cost = costs[node] + costOf(edge);
      if (cost >= costs[target]) continue;
      costs[target] = cost;
      previousNode[target] = node;
      previousEdge[target] = edge;
      queue.push(target, cost + heuristicFor(target));
    }
  }

  if (!bestFinisher) return null;
  const edges: number[] = [];
  let node = bestNode;
  while (previousNode[node] !== -1) { edges.push(previousEdge[node]); node = previousNode[node]; }
  edges.reverse();
  return { edges, finisher: bestFinisher, seed: seedAt.get(node)! };
}

/**
 * Edge-labelled A*. The search state is "arrived at a node along edge e", the
 * smallest state that can express a banned turn — and exactly the state a
 * mid-edge start already provides, so entering the graph part-way along a road
 * needs no special case and still obeys restrictions on the very first turn.
 */
function searchByEdge(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, restrictions: TurnRestrictionIndex): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference);
  const edgeCount = graph.edgeTargets.length;
  const costs = new Float64Array(edgeCount).fill(Infinity);
  const previousEdge = new Int32Array(edgeCount).fill(-1);
  const seedOf = new Map<number, Seed>();
  const queue = new MinPriorityQueue<number>();

  let best = Infinity;
  let bestArrival = -1;
  let bestFinisher: Finisher | null = null;
  let bestSeed: Seed | null = null;

  const openEdge = (edge: number, cost: number, from: number, seed: Seed | null) => {
    if (cost >= costs[edge]) return;
    costs[edge] = cost;
    previousEdge[edge] = from;
    if (from === -1 && seed) seedOf.set(edge, seed);
    queue.push(edge, cost + heuristicFor(graph.edgeTargets[edge]));
  };

  for (const seed of seeds) {
    if (seed.edge >= 0) {
      // Already on a road: the seed *is* an arrival state at seed.node.
      openEdge(seed.edge, seed.cost, -1, seed);
      for (const finisher of finishers.get(seed.node) ?? []) {
        if (finisher.edge >= 0 && restrictions.get(seed.edge)?.has(finisher.edge)) continue;
        const total = seed.cost + finisher.cost;
        if (total < best) { best = total; bestArrival = seed.edge; bestFinisher = finisher; bestSeed = seed; }
      }
      continue;
    }
    // Starting at a junction: no arriving edge, so no restriction applies yet.
    for (const finisher of finishers.get(seed.node) ?? []) {
      const total = seed.cost + finisher.cost;
      if (total < best) { best = total; bestArrival = -1; bestFinisher = finisher; bestSeed = seed; }
    }
    for (let edge = graph.edgeOffsets[seed.node]; edge < graph.edgeOffsets[seed.node + 1]; edge += 1) {
      openEdge(edge, seed.cost + costOf(edge), -1, seed);
    }
  }

  while (queue.size) {
    if (queue.minimumPriority >= best) break;
    const edge = queue.pop()!;
    const node = graph.edgeTargets[edge];
    const banned = restrictions.get(edge);
    for (const finisher of finishers.get(node) ?? []) {
      if (finisher.edge >= 0 && banned?.has(finisher.edge)) continue;
      const total = costs[edge] + finisher.cost;
      if (total < best) { best = total; bestArrival = edge; bestFinisher = finisher; bestSeed = null; }
    }
    for (let next = graph.edgeOffsets[node]; next < graph.edgeOffsets[node + 1]; next += 1) {
      if (banned?.has(next)) continue;
      openEdge(next, costs[edge] + costOf(next), edge, null);
    }
  }

  if (!bestFinisher) return null;
  const chain: number[] = [];
  for (let edge = bestArrival; edge !== -1; edge = previousEdge[edge]) chain.push(edge);
  chain.reverse();
  const seed = bestSeed ?? (chain.length ? seedOf.get(chain[0])! : seeds[0]);
  // A seed that supplied its own edge entered part-way along it, so that first
  // entry is not a full hop between two nodes.
  if (seed.edge >= 0 && chain[0] === seed.edge) chain.shift();
  return { edges: chain, finisher: bestFinisher, seed };
}

function seedsFor(snap: GraphSnap, costOf: (edge: number) => number): Seed[] {
  if (snap.kind === "node") return [{ node: snap.node, edge: -1, cost: 0 }];
  return snap.projections.map((projection) => ({
    node: projection.target,
    edge: projection.edge,
    cost: (1 - projection.fraction) * costOf(projection.edge),
  }));
}

function finishersFor(snap: GraphSnap, costOf: (edge: number) => number): Finisher[] {
  if (snap.kind === "node") return [{ node: snap.node, edge: -1, cost: 0 }];
  return snap.projections.map((projection) => ({
    node: projection.source,
    edge: projection.edge,
    cost: projection.fraction * costOf(projection.edge),
  }));
}

function projectionOf(snap: GraphSnap, edge: number) {
  return snap.kind === "edge" ? snap.projections.find((projection) => projection.edge === edge) : undefined;
}

function snapSummary(snap: GraphSnap): RouteSnap {
  return snap.kind === "node"
    ? { node: snap.node, edge: -1, point: snap.point, distanceMeters: snap.distanceMeters }
    : { node: -1, edge: snap.projections[0].edge, point: snap.point, distanceMeters: snap.distanceMeters };
}

export function route(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest"): RouteResult {
  assertGraph(graph);
  const originSnap = snapToGraph(graph, from);
  if (!originSnap) throw new RouterError("ORIGIN_NOT_ON_GRAPH", "No routable road is close to the origin.");
  const destinationSnap = snapToGraph(graph, to);
  if (!destinationSnap) throw new RouterError("DESTINATION_NOT_ON_GRAPH", "No routable road is close to the destination.");

  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  const costOf = (edge: number) => preference === "fastest" ? graph.edgeDurationsSeconds[edge] * durationScale : graph.edgeDistancesMeters[edge] * distanceScale;

  const seeds = seedsFor(originSnap, costOf);
  const finisherList = finishersFor(destinationSnap, costOf);
  const finishers = new Map<number, Finisher[]>();
  for (const finisher of finisherList) {
    const bucket = finishers.get(finisher.node);
    if (bucket) bucket.push(finisher);
    else finishers.set(finisher.node, [finisher]);
  }

  // Both ends on the same stretch of road with the destination ahead: the route
  // never reaches a junction, so the search alone cannot express it.
  let direct: { origin: EdgeProjection; destination: EdgeProjection; cost: number } | null = null;
  if (originSnap.kind === "edge" && destinationSnap.kind === "edge") {
    for (const origin of originSnap.projections) {
      const destination = projectionOf(destinationSnap, origin.edge);
      if (!destination || destination.fraction < origin.fraction) continue;
      const cost = (destination.fraction - origin.fraction) * costOf(origin.edge);
      if (!direct || cost < direct.cost) direct = { origin, destination, cost };
    }
  }

  const sameNode = originSnap.kind === "node" && destinationSnap.kind === "node" && originSnap.node === destinationSnap.node;
  const restrictions = buildTurnRestrictionIndex(graph);
  const outcome: SearchOutcome = sameNode
    ? { edges: [], finisher: finisherList[0], seed: seeds[0] }
    : restrictions
      ? searchByEdge(graph, seeds, finishers, destinationSnap.point, preference, restrictions)
      : searchByNode(graph, seeds, finishers, destinationSnap.point, preference);
  if (!outcome && !direct) throw new RouterError("NO_ROUTE", "No car route connects the selected points.");

  const searchCost = outcome ? outcome.seed.cost + outcome.edges.reduce((sum, edge) => sum + costOf(edge), 0) + outcome.finisher.cost : Infinity;
  const partial = (projection: EdgeProjection, fraction: number) => ({
    distance: fraction * graph.edgeDistancesMeters[projection.edge] * distanceScale,
    duration: fraction * graph.edgeDurationsSeconds[projection.edge] * durationScale,
  });

  const coordinates: GeoJSON.Position[] = [];
  const push = (point: Coordinate) => coordinates.push([point.lng, point.lat]);
  const nodeIds: number[] = [];
  let edgeIds: number[] = [];
  let distanceMeters = 0;
  let durationSeconds = 0;

  if (direct && direct.cost <= searchCost) {
    for (const point of geometryBetween(direct.origin, direct.destination)) push(point);
    const span = partial(direct.origin, direct.destination.fraction - direct.origin.fraction);
    distanceMeters = span.distance;
    durationSeconds = span.duration;
  } else {
    const { edges, finisher, seed } = outcome!;
    edgeIds = edges;
    const entry = seed.edge >= 0 ? projectionOf(originSnap, seed.edge) : undefined;
    push(originSnap.point);
    if (entry) {
      for (const point of geometryAfter(entry).slice(1)) push(point);
      const span = partial(entry, 1 - entry.fraction);
      distanceMeters += span.distance;
      durationSeconds += span.duration;
      nodeIds.push(entry.target);
      push(coordinateFor(graph, entry.target));
    } else {
      nodeIds.push(seed.node);
    }
    const scale = graph.coordinateScale ?? 1;
    for (const edge of edges) {
      distanceMeters += graph.edgeDistancesMeters[edge] * distanceScale;
      durationSeconds += graph.edgeDurationsSeconds[edge] * durationScale;
      if (graph.edgeShapeOffsets && graph.edgeShapeLatitudes && graph.edgeShapeLongitudes) {
        for (let point = graph.edgeShapeOffsets[edge]; point < graph.edgeShapeOffsets[edge + 1]; point += 1) {
          coordinates.push([graph.edgeShapeLongitudes[point] / scale, graph.edgeShapeLatitudes[point] / scale]);
        }
      }
      nodeIds.push(graph.edgeTargets[edge]);
      push(coordinateFor(graph, graph.edgeTargets[edge]));
    }
    const exit = finisher.edge >= 0 ? projectionOf(destinationSnap, finisher.edge) : undefined;
    if (exit) {
      for (const point of geometryBefore(exit)) push(point);
      const span = partial(exit, exit.fraction);
      distanceMeters += span.distance;
      durationSeconds += span.duration;
    }
  }

  return {
    nodeIds,
    edgeIds,
    distanceMeters,
    durationSeconds,
    originSnap: snapSummary(originSnap),
    destinationSnap: snapSummary(destinationSnap),
    geometry: { type: "LineString", coordinates },
  };
}
