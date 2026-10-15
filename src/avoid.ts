/**
 * Roads the caller knows are shut.
 *
 * A compiled bundle is as current as the extract it came from: roadworks, a
 * burst main, a festival closing the square are all things that happened
 * after it was built, and nothing inside it can know about them. What it can
 * do is let whoever does know say so at the time of asking.
 *
 * An area rather than a road, because a caller reading an incident feed has a
 * place and a radius, not an edge number. Anything the circle touches is
 * closed to the search and to snapping, exactly as a tagged restriction would
 * be, so a route neither drives through a closure nor starts in the middle of
 * one.
 */

import { accessMaskFor, edgeAllowed } from "./access";
import { edgePolyline, edgeSource, edgeSpatialIndexFor, nearbyEdgeIds } from "./edge-index";
import { haversineMeters } from "./snap";
import type { Coordinate, RoadGraph } from "./types";

/** A circle of road that cannot be driven, whatever the map says. */
export type AvoidArea = {
  lat: number;
  lng: number;
  /** How far the closure reaches from that point. */
  radiusMeters: number;
};

/** Rejects an area that would close everything, or nothing, by accident. */
function check(area: AvoidArea, index: number) {
  const say = (what: string) => { throw new RangeError(`avoid[${index}]: ${what}`); };
  if (!Number.isFinite(area.lat) || area.lat < -90 || area.lat > 90) say(`lat must be a latitude, not ${area.lat}.`);
  if (!Number.isFinite(area.lng) || area.lng < -180 || area.lng > 180) say(`lng must be a longitude, not ${area.lng}.`);
  if (!Number.isFinite(area.radiusMeters) || area.radiusMeters <= 0) say(`radiusMeters must be a positive distance, not ${area.radiusMeters}.`);
}

const METRES_PER_DEGREE_LATITUDE = 111_320;

/**
 * Whether any part of this edge lies inside the circle.
 *
 * The whole of each segment counts, not only its ends: a motorway crossing a
 * closed junction may have no shape point anywhere near it, and testing the
 * ends alone would drive a route straight through.
 */
function touches(graph: RoadGraph, edge: number, area: AvoidArea, centre: Coordinate) {
  const polyline = edgePolyline(graph, edge, edgeSource(graph, edge));
  // Flat-earth metres about the centre, which is accurate well past any
  // radius a closure is described with.
  const longitudeScale = METRES_PER_DEGREE_LATITUDE * Math.cos((centre.lat * Math.PI) / 180);
  const x = (point: Coordinate) => (point.lng - centre.lng) * longitudeScale;
  const y = (point: Coordinate) => (point.lat - centre.lat) * METRES_PER_DEGREE_LATITUDE;

  for (let index = 0; index < polyline.length; index += 1) {
    if (haversineMeters(centre, polyline[index]) <= area.radiusMeters) return true;
    if (index === 0) continue;
    // The nearest point of the segment before it, which may be neither end.
    const ax = x(polyline[index - 1]);
    const ay = y(polyline[index - 1]);
    const bx = x(polyline[index]);
    const by = y(polyline[index]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const along = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    if (Math.hypot(ax + along * dx, ay + along * dy) <= area.radiusMeters) return true;
  }
  return false;
}

/**
 * The access mask with every road the caller has closed cleared as well.
 *
 * Only the roads near each circle are looked at, so closing a junction costs
 * the same whether the graph holds a town or a country.
 */
export function accessAvoiding(graph: RoadGraph, areas: AvoidArea[] | undefined, base?: Uint8Array): Uint8Array | undefined {
  const start = base ?? graph.edgeAccess;
  if (!areas?.length) return start;
  areas.forEach(check);

  const edges = graph.edgeTargets.length;
  let mask: Uint8Array | undefined;
  const index = edgeSpatialIndexFor(graph);
  for (const area of areas) {
    const centre = { lat: area.lat, lng: area.lng };
    for (const edge of nearbyEdgeIds(index, centre, area.radiusMeters)) {
      if (edge >= edges) continue;
      if (mask && !edgeAllowed(mask, edge)) continue;
      if (!touches(graph, edge, area, centre)) continue;
      mask ??= start ? Uint8Array.from(start) : accessMaskFor(edges, () => true);
      mask[edge >> 3] &= ~(1 << (edge & 7));
    }
  }
  return mask ?? start;
}

/** How many roads these closures take away, for reporting rather than routing. */
export function countAvoided(graph: RoadGraph, areas: AvoidArea[] | undefined) {
  const before = graph.edgeAccess;
  const after = accessAvoiding(graph, areas);
  if (after === before) return 0;
  let closed = 0;
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
    if (edgeAllowed(before, edge) && !edgeAllowed(after, edge)) closed += 1;
  }
  return closed;
}
