import { BoundedCache, heldBytes } from "./bounded-cache";
import { encodeRoadGraphBundle, openRoadGraphBundle } from "./bundle";
import { compactGraph } from "./compact";
import { buildGraph, rangeFetcher } from "./test-support";

/** A value of `bytes` bytes, as the caches see it. */
const sized = (bytes: number) => ({ data: new Uint8Array(bytes) });
const cacheOf = (maxBytes: number, keepOversized = false, maxEntries = Infinity) => {
  const evicted: string[] = [];
  const cache = new BoundedCache<{ data: Uint8Array }>({
    maxEntries, maxBytes, keepOversized, sizeOf: heldBytes, onEvict: (key) => evicted.push(key),
  });
  return { cache, evicted };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("heldBytes", () => {
  it("counts typed arrays, nested ones included, each once", () => {
    const shared = new Float64Array(10);
    const value = { a: shared, b: new Uint32Array(4), index: { cells: new Map([["0:0", new Uint32Array(2)]]) }, again: shared, n: 5 };
    expect(heldBytes(value)).toBe(80 + 16 + 8);
  });
});

describe("BoundedCache", () => {
  it("drops the least recently used once over its byte budget", async () => {
    const { cache, evicted } = cacheOf(100);
    cache.set("a", Promise.resolve(sized(40)));
    cache.set("b", Promise.resolve(sized(40)));
    await settle();
    await cache.get("a"); // a is now the most recently used
    cache.set("c", Promise.resolve(sized(40)));
    await settle();
    expect(evicted).toEqual(["b"]);
    expect([...cache.keys()].sort()).toEqual(["a", "c"]);
    expect(cache.heldBytes).toBe(80);
  });

  it("does not keep a value larger than its whole budget, unless told to", async () => {
    const corridors = cacheOf(100);
    corridors.cache.set("small", Promise.resolve(sized(30)));
    corridors.cache.set("huge", Promise.resolve(sized(150)));
    await settle();
    // Nothing else is dropped for it either: it goes, the small one stays.
    expect([...corridors.cache.keys()]).toEqual(["small"]);

    const tiles = cacheOf(100, true);
    tiles.cache.set("small", Promise.resolve(sized(30)));
    tiles.cache.set("huge", Promise.resolve(sized(150)));
    await settle();
    expect([...tiles.cache.keys()]).toEqual(["huge"]);
  });

  it("forgets a value that failed, so it is fetched afresh", async () => {
    const { cache } = cacheOf(100);
    const failed = Promise.reject(new Error("offline"));
    failed.catch(() => {});
    cache.set("a", failed);
    await settle();
    expect(cache.has("a")).toBe(false);
  });

  it("keeps nothing with a budget of 0", async () => {
    const { cache } = cacheOf(0);
    cache.set("a", Promise.resolve(sized(1)));
    expect(cache.size).toBe(0);
  });

  it("also bounds the number of entries", async () => {
    const { cache, evicted } = cacheOf(1000, false, 2);
    for (const key of ["a", "b", "c"]) cache.set(key, Promise.resolve(sized(1)));
    expect(evicted).toEqual(["a"]);
  });
});

/** Two tiles overlapping on the shared B-C road. */
function twoTileBundle() {
  const west = compactGraph(buildGraph({ nodes: { A: [41.0, -8.04], B: [41.0, -8.02], C: [41.0, -8.0] }, roads: ["A-B", "B-C"] }));
  const east = compactGraph(buildGraph({ nodes: { B: [41.0, -8.02], C: [41.0, -8.0], D: [41.0, -7.98] }, roads: ["B-C", "C-D"] }));
  return encodeRoadGraphBundle([
    { id: 1, bounds: { minLat: 40.99, minLng: -8.05, maxLat: 41.01, maxLng: -8.0 }, graph: west },
    { id: 2, bounds: { minLat: 40.99, minLng: -8.02, maxLat: 41.01, maxLng: -7.97 }, graph: east },
  ]);
}

describe("a bundle's caches bounded by size", () => {
  it("does not keep a corridor larger than mergedCacheBytes", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher, { mergedCacheBytes: 16 });
    const first = await bundle.loadTiles(bundle.tiles);
    await settle();
    const second = await bundle.loadTiles(bundle.tiles);
    expect(second).not.toBe(first);
    expect(second.nodeLatitudes.length).toBe(first.nodeLatitudes.length);
  });

  it("keeps the corridor within the default budget", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher);
    const first = await bundle.loadTiles(bundle.tiles);
    await settle();
    expect(await bundle.loadTiles(bundle.tiles)).toBe(first);
  });

  it("downloads a tile again once tileCacheBytes has pushed it out", async () => {
    const { fetcher, stats } = rangeFetcher(twoTileBundle());
    // Room for one tile only: the other one goes when it is loaded.
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", fetcher, { tileCacheBytes: 1, mergedCacheSize: 0 });
    const [west, east] = bundle.tiles;
    await bundle.loadTiles([west]);
    await settle();
    await bundle.loadTiles([east]);
    await settle();
    const before = stats.requests;
    await bundle.loadTiles([east]);
    expect(stats.requests).toBe(before);
    await bundle.loadTiles([west]);
    expect(stats.requests).toBeGreaterThan(before);
  });

  it("routes the same with tiny budgets as with the defaults", async () => {
    const { RoadRouter } = await import("./road-router");
    const file = twoTileBundle();
    const roomy = await RoadRouter.open("https://example.test/b.efrb", rangeFetcher(file).fetcher);
    const tight = await RoadRouter.open("https://example.test/b.efrb", rangeFetcher(file).fetcher, { tileCacheBytes: 1, mergedCacheBytes: 1 });
    const from = { lat: 41.0, lng: -8.04 }, to = { lat: 41.0, lng: -7.98 };
    for (let i = 0; i < 2; i++) {
      const a = await roomy.route(from, to), b = await tight.route(from, to);
      expect(b.distanceMeters).toBeCloseTo(a.distanceMeters, 6);
      expect(b.geometry.coordinates).toEqual(a.geometry.coordinates);
    }
  });

  it("refuses a byte budget that is not a number of bytes", async () => {
    const { fetcher } = rangeFetcher(twoTileBundle());
    await expect(openRoadGraphBundle("https://example.test/b.efrb", fetcher, { tileCacheBytes: -1 })).rejects.toThrow(RangeError);
    await expect(openRoadGraphBundle("https://example.test/b.efrb", fetcher, { mergedCacheBytes: Number.NaN })).rejects.toThrow(RangeError);
  });
});
