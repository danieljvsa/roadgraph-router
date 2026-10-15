import { encodeProfiledRoadGraphBundle } from "./bundle";
import { compactGraph } from "./compact";
import { RoadRouter } from "./road-router";
import { ProfileId } from "./routing-profile";
import { buildGraph, rangeFetcher } from "./test-support";

/**
 * A bundle where the second way round lies outside the corridor the best
 * route needed.
 *
 * Alternatives are allowed to be worse than the best by `maxStretch`, so the
 * tiles that could hold one reach further than the tiles that proved the best
 * route. The search has to be handed the graph as it stands after that wider
 * corridor is downloaded; given the earlier one it searches the narrow
 * corridor and throws the new tiles away.
 */
const A = { lat: 41.0, lng: -8.0 };
const C = { lat: 41.0, lng: -7.8 };
/** Far enough north that only the widened corridor reaches it. */
const N = { lat: 41.1117, lng: -7.9 };

const direct = () => buildGraph({
  nodes: { A: [A.lat, A.lng], B: [41.0, -7.9], C: [C.lat, C.lng] },
  roads: ["A-B", "B-C"],
  speedsKph: { "A-B": 90, "B-C": 90 },
});

/** The long way round, through one node far off the straight line. */
const northern = () => buildGraph({
  nodes: { A: [A.lat, A.lng], N: [N.lat, N.lng], C: [C.lat, C.lng] },
  roads: ["A-N", "N-C"],
  speedsKph: { "A-N": 120, "N-C": 120 },
});

const tiles = [
  { graph: direct(), bounds: { minLat: 40.99, minLng: -8.01, maxLat: 41.01, maxLng: -7.79 } },
  // Bounds hugging the northern node, so the tile is as far from both ends as
  // the detour through it is long.
  { graph: northern(), bounds: { minLat: 41.111, minLng: -7.901, maxLat: 41.113, maxLng: -7.899 } },
];

const bundle = () => encodeProfiledRoadGraphBundle(
  tiles.map((tile, index) => {
    const graph = compactGraph(tile.graph);
    return {
      id: index + 1,
      bounds: tile.bounds,
      graph,
      profiles: [{
        profileId: ProfileId.car,
        maxSpeedKph: 150,
        edgeDurationScale: graph.edgeDurationScale ?? 1,
        edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
      }],
    };
  }),
  { compression: "none" },
);

describe("an alternative that lives outside the corridor", () => {
  it("is found, rather than downloaded and discarded", async () => {
    const { fetcher } = rangeFetcher(await bundle());
    const router = await RoadRouter.open("https://example.test/x.efrb", fetcher, { profile: "car" });
    const routes = await router.routeAlternatives(A, C, "fastest", { count: 3 });
    expect(routes.length).toBeGreaterThan(1);
    // The second route is the northern one, which is longer on the ground.
    expect(routes[1].distanceMeters).toBeGreaterThan(routes[0].distanceMeters * 1.2);
  });

  it("agrees with the single route about the best way", async () => {
    const { fetcher } = rangeFetcher(await bundle());
    const router = await RoadRouter.open("https://example.test/x.efrb", fetcher, { profile: "car" });
    const one = await router.route(A, C);
    const many = await router.routeAlternatives(A, C, "fastest", { count: 3 });
    expect(many[0].distanceMeters).toBeCloseTo(one.distanceMeters, 0);
    expect(many[0].durationSeconds).toBeCloseTo(one.durationSeconds, 0);
  });

  it("does not download the shared road network again for each alternative", async () => {
    const { fetcher, stats } = rangeFetcher(await bundle());
    const router = await RoadRouter.open("https://example.test/x.efrb", fetcher, { profile: "car" });
    await router.routeAlternatives(A, C, "fastest", { count: 3 });
    const everyChunkOnce = stats.rangeHeaders.length;
    expect(new Set(stats.rangeHeaders).size).toBe(everyChunkOnce);
  });
});
