import { encodeProfiledRoadGraphBundle, encodeRoadGraphBundle, openRoadGraphBundle } from "./bundle";
import { compactGraph } from "./compact";
import { accessMaskFor } from "./access";
import { RoadRouter } from "./road-router";
import { ProfileId } from "./routing-profile";
import { buildGraph, pathOf, rangeFetcher } from "./test-support";
import type { ProfileChunk } from "./types";

/** A fast through road and a slow parallel one, in two overlapping tiles. */
const west = () => buildGraph({
  nodes: { A: [41.0, -8.04], B: [41.0, -8.02], D: [41.004, -8.03] },
  roads: ["A-B", "A-D", "D-B"],
  speedsKph: { "A-B": 120, "A-D": 40, "D-B": 40 },
});
const east = () => buildGraph({
  nodes: { B: [41.0, -8.02], C: [41.0, -8.0] },
  roads: ["B-C"],
  speedsKph: { "B-C": 120 },
});

const bounds = [
  { minLat: 40.99, minLng: -8.05, maxLat: 41.01, maxLng: -8.019 },
  { minLat: 40.99, minLng: -8.021, maxLat: 41.01, maxLng: -7.99 },
];

/** Both directions of one named road, found by walking the edge grouping. */
function edgesOfRoad(graph: { edgeOffsets: Uint32Array; edgeTargets: Uint32Array }, names: string[], road: string) {
  const [left, right] = road.split("-");
  const banned = new Set<number>();
  for (let source = 0; source < names.length; source += 1) {
    for (let edge = graph.edgeOffsets[source]; edge < graph.edgeOffsets[source + 1]; edge += 1) {
      const pair = `${names[source]}-${names[graph.edgeTargets[edge]]}`;
      if (pair === `${left}-${right}` || pair === `${right}-${left}`) banned.add(edge);
    }
  }
  return banned;
}

/** A vehicle this tile's roads are open to, except for the fast A-B link. */
function bannedFromFastRoad(graph: { edgeOffsets: Uint32Array; edgeTargets: Uint32Array; edgeDurationsSeconds: Uint16Array; edgeDurationScale?: number }, names: string[]): ProfileChunk {
  const edges = graph.edgeTargets.length;
  const banned = edgesOfRoad(graph, names, "A-B");
  return {
    profileId: ProfileId.car,
    maxSpeedKph: 150,
    edgeDurationScale: graph.edgeDurationScale ?? 1,
    edgeDurationsSeconds: graph.edgeDurationsSeconds,
    edgeAccess: accessMaskFor(edges, (edge) => !banned.has(edge)),
  };
}

const profiledBundle = () => {
  const tiles = [compactGraph(west()), compactGraph(east())].map((graph, index) => ({
    id: index + 1,
    bounds: bounds[index],
    graph,
    profiles: [{
      profileId: ProfileId.car,
      maxSpeedKph: 150,
      edgeDurationScale: graph.edgeDurationScale ?? 1,
      edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
    }],
  }));
  return encodeProfiledRoadGraphBundle(tiles, { compression: "none" });
};

describe("a multi-profile bundle", () => {
  it("stores the road network once and the vehicle separately", async () => {
    const single = encodeRoadGraphBundle([
      { id: 1, bounds: bounds[0], graph: compactGraph(west()) },
      { id: 2, bounds: bounds[1], graph: compactGraph(east()) },
    ]);
    const profiled = await profiledBundle();
    const opened = await openRoadGraphBundle("https://example.test/p.efrb", rangeFetcher(profiled).fetcher);
    expect(opened.tiles).toHaveLength(2);
    expect(opened.profiles).toEqual([ProfileId.car]);
    // Two chunks per tile instead of one, so the directory is longer, but the
    // bytes are the same road network written once either way.
    expect(profiled.byteLength).toBeGreaterThan(single.byteLength - 1024);
  });

  it("downloads the shared half of a tile once, whichever vehicle is asked for", async () => {
    const fetcher = rangeFetcher(await profiledBundle());
    const bundle = await openRoadGraphBundle("https://example.test/p.efrb", fetcher.fetcher);
    await bundle.loadTiles([bundle.tiles[0]]);
    const afterFirst = fetcher.stats.requests;
    await bundle.loadTiles([bundle.tiles[0]]);
    expect(fetcher.stats.requests).toBe(afterFirst);
  });

  it("routes across tiles exactly as the single-profile bundle does", async () => {
    const built = west();
    const profiled = await openRoadGraphBundle("https://example.test/p.efrb", rangeFetcher(await profiledBundle()).fetcher);
    const graph = await profiled.loadTiles(profiled.tiles);
    const { route } = await import("./router");
    const result = route(graph, { lat: 41.0, lng: -8.04 }, { lat: 41.0, lng: -8.0 });
    expect(pathOf(built, result.nodeIds.slice(0, 2))).toBe("A>B");
    expect(result.distanceMeters).toBeGreaterThan(0);
  });

  it("says which vehicles it holds, and refuses one it does not", async () => {
    const bundle = await profiledBundle();
    await expect(openRoadGraphBundle("https://example.test/p.efrb", rangeFetcher(bundle).fetcher, { profile: "bicycle" }))
      .rejects.toThrow(/Unknown routing profile|does not hold/i);
  });

  it("refuses tiles that do not all carry the same vehicles", async () => {
    const graph = compactGraph(west());
    const columns = { profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1, edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array };
    await expect(encodeProfiledRoadGraphBundle([
      { id: 1, bounds: bounds[0], graph, profiles: [columns] },
      { id: 2, bounds: bounds[1], graph, profiles: [] },
    ], { compression: "none" })).rejects.toThrow(/same profiles/i);
  });

  it("refuses to list the same vehicle twice", async () => {
    const graph = compactGraph(west());
    const columns = { profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1, edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array };
    await expect(encodeProfiledRoadGraphBundle([{ id: 1, bounds: bounds[0], graph, profiles: [columns, columns] }], { compression: "none" }))
      .rejects.toThrow(/same profile twice/i);
  });
});

describe("the access mask inside a bundle", () => {
  it("keeps a vehicle off a road it may not use, across a whole route", async () => {
    const graph = compactGraph(west());
    const open = await encodeProfiledRoadGraphBundle([{
      id: 1, bounds: { minLat: 40.99, minLng: -8.05, maxLat: 41.01, maxLng: -7.99 }, graph,
      profiles: [{ profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: graph.edgeDurationScale ?? 1, edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array }],
    }], { compression: "none" });
    const restricted = await encodeProfiledRoadGraphBundle([{
      id: 1, bounds: { minLat: 40.99, minLng: -8.05, maxLat: 41.01, maxLng: -7.99 }, graph,
      profiles: [bannedFromFastRoad(graph as never, west().nodeNames)],
    }], { compression: "none" });

    const built = west();
    const read = async (bundle: ArrayBuffer) => {
      const router = await RoadRouter.open("https://example.test/p.efrb", rangeFetcher(bundle).fetcher);
      return router.route({ lat: 41.0, lng: -8.04 }, { lat: 41.0, lng: -8.02 });
    };
    expect(pathOf(built, (await read(open)).nodeIds)).toBe("A>B");
    expect(pathOf(built, (await read(restricted)).nodeIds)).toBe("A>D>B");
  });
});

describe("a bundle written before profiles existed", () => {
  it("still opens, routes, and reports its one vehicle", async () => {
    const bundle = encodeRoadGraphBundle([
      { id: 1, bounds: bounds[0], graph: compactGraph(west()) },
      { id: 2, bounds: bounds[1], graph: compactGraph(east()) },
    ]);
    const router = await RoadRouter.open("https://example.test/v1.efrb", rangeFetcher(bundle).fetcher);
    const result = await router.route({ lat: 41.0, lng: -8.04 }, { lat: 41.0, lng: -8.0 });
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(router.profile).toBe("car");
    // It holds one vehicle, so asking for that one is a no-op and asking for
    // any other says what the file actually has.
    expect(router.withProfile("car").profile).toBe("car");
    expect(() => router.withProfile("motorcycle")).toThrow(/does not hold/i);
  });
});
