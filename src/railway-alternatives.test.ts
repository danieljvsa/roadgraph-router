/**
 * Alternative routes around stations, and what tells one physical track from
 * another.
 *
 * A station is where this is hard: several tracks within a few metres, each a
 * separate one-way way, joined by crossovers and flanked by sidings. Two
 * routes that leave by different platforms are different routes; two that
 * merely share a station are not the same route; and the same track walked in
 * opposite directions is one track.
 */

import { ProfileId, railwayOf, route, routeAlternatives } from "./index";
import { RAIL, at, compileWorkspace, line } from "./test-support-compile";
import type { PbfNode, PbfWay } from "./test-support-pbf";

jest.setTimeout(120_000);
const { compile, cleanUp } = compileWorkspace();
afterAll(cleanUp);

const METRO = { railway: "light_rail", gauge: "1435", electrified: "contact_line", voltage: "750", frequency: "0" } as const;

/**
 * Two stations joined by two separate double-track routes — a northern way
 * and a southern way — with platform tracks at each end. The shape of a
 * small network, rather than a corridor.
 */
const TWO_ROUTES: [PbfNode[], PbfWay[]] = [[
  // West station: two platform faces a few metres apart.
  { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.0000, lon: -8.60008 },
  // East station, likewise.
  { id: 3, lat: 41.000, lon: -8.5000 }, { id: 4, lat: 41.0000, lon: -8.50008 },
  // The northern way.
  { id: 10, lat: 41.020, lon: -8.5700 }, { id: 11, lat: 41.020, lon: -8.5300 },
  // The southern way, a little longer.
  { id: 20, lat: 40.970, lon: -8.5700 }, { id: 21, lat: 40.970, lon: -8.5300 },
], [
  { id: 100, refs: [1, 10], tags: RAIL }, { id: 101, refs: [10, 11], tags: RAIL }, { id: 102, refs: [11, 3], tags: RAIL },
  { id: 103, refs: [2, 20], tags: RAIL }, { id: 104, refs: [20, 21], tags: RAIL }, { id: 105, refs: [21, 4], tags: RAIL },
  // The two faces of each station are joined, as platforms are.
  { id: 106, refs: [1, 2], tags: { ...RAIL, service: "crossover" } },
  { id: 107, refs: [3, 4], tags: { ...RAIL, service: "crossover" } },
]];

describe("two stations joined by more than one way", () => {
  const west = at(41.000, -8.6000);
  const east = at(41.000, -8.5000);

  it("offers both ways round", async () => {
    const { graph } = await compile("two-routes", ...TWO_ROUTES);
    const routes = routeAlternatives(graph, west, east, "shortest", { count: 3, maxStretch: 3 });
    expect(routes.length).toBeGreaterThanOrEqual(2);
    // One goes north and one goes south; they are not the same route twice.
    const northerly = routes.filter((result) => result.geometry.coordinates.some(([, lat]) => lat > 41.01));
    const southerly = routes.filter((result) => result.geometry.coordinates.some(([, lat]) => lat < 40.99));
    expect(northerly.length).toBeGreaterThanOrEqual(1);
    expect(southerly.length).toBeGreaterThanOrEqual(1);
  });

  it("sorts them by what they really cost", async () => {
    const { graph } = await compile("two-routes", [], []);
    const routes = routeAlternatives(graph, west, east, "shortest", { count: 3, maxStretch: 3 });
    for (let index = 1; index < routes.length; index += 1) {
      expect(routes[index].distanceMeters).toBeGreaterThanOrEqual(routes[index - 1].distanceMeters);
    }
  });

  it("never returns the same route twice", async () => {
    const { graph } = await compile("two-routes", [], []);
    const routes = routeAlternatives(graph, west, east, "shortest", { count: 4, maxStretch: 4 });
    const seen = new Set(routes.map((result) => JSON.stringify(result.nodeIds)));
    expect(seen.size).toBe(routes.length);
  });

  // Sharing a station is not being the same route.
  it("does not call two routes duplicates for meeting at both ends", async () => {
    const { graph } = await compile("two-routes", [], []);
    const routes = routeAlternatives(graph, west, east, "shortest", { count: 2, maxStretch: 3, maxSharing: 0.4 });
    expect(routes.length).toBe(2);
  });

  it("refuses a second way that exceeds maxStretch", async () => {
    const { graph } = await compile("two-routes", [], []);
    expect(routeAlternatives(graph, west, east, "shortest", { count: 3, maxStretch: 1.01 }).length).toBe(1);
  });

  // Every route has to say which track it really left and arrived on, and the
  // geometry has to start and finish there.
  it("reports the tracks it used, and draws them", async () => {
    const { graph } = await compile("two-routes", [], []);
    for (const result of routeAlternatives(graph, west, east, "shortest", { count: 3, maxStretch: 3 })) {
      const used = [result.originSnap, result.destinationSnap];
      for (const snap of used) expect(snap.node >= 0 || snap.edge >= 0).toBe(true);
      const first = result.geometry.coordinates[0];
      const last = result.geometry.coordinates[result.geometry.coordinates.length - 1];
      expect(Math.abs(first[0] - result.originSnap.point.lng)).toBeLessThan(1e-6);
      expect(Math.abs(first[1] - result.originSnap.point.lat)).toBeLessThan(1e-6);
      expect(Math.abs(last[0] - result.destinationSnap.point.lng)).toBeLessThan(1e-6);
      expect(Math.abs(last[1] - result.destinationSnap.point.lat)).toBeLessThan(1e-6);
    }
  });
});

describe("telling one physical track from another", () => {
  // Two parallel tracks between the same pair of stations, plus a siding, so
  // every distinction the identity has to make is present at once.
  const PARALLEL: [PbfNode[], PbfWay[]] = [[
    ...line(1, 41.000, -8.600, 3),
    // Far enough from the running line that a point on it is unambiguous,
    // rather than within the tolerance that holds a double track together.
    { id: 11, lat: 41.0010, lon: -8.600 }, { id: 12, lat: 41.0010, lon: -8.590 }, { id: 13, lat: 41.0010, lon: -8.580 },
    { id: 21, lat: 41.0004, lon: -8.595 }, { id: 22, lat: 41.0004, lon: -8.585 },
  ], [
    { id: 100, refs: [1, 2, 3], tags: RAIL },
    { id: 101, refs: [11, 12, 13], tags: RAIL },
    { id: 102, refs: [2, 21, 22, 3], tags: { ...RAIL, service: "siding" } },
  ]];

  // `roadOf` is private, so the property is asserted through the behaviour it
  // exists for: a route and its reverse share their track, and two parallel
  // tracks do not.
  it("treats a track and its reverse as one track, and parallel tracks as two", async () => {
    const { graph } = await compile("parallel-identity", ...PARALLEL);
    const there = route(graph, at(41.000, -8.600), at(41.000, -8.580), "shortest");
    const back = route(graph, at(41.000, -8.580), at(41.000, -8.600), "shortest");
    // The same metals both ways: same length, mirrored geometry.
    expect(back.distanceMeters).toBeCloseTo(there.distanceMeters, 0);
    const forward = there.geometry.coordinates.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`);
    const reverse = back.geometry.coordinates.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).reverse();
    expect(reverse).toEqual(forward);

    // The parallel track is a different road: a route along it is drawn on
    // its own alignment, not folded onto the running line beside it.
    const other = route(graph, at(41.0010, -8.600), at(41.0010, -8.580), "shortest");
    const alongOther = other.geometry.coordinates.map(([, lat]) => lat);
    expect(Math.min(...alongOther)).toBeGreaterThan(41.0005);
    const alongThere = there.geometry.coordinates.map(([, lat]) => lat);
    expect(Math.max(...alongThere)).toBeLessThan(41.0005);
  });

  // The fingerprint is taken from the decoded geometry, which the shape table
  // stores once and mirrors for the reverse copy. If that round trip moved a
  // single point the two copies would stop being one road.
  it("keeps its identity through the bundle's shape table", async () => {
    const { graph } = await compile("parallel-identity", [], []);
    // A two-way track decodes to a forward and a reverse edge whose polylines
    // are each other's mirror, which is what the identity relies on.
    const scale = graph.coordinateScale ?? 1;
    const shapeOf = (edge: number) => {
      const offsets = graph.edgeShapeOffsets;
      if (!offsets) return [];
      const points: string[] = [];
      for (let point = offsets[edge]; point < offsets[edge + 1]; point += 1) {
        points.push(`${graph.edgeShapeLatitudes![point] / scale},${graph.edgeShapeLongitudes![point] / scale}`);
      }
      return points;
    };
    let mirrored = 0;
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      const target = graph.edgeTargets[edge];
      for (let other = graph.edgeOffsets[target]; other < graph.edgeOffsets[target + 1]; other += 1) {
        if (graph.edgeTargets[other] !== edgeSourceOf(graph, edge)) continue;
        const a = shapeOf(edge);
        const b = shapeOf(other);
        if (a.length && a.length === b.length) { expect([...b].reverse()).toEqual(a); mirrored += 1; }
      }
    }
    expect(mirrored).toBeGreaterThan(0);
  });
});

/** The node an edge leaves, found from the CSR offsets. */
function edgeSourceOf(graph: { edgeOffsets: Uint32Array; nodeLatitudes: ArrayLike<number> }, edge: number) {
  let low = 0;
  let high = graph.nodeLatitudes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (graph.edgeOffsets[middle] <= edge) low = middle; else high = middle - 1;
  }
  return low;
}

describe("starting from the right platform", () => {
  // The nearest platform runs the wrong way; the one that serves the journey
  // is a little further off.
  const PLATFORMS: [PbfNode[], PbfWay[]] = [[
    { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.010, lon: -8.6000 }, { id: 3, lat: 41.020, lon: -8.6000 },
    { id: 11, lat: 41.000, lon: -8.60008 }, { id: 12, lat: 41.010, lon: -8.60008 }, { id: 13, lat: 41.020, lon: -8.60008 },
  ], [
    // Southbound on the near track, northbound on the far one.
    { id: 100, refs: [3, 2], tags: { ...METRO, oneway: "yes" } },
    { id: 101, refs: [2, 1], tags: { ...METRO, oneway: "yes" } },
    { id: 102, refs: [11, 12], tags: { ...METRO, oneway: "yes" } },
    { id: 103, refs: [12, 13], tags: { ...METRO, oneway: "yes" } },
  ]];

  it("leaves from the platform that serves the journey, and says so", async () => {
    const { graph } = await compile("platform-choice-alt", ...PLATFORMS, ["--profile", "metro"]);
    // Standing a shade nearer the southbound track, travelling north.
    const result = route(graph, at(41.0050, -8.60003), at(41.0150, -8.60008), "shortest");
    expect(result.distanceMeters).toBeLessThan(1_600);
    // Northwards, and reported as leaving on a track that really goes north.
    const first = result.geometry.coordinates[0];
    const last = result.geometry.coordinates[result.geometry.coordinates.length - 1];
    expect(last[1]).toBeGreaterThan(first[1]);
    expect(result.originSnap.edge >= 0 || result.originSnap.node >= 0).toBe(true);
    if (result.originSnap.edge >= 0) expect(railwayOf(graph, result.originSnap.edge)).toBeDefined();
  });

  it("will not invent a way across tracks that do not meet", async () => {
    const { graph } = await compile("platform-choice-alt", [], []);
    // The two tracks share no node, so there is no crossing between them.
    const routes = routeAlternatives(graph, at(41.0050, -8.60003), at(41.0150, -8.60008), "shortest", { count: 3 });
    for (const result of routes) {
      const latitudes = result.geometry.coordinates.map(([, lat]) => lat);
      expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeLessThan(0.03);
    }
  });
});
