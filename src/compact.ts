import type { RoadGraph } from "./types";

export type CompactGraphOptions = {
  coordinateScale?: number;
  maxEdgeWeight?: number;
};

function scaleFor(values: ArrayLike<number>, maximum: number) {
  let largest = 0;
  for (let index = 0; index < values.length; index += 1) largest = Math.max(largest, values[index]);
  return Math.max(1, Math.ceil(largest / maximum));
}

/**
 * Converts a v1 graph into the storage layout used by the compact format.
 * Coordinates use fixed-point Int32 values; edge weights use scaled Uint16s.
 */
export function compactGraph(graph: RoadGraph, options: CompactGraphOptions = {}): RoadGraph {
  const coordinateScale = options.coordinateScale ?? 10_000_000;
  const maximum = options.maxEdgeWeight ?? 65_535;
  const inputCoordinateScale = graph.coordinateScale ?? 1;
  const inputDistanceScale = graph.edgeDistanceScale ?? 1;
  const inputDurationScale = graph.edgeDurationScale ?? 1;
  const nodeLatitudes = new Int32Array(graph.nodeLatitudes.length);
  const nodeLongitudes = new Int32Array(graph.nodeLongitudes.length);
  for (let index = 0; index < nodeLatitudes.length; index += 1) {
    nodeLatitudes[index] = Math.round((graph.nodeLatitudes[index] / inputCoordinateScale) * coordinateScale);
    nodeLongitudes[index] = Math.round((graph.nodeLongitudes[index] / inputCoordinateScale) * coordinateScale);
  }

  const distances = Float64Array.from(graph.edgeDistancesMeters, (value) => value * inputDistanceScale);
  const durations = Float64Array.from(graph.edgeDurationsSeconds, (value) => value * inputDurationScale);
  const edgeDistanceScale = scaleFor(distances, maximum);
  const edgeDurationScale = scaleFor(durations, maximum);
  const edgeDistancesMeters = new Uint16Array(distances.length);
  const edgeDurationsSeconds = new Uint16Array(durations.length);
  // Rounding a short edge's duration down can leave it costing nothing at all,
  // and a free edge is a shortcut the search will always take. Every edge with
  // length keeps at least one unit of duration.
  for (let index = 0; index < distances.length; index += 1) {
    edgeDistancesMeters[index] = Math.round(distances[index] / edgeDistanceScale);
    const quantised = Math.round(durations[index] / edgeDurationScale);
    edgeDurationsSeconds[index] = quantised || (durations[index] > 0 || distances[index] > 0 ? 1 : 0);
  }

  const edgeShapeOffsets = graph.edgeShapeOffsets?.slice();
  const edgeShapeLatitudes = graph.edgeShapeLatitudes && Int32Array.from(graph.edgeShapeLatitudes, (value) => Math.round((value / inputCoordinateScale) * coordinateScale));
  const edgeShapeLongitudes = graph.edgeShapeLongitudes && Int32Array.from(graph.edgeShapeLongitudes, (value) => Math.round((value / inputCoordinateScale) * coordinateScale));

  return {
    nodeLatitudes,
    nodeLongitudes,
    edgeOffsets: graph.edgeOffsets.slice(),
    edgeTargets: graph.edgeTargets.slice(),
    edgeDistancesMeters,
    edgeDurationsSeconds,
    coordinateScale,
    edgeDistanceScale,
    edgeDurationScale,
    // Quantising the weights does not change which vehicle the graph is for.
    ...(graph.profileId ? { profileId: graph.profileId } : {}),
    ...(graph.maxSpeedKph ? { maxSpeedKph: graph.maxSpeedKph } : {}),
    ...(edgeShapeOffsets && edgeShapeLatitudes && edgeShapeLongitudes ? { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes } : {}),
    ...(graph.turnRestrictionFromEdges && graph.turnRestrictionToEdges
      ? { turnRestrictionFromEdges: graph.turnRestrictionFromEdges.slice(), turnRestrictionToEdges: graph.turnRestrictionToEdges.slice() }
      : {}),
    ...(graph.turnRestrictionSequenceOffsets && graph.turnRestrictionSequenceEdges
      ? { turnRestrictionSequenceOffsets: graph.turnRestrictionSequenceOffsets.slice(), turnRestrictionSequenceEdges: graph.turnRestrictionSequenceEdges.slice() }
      : {}),
  };
}
