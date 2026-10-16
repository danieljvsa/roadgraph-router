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

import { edgePolyline, edgeSource } from "./edge-index";
import { route } from "./router";
import type { RouteOptions } from "./router";
import { assertRailwayConstraints } from "./railway";
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
  /**
   * Whether to download the wider corridor an alternative might lie in.
   *
   * On by default, because an alternative is allowed to be worse than the
   * best by `maxStretch` and the tiles holding one therefore reach further
   * than the tiles that proved the best route. On a long journey that is
   * about three megabytes more map. Turning it off keeps the download to
   * what one route needed and offers only the alternatives already inside
   * it, which on a dense network is usually most of them.
   */
  searchWiderCorridor?: boolean;
};

/** Exported so a bundle can widen its corridor by as much as a route may stretch. */
export const DEFAULT_MAX_STRETCH = 1.4;

const DEFAULTS = { count: 3, maxStretch: DEFAULT_MAX_STRETCH, maxSharing: 0.75, penaltyFactor: 2 };

/**
 * More routes than this is not a choice but a list, and each one costs a
 * search over the whole corridor. A caller wanting dozens wants something
 * this method is the wrong shape for.
 */
const MOST_ROUTES = 10;

/**
 * Rejects options that would make the search unbounded or meaningless.
 *
 * Exported so the public entry point can refuse them before it downloads
 * anything: a caller who passed `count: NaN` should be told so, not billed
 * for a corridor first.
 */
export function checkAlternativeOptions(options: AlternativeRoutesOptions) {
  assertRailwayConstraints(options.railway);
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
 * other, so an edge cannot name itself.
 *
 * Its two ends are not enough either. Two different roads often join the same
 * pair of junctions — a slip road beside the road it leaves, a lane round the
 * far side of a square — and calling those one road would hide a genuine
 * alternative. In the Porto to Lisbon corridor alone there are 12,015 such
 * pairs, and not one of them is the same length as its twin, so the length
 * tells them apart while staying equal for the two directions of one road.
 *
 * The key is a string rather than arithmetic on node numbers: a graph with
 * more nodes than a packed number can hold would otherwise fold two roads
 * onto one key without anything saying so.
 */
function roadOf(graph: RoadGraph, edge: number) {
  const source = edgeSource(graph, edge);
  const target = graph.edgeTargets[edge];
  const ends = source < target ? `${source}:${target}` : `${target}:${source}`;

  // The geometry, walked in the direction both copies of the road agree on:
  // from the lower-numbered end to the higher one. Each copy of a two-way
  // road then sees the same sequence of points, and two different roads
  // between the same junctions see different ones.
  //
  // Folded in order rather than added up. A sum does not care which point
  // came first, so a road bending north then east and one bending east then
  // north add to the same number and would be taken for one road.
  const polyline = edgePolyline(graph, edge, source);
  const points = source < target ? polyline : [...polyline].reverse();
  const scale = graph.coordinateScale ?? 1e7;
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const point of points) {
    for (const value of [Math.round(point.lat * scale), Math.round(point.lng * scale)]) {
      first = Math.imul(first ^ (value & 0xffff), 0x01000193) >>> 0;
      first = Math.imul(first ^ (value >>> 16), 0x01000193) >>> 0;
      second = Math.imul(second ^ (value & 0xffff), 0x85ebca6b) >>> 0;
      second = Math.imul(second ^ (value >>> 16), 0xc2b2ae35) >>> 0;
    }
  }
  return `${ends}:${first.toString(36)}${second.toString(36)}`;
}

/** Every stretch of road a route drives, the ends it only part-drives included. */
function roadsOf(graph: RoadGraph, route: RouteResult) {
  const roads = new Set<string>();
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
function sharedFraction(graph: RoadGraph, candidate: RouteResult, used: Set<string>) {
  const scale = graph.edgeDistanceScale ?? 1;
  let shared = 0;
  let total = 0;
  for (const edge of candidate.edgeIds) {
    const length = graph.edgeDistancesMeters[edge] * scale;
    total += length;
    if (used.has(roadOf(graph, edge))) shared += length;
  }
  // Each end contributes what it actually drives of the road it sits on,
  // which the route reports. Splitting the two ends' total evenly between
  // them, as this once did, is wrong whenever one end joins its road near
  // the far junction and the other a few metres from its own.
  for (const snap of [candidate.originSnap, candidate.destinationSnap]) {
    if (snap.edge < 0) continue;
    const travelled = snap.travelledMeters ?? 0;
    total += travelled;
    if (used.has(roadOf(graph, snap.edge))) shared += travelled;
  }
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
  checkAlternativeOptions(options);
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
