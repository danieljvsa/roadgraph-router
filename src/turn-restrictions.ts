import type { RoadGraph } from "./types";

/**
 * Turn restrictions are stored as banned ordered edge pairs. A pair
 * `(from, to)` means: a vehicle that reached a node by traversing directed edge
 * `from` may not leave it along directed edge `to`.
 *
 * `only_*` relations are expanded into the equivalent set of `no_*` bans while
 * compiling, so the runtime only ever has to answer one question. The via node
 * is implicit — it is `edgeTargets[from]`, which is also the source node of
 * `to` — which keeps the on-disk form to two parallel `Uint32` arrays.
 */
export type TurnRestrictionIndex = Map<number, Set<number>>;

/** Builds the lookup used by A*. Returns null when the graph has no restrictions. */
export function buildTurnRestrictionIndex(graph: RoadGraph): TurnRestrictionIndex | null {
  const fromEdges = graph.turnRestrictionFromEdges;
  const toEdges = graph.turnRestrictionToEdges;
  if (!fromEdges || !toEdges || !fromEdges.length) return null;
  if (fromEdges.length !== toEdges.length) throw new Error("Turn restriction arrays must have the same length.");
  const index: TurnRestrictionIndex = new Map();
  for (let pair = 0; pair < fromEdges.length; pair += 1) {
    const banned = index.get(fromEdges[pair]);
    if (banned) banned.add(toEdges[pair]);
    else index.set(fromEdges[pair], new Set([toEdges[pair]]));
  }
  return index;
}

export function isTurnBanned(index: TurnRestrictionIndex, fromEdge: number, toEdge: number) {
  return index.get(fromEdge)?.has(toEdge) ?? false;
}

/** Normalises banned pairs into the deduplicated, sorted arrays the codec writes. */
export function packTurnRestrictions(pairs: Iterable<readonly [number, number]>) {
  const unique = new Set<string>();
  const sorted: [number, number][] = [];
  for (const [fromEdge, toEdge] of pairs) {
    const key = `${fromEdge}:${toEdge}`;
    if (unique.has(key)) continue;
    unique.add(key);
    sorted.push([fromEdge, toEdge]);
  }
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    turnRestrictionFromEdges: Uint32Array.from(sorted, (pair) => pair[0]),
    turnRestrictionToEdges: Uint32Array.from(sorted, (pair) => pair[1]),
  };
}
