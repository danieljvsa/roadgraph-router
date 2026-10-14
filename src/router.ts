import { MinPriorityQueue } from "./priority-queue";
import type { Coordinate, GeoJsonPosition, RoadGraph, RoutePreference, RouteResult, RouteSnap } from "./types";
import { RouterError } from "./types";
import { nearbyNodeIds } from "./spatial-index";
import { edgeAllowed } from "./access";
import { accessForVehicle } from "./limits";
import { componentSizes, componentsFor } from "./connectivity";
import { searchBoundsFor, straightLineAtMost } from "./search-bounds";
import type { VehicleDimensions } from "./vehicle";
import { buildTurnRestrictionIndex, buildTurnSequenceIndex, guardedJunctionsFor, type TurnRestrictionIndex, type TurnSequenceIndex } from "./turn-restrictions";
import { profileOf } from "./routing-profile";
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
  // Both bounds are measured from the graph rather than assumed, and cached
  // with it. The speed ceiling has to cover the fastest edge the graph
  // actually holds, which quantisation can push above the profile's own
  // ceiling; dividing by the smaller number would overestimate what remains
  // and let A* settle for a route that is not the best one.
  const { maxSpeedMps, longitudeMetresPerDegree } = searchBoundsFor(graph);
  const coordinateScale = graph.coordinateScale ?? 1;
  const latitudes = graph.nodeLatitudes;
  const longitudes = graph.nodeLongitudes;
  const destinationLatitude = destinationPoint.lat;
  const destinationLongitude = destinationPoint.lng;
  const toCost = preference === "fastest" ? 1 / maxSpeedMps : 1;
  return {
    costOf: (edge: number) => preference === "fastest" ? graph.edgeDurationsSeconds[edge] * durationScale : graph.edgeDistancesMeters[edge] * distanceScale,
    // Called once per relaxation, millions of times on a long route, so it
    // reads the coordinate arrays directly and avoids a haversine's four
    // trigonometric calls for a number that only has to be a lower bound.
    heuristicFor: (node: number) => straightLineAtMost(
      latitudes[node] / coordinateScale, longitudes[node] / coordinateScale,
      destinationLatitude, destinationLongitude, longitudeMetresPerDegree,
    ) * toCost,
  };
}

type SearchOutcome = { edges: number[]; finisher: Finisher; seed: Seed } | null;

/**
 * Node-labelled A*. Valid only when no turn is forbidden, because the cost of
 * reaching a node is then independent of how the node was reached.
 */
function searchByNode(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, costBound: number, access: Uint8Array | undefined): SearchOutcome {
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
 * A* that remembers how it arrived, but only where that can change the answer.
 *
 * A banned turn can only be obeyed by a search that knows which road it came
 * in on, and the state expressing that is "arrived at this node along that
 * edge" — one state per directed edge instead of one per node. Carrying it
 * everywhere costs twice the search for the sake of the 1.3% of junctions that
 * ban anything. Here a guarded junction gets that state and every other
 * junction is just itself, which is exactly the same answer for about half the
 * work.
 *
 * Nothing is lost by forgetting the approach elsewhere: a junction is guarded
 * precisely when a ban or a banned run turns on it, so an unguarded one has no
 * rule that could depend on how it was reached. A mid-edge start still arrives
 * along a known edge, so entering part-way along a road obeys a restriction on
 * the very first turn as before.
 */
function searchWithRestrictions(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, restrictions: TurnRestrictionIndex | null, sequenceIndex: TurnSequenceIndex | null, costBound: number, access: Uint8Array | undefined): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference);
  const targets = graph.edgeTargets;
  const { guarded, stateOfEdge, edgeOfState, count: guardedStates } = guardedJunctionsFor(graph, restrictions, sequenceIndex);

  // States below `guardedStates` are an arrival at a guarded junction along one
  // edge; the next `nodes` are the junctions where arriving does not matter;
  // anything above is a partly-driven banned run.
  const nodes = graph.nodeLatitudes.length;
  const plainBase = guardedStates;
  const stateCount = guardedStates + nodes;
  const costs = new Float64Array(stateCount).fill(Infinity);
  const cameFrom = new Int32Array(stateCount).fill(-1);
  const cameVia = new Int32Array(stateCount).fill(-1);
  const seedOf = new Map<number, Seed>();
  const queue = new MinPriorityQueue<number>();

  // A banned run of three or more edges needs to remember how much of it has
  // been driven, which neither state above can hold. Those few live alongside
  // the typed arrays rather than widening them.
  const sequences = sequenceIndex?.sequences ?? [];
  const startingAt = sequenceIndex?.startingAt;
  const partialEdge: number[] = [];
  const partialMatches: number[][] = [];
  const partialCost: number[] = [];
  const partialPrevious: number[] = [];
  const partialIds = new Map<string, number>();
  const stride = sequenceIndex?.stride ?? 1;
  const encode = (sequence: number, position: number) => sequence * stride + position;

  const nodeOf = (state: number) => {
    if (state < guardedStates) return targets[edgeOfState[state]];
    if (state < stateCount) return state - plainBase;
    return targets[partialEdge[state - stateCount]];
  };
  /** The edge a state arrived along, which only a guarded state is asked for. */
  const arrivalOf = (state: number) => {
    if (state < guardedStates) return edgeOfState[state];
    if (state < stateCount) return cameVia[state];
    return partialEdge[state - stateCount];
  };
  const matchesOf = (state: number) => state < stateCount ? undefined : partialMatches[state - stateCount];
  const costOfState = (state: number) => state < stateCount ? costs[state] : partialCost[state - stateCount];
  /** An unguarded junction has no rule that could depend on the approach. */
  const bansAt = (state: number) => state < guardedStates || state >= stateCount ? restrictions?.get(arrivalOf(state)) : undefined;

  const relax = (state: number, cost: number, from: number, via: number, seed: Seed | null) => {
    if (state < stateCount) {
      if (cost >= costs[state]) return;
      costs[state] = cost;
      cameFrom[state] = from;
      cameVia[state] = via;
      if (from === -1 && seed) seedOf.set(state, seed);
    } else {
      const slot = state - stateCount;
      if (cost >= partialCost[slot]) return;
      partialCost[slot] = cost;
      partialPrevious[slot] = from;
    }
    queue.push(state, cost + heuristicFor(nodeOf(state)));
  };

  /** Where arriving along `edge` lands, once any part-driven run is accounted for. */
  const stateFor = (edge: number, matches: number[]) => {
    if (!matches.length) {
      const node = targets[edge];
      return guarded[node] ? stateOfEdge[edge] : plainBase + node;
    }
    const key = `${edge}:${matches.sort((a, b) => a - b).join(",")}`;
    let id = partialIds.get(key);
    if (id === undefined) {
      id = stateCount + partialEdge.length;
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
    const banned = bansAt(state);
    const edge = arrivalOf(state);
    for (const finisher of finishers.get(node) ?? []) {
      if (finisher.edge >= 0 && banned?.has(finisher.edge)) continue;
      // Finishing part-way along an edge still counts as driving it.
      if (finisher.edge >= 0 && edge >= 0 && advance(edge, matchesOf(state), finisher.edge) === null) continue;
      const total = costOfState(state) + finisher.cost;
      if (total < best) { best = total; bestArrival = state; bestFinisher = finisher; bestSeed = seed; }
    }
  };

  for (const seed of seeds) {
    if (seed.edge >= 0) {
      // Already on a road: the seed *is* an arrival at seed.node.
      const state = stateFor(seed.edge, []);
      relax(state, seed.cost, -1, seed.edge, seed);
      considerFinishers(state, seed.node, seed);
      continue;
    }
    // Starting at a junction: no arriving edge, so no restriction applies yet.
    for (const finisher of finishers.get(seed.node) ?? []) {
      const total = seed.cost + finisher.cost;
      if (total < best) { best = total; bestArrival = -1; bestFinisher = finisher; bestSeed = seed; }
    }
    for (let edge = graph.edgeOffsets[seed.node]; edge < graph.edgeOffsets[seed.node + 1]; edge += 1) {
      if (!edgeAllowed(access, edge)) continue;
      relax(stateFor(edge, []), seed.cost + costOf(edge), -1, edge, seed);
    }
  }

  while (queue.size) {
    if (queue.minimumPriority >= best) break;
    const state = queue.pop()!;
    const node = nodeOf(state);
    const matches = matchesOf(state);
    const banned = bansAt(state);
    const arrival = arrivalOf(state);
    considerFinishers(state, node, null);
    for (let next = graph.edgeOffsets[node]; next < graph.edgeOffsets[node + 1]; next += 1) {
      if (banned?.has(next) || !edgeAllowed(access, next)) continue;
      // Only a guarded or part-driven state can be inside a banned run.
      const carried = arrival >= 0 && (state < guardedStates || state >= stateCount) ? advance(arrival, matches, next) : [];
      if (carried === null) continue;
      relax(stateFor(next, carried), costOfState(state) + costOf(next), state, next, null);
    }
  }

  if (!bestFinisher) return null;
  const chain: number[] = [];
  for (let state = bestArrival; state !== -1; ) {
    const via = state < stateCount ? cameVia[state] : partialEdge[state - stateCount];
    if (via >= 0) chain.push(via);
    state = state < stateCount ? cameFrom[state] : partialPrevious[state - stateCount];
  }
  chain.reverse();
  const seed = bestSeed ?? (chain.length ? seedOf.get(stateFor(chain[0], [])) ?? seeds[0] : seeds[0]);
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
export type RouteOptions = {
  costBound?: number;
  /**
   * The lorry being routed, where the graph states physical limits. Roads it
   * is too large or too heavy for are closed to the search and to snapping.
   */
  vehicle?: VehicleDimensions;
};

/** The node a snap stands on, for asking which piece of the network it is in. */
function nodeOfSnap(snap: GraphSnap) {
  return snap.kind === "node" ? snap.node : snap.projections[0].source;
}

/**
 * A second attempt for a route that failed because an end snapped to the wrong
 * piece of the network.
 *
 * Snapping finds the nearest road, which near a disconnected stub is the stub
 * — a path fragment behind a fence, a service road in a compound, a stretch
 * clipped at the edge of a tile. The route then fails although a usable road
 * was a few metres further. Here the two ends are compared: if they sit in
 * different pieces, the end in the smaller one is snapped again, this time
 * only to roads joined to the other end.
 *
 * It runs only after a failure, so an ordinary route never pays for labelling
 * the network.
 */
function reconnect(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference, options: RouteOptions, access: Uint8Array | undefined): RouteResult | null {
  const originSnap = snapToGraph(graph, from, undefined, access);
  const destinationSnap = snapToGraph(graph, to, undefined, access);
  if (!originSnap || !destinationSnap) return null;

  const labels = componentsFor(graph);
  const originLabel = labels[nodeOfSnap(originSnap)];
  const destinationLabel = labels[nodeOfSnap(destinationSnap)];
  // Both ends already in one piece: the search failed for some other reason,
  // a one-way trap most likely, and a different snap will not mend it.
  if (originLabel === destinationLabel) return null;

  const sizes = componentSizes(labels);
  // The end in the smaller piece is the one that snapped somewhere useless.
  const moveOrigin = (sizes.get(originLabel) ?? 0) <= (sizes.get(destinationLabel) ?? 0);
  const wanted = moveOrigin ? destinationLabel : originLabel;
  const accept = (node: number) => labels[node] === wanted;
  try {
    return routeBetween(graph, from, to, preference, options, access, moveOrigin ? accept : undefined, moveOrigin ? undefined : accept);
  } catch {
    // Nothing joined to the other end is within snapping range either.
    return null;
  }
}

export function route(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest", options: RouteOptions = {}): RouteResult {
  assertGraph(graph);
  // The vehicle narrows the profile's own mask, so every later step — snapping
  // included — sees one answer about which roads are usable.
  const access = accessForVehicle(graph, options.vehicle);
  try {
    return routeBetween(graph, from, to, preference, options, access);
  } catch (error) {
    if (!(error instanceof RouterError) || error.code !== "NO_ROUTE") throw error;
    return reconnect(graph, from, to, preference, options, access) ?? (() => { throw error; })();
  }
}

function routeBetween(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference, options: RouteOptions, access: Uint8Array | undefined, acceptOrigin?: (node: number) => boolean, acceptDestination?: (node: number) => boolean): RouteResult {
  const originSnap = snapToGraph(graph, from, undefined, access, acceptOrigin);
  if (!originSnap) throw new RouterError("ORIGIN_NOT_ON_GRAPH", "No routable road is close to the origin.");
  const destinationSnap = snapToGraph(graph, to, undefined, access, acceptDestination);
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
      ? searchWithRestrictions(graph, seeds, finishers, destinationSnap.point, preference, restrictions, sequenceIndex, costBound, access)
      : searchByNode(graph, seeds, finishers, destinationSnap.point, preference, costBound, access);
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
