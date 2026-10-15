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

const costOfRoute = (result: RouteResult, preference: RoutePreference) =>
  preference === "fastest" ? result.durationSeconds : result.distanceMeters;

/** How much of this route runs along roads already offered, by distance. */
function sharedFraction(graph: RoadGraph, candidate: RouteResult, used: Set<number>) {
  const scale = graph.edgeDistanceScale ?? 1;
  let shared = 0;
  let total = 0;
  for (const edge of candidate.edgeIds) {
    const length = graph.edgeDistancesMeters[edge] * scale;
    total += length;
    if (used.has(edge)) shared += length;
  }
  // A route made entirely of the partial edges either end snaps to has no
  // edges to compare; treating it as wholly shared keeps a near-duplicate out.
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
  const { count, maxStretch, maxSharing, penaltyFactor } = { ...DEFAULTS, ...options };
  const best = route(graph, from, to, preference, options);
  if (count <= 1) return [best];

  const chosen = [best];
  const ceiling = costOfRoute(best, preference) * maxStretch;
  const used = new Set(best.edgeIds);
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
    for (const edge of candidate.edgeIds) used.add(edge);
  }
  return chosen;
}
