/**
 * The two constants an A* search needs from a graph, measured once per graph
 * rather than assumed.
 *
 * Both exist to keep the heuristic admissible — never larger than the true
 * remaining cost — while making it as cheap and as tight as the data allows.
 * An inadmissible heuristic does not merely slow a search down; it lets A*
 * settle for a route that is not the best one.
 */

import type { RoadGraph } from "./types";
import { maxSpeedMpsFor } from "./routing-profile";

const RADIANS = Math.PI / 180;
/** Metres per degree of latitude at the equator, the smallest value anywhere. */
const METRES_PER_DEGREE_LATITUDE = 110_574;
const METRES_PER_DEGREE_LONGITUDE = 111_320;
/** Covers the last of the floating-point slack, so the bound stays below the truth. */
const SAFETY = 0.999;

export type SearchBounds = {
  /**
   * The fastest any edge in this graph is actually travelled. Quantising a
   * short edge's duration downwards can imply a speed above the profile's
   * own ceiling, and dividing by the lower number would overestimate what
   * remains, so the measured value is used rather than the declared one.
   */
  maxSpeedMps: number;
  /**
   * Scales a longitude difference into metres using the highest latitude in
   * the graph, where a degree of longitude is shortest. Under-estimating that
   * everywhere keeps the straight-line estimate below the true distance.
   */
  longitudeMetresPerDegree: number;
};

const cache = new WeakMap<RoadGraph, SearchBounds>();

export function searchBoundsFor(graph: RoadGraph): SearchBounds {
  const held = cache.get(graph);
  if (held) return held;

  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  let fastest = 0;
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
    const seconds = graph.edgeDurationsSeconds[edge] * durationScale;
    if (seconds <= 0) continue;
    const speed = (graph.edgeDistancesMeters[edge] * distanceScale) / seconds;
    if (speed > fastest) fastest = speed;
  }

  const coordinateScale = graph.coordinateScale ?? 1;
  let highest = 0;
  for (let node = 0; node < graph.nodeLatitudes.length; node += 1) {
    const latitude = Math.abs(graph.nodeLatitudes[node] / coordinateScale);
    if (latitude > highest) highest = latitude;
  }

  const bounds: SearchBounds = {
    // An empty or zero-duration graph falls back to the profile's ceiling.
    maxSpeedMps: Math.max(fastest, maxSpeedMpsFor(graph)),
    longitudeMetresPerDegree: METRES_PER_DEGREE_LONGITUDE * Math.cos(Math.min(highest, 89.9) * RADIANS) * SAFETY,
  };
  cache.set(graph, bounds);
  return bounds;
}

/**
 * A lower bound on the great-circle distance between two points, without the
 * four trigonometric calls a haversine needs. The heuristic asks for this once
 * per relaxation — millions of times on a long route — and only ever needs a
 * number that cannot exceed the truth.
 */
export function straightLineAtMost(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number, longitudeMetresPerDegree: number) {
  const north = (latitudeA - latitudeB) * METRES_PER_DEGREE_LATITUDE * SAFETY;
  const east = (longitudeA - longitudeB) * longitudeMetresPerDegree;
  return Math.sqrt(north * north + east * east);
}
