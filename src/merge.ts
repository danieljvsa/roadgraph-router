import type { RoadGraph } from "./types";
import { withSpatialIndex } from "./spatial-index";

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
  const edges: { from: number; to: number; distance: number; duration: number; shape: number[] }[] = [];

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
        const shape: number[] = [];
        if (graph.edgeShapeOffsets && graph.edgeShapeLatitudes && graph.edgeShapeLongitudes) {
          for (let point = graph.edgeShapeOffsets[edge]; point < graph.edgeShapeOffsets[edge + 1]; point += 1) shape.push(graph.edgeShapeLatitudes[point] / coordinateScale, graph.edgeShapeLongitudes[point] / coordinateScale);
        }
        edges.push({ from: nodeMap[from], to: nodeMap[graph.edgeTargets[edge]], distance: graph.edgeDistancesMeters[edge] * distanceScale, duration: graph.edgeDurationsSeconds[edge] * durationScale, shape });
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
  const edgeShapeOffsets = new Uint32Array(edges.length + 1);
  const shapeLatitudes: number[] = [];
  const shapeLongitudes: number[] = [];
  for (const edge of edges) {
    const index = writeOffsets[edge.from]++;
    edgeTargets[index] = edge.to;
    edgeDistancesMeters[index] = edge.distance;
    edgeDurationsSeconds[index] = edge.duration;
    edgeShapeOffsets[index + 1] = edgeShapeOffsets[index] + edge.shape.length / 2;
    for (let point = 0; point < edge.shape.length; point += 2) { shapeLatitudes.push(edge.shape[point]); shapeLongitudes.push(edge.shape[point + 1]); }
  }
  if (!shapeLatitudes.length) return withSpatialIndex({ nodeLatitudes: Float64Array.from(latitudes), nodeLongitudes: Float64Array.from(longitudes), edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds });
  const coordinateScale = 10_000_000;
  return withSpatialIndex({ nodeLatitudes: Int32Array.from(latitudes, (value) => Math.round(value * coordinateScale)), nodeLongitudes: Int32Array.from(longitudes, (value) => Math.round(value * coordinateScale)), edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds, coordinateScale, edgeShapeOffsets, edgeShapeLatitudes: Int32Array.from(shapeLatitudes, (value) => Math.round(value * coordinateScale)), edgeShapeLongitudes: Int32Array.from(shapeLongitudes, (value) => Math.round(value * coordinateScale)) });
}
