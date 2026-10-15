/**
 * Which edges a profile may use, as one bit per edge.
 *
 * A multi-profile bundle stores the road network once and the vehicle-specific
 * parts separately, so the shared topology holds every road any of its
 * profiles can drive. A profile that cannot use a road marks its bit clear
 * rather than having the edge removed: edge numbers are what turn restrictions
 * and shape references are written against, so they have to stay put.
 */

export function accessMaskFor(edges: number, allowed: (edge: number) => boolean) {
  const mask = new Uint8Array((edges + 7) >> 3);
  for (let edge = 0; edge < edges; edge += 1) if (allowed(edge)) mask[edge >> 3] |= 1 << (edge & 7);
  return mask;
}

/** An absent mask means every edge is usable, which is what a single-profile graph holds. */
export function edgeAllowed(mask: Uint8Array | undefined, edge: number) {
  return mask === undefined || (mask[edge >> 3] & (1 << (edge & 7))) !== 0;
}

/** True when the mask lets every edge through, in which case it need not be stored. */
export function allowsEverything(mask: Uint8Array, edges: number) {
  for (let edge = 0; edge < edges; edge += 1) if (!edgeAllowed(mask, edge)) return false;
  return true;
}
