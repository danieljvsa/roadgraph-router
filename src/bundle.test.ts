import { encodeCompressedRoadGraphBundle, encodeRoadGraphBundle, RoadRouter } from "./index";

const graph = {
  nodeLatitudes: new Float64Array([37, 37.001]),
  nodeLongitudes: new Float64Array([-8, -8.001]),
  edgeOffsets: new Uint32Array([0, 1, 1]),
  edgeTargets: new Uint32Array([1]),
  edgeDistancesMeters: new Float32Array([100]),
  edgeDurationsSeconds: new Float32Array([10]),
};

describe("range-addressable routing bundle", () => {
  it("loads the directory and a matching graph chunk through HTTP ranges", async () => {
    const bundle = encodeRoadGraphBundle([{ id: 7, bounds: { minLat: 36, minLng: -9, maxLat: 38, maxLng: -7 }, graph }]);
    const fetcher = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>)?.Range);
      const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
      const start = Number(startText);
      const end = Number(endText);
      return new Response(bundle.slice(start, end + 1), { status: 206 });
    });

    const router = await RoadRouter.open("/routing/portugal.efrb", fetcher);
    const result = await router.route({ lat: 37, lng: -8 }, { lat: 37.001, lng: -8.001 });

    expect(result.nodeIds).toEqual([0, 1]);
    expect(result.distanceMeters).toBe(100);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Range)).toEqual([
      "bytes=0-31", "bytes=32-71", expect.stringMatching(/^bytes=72-/),
    ]);
  });

  it("creates and decompresses independently gzip-compressed chunks", async () => {
    const bundle = await encodeCompressedRoadGraphBundle([{ id: 7, bounds: { minLat: 36, minLng: -9, maxLat: 38, maxLng: -7 }, graph }]);
    const view = new DataView(bundle);
    expect(view.getUint16(64, true)).toBe(1);
    expect(view.getUint32(56, true)).toBeLessThan(view.getUint32(60, true));
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>)?.Range);
      const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
      return new Response(bundle.slice(Number(startText), Number(endText) + 1), { status: 206 });
    };

    const router = await RoadRouter.open("/routing/portugal.efrb", fetcher);
    await expect(router.route({ lat: 37, lng: -8 }, { lat: 37.001, lng: -8.001 })).resolves.toMatchObject({ nodeIds: [0, 1] });
  });

  it("retries with neighbouring tiles when a detour lies outside the direct corridor", async () => {
    const point = (lat: number, lng: number) => ({ lat, lng });
    const edge = (from: ReturnType<typeof point>, to: ReturnType<typeof point>) => ({
      nodeLatitudes: new Float64Array([from.lat, to.lat]), nodeLongitudes: new Float64Array([from.lng, to.lng]),
      edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]),
      edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
    });
    const origin = point(0.2, 0.2);
    const joinA = point(0.9, 0.5);
    const joinB = point(0.9, 2.5);
    const destination = point(0.2, 2.8);
    const bundle = encodeRoadGraphBundle([
      { id: 1, bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }, graph: edge(origin, joinA) },
      { id: 2, bounds: { minLat: 0, minLng: 2, maxLat: 1, maxLng: 3 }, graph: edge(joinB, destination) },
      { id: 3, bounds: { minLat: 1, minLng: 0, maxLat: 2, maxLng: 3 }, graph: edge(joinA, joinB) },
    ]);
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>)?.Range);
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
      return new Response(bundle.slice(Number(start), Number(end) + 1), { status: 206 });
    };
    const router = await RoadRouter.open("/routing/detour.efrb", fetcher);
    await expect(router.route(origin, destination)).resolves.toMatchObject({ nodeIds: [0, 1, 2, 3], distanceMeters: 300 });
  });
});
