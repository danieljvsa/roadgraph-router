import { MinPriorityQueue } from "./priority-queue";
import type { Coordinate, GeoJsonPosition, RoadGraph, RoutePreference, RouteResult, RouteSnap } from "./types";
import { RouterError } from "./types";
import { nearbyNodeIds } from "./spatial-index";
import { edgeAllowed } from "./access";
import { accessForVehicle } from "./limits";
import { accessForRailway, assertRailwayConstraints, railwayCertainty, type RailwayConstraints } from "./railway";
import { accessAvoiding, type AvoidArea } from "./avoid";
import { accessAtTime, conditionalDurations, conditionsOf, travelTimeFrom, type Circumstances, type TravelTime } from "./conditional";
import { componentSizes, componentsFor } from "./connectivity";
import { searchBoundsFor, straightLineAtMost } from "./search-bounds";
import type { VehicleDimensions } from "./vehicle";
import { buildTurnRestrictionIndex, buildTurnSequenceIndex, guardedJunctionsFor, type TurnRestrictionIndex, type TurnSequenceIndex } from "./turn-restrictions";
import { profileOf } from "./routing-profile";
import { isRailwayProfile } from "./railway-profile";
import { FALLBACK_SNAP_RADIUS_METERS, coordinateFor, geometryAfter, geometryBefore, geometryBetween, haversineMeters, snapToGraph, type EdgeProjection, type GraphSnap } from "./snap";

/** Entering the graph: traverse the tail of `edge` to reach `node`. `edge` is -1 at a junction. */
type Seed = { node: number; edge: number; cost: number };
/** Leaving the graph: from `node`, traverse the head of `edge`. `edge` is -1 at a junction. */
/** How many of the nearest roads a failed route tries before giving up. */
const ROADS_TO_TRY = 6;

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

function searchContext(graph: RoadGraph, destinationPoint: Coordinate, preference: RoutePreference, slowed?: Map<number, number>) {
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
    // An overridden cost only ever exceeds the graph's own — a conditional
    // limit slows an edge and a penalty makes it dearer — so the heuristic
    // built from the graph's fastest edge stays a lower bound and the search
    // still returns the best route under the costs it was given.
    costOf: (edge: number) => slowed?.get(edge) ?? (preference === "fastest"
      ? graph.edgeDurationsSeconds[edge] * durationScale
      : graph.edgeDistancesMeters[edge] * distanceScale),
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
function searchByNode(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, costBound: number, access: Uint8Array | undefined, slowed?: Map<number, number>): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference, slowed);
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
function searchWithRestrictions(graph: RoadGraph, seeds: Seed[], finishers: Map<number, Finisher[]>, destinationPoint: Coordinate, preference: RoutePreference, restrictions: TurnRestrictionIndex | null, sequenceIndex: TurnSequenceIndex | null, costBound: number, access: Uint8Array | undefined, slowed?: Map<number, number>): SearchOutcome {
  const { costOf, heuristicFor } = searchContext(graph, destinationPoint, preference, slowed);
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

function snapSummary(snap: GraphSnap, travelledMeters = 0): RouteSnap {
  return snap.kind === "node"
    ? { node: snap.node, edge: -1, point: snap.point, distanceMeters: snap.distanceMeters, travelledMeters: 0 }
    : { node: -1, edge: snap.projections[0].edge, point: snap.point, distanceMeters: snap.distanceMeters, travelledMeters };
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
  /**
   * What the train being routed can run on, where the graph describes its
   * track. Track whose tags contradict a constraint is closed to the search
   * and to snapping; track that says nothing stays open, because silence in
   * OSM is an absent survey rather than a statement of incompatibility. See
   * `./railway` for the full policy and for `strictUnknown`, which reverses it.
   */
  railway?: RailwayConstraints;
  /**
   * When the journey starts, in the local time of the roads being travelled.
   *
   * Leaving it out ignores every conditional restriction, which is what this
   * library did before it could read them: a road closed only at certain hours
   * counts as open. Supplying it closes the roads shut at that moment and
   * slows the ones a conditional speed limit slows.
   *
   * One moment is used for the whole route rather than an arrival time per
   * edge. A route crossing a boundary as a restriction begins is therefore
   * judged by where it set out, which is the honest limit of a departure time.
   */
  departAt?: Date | TravelTime;
  /** Whether that day is a public holiday, which only a caller can know. */
  publicHoliday?: boolean;
  /**
   * The time zone the roads are in, as an IANA name such as
   * `"Europe/Lisbon"`. A restriction is written in the local time of the road
   * it is on, so a caller routing somewhere other than where it is running
   * should say where. Left out, a `Date` is read as this machine reads it.
   */
  timeZone?: string;
  /**
   * What the map cannot know: whether it is raining, who is driving, what the
   * journey is for. A conditional rule resting on one of these is ignored
   * unless it is answered here, so a road shut `@ (wet)` stays open until a
   * caller says it is wet.
   */
  circumstances?: Circumstances;
  /**
   * Roads the caller knows are shut — roadworks, an incident, an event. A
   * compiled bundle cannot know about any of them; whoever is reading a feed
   * of them can say so here, and the search will neither drive through a
   * closure nor begin in the middle of one.
   */
  avoid?: AvoidArea[];
  /**
   * Multipliers making certain edges dearer to the search than they really
   * are, used to push a search away from a route already found. The route
   * reported back is always priced at the graph's own cost, so a penalty
   * changes which roads are chosen and never what they are said to cost.
   */
  costPenalties?: ReadonlyMap<number, number>;
  /**
   * Whether a route that cannot reach the road nearest its destination may
   * finish on one a little further away. On by default, because the nearest
   * road is sometimes one the network cannot legally enter — a pocket of
   * one-way streets behind banned turns, an island of service roads — and
   * refusing to route at all is a worse answer than finishing nearby.
   *
   * Turn it off to be told plainly that the point asked for cannot be
   * reached. `RouteResult.destinationSnap.distanceMeters` reports how far
   * short a route finished either way.
   */
  finishOnANearbyRoad?: boolean;
};

/**
 * The per-edge costs a search should use: the conditional slowdowns, with any
 * penalty folded in on top. Absent both, the search reads the graph directly.
 */
function withPenalties(
  graph: RoadGraph,
  preference: RoutePreference,
  slowed: Map<number, number> | undefined,
  penalties: ReadonlyMap<number, number> | undefined,
): Map<number, number> | undefined {
  if (!penalties?.size) return slowed;
  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  const costs = new Map(slowed);
  for (const [edge, multiplier] of penalties) {
    const base = costs.get(edge) ?? (preference === "fastest"
      ? graph.edgeDurationsSeconds[edge] * durationScale
      : graph.edgeDistancesMeters[edge] * distanceScale);
    costs.set(edge, base * multiplier);
  }
  return costs;
}

/** Reads whichever form of departure time a caller supplied. */
export function departureTime(options: Pick<RouteOptions, "departAt" | "publicHoliday" | "timeZone">): TravelTime | undefined {
  const departAt = options.departAt;
  if (!departAt) return undefined;
  return departAt instanceof Date
    ? travelTimeFrom(departAt, options.publicHoliday, options.timeZone)
    : { ...departAt, publicHoliday: departAt.publicHoliday ?? options.publicHoliday };
}

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
  // Before anything is snapped, masked or searched: a malformed constraint
  // would otherwise be read as one no track can satisfy, and the caller would
  // be told "no route" for what is really a typo.
  assertRailwayConstraints(options.railway);
  // The vehicle narrows the profile's own mask, so every later step — snapping
  // included — sees one answer about which roads are usable.
  const vehicleAccess = accessForVehicle(graph, options.vehicle);
  // What the train can run on narrows it the same way, and composes with the
  // step before it: each one takes the mask the last one produced.
  const trackAccess = accessForRailway(graph, options.railway, vehicleAccess);
  // The departure time narrows the mask further, so snapping and search agree
  // about which roads are usable at the moment the journey starts.
  const timed = accessAtTime(graph, conditionsOf(graph), departureTime(options), options.vehicle, trackAccess, options.circumstances);
  // What the caller knows is shut comes last: it outranks anything the map
  // has to say about the road being open.
  const access = accessAvoiding(graph, options.avoid, timed);
  try {
    return routeBetween(graph, from, to, preference, options, access);
  } catch (error) {
    if (!(error instanceof RouterError) || error.code !== "NO_ROUTE") throw error;
    const mended = reconnect(graph, from, to, preference, options, access);
    if (mended) return mended;
    // The nearest road is not always one the rest of the network can reach: a
    // pocket of one-way streets behind banned turns can be left but not
    // entered, and an island of service roads joins nothing at all. Both ends
    // already sit in one piece of the network here, so re-snapping by
    // component cannot help, and the only thing left is to look further and
    // let the search finish on a road it can actually get to.
    if (options.finishOnANearbyRoad === false) throw error;
    return onAnotherRoad(graph, from, to, preference, options, access) ?? (() => { throw error; })();
  }
}

/** The roads near a point, nearest first, each as a snap of its own. */
function roadsNear(graph: RoadGraph, point: Coordinate, access: Uint8Array | undefined): GraphSnap[] {
  const nearby = snapToGraph(graph, point, FALLBACK_SNAP_RADIUS_METERS, access, undefined, true);
  if (!nearby || nearby.kind === "node") return nearby ? [nearby] : [];
  // The forward and reverse copies of one stretch are one road: a route may
  // use either direction, so they are offered together.
  const byRoad = new Map<string, EdgeProjection[]>();
  for (const projection of nearby.projections) {
    const key = `${Math.min(projection.source, projection.target)}:${Math.max(projection.source, projection.target)}`;
    const held = byRoad.get(key);
    if (held) held.push(projection); else byRoad.set(key, [projection]);
  }
  return [...byRoad.values()].map((projections) => ({
    kind: "edge" as const,
    projections,
    point: projections[0].point,
    distanceMeters: projections[0].distanceMeters,
  }));
}

/**
 * The last thing tried when a route fails: finish, or start, on a road a
 * little further away.
 *
 * The nearest road is not always one the rest of the network can reach. A
 * pocket of one-way streets behind banned turns can be left but not entered,
 * and an island of service roads joins nothing at all. Both ends are in one
 * piece of the network by the time this runs, so re-snapping by component
 * cannot help; what is left is to try the next nearest roads in turn.
 *
 * Nearest first, and only a few of them, so the answer is the closest road
 * that actually works rather than whichever one makes the sums smallest. The
 * route then ends short of where it was asked to, which
 * `RouteResult.destinationSnap.distanceMeters` reports.
 */
function onAnotherRoad(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference, options: RouteOptions, access: Uint8Array | undefined): RouteResult | null {
  const attempt = (chosen: { origin?: GraphSnap; destination?: GraphSnap }) => {
    try {
      return routeBetween(graph, from, to, preference, options, access, undefined, undefined, chosen);
    } catch {
      return null;
    }
  };
  // The destination first: a point someone typed is far likelier to be a door
  // in a restricted street than the place they are standing.
  for (const destination of roadsNear(graph, to, access).slice(1, ROADS_TO_TRY + 1)) {
    const found = attempt({ destination });
    if (found) return found;
  }
  for (const origin of roadsNear(graph, from, access).slice(1, ROADS_TO_TRY + 1)) {
    const found = attempt({ origin });
    if (found) return found;
  }
  return null;
}

function routeBetween(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference, options: RouteOptions, access: Uint8Array | undefined, acceptOrigin?: (node: number) => boolean, acceptDestination?: (node: number) => boolean, chosen?: { origin?: GraphSnap; destination?: GraphSnap }): RouteResult {
  const originSnap = chosen?.origin ?? snapToGraph(graph, from, undefined, access, acceptOrigin);
  if (!originSnap) throw new RouterError("ORIGIN_NOT_ON_GRAPH", "No routable road is close to the origin.");
  const destinationSnap = chosen?.destination ?? snapToGraph(graph, to, undefined, access, acceptDestination);
  if (!destinationSnap) throw new RouterError("DESTINATION_NOT_ON_GRAPH", "No routable road is close to the destination.");

  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  const when = departureTime(options);
  const conditionallySlowed = preference === "fastest" && when ? conditionalDurations(graph, conditionsOf(graph), when, options.vehicle, options.circumstances) : undefined;
  // A penalty makes an edge dearer to the search without making it dearer in
  // the answer: the distance and duration reported below are the real ones.
  const slowed = withPenalties(graph, preference, conditionallySlowed, options.costPenalties);
  const costOf = (edge: number) => preference === "fastest"
    ? (conditionallySlowed?.get(edge) ?? graph.edgeDurationsSeconds[edge] * durationScale)
    : graph.edgeDistancesMeters[edge] * distanceScale;

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
      ? searchWithRestrictions(graph, seeds, finishers, destinationSnap.point, preference, restrictions, sequenceIndex, costBound, access, slowed)
      : searchByNode(graph, seeds, finishers, destinationSnap.point, preference, costBound, access, slowed);
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
  // How much of the road each end sits on the route actually drives.
  let travelledAtOrigin = 0;
  let travelledAtDestination = 0;

  if (direct && direct.cost <= searchCost) {
    for (const point of geometryBetween(direct.origin, direct.destination)) push(point);
    const span = partial(direct.origin, direct.destination.fraction - direct.origin.fraction);
    distanceMeters = span.distance;
    durationSeconds = span.duration;
    // One road, driven once: the whole of it is recorded at the origin so
    // that the two ends do not add up to twice the journey.
    travelledAtOrigin = span.distance;
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
      travelledAtOrigin = span.distance;
      nodeIds.push(entry.target);
      push(coordinateFor(graph, entry.target));
    } else {
      nodeIds.push(seed.node);
    }
    const scale = graph.coordinateScale ?? 1;
    for (const edge of edges) {
      distanceMeters += graph.edgeDistancesMeters[edge] * distanceScale;
      // The conditional slowdown the search planned with, so a route held up
      // by a night speed limit is not reported at the daytime time. Never the
      // search penalties, which are a way of steering and not a real cost.
      durationSeconds += conditionallySlowed?.get(edge) ?? graph.edgeDurationsSeconds[edge] * durationScale;
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
      travelledAtDestination = span.distance;
    }
  }

  const origin = snapSummary(originSnap, travelledAtOrigin);
  const destination = snapSummary(destinationSnap, travelledAtDestination);
  return {
    nodeIds,
    edgeIds,
    distanceMeters,
    durationSeconds,
    originSnap: origin,
    destinationSnap: destination,
    geometry: { type: "LineString", coordinates },
    // A railway route reports what the track vouched for, counting the edges
    // it entered and left on: those are not hops between two nodes, so they
    // are reported in the snaps rather than in `edgeIds`, and a route that
    // began on a siding should say so.
    //
    // Every railway route carries it, including one whose track states
    // nothing at all — that route reports itself as entirely unstated, which
    // is the answer. Leaving the field off there would make its absence mean
    // two different things: "this is a road" and "nobody surveyed this".
    ...(graph.edgeRailway || isRailwayProfile(profileOf(graph)) ? {
      railway: railwayCertainty(graph, [...edgeIds, origin.edge, destination.edge].filter((edge) => edge >= 0), options.railway ?? {}),
    } : {}),
  };
}
