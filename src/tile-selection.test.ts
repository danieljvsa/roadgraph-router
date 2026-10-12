import { encodeRoadGraphBundle, RoadRouter } from "./index";
import type { BundleGraphTile } from "./bundle";
import { buildGraph, rangeFetcher, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

/**
 * A slow direct road from W to E, and a fast motorway that bulges far to the
 * north. The motorway is the better route but lies well outside the straight
 * corridor between the two endpoints, so a corridor-shaped download misses it.
 *
 *        N1 ========== N2        (motorway, 120 km/h)
 *       /                \
 *      W ---------------- E      (local road, 30 km/h)
 */
function detourWorld(bulgeDegrees: number): GraphSpec {
  return {
    nodes: { W: [0, 0], E: [0, 4], N1: [bulgeDegrees, 1], N2: [bulgeDegrees, 3] },
    roads: ["W-E", "W-N1", "N1-N2", "N2-E"],
    speedsKph: { "W-E": 30, "W-N1": 120, "N1-N2": 120, "N2-E": 120 },
  };
}

/** Cuts a world into square tiles of `size` degrees, each holding the roads whose nodes it owns. */
function tilesOfSize(spec: GraphSpec, size: number): BundleGraphTile[] {
  const tiles: BundleGraphTile[] = [];
  const latitudes = Object.values(spec.nodes).map((node) => node[0]);
  const longitudes = Object.values(spec.nodes).map((node) => node[1]);
  const minLat = Math.floor(Math.min(...latitudes) / size) * size;
  const maxLat = Math.max(Math.ceil(Math.max(...latitudes) / size) * size, minLat + size);
  const minLng = Math.floor(Math.min(...longitudes) / size) * size;
  const maxLng = Math.max(Math.ceil(Math.max(...longitudes) / size) * size, minLng + size);

  for (let lat = minLat; lat < maxLat; lat += size) {
    for (let lng = minLng; lng < maxLng; lng += size) {
      const bounds = { minLat: lat, minLng: lng, maxLat: lat + size, maxLng: lng + size };
      // A tile keeps every road with an endpoint inside it, which mirrors how
      // the compiler assigns a segment to the tile holding its first node.
      const roads = spec.roads.filter((road) => {
        const [left, right] = road.split(/[->]/).filter(Boolean);
        return [left, right].some((name) => {
          const [nodeLat, nodeLng] = spec.nodes[name];
          return nodeLat >= bounds.minLat && nodeLat <= bounds.maxLat && nodeLng >= bounds.minLng && nodeLng <= bounds.maxLng;
        });
      });
      if (!roads.length) continue;
      const names = new Set(roads.flatMap((road) => road.split(/[->]/).filter(Boolean)));
      tiles.push({
        id: tiles.length,
        bounds,
        graph: buildGraph({
          ...spec,
          nodes: Object.fromEntries([...names].map((name) => [name, spec.nodes[name]])),
          roads,
        }),
      });
    }
  }
  return tiles;
}

async function routeOver(tiles: BundleGraphTile[], from: ReturnType<typeof point>, to: ReturnType<typeof point>) {
  const bundle = encodeRoadGraphBundle(tiles);
  const { fetcher, stats } = rangeFetcher(bundle);
  const router = await RoadRouter.open("/routing/world.efrb", fetcher);
  const result = await router.route(from, to);
  return { result, stats, tileCount: tiles.length, bundleBytes: bundle.byteLength };
}

describe("routes that leave the straight corridor", () => {
  it("finds the fast road that bulges outside the direct corridor", async () => {
    const { result } = await routeOver(tilesOfSize(detourWorld(1), 1), point(0, 0), point(0, 4));
    // The motorway is longer in distance but quicker, so a fastest route takes it.
    expect(result.nodeIds).toHaveLength(4);
    expect(result.distanceMeters).toBeGreaterThan(444_000);
    expect(result.durationSeconds).toBeLessThan((444_000 / (30 * 1000 / 3600)));
  });

  it("still prefers the direct road when the detour is genuinely worse", async () => {
    // At 120 km/h a detour only loses once it is about seven degrees out.
    const { result } = await routeOver(tilesOfSize(detourWorld(10), 1), point(0, 0), point(0, 4));
    expect(result.nodeIds).toHaveLength(2);
  });

  it("reaches the same answer however far outside the corridor the detour sits", async () => {
    const near = await routeOver(tilesOfSize(detourWorld(1), 1), point(0, 0), point(0, 4));
    const far = await routeOver(tilesOfSize(detourWorld(2), 1), point(0, 0), point(0, 4));
    expect(near.result.nodeIds).toHaveLength(4);
    expect(far.result.nodeIds).toHaveLength(4);
  });
});

describe("results do not depend on tile size", () => {
  it("returns the same route whether the region is cut into large or small tiles", async () => {
    const world = detourWorld(1);
    const coarse = await routeOver(tilesOfSize(world, 4), point(0, 0), point(0, 4));
    const fine = await routeOver(tilesOfSize(world, 1), point(0, 0), point(0, 4));
    const finer = await routeOver(tilesOfSize(world, 0.5), point(0, 0), point(0, 4));

    expect(coarse.tileCount).toBeLessThan(fine.tileCount);
    expect(fine.tileCount).toBeLessThan(finer.tileCount);
    for (const run of [fine, finer]) {
      expect(run.result.durationSeconds / coarse.result.durationSeconds).toBeCloseTo(1, 4);
      expect(run.result.distanceMeters / coarse.result.distanceMeters).toBeCloseTo(1, 4);
      expect(run.result.geometry.coordinates).toEqual(coarse.result.geometry.coordinates);
    }
  });

  it("does not download the whole bundle to prove it", async () => {
    // A world wide enough that most of it can never be on a sensible route.
    const spread: GraphSpec = {
      nodes: Object.fromEntries([
        ["W", [0, 0]], ["E", [0, 2]],
        ...Array.from({ length: 8 }, (_, index) => [`F${index}`, [0, 10 + index]] as [string, [number, number]]),
      ]),
      roads: ["W-E", ...Array.from({ length: 7 }, (_, index) => `F${index}-F${index + 1}`)],
    };
    const tiles = tilesOfSize(spread, 1);
    const { stats, result } = await routeOver(tiles, point(0, 0), point(0, 2));
    expect(result.nodeIds).toHaveLength(2);
    // Header, directory, and only the handful of tiles near the route.
    expect(stats.requests).toBeLessThan(2 + tiles.length / 2);
  });
});

describe("no route at all", () => {
  it("widens the search before giving up, then reports no route", async () => {
    const split: GraphSpec = {
      nodes: { A: [0, 0], B: [0, 1], Y: [0, 8], Z: [0, 9] },
      roads: ["A-B", "Y-Z"],
    };
    const tiles = tilesOfSize(split, 1);
    const bundle = encodeRoadGraphBundle(tiles);
    const { fetcher } = rangeFetcher(bundle);
    const router = await RoadRouter.open("/routing/split.efrb", fetcher);
    await expect(router.route(point(0, 0), point(0, 9))).rejects.toThrow(/No car route/);
  });

  it("connects two far components when a road does link them", async () => {
    const linked: GraphSpec = {
      nodes: { A: [0, 0], B: [0, 3], C: [0, 6], D: [0, 9] },
      roads: ["A-B", "B-C", "C-D"],
    };
    const tiles = tilesOfSize(linked, 1);
    const { result } = await routeOver(tiles, point(0, 0), point(0, 9));
    expect(result.nodeIds).toHaveLength(4);
  });
});

describe("capping how far the search may reach", () => {
  // A four-degree bulge puts the motorway in tiles far off the direct line,
  // so a tight allowance can genuinely exclude them.
  const world = detourWorld(4);
  const run = async (size: number, maxDetourFactor?: number) => {
    const bundle = encodeRoadGraphBundle(tilesOfSize(world, size));
    const { fetcher, stats } = rangeFetcher(bundle);
    const router = await RoadRouter.open("/routing/world.efrb", fetcher, maxDetourFactor === undefined ? {} : { maxDetourFactor });
    return { result: await router.route(point(0, 0), point(0, 4)), stats };
  };

  it("keeps to the allowance, and gives the same answer at either tile size", async () => {
    // Too tight to reach the motorway, so the slow direct road is returned.
    expect((await run(2, 1.01)).result.nodeIds).toHaveLength(2);
    expect((await run(1, 1.01)).result.nodeIds).toHaveLength(2);
    // Left unbounded, both tile sizes find it.
    expect((await run(2)).result.nodeIds).toHaveLength(4);
    expect((await run(1)).result.nodeIds).toHaveLength(4);
  });

  it("downloads less when the allowance is tight", async () => {
    expect((await run(1, 1.01)).stats.bytes).toBeLessThan((await run(1)).stats.bytes);
  });
});
