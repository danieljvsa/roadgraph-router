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

/**
 * A restriction whose `via` is a way bans a run of three or more consecutive
 * edges, which a single banned pair cannot express. They are kept apart from
 * pairs because enforcing them costs search state, and they are rare: in a
 * Portugal extract they are about 6% of the restrictions read.
 */
export type TurnSequenceIndex = {
  /** Each banned run, in traversal order. */
  sequences: number[][];
  /** Runs keyed by their first edge, so the hot loop only pays when one starts. */
  startingAt: Map<number, number[]>;
  /**
   * Multiplier used to pack a (run, position) pair into one number. It is
   * derived from the longest run present rather than fixed, so a long run can
   * never alias onto another run's identifier.
   */
  stride: number;
};

export function buildTurnSequenceIndex(graph: RoadGraph): TurnSequenceIndex | null {
  const offsets = graph.turnRestrictionSequenceOffsets;
  const edges = graph.turnRestrictionSequenceEdges;
  if (!offsets || !edges || offsets.length < 2) return null;
  const sequences: number[][] = [];
  const startingAt = new Map<number, number[]>();
  for (let index = 0; index + 1 < offsets.length; index += 1) {
    const sequence = Array.from(edges.subarray(offsets[index], offsets[index + 1]));
    if (sequence.length < 3) continue;
    const id = sequences.length;
    sequences.push(sequence);
    const bucket = startingAt.get(sequence[0]);
    if (bucket) bucket.push(id);
    else startingAt.set(sequence[0], [id]);
  }
  if (!sequences.length) return null;
  const stride = sequences.reduce((longest, sequence) => Math.max(longest, sequence.length), 0) + 1;
  return { sequences, startingAt, stride };
}

/** Flattens banned runs into the two arrays the codec writes. */
export function packTurnSequences(sequences: number[][]) {
  const kept = sequences.filter((sequence) => sequence.length >= 3);
  const unique = new Map(kept.map((sequence) => [sequence.join(","), sequence]));
  const ordered = [...unique.values()].sort((a, b) => a[0] - b[0] || a.length - b.length || a[1] - b[1]);
  const turnRestrictionSequenceOffsets = new Uint32Array(ordered.length + 1);
  for (let index = 0; index < ordered.length; index += 1) turnRestrictionSequenceOffsets[index + 1] = turnRestrictionSequenceOffsets[index] + ordered[index].length;
  const turnRestrictionSequenceEdges = new Uint32Array(turnRestrictionSequenceOffsets[ordered.length]);
  let at = 0;
  for (const sequence of ordered) for (const edge of sequence) turnRestrictionSequenceEdges[at++] = edge;
  return { turnRestrictionSequenceOffsets, turnRestrictionSequenceEdges };
}
