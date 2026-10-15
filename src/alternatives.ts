/**
 * Several ways to get there, not just the best one.
 *
 * A second route is only worth offering if it is genuinely different and not
 * much worse. The method here is the simple one: find the best route, make the
 * roads it used dearer to the search than they really are, and search again.
 * A road that is the only sensible way through survives the penalty and is
 * used again; one that was merely convenient gives way to its neighbour.
 *
 * The penalty never reaches the answer. A route is always reported at the
 * graph's own cost, so an alternative's distance and duration are what it
 * would really take, not what the search was told to believe.
 *
 * Candidates are then filtered rather than trusted: one that reuses most of a
 * route already offered, or that is far worse than the best, is not an
 * alternative anybody wants. What comes back is in order, best first.
 */

import { edgeSource } from "./edge-index";
import { route } from "./router";
import type { RouteOptions } from "./router";
import { RouterError, type Coordinate, type RoadGraph, type RoutePreference, type RouteResult } from "./types";

export type AlternativeRoutesOptions = Omit<RouteOptions, "costPenalties" | "costBound"> & {
  /** How many routes to return at most, the best one included. Default 3. */
  count?: number;
  /**
   * How much worse than the best route an alternative may be. 1.4 allows one
   * taking 40% longer; raising it offers more routes and worse ones.
   */
  maxStretch?: number;
  /**
   * How much of the routes already offered an alternative may reuse, measured
   * by distance. 0.75 rejects one that is three-quarters the same road.
   */
  maxSharing?: number;
  /**
   * How much dearer a road already used is made to look. Too small and the
   * search returns the same route again; too large and it flees onto
   * absurdities. Default 2.
   */
  penaltyFactor?: number;
};

/** Exported so a bundle can widen its corridor by as much as a route may stretch. */
export const DEFAULT_MAX_STRETCH = 1.4;

const DEFAULTS = { count: 3, maxStretch: DEFAULT_MAX_STRETCH, maxSharing: 0.75, penaltyFactor: 2 };

/** Wider than any graph has nodes, so a road's two ends make one number. */
const ROAD_KEY_STRIDE = 2 ** 26;

/**
 * More routes than this is not a choice but a list, and each one costs a
 * search over the whole corridor. A caller wanting dozens wants something
 * this method is the wrong shape for.
 */
const MOST_ROUTES = 10;

/** Rejects options that would make the search unbounded or meaningless. */
function checkOptions(options: AlternativeRoutesOptions) {
  const whole = (name: string, value: number) => {
    if (!Number.isInteger(value)) throw new RangeError(`routeAlternatives: ${name} must be a whole number, not ${value}.`);
  };
  const finite = (name: string, value: number, least: number, most: number) => {
    if (!Number.isFinite(value) || value < least || value > most) {
      throw new RangeError(`routeAlternatives: ${name} must be between ${least} and ${most}, not ${value}.`);
    }
  };
  if (options.count !== undefined) { whole("count", options.count); finite("count", options.count, 1, MOST_ROUTES); }
  if (options.maxStretch !== undefined) finite("maxStretch", options.maxStretch, 1, Number.MAX_SAFE_INTEGER);
  if (options.maxSharing !== undefined) finite("maxSharing", options.maxSharing, 0, 1);
  if (options.penaltyFactor !== undefined) finite("penaltyFactor", options.penaltyFactor, 1, Number.MAX_SAFE_INTEGER);
}

const costOfRoute = (result: RouteResult, preference: RoutePreference) =>
  preference === "fastest" ? result.durationSeconds : result.distanceMeters;

/**
 * Which stretch of road an edge is, regardless of which way it is driven.
 *
 * A two-way road is two directed edges with different numbers, and a route
 * that comes back along one is on the same tarmac as a route that went up the
 * other. Comparing edge numbers would call those two routes different; naming
 * the road by its endpoints, in a fixed order, does not.
 */
function roadOf(graph: RoadGraph, edge: number) {
  const source = edgeSource(graph, edge);
  const target = graph.edgeTargets[edge];
  return source < target ? source * ROAD_KEY_STRIDE + target : target * ROAD_KEY_STRIDE + source;
}

/** Every stretch of road a route drives, the ends it only part-drives included. */
function roadsOf(graph: RoadGraph, route: RouteResult) {
  const roads = new Set<number>();
  for (const edge of route.edgeIds) roads.add(roadOf(graph, edge));
  for (const snap of [route.originSnap, route.destinationSnap]) {
    if (snap.edge >= 0) roads.add(roadOf(graph, snap.edge));
  }
  return roads;
}

/**
 * How much of this route runs along roads already offered, measured by the
 * distance actually travelled on them rather than by how many edges are in
 * common. Junctions are shared by every route that meets at them and cost no
 * distance, so they do not count towards being the same road.
 *
 * The partial edges a route starts and finishes on are counted too. Their
 * length is what the route's total has over the sum of its whole edges, split
 * evenly between the two ends, since a result says which road each end sits
 * on but not how far along it.
 */
function sharedFraction(graph: RoadGraph, candidate: RouteResult, used: Set<number>) {
  const scale = graph.edgeDistanceScale ?? 1;
  let shared = 0;
  let whole = 0;
  for (const edge of candidate.edgeIds) {
    const length = graph.edgeDistancesMeters[edge] * scale;
    whole += length;
    if (used.has(roadOf(graph, edge))) shared += length;
  }
  const ends = [candidate.originSnap, candidate.destinationSnap].filter((snap) => snap.edge >= 0);
  const partial = Math.max(0, candidate.distanceMeters - whole);
  for (const snap of ends) {
    if (used.has(roadOf(graph, snap.edge))) shared += partial / ends.length;
  }
  const total = whole + partial;
  // A route with no length at all cannot be told apart from anything, and
  // treating it as wholly shared keeps a duplicate out rather than in.
  return total > 0 ? shared / total : 1;
}

/**
 * Routes from one point to another, best first, with up to `count - 1`
 * genuinely different alternatives after it.
 *
 * Returns at least the best route; fewer than `count` means the graph held
 * nothing else worth offering, which is the usual answer on a road network
 * with one obvious way through.
 */
export function routeAlternatives(
  graph: RoadGraph,
  from: Coordinate,
  to: Coordinate,
  preference: RoutePreference = "fastest",
  options: AlternativeRoutesOptions = {},
): RouteResult[] {
  checkOptions(options);
  const { count, maxStretch, maxSharing, penaltyFactor } = { ...DEFAULTS, ...options };
  const best = route(graph, from, to, preference, options);
  if (count <= 1) return [best];

  const chosen = [best];
  const ceiling = costOfRoute(best, preference) * maxStretch;
  const used = roadsOf(graph, best);
  const penalties = new Map<number, number>();
  const penalise = (edges: number[]) => {
    for (const edge of edges) penalties.set(edge, (penalties.get(edge) ?? 1) * penaltyFactor);
  };
  penalise(best.edgeIds);

  // Each pass either adds a route or makes the next pass look somewhere else,
  // so the attempts are bounded rather than run until something is found.
  const attempts = (count - 1) * 3;
  for (let attempt = 0; attempt < attempts && chosen.length < count; attempt += 1) {
    let candidate: RouteResult;
    try {
      candidate = route(graph, from, to, preference, { ...options, costPenalties: penalties });
    } catch (error) {
      // A penalty cannot sever the graph, but a caller's own options may still
      // leave nothing to find on a later pass.
      if (error instanceof RouterError && error.code === "NO_ROUTE") break;
      throw error;
    }
    // Penalise whatever came back, accepted or not: repeating a rejected
    // candidate is how this search would otherwise stall.
    penalise(candidate.edgeIds);
    if (costOfRoute(candidate, preference) > ceiling) continue;
    if (sharedFraction(graph, candidate, used) > maxSharing) continue;
    chosen.push(candidate);
    for (const road of roadsOf(graph, candidate)) used.add(road);
  }
  // Candidates are found in whatever order the penalties drove the search,
  // which is not the order they would be driven in. The best route is the
  // best by construction and stays first; the rest are put in the order a
  // reader would compare them, by what they really cost rather than by what
  // the search was told to believe they cost.
  const rest = chosen.slice(1).sort((left, right) => costOfRoute(left, preference) - costOfRoute(right, preference));
  return [best, ...rest];
}
