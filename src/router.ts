import { MinPriorityQueue } from "./priority-queue";
import type { Coordinate, GeoJsonPosition, RoadGraph, RoutePreference, RouteResult, RouteSnap } from "./types";
import { RouterError } from "./types";
import { nearbyNodeIds } from "./spatial-index";
import { edgeAllowed } from "./access";
import { buildTurnRestrictionIndex, buildTurnSequenceIndex, type TurnRestrictionIndex, type TurnSequenceIndex } from "./turn-restrictions";
import { maxSpeedMpsFor, profileOf } from "./routing-profile";
import { coordinateFor, geometryAfter, geometryBefore, geometryBetween, haversineMeters, snapToGraph, type EdgeProjection, type GraphSnap } from "./snap";

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
  // The ceiling comes from the graph, not from this file: dividing a walking
  // route's remaining distance by a car's top speed keeps the heuristic
  // admissible but drives it to nearly zero, which turns A* into Dijkstra.
  const maxSpeedMps = maxSpeedMpsFor(graph);
  return {
    costOf: (edge: number) => preference === "fastest" ? graph.edgeDurationsSeconds[edge] * durationScale : graph.edgeDistancesMeters[edge] * distanceScale,
    heuristicFor: (node: number) => {
      const remaining = haversineMeters(coordinateFor(graph, node), destinationPoint);
      return preference === "fastest" ? remaining / maxSpeedMps : remaining;
    },
  };
}

type SearchOutcome = { edges: number[]; finisher: Finisher; seed: Seed } | null;

/**
 * Node-labelled A*. Valid only when no turn is forbidden, because the cost of
 * reaching a node is then independent of how the node was reached.
 */
function searchByNode(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, costBound = Infinity): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference);
  const access = graph.edgeAccess;
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

  let best = costBound;
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
      if (!edgeAllowed(access, edge)) continue;
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
function searchByEdge(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, restrictions: TurnRestrictionIndex | null, sequenceIndex: TurnSequenceIndex | null, costBound = Infinity): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference);
  const access = graph.edgeAccess;
  const edgeCount = graph.edgeTargets.length;
  const costs = new Float64Array(edgeCount).fill(Infinity);
  const previousState = new Int32Array(edgeCount).fill(-1);
  const seedOf = new Map<number, Seed>();
  const queue = new MinPriorityQueue<number>();

  // A banned run of three or more edges needs to remember how much of it has
  // been driven, which a plain "arrived along edge e" state cannot hold. Those
  // few states live alongside the typed arrays rather than widening them, so
  // the ordinary case keeps costing exactly one array slot per edge.
  const sequences = sequenceIndex?.sequences ?? [];
  const startingAt = sequenceIndex?.startingAt;
  const partialEdge: number[] = [];
  const partialMatches: number[][] = [];
  const partialCost: number[] = [];
  const partialPrevious: number[] = [];
  const partialIds = new Map<string, number>();
  const stride = sequenceIndex?.stride ?? 1;
  const encode = (sequence: number, position: number) => sequence * stride + position;

  const edgeOf = (state: number) => state < edgeCount ? state : partialEdge[state - edgeCount];
  const matchesOf = (state: number) => state < edgeCount ? undefined : partialMatches[state - edgeCount];
  const costOfState = (state: number) => state < edgeCount ? costs[state] : partialCost[state - edgeCount];

  const relax = (state: number, cost: number, from: number, seed: Seed | null) => {
    if (state < edgeCount) {
      if (cost >= costs[state]) return;
      costs[state] = cost;
      previousState[state] = from;
      if (from === -1 && seed) seedOf.set(state, seed);
    } else {
      const slot = state - edgeCount;
      if (cost >= partialCost[slot]) return;
      partialCost[slot] = cost;
      partialPrevious[slot] = from;
    }
    queue.push(state, cost + heuristicFor(graph.edgeTargets[edgeOf(state)]));
  };

  const stateFor = (edge: number, matches: number[]) => {
    if (!matches.length) return edge;
    const key = `${edge}:${matches.sort((a, b) => a - b).join(",")}`;
    let id = partialIds.get(key);
    if (id === undefined) {
      id = edgeCount + partialEdge.length;
      partialIds.set(key, id);
      partialEdge.push(edge);
      partialMatches.push(matches);
      partialCost.push(Infinity);
      partialPrevious.push(-1);
    }
    return id;
  };

  /**
   * Where `next` may be driven after `edge`. Returns the follow-on matches, or
   * null when taking it would complete a banned run.
   */
  const advance = (edge: number, matches: number[] | undefined, next: number): number[] | null => {
    const carried: number[] = [];
    if (matches) {
      for (const match of matches) {
        const sequence = sequences[Math.floor(match / stride)];
        const position = match % stride;
        if (sequence[position + 1] !== next) continue;
        if (position + 2 === sequence.length) return null;
        carried.push(encode(Math.floor(match / stride), position + 1));
      }
    }
    for (const id of startingAt?.get(edge) ?? []) {
      if (sequences[id][1] !== next) continue;
      if (sequences[id].length === 2) return null;
      carried.push(encode(id, 1));
    }
    return carried;
  };

  let best = costBound;
  let bestArrival = -1;
  let bestFinisher: Finisher | null = null;
  let bestSeed: Seed | null = null;

  const considerFinishers = (state: number, node: number, seed: Seed | null) => {
    const edge = edgeOf(state);
    const banned = restrictions?.get(edge);
    for (const finisher of finishers.get(node) ?? []) {
      if (finisher.edge >= 0 && banned?.has(finisher.edge)) continue;
      // Finishing part-way along an edge still counts as driving it.
      if (finisher.edge >= 0 && advance(edge, matchesOf(state), finisher.edge) === null) continue;
      const total = costOfState(state) + finisher.cost;
      if (total < best) { best = total; bestArrival = state; bestFinisher = finisher; bestSeed = seed; }
    }
  };

  for (const seed of seeds) {
    if (seed.edge >= 0) {
      // Already on a road: the seed *is* an arrival state at seed.node.
      relax(seed.edge, seed.cost, -1, seed);
      considerFinishers(seed.edge, seed.node, seed);
      continue;
    }
    // Starting at a junction: no arriving edge, so no restriction applies yet.
    for (const finisher of finishers.get(seed.node) ?? []) {
      const total = seed.cost + finisher.cost;
      if (total < best) { best = total; bestArrival = -1; bestFinisher = finisher; bestSeed = seed; }
    }
    for (let edge = graph.edgeOffsets[seed.node]; edge < graph.edgeOffsets[seed.node + 1]; edge += 1) {
      if (!edgeAllowed(access, edge)) continue;
      relax(edge, seed.cost + costOf(edge), -1, seed);
    }
  }

  while (queue.size) {
    if (queue.minimumPriority >= best) break;
    const state = queue.pop()!;
    const edge = edgeOf(state);
    const matches = matchesOf(state);
    const node = graph.edgeTargets[edge];
    const banned = restrictions?.get(edge);
    considerFinishers(state, node, null);
    for (let next = graph.edgeOffsets[node]; next < graph.edgeOffsets[node + 1]; next += 1) {
      if (banned?.has(next) || !edgeAllowed(access, next)) continue;
      const carried = advance(edge, matches, next);
      if (carried === null) continue;
      relax(stateFor(next, carried), costOfState(state) + costOf(next), state, null);
    }
  }

  if (!bestFinisher) return null;
  const chain: number[] = [];
  for (let state = bestArrival; state !== -1; state = state < edgeCount ? previousState[state] : partialPrevious[state - edgeCount]) {
    chain.push(edgeOf(state));
  }
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

/**
 * `costBound` lets a caller say "I already have a route this good". The search
 * then explores only what could beat it and reports no route otherwise, which
 * makes re-checking a route against extra map tiles far cheaper than the
 * original search.
 */
export type RouteOptions = { costBound?: number };

export function route(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest", options: RouteOptions = {}): RouteResult {
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
  const costBound = options.costBound ?? Infinity;
  const restrictions = buildTurnRestrictionIndex(graph);
  const sequenceIndex = buildTurnSequenceIndex(graph);
  const outcome: SearchOutcome = sameNode
    ? { edges: [], finisher: finisherList[0], seed: seeds[0] }
    : restrictions || sequenceIndex
      ? searchByEdge(graph, seeds, finishers, destinationSnap.point, preference, restrictions, sequenceIndex, costBound)
      : searchByNode(graph, seeds, finishers, destinationSnap.point, preference, costBound);
  if (direct && direct.cost >= costBound) direct = null;
  if (!outcome && !direct) throw new RouterError("NO_ROUTE", `No ${profileOf(graph).name} route connects the selected points.`);

  const searchCost = outcome ? outcome.seed.cost + outcome.edges.reduce((sum, edge) => sum + costOf(edge), 0) + outcome.finisher.cost : Infinity;
  const partial = (projection: EdgeProjection, fraction: number) => ({
    distance: fraction * graph.edgeDistancesMeters[projection.edge] * distanceScale,
    duration: fraction * graph.edgeDurationsSeconds[projection.edge] * durationScale,
  });

  const coordinates: GeoJsonPosition[] = [];
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
