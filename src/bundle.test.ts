import { encodeRoadGraphBundle, RoadRouter } from "./index";

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

  it("decompresses independently gzip-compressed chunks after their range fetch", async () => {
    const uncompressed = encodeRoadGraphBundle([{ id: 7, bounds: { minLat: 36, minLng: -9, maxLat: 38, maxLng: -7 }, graph }]);
    const rawChunk = uncompressed.slice(72);
    const compressedStream = new Blob([rawChunk]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(compressedStream).arrayBuffer();
    const bundle = new ArrayBuffer(72 + compressed.byteLength);
    const view = new DataView(bundle);
    new Uint8Array(bundle, 0, 72).set(new Uint8Array(uncompressed, 0, 72));
    view.setUint32(56, compressed.byteLength, true);
    view.setUint32(60, rawChunk.byteLength, true);
    view.setUint16(64, 1, true);
    new Uint8Array(bundle, 72).set(new Uint8Array(compressed));
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const range = String((init?.headers as Record<string, string>)?.Range);
      const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
      return new Response(bundle.slice(Number(startText), Number(endText) + 1), { status: 206 });
    };

    const router = await RoadRouter.open("/routing/portugal.efrb", fetcher);
    await expect(router.route({ lat: 37, lng: -8 }, { lat: 37.001, lng: -8.001 })).resolves.toMatchObject({ nodeIds: [0, 1] });
  });
});
