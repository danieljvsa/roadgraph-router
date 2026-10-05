import { encodeGraph } from "./codec";
import { createRouteGraphLoader } from "./manifest";

const graph = encodeGraph({
  nodeLatitudes: new Float64Array([37, 37.001]),
  nodeLongitudes: new Float64Array([-8, -8.001]),
  edgeOffsets: new Uint32Array([0, 1, 1]),
  edgeTargets: new Uint32Array([1]),
  edgeDistancesMeters: new Float32Array([100]),
  edgeDurationsSeconds: new Float32Array([10]),
});

describe("createRouteGraphLoader", () => {
  it("loads a graph tile selected by generic manifest bounds", async () => {
    const fetcher = jest.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/routing/manifest.json") {
        return new Response(JSON.stringify({
          formatVersion: 1,
          region: { id: "test-region", name: "Test region" },
          profile: "car",
          generatedAt: "2026-01-01T00:00:00.000Z",
          tiles: [{ id: "test", href: "/routing/test.efrt", bounds: { minLat: 36, minLng: -9, maxLat: 38, maxLng: -7 }, bytes: graph.byteLength, nodes: 2, edges: 1 }],
        }));
      }
      return new Response(graph);
    });

    const loader = await createRouteGraphLoader("/routing/manifest.json", fetcher);
    const loaded = await loader.loadForRoute({ lat: 37, lng: -8 }, { lat: 37.001, lng: -8.001 });

    expect(loaded.nodeLatitudes).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith("/routing/test.efrt");
  });
});
