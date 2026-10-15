import type { RoadGraph } from "./types";
import { withSpatialIndex } from "./spatial-index";
import { packTurnRestrictions, packTurnSequences } from "./turn-restrictions";
import { accessMaskFor, edgeAllowed } from "./access";
import { packEdgeLimits, fromDecimetres, fromHalfTonnes } from "./limits";
import { packEdgeConditions } from "./conditional";

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
  // Merging graphs compiled for different vehicles would produce a network
  // that is legal for neither, so the profiles have to agree.
  const profileId = graphs[0].profileId;
  for (const graph of graphs) {
    if (graph.profileId !== profileId) throw new Error("Cannot merge road graphs compiled for different routing profiles.");
  }

  // 1. Stitch the node tables on shared coordinates.
  //
  // A country-sized corridor stitches well over a million node copies, so this
  // loop is the merge. Tiles compiled together share a coordinate scale, which
  // means their stored integers can be compared directly: no divide, no round
  // and no string key per copy. The integers are packed into one number
  // relative to the region's own corner, and that only works while the region
  // is small enough for the product to stay exact, so the general path stays
  // for anything larger or for tiles that disagree on a scale.
  const scale = graphs[0].coordinateScale ?? 1;
  const uniformScale = graphs.every((graph) => (graph.coordinateScale ?? 1) === scale);
  let minLatitude = Infinity;
  let minLongitude = Infinity;
  let span = Infinity;
  if (uniformScale) {
    let maxLatitude = -Infinity;
    let maxLongitude = -Infinity;
    for (const graph of graphs) {
      for (let index = 0; index < graph.nodeLatitudes.length; index += 1) {
        const latitude = graph.nodeLatitudes[index];
        const longitude = graph.nodeLongitudes[index];
        if (latitude < minLatitude) minLatitude = latitude;
        if (latitude > maxLatitude) maxLatitude = latitude;
        if (longitude < minLongitude) minLongitude = longitude;
        if (longitude > maxLongitude) maxLongitude = longitude;
      }
    }
    span = maxLongitude - minLongitude + 1;
    if ((maxLatitude - minLatitude + 1) * span > Number.MAX_SAFE_INTEGER) span = Infinity;
  }
  const packed = Number.isFinite(span);

  const totalNodes = graphs.reduce((sum, graph) => sum + graph.nodeLatitudes.length, 0);
  const mergedLatitudes = new Int32Array(totalNodes);
  const mergedLongitudes = new Int32Array(totalNodes);
  let nodeCount = 0;
  const nodeIds = new Map<number | string, number>();
  const nodeMaps: Uint32Array[] = [];
  let candidateEdges = 0;
  for (const graph of graphs) {
    const graphScale = graph.coordinateScale ?? 1;
    const nodeMap = new Uint32Array(graph.nodeLatitudes.length);
    for (let index = 0; index < graph.nodeLatitudes.length; index += 1) {
      const rawLatitude = graph.nodeLatitudes[index];
      const rawLongitude = graph.nodeLongitudes[index];
      const key = packed
        ? (rawLatitude - minLatitude) * span + (rawLongitude - minLongitude)
        : nodeKey(rawLatitude / graphScale, rawLongitude / graphScale);
      let mergedIndex = nodeIds.get(key);
      if (mergedIndex === undefined) {
        mergedIndex = nodeCount++;
        nodeIds.set(key, mergedIndex);
        mergedLatitudes[mergedIndex] = graphScale === COORDINATE_SCALE ? rawLatitude : Math.round((rawLatitude / graphScale) * COORDINATE_SCALE);
        mergedLongitudes[mergedIndex] = graphScale === COORDINATE_SCALE ? rawLongitude : Math.round((rawLongitude / graphScale) * COORDINATE_SCALE);
      }
      nodeMap[index] = mergedIndex;
    }
    nodeMaps.push(nodeMap);
    candidateEdges += graph.edgeTargets.length;
  }
  nodeIds.clear();

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

  // 5. Rebase every tile's restrictions, access and limits onto the merged
  //    edge numbering. All three are written against edge numbers that the
  //    merge has just changed, and a corridor that lost them would route a
  //    lorry under a bridge it does not fit through.
  const bannedPairs: [number, number][] = [];
  const bannedSequences: number[][] = [];
  const hasAccess = graphs.some((graph) => graph.edgeAccess);
  const mergedAccess = hasAccess ? accessMaskFor(edgeCount, () => true) : undefined;
  const limitRows = new Map<number, { heightMeters?: number; widthMeters?: number; lengthMeters?: number; weightTonnes?: number }>();
  const conditionRows: { edge: number; kind: number; value: string }[] = [];
  const seenConditions = new Set<string>();
  for (let index = 0; index < graphs.length; index += 1) {
    const graph = graphs[index];
    const edgeMap = edgeMaps[index];
    const rebase = (edge: number) => slotToEdge[edgeMap[edge]];

    if (mergedAccess) {
      // A road one tile says this vehicle may not use is one it may not use,
      // whichever tile the merge happened to take the edge from.
      for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
        if (edgeAllowed(graph.edgeAccess, edge)) continue;
        const merged = rebase(edge);
        if (merged >= 0) mergedAccess[merged >> 3] &= ~(1 << (merged & 7));
      }
    }

    const limits = graph.edgeLimits;
    if (limits) {
      for (let row = 0; row < limits.edges.length; row += 1) {
        const merged = rebase(limits.edges[row]);
        if (merged < 0) continue;
        const existing = limitRows.get(merged) ?? {};
        // Two tiles describing the same road must agree; where they do not,
        // the stricter limit is the safe one to keep.
        const stricter = (left: number | undefined, right: number) => (left === undefined ? right : Math.min(left, right));
        if (limits.heightDecimetres[row]) existing.heightMeters = stricter(existing.heightMeters, fromDecimetres(limits.heightDecimetres[row]));
        if (limits.widthDecimetres[row]) existing.widthMeters = stricter(existing.widthMeters, fromDecimetres(limits.widthDecimetres[row]));
        if (limits.lengthDecimetres[row]) existing.lengthMeters = stricter(existing.lengthMeters, fromDecimetres(limits.lengthDecimetres[row]));
        if (limits.weightHalfTonnes[row]) existing.weightTonnes = stricter(existing.weightTonnes, fromHalfTonnes(limits.weightHalfTonnes[row]));
        limitRows.set(merged, existing);
      }
    }

    const conditions = graph.edgeConditions;
    if (conditions) {
      for (let row = 0; row < conditions.edges.length; row += 1) {
        const merged = rebase(conditions.edges[row]);
        if (merged < 0) continue;
        const value = conditions.values[conditions.rules[row]];
        // Tiles overlap, so the same restriction arrives once per tile that
        // saw the road. Keeping one copy of each is enough: they say the same.
        const key = `${merged}:${conditions.kinds[row]}:${value}`;
        if (seenConditions.has(key)) continue;
        seenConditions.add(key);
        conditionRows.push({ edge: merged, kind: conditions.kinds[row], value });
      }
    }

    const { turnRestrictionFromEdges: fromEdges, turnRestrictionToEdges: toEdges } = graph;
    if (fromEdges && toEdges) {
      for (let pair = 0; pair < fromEdges.length; pair += 1) {
        // A restriction this vehicle is excepted from is dropped here rather
        // than carried as a mask, so the merged graph needs no mask at all.
        if (!edgeAllowed(graph.restrictionMask, pair)) continue;
        const fromEdge = rebase(fromEdges[pair]);
        const toEdge = rebase(toEdges[pair]);
        if (fromEdge >= 0 && toEdge >= 0) bannedPairs.push([fromEdge, toEdge]);
      }
    }
    const offsets = graph.turnRestrictionSequenceOffsets;
    const sequenceEdges = graph.turnRestrictionSequenceEdges;
    if (!offsets || !sequenceEdges) continue;
    const pairCount = fromEdges?.length ?? 0;
    for (let sequence = 0; sequence + 1 < offsets.length; sequence += 1) {
      if (!edgeAllowed(graph.restrictionMask, pairCount + sequence)) continue;
      const rebased: number[] = [];
      for (let at = offsets[sequence]; at < offsets[sequence + 1]; at += 1) rebased.push(rebase(sequenceEdges[at]));
      // A run that lost an edge to clipping cannot be enforced, and keeping a
      // shortened version would ban a turn nobody asked to ban.
      if (rebased.every((edge) => edge >= 0)) bannedSequences.push(rebased);
    }
  }
  const mergedLimits = packEdgeLimits([...limitRows].map(([edge, limits]) => ({ edge, limits })));
  const mergedConditions = packEdgeConditions(conditionRows);

  return withSpatialIndex({
    nodeLatitudes: mergedLatitudes.slice(0, nodeCount),
    nodeLongitudes: mergedLongitudes.slice(0, nodeCount),
    coordinateScale: COORDINATE_SCALE,
    edgeOffsets,
    edgeTargets,
    edgeDistancesMeters,
    edgeDurationsSeconds,
    ...(profileId ? { profileId } : {}),
    ...(graphs[0].maxSpeedKph ? { maxSpeedKph: graphs[0].maxSpeedKph } : {}),
    ...(mergedAccess ? { edgeAccess: mergedAccess } : {}),
    ...(mergedLimits ? { edgeLimits: mergedLimits } : {}),
    ...(mergedConditions ? { edgeConditions: mergedConditions } : {}),
    ...(pointCount ? { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes } : {}),
    ...(bannedPairs.length ? packTurnRestrictions(bannedPairs) : {}),
    ...(bannedSequences.length ? packTurnSequences(bannedSequences) : {}),
  });
}
