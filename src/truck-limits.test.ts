import { combineProfiledGraph, decodeProfileChunk, encodeProfileChunk, encodeSharedGraph, decodeSharedGraph } from "./codec";
import { accessForVehicle, countBlocked, fromDecimetres, packEdgeLimits, toDecimetres, toHalfTonnes } from "./limits";
import { compactGraph } from "./compact";
import { edgeAllowed } from "./access";
import { route } from "./router";
import { RoadRouter } from "./road-router";
import { ProfileId } from "./routing-profile";
import { resolveVehicle } from "./vehicle";
import { encodeProfiledRoadGraphBundle } from "./bundle";
import { buildGraph, pathOf, rangeFetcher } from "./test-support";

describe("quantising a signed limit", () => {
  it("rounds down, so a stored limit never permits what the sign forbids", () => {
    expect(toDecimetres(4.0)).toBe(40);
    expect(toDecimetres(4.09)).toBe(40);
    expect(fromDecimetres(toDecimetres(4.09))).toBe(4);
    expect(toHalfTonnes(7.5)).toBe(15);
    expect(toHalfTonnes(7.9)).toBe(15);
  });

  it("stores a limit too large to hold as not stated, never clamped", () => {
    // Clamping down would forbid what the sign permits; a limit this high
    // restricts no lorry anyway.
    expect(toDecimetres(30)).toBe(0);
    expect(toHalfTonnes(200)).toBe(0);
  });

  it("treats an absent or nonsensical limit as not stated", () => {
    expect(toDecimetres(undefined)).toBe(0);
    expect(toDecimetres(0)).toBe(0);
    expect(toHalfTonnes(-5)).toBe(0);
  });
});

describe("the packed limit table", () => {
  it("keeps only the edges that state something, in order", () => {
    const packed = packEdgeLimits([
      { edge: 7, limits: { heightMeters: 3.5 } },
      { edge: 2, limits: { weightTonnes: 7.5 } },
      { edge: 4, limits: {} },
      { edge: 9, limits: { heightMeters: 40 } },
    ]);
    expect([...packed!.edges]).toEqual([2, 7]);
    expect([...packed!.heightDecimetres]).toEqual([0, 35]);
    expect([...packed!.weightHalfTonnes]).toEqual([15, 0]);
  });

  it("is absent when nothing is stated", () => {
    expect(packEdgeLimits([{ edge: 1, limits: {} }])).toBeUndefined();
    expect(packEdgeLimits([])).toBeUndefined();
  });
});

/** A low bridge on the direct road, with a longer way round that has none. */
const network = () => buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.98], C: [41.0, -7.96], D: [41.006, -7.98] },
  roads: ["A-B", "B-C", "A-D", "D-C"],
});

function truckChunk(graph: ReturnType<typeof compactGraph>, names: string[], road: string, limits: Record<string, number>) {
  const [left, right] = road.split("-");
  const entries: { edge: number; limits: Record<string, number> }[] = [];
  for (let source = 0; source < names.length; source += 1) {
    for (let edge = graph.edgeOffsets[source]; edge < graph.edgeOffsets[source + 1]; edge += 1) {
      const pair = `${names[source]}-${names[graph.edgeTargets[edge]]}`;
      if (pair === `${left}-${right}` || pair === `${right}-${left}`) entries.push({ edge, limits });
    }
  }
  return {
    profileId: ProfileId.truck,
    maxSpeedKph: 90,
    edgeDurationScale: graph.edgeDurationScale ?? 1,
    edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
    edgeLimits: packEdgeLimits(entries),
  };
}

describe("routing a lorry past a signed limit", () => {
  const built = network();
  const graph = compactGraph(built);
  const chunk = truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.5 });
  const withLimits = () => combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk(chunk)));

  it("survives the round trip into a chunk and back", () => {
    const rebuilt = withLimits();
    expect(rebuilt.edgeLimits?.edges.length).toBe(2);
    expect([...rebuilt.edgeLimits!.heightDecimetres]).toEqual([35, 35]);
  });

  it("sends a tall lorry the long way round", () => {
    const rebuilt = withLimits();
    const low = route(rebuilt, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }, "fastest", { vehicle: resolveVehicle({ heightMeters: 3.0 }) });
    const tall = route(rebuilt, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }, "fastest", { vehicle: resolveVehicle({ heightMeters: 4.0 }) });
    expect(pathOf(built, low.nodeIds)).toBe("A>B>C");
    expect(pathOf(built, tall.nodeIds)).toBe("A>D>C");
  });

  it("lets a lorry exactly at the limit through", () => {
    const exact = route(withLimits(), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }, "fastest", { vehicle: resolveVehicle({ heightMeters: 3.5 }) });
    expect(pathOf(built, exact.nodeIds)).toBe("A>B>C");
  });

  it("ignores limits on an axis the lorry is within", () => {
    const heavy = route(withLimits(), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }, "fastest", { vehicle: resolveVehicle({ heightMeters: 3.0, weightTonnes: 44 }) });
    expect(pathOf(built, heavy.nodeIds)).toBe("A>B>C");
  });

  it("routes over every road when no vehicle is given", () => {
    const anything = route(withLimits(), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    expect(pathOf(built, anything.nodeIds)).toBe("A>B>C");
  });

  it("counts what a vehicle is shut out of", () => {
    const rebuilt = withLimits();
    expect(countBlocked(rebuilt, resolveVehicle({ heightMeters: 4.0 }))).toBe(2);
    expect(countBlocked(rebuilt, resolveVehicle({ heightMeters: 3.0 }))).toBe(0);
  });

  it("leaves a road stating no limit open, because untagged is not measured", () => {
    const mask = accessForVehicle(withLimits(), resolveVehicle({ heightMeters: 4.9 }));
    const open = [...Array(graph.edgeTargets.length).keys()].filter((edge) => edgeAllowed(mask, edge));
    expect(open.length).toBe(graph.edgeTargets.length - 2);
  });
});

describe("a truck bundle that cannot hold limits", () => {
  it("is refused rather than routed with the dimensions ignored", async () => {
    const { encodeRoadGraphBundle } = await import("./bundle");
    const graph = { ...compactGraph(network()), profileId: ProfileId.truck, maxSpeedKph: 90 };
    const bundle = encodeRoadGraphBundle([{ id: 1, bounds: { minLat: 40.99, minLng: -8.01, maxLat: 41.01, maxLng: -7.95 }, graph }]);
    await expect(RoadRouter.open("https://example.test/old-truck.efrb", rangeFetcher(bundle).fetcher))
      .rejects.toThrow(/must carry its physical limits/i);
  });
});

describe("the vehicle option on a router", () => {
  const built = network();
  const graph = compactGraph(built);
  const bundleFor = (chunk: ReturnType<typeof truckChunk>) => encodeProfiledRoadGraphBundle([{
    id: 1, bounds: { minLat: 40.99, minLng: -8.01, maxLat: 41.01, maxLng: -7.95 }, graph, profiles: [chunk],
  }], { compression: "none" });

  it("defaults to an articulated lorry and says so", async () => {
    const bundle = await bundleFor(truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.5 }));
    const router = await RoadRouter.open("https://example.test/t.efrb", rangeFetcher(bundle).fetcher);
    expect(router.profile).toBe("truck");
    expect(router.vehicle).toEqual({ heightMeters: 4.0, widthMeters: 2.55, lengthMeters: 16.5, weightTonnes: 40 });
    // 4.0m does not fit under a 3.5m bridge, so the default takes the detour.
    const result = await router.route({ lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    expect(pathOf(built, result.nodeIds)).toBe("A>D>C");
  });

  it("takes a preset name, and a preset with a field overridden", async () => {
    const bundle = await bundleFor(truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.5 }));
    const van = await RoadRouter.open("https://example.test/t.efrb", rangeFetcher(bundle).fetcher, { vehicle: "van" });
    expect(van.vehicle?.heightMeters).toBe(2.6);
    expect(pathOf(built, (await van.route({ lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 })).nodeIds)).toBe("A>B>C");

    const tall = await RoadRouter.open("https://example.test/t.efrb", rangeFetcher(bundle).fetcher, { vehicle: { preset: "van", heightMeters: 4.5 } });
    expect(tall.vehicle).toEqual({ heightMeters: 4.5, widthMeters: 2.1, lengthMeters: 6.0, weightTonnes: 3.5 });
  });

  it("can be turned off, which accepts routes no real lorry may manage", async () => {
    const bundle = await bundleFor(truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.5 }));
    const router = await RoadRouter.open("https://example.test/t.efrb", rangeFetcher(bundle).fetcher, { vehicle: null });
    expect(router.vehicle).toBeUndefined();
    expect(pathOf(built, (await router.route({ lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 })).nodeIds)).toBe("A>B>C");
  });

  it("refuses dimensions on a bundle that cannot act on them", async () => {
    const car = await encodeProfiledRoadGraphBundle([{
      id: 1, bounds: { minLat: 40.99, minLng: -8.01, maxLat: 41.01, maxLng: -7.95 }, graph,
      profiles: [{ profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: graph.edgeDurationScale ?? 1, edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array }],
    }], { compression: "none" });
    await expect(RoadRouter.open("https://example.test/c.efrb", rangeFetcher(car).fetcher, { vehicle: "articulated" }))
      .rejects.toThrow(/does not use vehicle dimensions/i);
  });
});

describe("merging tiles that carry limits", () => {
  it("keeps them, rebased onto the merged edge numbering", async () => {
    const { mergeRoadGraphs } = await import("./merge");
    const built = network();
    const graph = compactGraph(built);
    const chunk = truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.5 });
    const tile = combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk(chunk)));
    const merged = mergeRoadGraphs([tile, tile]);
    expect(merged.edgeLimits?.edges.length).toBe(2);
    // A corridor that lost them would route a lorry under a bridge it does
    // not fit through, which is the whole failure this guards against.
    expect(countBlocked(merged, resolveVehicle({ heightMeters: 4.0 }))).toBe(2);
    expect(pathOf(built, route(merged, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }, "fastest", { vehicle: resolveVehicle({ heightMeters: 4.0 }) }).nodeIds)).toBe("A>D>C");
  });

  it("keeps the stricter limit when two tiles disagree", async () => {
    const { mergeRoadGraphs } = await import("./merge");
    const built = network();
    const graph = compactGraph(built);
    const low = combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk(truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 3.0 }))));
    const high = combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk(truckChunk(graph, built.nodeNames, "B-C", { heightMeters: 4.5 }))));
    const merged = mergeRoadGraphs([high, low]);
    expect([...merged.edgeLimits!.heightDecimetres]).toEqual([30, 30]);
  });

  it("keeps a road one tile closes closed", async () => {
    const { mergeRoadGraphs } = await import("./merge");
    const { accessMaskFor } = await import("./access");
    const built = network();
    const graph = compactGraph(built);
    const columns = (edgeAccess?: Uint8Array) => combineProfiledGraph(
      decodeSharedGraph(encodeSharedGraph(graph)),
      decodeProfileChunk(encodeProfileChunk({
        profileId: ProfileId.truck, maxSpeedKph: 90, edgeDurationScale: graph.edgeDurationScale ?? 1,
        edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array, edgeAccess,
      })),
    );
    const closed = accessMaskFor(graph.edgeTargets.length, (edge) => edge !== 0);
    const merged = mergeRoadGraphs([columns(), columns(closed)]);
    expect(merged.edgeAccess).toBeDefined();
    expect(countBlocked(merged, resolveVehicle("articulated"))).toBe(1);
  });
});
