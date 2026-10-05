import { mergeRoadGraphs } from "./merge";
import { route } from "./router";

const first = {
  nodeLatitudes: new Float64Array([37, 37]), nodeLongitudes: new Float64Array([-8, -7.9]),
  edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]),
  edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
};
const second = {
  nodeLatitudes: new Float64Array([37, 37]), nodeLongitudes: new Float64Array([-7.9, -7.8]),
  edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]),
  edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
};

it("stitches matching boundary nodes from adjacent graph tiles", () => {
  const merged = mergeRoadGraphs([first, second]);
  expect(merged.nodeLatitudes).toHaveLength(3);
  expect(route(merged, { lat: 37, lng: -8 }, { lat: 37, lng: -7.8 }).distanceMeters).toBe(200);
});
