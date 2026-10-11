import { compactGraph, decodeGraph, encodeCompactGraph, mergeRoadGraphs, route } from "./index";
import type { RoadGraph } from "./types";

it("round-trips compact edge shapes and returns their real route geometry", () => {
  const graph: RoadGraph = {
    nodeLatitudes: new Int32Array([410000000, 410020000]), nodeLongitudes: new Int32Array([-80000000, -79980000]),
    edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]), edgeDistancesMeters: new Float32Array([300]), edgeDurationsSeconds: new Float32Array([30]),
    edgeShapeOffsets: new Uint32Array([0, 2]), edgeShapeLatitudes: new Int32Array([410005000, 410015000]), edgeShapeLongitudes: new Int32Array([-79995000, -79985000]), coordinateScale: 10_000_000,
  };
  const decoded = decodeGraph(encodeCompactGraph(compactGraph(graph)));
  expect(route(decoded, { lat: 41, lng: -8 }, { lat: 41.002, lng: -7.998 }).geometry.coordinates).toEqual([[-8, 41], [-7.9995, 41.0005], [-7.9985, 41.0015], [-7.998, 41.002]]);
});

it("keeps edge shapes when route tiles are merged", () => {
  const graph = (latitudes: number[], longitudes: number[], target: number, shapes: number[]) => ({
    nodeLatitudes: Int32Array.from(latitudes), nodeLongitudes: Int32Array.from(longitudes), coordinateScale: 10_000_000,
    edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([target]), edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
    edgeShapeOffsets: new Uint32Array([0, shapes.length / 2]), edgeShapeLatitudes: new Int32Array(shapes.filter((_, index) => index % 2 === 0)), edgeShapeLongitudes: new Int32Array(shapes.filter((_, index) => index % 2 === 1)),
  });
  const first = graph([410000000, 410010000], [-80000000, -79990000], 1, [410005000, -79995000]);
  const second = graph([410010000, 410020000], [-79990000, -79980000], 1, [410015000, -79985000]);
  const result = route(mergeRoadGraphs([first, second]), { lat: 41, lng: -8 }, { lat: 41.002, lng: -7.998 });
  expect(result.geometry.coordinates).toEqual([[-8, 41], [-7.9995, 41.0005], [-7.999, 41.001], [-7.9985, 41.0015], [-7.998, 41.002]]);
});
