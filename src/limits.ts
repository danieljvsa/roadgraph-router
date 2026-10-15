/**
 * Turning signed limits into the handful of bytes a bundle stores, and back
 * into a yes or no for one lorry.
 *
 * Quantisation always rounds a limit *down*, so a stored value never permits
 * what the sign forbids. A limit too large to store is stored as "not stated"
 * rather than clamped, because a clamped value would forbid what the sign
 * permits, and a limit that high restricts nothing any lorry cares about.
 */

import type { EdgeLimits, RoadGraph } from "./types";
import type { VehicleDimensions, VehicleLimits } from "./vehicle";
import { accessMaskFor, edgeAllowed } from "./access";

const DECIMETRE_CEILING = 255;
const HALF_TONNE_CEILING = 255;

/** Zero means "not stated"; a limit above what fits is treated the same way. */
export function toDecimetres(metres: number | undefined) {
  if (metres === undefined || !(metres > 0)) return 0;
  const value = Math.floor(metres * 10);
  return value > DECIMETRE_CEILING ? 0 : value;
}

export function toHalfTonnes(tonnes: number | undefined) {
  if (tonnes === undefined || !(tonnes > 0)) return 0;
  const value = Math.floor(tonnes * 2);
  return value > HALF_TONNE_CEILING ? 0 : value;
}

export const fromDecimetres = (value: number) => value / 10;
export const fromHalfTonnes = (value: number) => value / 2;

/** Collects the per-edge limits a compiler gathered into the stored side table. */
export function packEdgeLimits(entries: { edge: number; limits: VehicleLimits }[]): EdgeLimits | undefined {
  const rows = entries
    .map(({ edge, limits }) => ({
      edge,
      height: toDecimetres(limits.heightMeters),
      width: toDecimetres(limits.widthMeters),
      length: toDecimetres(limits.lengthMeters),
      weight: toHalfTonnes(limits.weightTonnes),
    }))
    // A row where every limit rounded away to "not stated" says nothing.
    .filter((row) => row.height || row.width || row.length || row.weight)
    .sort((a, b) => a.edge - b.edge);
  if (!rows.length) return undefined;
  return {
    edges: Uint32Array.from(rows, (row) => row.edge),
    heightDecimetres: Uint8Array.from(rows, (row) => row.height),
    widthDecimetres: Uint8Array.from(rows, (row) => row.width),
    lengthDecimetres: Uint8Array.from(rows, (row) => row.length),
    weightHalfTonnes: Uint8Array.from(rows, (row) => row.weight),
  };
}

/** Whether the limits in row `index` stop this vehicle. */
function blocks(limits: EdgeLimits, index: number, vehicle: VehicleDimensions) {
  const height = limits.heightDecimetres[index];
  if (height && vehicle.heightMeters > fromDecimetres(height)) return true;
  const width = limits.widthDecimetres[index];
  if (width && vehicle.widthMeters > fromDecimetres(width)) return true;
  const length = limits.lengthDecimetres[index];
  if (length && vehicle.lengthMeters > fromDecimetres(length)) return true;
  const weight = limits.weightHalfTonnes[index];
  return Boolean(weight) && vehicle.weightTonnes > fromHalfTonnes(weight);
}

/**
 * The access mask a search should use for one lorry: the profile's own mask
 * with the roads this vehicle is too big or too heavy for cleared as well.
 * Roads stating no limit stay open, which is the assumption this library makes
 * and documents: an untagged bridge is not a measured one.
 */
export function accessForVehicle(graph: RoadGraph, vehicle: VehicleDimensions | undefined): Uint8Array | undefined {
  const limits = graph.edgeLimits;
  if (!vehicle || !limits?.edges.length) return graph.edgeAccess;
  const edges = graph.edgeTargets.length;
  const mask = graph.edgeAccess ? Uint8Array.from(graph.edgeAccess) : accessMaskFor(edges, () => true);
  for (let index = 0; index < limits.edges.length; index += 1) {
    const edge = limits.edges[index];
    if (edge < edges && blocks(limits, index, vehicle)) mask[edge >> 3] &= ~(1 << (edge & 7));
  }
  return mask;
}

/** How many edges this vehicle may not use, for reporting rather than routing. */
export function countBlocked(graph: RoadGraph, vehicle: VehicleDimensions) {
  const mask = accessForVehicle(graph, vehicle);
  if (!mask) return 0;
  let blocked = 0;
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) if (!edgeAllowed(mask, edge)) blocked += 1;
  return blocked;
}
