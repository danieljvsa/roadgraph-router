import { compactGraph, createSpatialIndex, decodeGraph, encodeCompactGraph, encodeGraph, findNearestNode, RoadRouter, route, withSpatialIndex } from "./index";
import type { RoadGraph } from "./types";

const graph: RoadGraph = {
  nodeLatitudes: new Float64Array([41, 41, 41.001, 41.001]),
  nodeLongitudes: new Float64Array([-8, -7.999, -8, -7.999]),
  edgeOffsets: new Uint32Array([0, 2, 3, 4, 4]),
  edgeTargets: new Uint32Array([1, 2, 3, 3]),
  edgeDistancesMeters: new Float32Array([100, 130, 100, 100]),
  edgeDurationsSeconds: new Float32Array([10, 30, 10, 10]),
};

describe("compact graph v2", () => {
  it("uses fixed-point coordinates and preserves routing behaviour", () => {
    const compact = compactGraph(graph);
    expect(compact.nodeLatitudes).toBeInstanceOf(Int32Array);
    expect(compact.edgeDistancesMeters).toBeInstanceOf(Uint16Array);
    expect(encodeCompactGraph(compact).byteLength).toBeLessThan(encodeGraph(graph).byteLength);
    const decoded = decodeGraph(encodeCompactGraph(compact));
    const result = route(decoded, { lat: 41, lng: -8 }, { lat: 41.001, lng: -7.999 });
    expect(result.nodeIds).toEqual([0, 1, 3]);
    expect(result.distanceMeters).toBe(200);
    expect(result.durationSeconds).toBe(20);
  });

  it("uses the spatial index to snap without changing the nearest result", () => {
    const indexed = withSpatialIndex(graph, 0.01);
    expect(indexed.spatialIndex).toEqual(createSpatialIndex(graph, 0.01));
    expect(findNearestNode(indexed, { lat: 41.0001, lng: -7.9999 })).toBe(0);
  });

  it("exposes the high-level router API for an in-memory graph", async () => {
    const router = await RoadRouter.open(graph);
    await expect(router.route({ lat: 41, lng: -8 }, { lat: 41.001, lng: -7.999 })).resolves.toMatchObject({ nodeIds: [0, 1, 3] });
  });
});
