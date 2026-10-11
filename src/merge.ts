import type { RoadGraph } from "./types";

/**
 * Combines overlapping graph tiles into one directed graph. The OSM compiler
 * preserves identical coordinates for shared boundary nodes, which gives us a
 * stable, data-format-independent key for stitching tiles in the browser.
 */
export function mergeRoadGraphs(graphs: RoadGraph[]): RoadGraph {
  if (!graphs.length) throw new Error("At least one road graph is required.");
  if (graphs.length === 1) return graphs[0];

  const nodes = new Map<string, number>();
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  const edges: { from: number; to: number; distance: number; duration: number }[] = [];

  for (const graph of graphs) {
    const nodeMap = new Uint32Array(graph.nodeLatitudes.length);
    const coordinateScale = graph.coordinateScale ?? 1;
    const distanceScale = graph.edgeDistanceScale ?? 1;
    const durationScale = graph.edgeDurationScale ?? 1;
    for (let index = 0; index < graph.nodeLatitudes.length; index += 1) {
      const lat = graph.nodeLatitudes[index] / coordinateScale;
      const lng = graph.nodeLongitudes[index] / coordinateScale;
      const key = `${lat},${lng}`;
      let mergedIndex = nodes.get(key);
      if (mergedIndex === undefined) {
        mergedIndex = latitudes.length;
        nodes.set(key, mergedIndex);
        latitudes.push(lat);
        longitudes.push(lng);
      }
      nodeMap[index] = mergedIndex;
    }
    for (let from = 0; from < graph.nodeLatitudes.length; from += 1) {
      for (let edge = graph.edgeOffsets[from]; edge < graph.edgeOffsets[from + 1]; edge += 1) {
        edges.push({ from: nodeMap[from], to: nodeMap[graph.edgeTargets[edge]], distance: graph.edgeDistancesMeters[edge] * distanceScale, duration: graph.edgeDurationsSeconds[edge] * durationScale });
      }
    }
  }

  const edgeOffsets = new Uint32Array(latitudes.length + 1);
  for (const edge of edges) edgeOffsets[edge.from + 1] += 1;
  for (let index = 1; index < edgeOffsets.length; index += 1) edgeOffsets[index] += edgeOffsets[index - 1];
  const writeOffsets = edgeOffsets.slice();
  const edgeTargets = new Uint32Array(edges.length);
  const edgeDistancesMeters = new Float32Array(edges.length);
  const edgeDurationsSeconds = new Float32Array(edges.length);
  for (const edge of edges) {
    const index = writeOffsets[edge.from]++;
    edgeTargets[index] = edge.to;
    edgeDistancesMeters[index] = edge.distance;
    edgeDurationsSeconds[index] = edge.duration;
  }
  return { nodeLatitudes: Float64Array.from(latitudes), nodeLongitudes: Float64Array.from(longitudes), edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds };
}
