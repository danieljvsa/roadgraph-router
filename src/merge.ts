import type { RoadGraph } from "./types";
import { withSpatialIndex } from "./spatial-index";
import { packTurnRestrictions } from "./turn-restrictions";

const COORDINATE_SCALE = 10_000_000;
/** Two edges count as the same road when their lengths agree to the centimetre. */
const LENGTH_EPSILON_METERS = 0.01;

/** Fixed-point key so two tiles agree on a shared boundary node despite float arithmetic. */
function nodeKey(latitude: number, longitude: number) {
  return `${Math.round(latitude * COORDINATE_SCALE)}:${Math.round(longitude * COORDINATE_SCALE)}`;
}

/**
 * Combines overlapping graph tiles into one directed graph. The OSM compiler
 * preserves identical coordinates for shared boundary nodes, which gives us a
 * stable, data-format-independent key for stitching tiles in the browser.
 *
 * Tiles overlap by design, so the same road appears in several chunks. Those
 * copies are collapsed into one directed edge: duplicates would otherwise give
 * A* an unrestricted alternative to an edge that a turn restriction forbids.
 * Restrictions are unioned across tiles, since a tile that only partly covers a
 * junction may legitimately be missing one.
 *
 * A country-sized corridor merge touches millions of edges, so everything past
 * the node table is built in typed arrays. Duplicates are found by scanning the
 * handful of edges already written for the same source node rather than through
 * a hash of every edge, which keeps the merge allocation-light.
 */
export function mergeRoadGraphs(graphs: RoadGraph[]): RoadGraph {
  if (!graphs.length) throw new Error("At least one road graph is required.");
  if (graphs.length === 1) return graphs[0];

  // 1. Stitch the node tables on shared coordinates.
  const nodeIds = new Map<string, number>();
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  const nodeMaps: Uint32Array[] = [];
  let candidateEdges = 0;
  for (const graph of graphs) {
    const coordinateScale = graph.coordinateScale ?? 1;
    const nodeMap = new Uint32Array(graph.nodeLatitudes.length);
    for (let index = 0; index < graph.nodeLatitudes.length; index += 1) {
      const lat = graph.nodeLatitudes[index] / coordinateScale;
      const lng = graph.nodeLongitudes[index] / coordinateScale;
      const key = nodeKey(lat, lng);
      let mergedIndex = nodeIds.get(key);
      if (mergedIndex === undefined) {
        mergedIndex = latitudes.length;
        nodeIds.set(key, mergedIndex);
        latitudes.push(lat);
        longitudes.push(lng);
      }
      nodeMap[index] = mergedIndex;
    }
    nodeMaps.push(nodeMap);
    candidateEdges += graph.edgeTargets.length;
  }
  nodeIds.clear();
  const nodeCount = latitudes.length;

  // 2. Reserve one slot per incoming copy, grouped by source node, so each
  //    node's copies sit together and can be deduplicated by a short scan.
  const slotStart = new Uint32Array(nodeCount + 1);
  for (let index = 0; index < graphs.length; index += 1) {
    const graph = graphs[index];
    const nodeMap = nodeMaps[index];
    for (let from = 0; from < graph.nodeLatitudes.length; from += 1) {
      slotStart[nodeMap[from] + 1] += graph.edgeOffsets[from + 1] - graph.edgeOffsets[from];
    }
  }
  for (let node = 1; node <= nodeCount; node += 1) slotStart[node] += slotStart[node - 1];

  const slotEnd = slotStart.slice(0, nodeCount);
  const slotTargets = new Uint32Array(candidateEdges);
  const slotDistances = new Float32Array(candidateEdges);
  const slotDurations = new Float32Array(candidateEdges);
  const slotSourceGraph = new Int32Array(candidateEdges);
  const slotSourceEdge = new Int32Array(candidateEdges);
  /** Per source graph, the slot each of its edges collapsed into. */
  const edgeMaps: Int32Array[] = [];

  for (let index = 0; index < graphs.length; index += 1) {
    const graph = graphs[index];
    const nodeMap = nodeMaps[index];
    const distanceScale = graph.edgeDistanceScale ?? 1;
    const durationScale = graph.edgeDurationScale ?? 1;
    const edgeMap = new Int32Array(graph.edgeTargets.length);
    for (let from = 0; from < graph.nodeLatitudes.length; from += 1) {
      const mergedFrom = nodeMap[from];
      for (let edge = graph.edgeOffsets[from]; edge < graph.edgeOffsets[from + 1]; edge += 1) {
        const mergedTo = nodeMap[graph.edgeTargets[edge]];
        const distance = graph.edgeDistancesMeters[edge] * distanceScale;
        let slot = -1;
        // Parallel roads between the same pair of nodes are real (a loop and
        // its shortcut), so length takes part in the identity.
        for (let candidate = slotStart[mergedFrom]; candidate < slotEnd[mergedFrom]; candidate += 1) {
          if (slotTargets[candidate] === mergedTo && Math.abs(slotDistances[candidate] - distance) <= LENGTH_EPSILON_METERS) { slot = candidate; break; }
        }
        if (slot < 0) {
          slot = slotEnd[mergedFrom]++;
          slotTargets[slot] = mergedTo;
          slotDistances[slot] = distance;
          slotDurations[slot] = graph.edgeDurationsSeconds[edge] * durationScale;
          slotSourceGraph[slot] = index;
          slotSourceEdge[slot] = edge;
        }
        edgeMap[edge] = slot;
      }
    }
    edgeMaps.push(edgeMap);
  }

  // 3. Close the gaps left by deduplication, keeping the grouping by node.
  const edgeOffsets = new Uint32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) edgeOffsets[node + 1] = edgeOffsets[node] + (slotEnd[node] - slotStart[node]);
  const edgeCount = edgeOffsets[nodeCount];
  const slotToEdge = new Int32Array(candidateEdges).fill(-1);
  const edgeTargets = new Uint32Array(edgeCount);
  const edgeDistancesMeters = new Float32Array(edgeCount);
  const edgeDurationsSeconds = new Float32Array(edgeCount);
  const sourceGraph = new Int32Array(edgeCount);
  const sourceEdge = new Int32Array(edgeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    let target = edgeOffsets[node];
    for (let slot = slotStart[node]; slot < slotEnd[node]; slot += 1, target += 1) {
      slotToEdge[slot] = target;
      edgeTargets[target] = slotTargets[slot];
      edgeDistancesMeters[target] = slotDistances[slot];
      edgeDurationsSeconds[target] = slotDurations[slot];
      sourceGraph[target] = slotSourceGraph[slot];
      sourceEdge[target] = slotSourceEdge[slot];
    }
  }

  // 4. Copy each surviving edge's shape points from the tile it came from.
  const edgeShapeOffsets = new Uint32Array(edgeCount + 1);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const graph = graphs[sourceGraph[edge]];
    const offsets = graph.edgeShapeOffsets;
    const length = offsets ? offsets[sourceEdge[edge] + 1] - offsets[sourceEdge[edge]] : 0;
    edgeShapeOffsets[edge + 1] = edgeShapeOffsets[edge] + length;
  }
  const pointCount = edgeShapeOffsets[edgeCount];
  const edgeShapeLatitudes = new Int32Array(pointCount);
  const edgeShapeLongitudes = new Int32Array(pointCount);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const graph = graphs[sourceGraph[edge]];
    if (!graph.edgeShapeOffsets || !graph.edgeShapeLatitudes || !graph.edgeShapeLongitudes) continue;
    const scale = graph.coordinateScale ?? 1;
    let target = edgeShapeOffsets[edge];
    for (let point = graph.edgeShapeOffsets[sourceEdge[edge]]; point < graph.edgeShapeOffsets[sourceEdge[edge] + 1]; point += 1, target += 1) {
      edgeShapeLatitudes[target] = Math.round((graph.edgeShapeLatitudes[point] / scale) * COORDINATE_SCALE);
      edgeShapeLongitudes[target] = Math.round((graph.edgeShapeLongitudes[point] / scale) * COORDINATE_SCALE);
    }
  }

  // 5. Rebase every tile's restrictions onto the merged edge numbering.
  const bannedPairs: [number, number][] = [];
  for (let index = 0; index < graphs.length; index += 1) {
    const { turnRestrictionFromEdges: fromEdges, turnRestrictionToEdges: toEdges } = graphs[index];
    if (!fromEdges || !toEdges) continue;
    const edgeMap = edgeMaps[index];
    for (let pair = 0; pair < fromEdges.length; pair += 1) {
      const fromEdge = slotToEdge[edgeMap[fromEdges[pair]]];
      const toEdge = slotToEdge[edgeMap[toEdges[pair]]];
      if (fromEdge >= 0 && toEdge >= 0) bannedPairs.push([fromEdge, toEdge]);
    }
  }

  return withSpatialIndex({
    nodeLatitudes: Int32Array.from(latitudes, (value) => Math.round(value * COORDINATE_SCALE)),
    nodeLongitudes: Int32Array.from(longitudes, (value) => Math.round(value * COORDINATE_SCALE)),
    coordinateScale: COORDINATE_SCALE,
    edgeOffsets,
    edgeTargets,
    edgeDistancesMeters,
    edgeDurationsSeconds,
    ...(pointCount ? { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes } : {}),
    ...(bannedPairs.length ? packTurnRestrictions(bannedPairs) : {}),
  });
}
