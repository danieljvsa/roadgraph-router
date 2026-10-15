/**
 * Which parts of a graph are joined to which.
 *
 * A road network is not one piece. Service roads inside a compound, a path
 * fragment behind a fence, a stretch clipped by the edge of a tile — all sit
 * apart from the rest, and a point a couple of metres from one of them snaps
 * to it rather than to the road just beyond. The route then fails although a
 * perfectly good road was in reach.
 *
 * Labels are weak: an edge joins its two nodes whichever way it points. That
 * is deliberately the cheap question. Two nodes in different pieces certainly
 * cannot reach each other, which is what the snapper needs to know; two in the
 * same piece usually can, and where a one-way trap says otherwise the search
 * finds out for itself.
 */

import type { RoadGraph } from "./types";

const cache = new WeakMap<RoadGraph, Int32Array>();

/** One label per node. Nodes sharing a label are joined, ignoring direction. */
export function componentsFor(graph: RoadGraph): Int32Array {
  const held = cache.get(graph);
  if (held) return held;

  const nodes = graph.nodeLatitudes.length;
  const labels = new Int32Array(nodes).fill(-1);
  // Reverse adjacency is needed to walk an edge backwards, and is built here
  // rather than kept, because this runs only when a route has already failed.
  const incomingStart = new Uint32Array(nodes + 1);
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) incomingStart[graph.edgeTargets[edge] + 1] += 1;
  for (let node = 1; node <= nodes; node += 1) incomingStart[node] += incomingStart[node - 1];
  const cursor = incomingStart.slice(0, nodes);
  const incoming = new Uint32Array(graph.edgeTargets.length);
  for (let node = 0; node < nodes; node += 1) {
    for (let edge = graph.edgeOffsets[node]; edge < graph.edgeOffsets[node + 1]; edge += 1) incoming[cursor[graph.edgeTargets[edge]]++] = node;
  }

  const stack = new Int32Array(nodes);
  let label = 0;
  for (let start = 0; start < nodes; start += 1) {
    if (labels[start] !== -1) continue;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const node = stack[--top];
      for (let edge = graph.edgeOffsets[node]; edge < graph.edgeOffsets[node + 1]; edge += 1) {
        const next = graph.edgeTargets[edge];
        if (labels[next] === -1) { labels[next] = label; stack[top++] = next; }
      }
      for (let slot = incomingStart[node]; slot < incomingStart[node + 1]; slot += 1) {
        const previous = incoming[slot];
        if (labels[previous] === -1) { labels[previous] = label; stack[top++] = previous; }
      }
    }
    label += 1;
  }
  cache.set(graph, labels);
  return labels;
}

/** How many nodes carry each label, so the smaller piece can be recognised. */
export function componentSizes(labels: Int32Array) {
  const sizes = new Map<number, number>();
  for (let node = 0; node < labels.length; node += 1) sizes.set(labels[node], (sizes.get(labels[node]) ?? 0) + 1);
  return sizes;
}
