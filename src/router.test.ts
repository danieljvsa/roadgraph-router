import { decodeGraph, encodeGraph, route } from "./index";
import type { RoadGraph } from "./types";

const graph: RoadGraph = {
  nodeLatitudes: new Float64Array([41, 41, 41.001, 41.001]),
  nodeLongitudes: new Float64Array([-8, -7.999, -8, -7.999]),
  edgeOffsets: new Uint32Array([0, 2, 3, 4, 4]),
  edgeTargets: new Uint32Array([1, 2, 3, 3]),
  edgeDistancesMeters: new Float32Array([100, 130, 100, 100]),
  edgeDurationsSeconds: new Float32Array([10, 30, 10, 10]),
};

describe("router-core", () => {
  it("uses A* to choose the fastest directed route", () => {
    const result = route(graph, { lat: 41, lng: -8 }, { lat: 41.001, lng: -7.999 });
    expect(result.nodeIds).toEqual([0, 1, 3]);
    expect(result.distanceMeters).toBe(200);
    expect(result.durationSeconds).toBe(20);
    expect(result.geometry.coordinates).toEqual([[-8, 41], [-7.999, 41], [-7.999, 41.001]]);
  });

  it("round-trips the binary graph format", () => {
    const decoded = decodeGraph(encodeGraph(graph));
    expect(route(decoded, { lat: 41, lng: -8 }, { lat: 41.001, lng: -7.999 }).nodeIds).toEqual([0, 1, 3]);
  });
});
