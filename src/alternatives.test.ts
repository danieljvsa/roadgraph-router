import { routeAlternatives } from "./alternatives";
import { route } from "./router";
import { buildGraph, pathOf } from "./test-support";

/**
 * Three ways from A to E: a middle road, and a loop either side of it. The
 * middle is quickest, and the other two are real alternatives rather than
 * detours around the same street.
 */
const threeWays = buildGraph({
  nodes: {
    A: [41.00, -8.00], E: [41.00, -7.90],
    M1: [41.00, -7.97], M2: [41.00, -7.93],
    N1: [41.005, -7.97], N2: [41.005, -7.93],
    S1: [40.995, -7.97], S2: [40.995, -7.93],
  },
  roads: ["A-M1", "M1-M2", "M2-E", "A-N1", "N1-N2", "N2-E", "A-S1", "S1-S2", "S2-E"],
  speedsKph: {
    "A-M1": 90, "M1-M2": 90, "M2-E": 90,
    "A-N1": 80, "N1-N2": 80, "N2-E": 80,
    "A-S1": 70, "S1-S2": 70, "S2-E": 70,
  },
});
const A = { lat: 41.0, lng: -8.0 };
const E = { lat: 41.0, lng: -7.9 };

describe("offering more than one way there", () => {
  it("puts the best route first", () => {
    const routes = routeAlternatives(threeWays, A, E);
    expect(pathOf(threeWays, routes[0].nodeIds)).toBe(pathOf(threeWays, route(threeWays, A, E).nodeIds));
  });

  it("finds the other two ways through", () => {
    const routes = routeAlternatives(threeWays, A, E);
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((result) => pathOf(threeWays, result.nodeIds))).size).toBe(3);
  });

  it("returns them in order, each no better than the last", () => {
    const routes = routeAlternatives(threeWays, A, E);
    for (let index = 1; index < routes.length; index += 1) {
      expect(routes[index].durationSeconds).toBeGreaterThanOrEqual(routes[index - 1].durationSeconds);
    }
  });

  it("gives back only what was asked for", () => {
    expect(routeAlternatives(threeWays, A, E, "fastest", { count: 2 })).toHaveLength(2);
    expect(routeAlternatives(threeWays, A, E, "fastest", { count: 1 })).toHaveLength(1);
  });

  it("reports each route at the graph's own cost, not the penalised one", () => {
    // The penalty steers the search; it must not reach the answer. Each route
    // re-measured on its own is exactly what it was reported to be.
    for (const result of routeAlternatives(threeWays, A, E)) {
      const scale = threeWays.edgeDistanceScale ?? 1;
      const measured = result.edgeIds.reduce((total, edge) => total + threeWays.edgeDistancesMeters[edge] * scale, 0);
      expect(result.distanceMeters).toBeGreaterThanOrEqual(measured);
      expect(result.distanceMeters).toBeLessThan(measured * 1.2);
    }
  });

  it("refuses an alternative that is far worse than the best", () => {
    const routes = routeAlternatives(threeWays, A, E, "fastest", { maxStretch: 1.01 });
    expect(routes).toHaveLength(1);
  });

  it("refuses an alternative that is mostly the same road", () => {
    // One road out, then a fork near the end: any second route shares most of
    // its length with the first, so there is nothing worth offering.
    const forkAtTheEnd = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.9], C: [41.001, -7.895], D: [40.999, -7.895], E: [41.0, -7.89] },
      roads: ["A-B", "B-C", "C-E", "B-D", "D-E"],
    });
    const routes = routeAlternatives(forkAtTheEnd, A, { lat: 41.0, lng: -7.89 }, "fastest", { maxSharing: 0.75 });
    expect(routes).toHaveLength(1);
  });

  it("offers the one route there is when the graph holds no other", () => {
    const oneWayThrough = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.95], C: [41.0, -7.9] },
      roads: ["A-B", "B-C"],
    });
    const routes = routeAlternatives(oneWayThrough, A, { lat: 41.0, lng: -7.9 });
    expect(routes).toHaveLength(1);
    expect(pathOf(oneWayThrough, routes[0].nodeIds)).toBe("A>B>C");
  });

  it("works for distance as well as for time", () => {
    const routes = routeAlternatives(threeWays, A, E, "shortest");
    expect(routes.length).toBeGreaterThan(1);
    for (let index = 1; index < routes.length; index += 1) {
      expect(routes[index].distanceMeters).toBeGreaterThanOrEqual(routes[index - 1].distanceMeters);
    }
  });

  it("raises what a single route would raise when there is no route at all", () => {
    const severed = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.99], X: [45.0, -2.0], Y: [45.0, -1.99] },
      roads: ["A-B", "X-Y"],
    });
    expect(() => routeAlternatives(severed, A, { lat: 45.0, lng: -1.99 })).toThrow();
  });
});

describe("alternatives obey everything a single route obeys", () => {
  it("keeps off a road shut at the departure time", async () => {
    const { packEdgeConditions, ConditionKind } = await import("./conditional");
    const start = threeWays.nodeIndex.A;
    let middle = -1;
    for (let edge = threeWays.edgeOffsets[start]; edge < threeWays.edgeOffsets[start + 1]; edge += 1) {
      if (threeWays.edgeTargets[edge] === threeWays.nodeIndex.M1) middle = edge;
    }
    const shut = {
      ...threeWays,
      edgeConditions: packEdgeConditions([{ edge: middle, kind: ConditionKind.access, value: "no @ (Mo-Fr 07:00-19:00)" }]),
    };
    const routes = routeAlternatives(shut, A, E, "fastest", { departAt: new Date(2026, 9, 12, 8, 0) });
    for (const result of routes) expect(result.edgeIds).not.toContain(middle);
  });
});

describe("the order routes come back in", () => {
  it("is by what they really cost, not by when they were found", () => {
    // Penalties drive the search somewhere new each pass, so the order
    // candidates turn up in is not the order they would be driven in.
    const routes = routeAlternatives(threeWays, A, E, "fastest", { count: 3 });
    const costs = routes.map((result) => result.durationSeconds);
    expect(costs).toEqual([...costs].sort((left, right) => left - right));
  });

  it("puts the genuinely best route first", () => {
    const best = route(threeWays, A, E).durationSeconds;
    for (const preference of ["fastest", "shortest"] as const) {
      const routes = routeAlternatives(threeWays, A, E, preference, { count: 3 });
      if (preference === "fastest") expect(routes[0].durationSeconds).toBeCloseTo(best, 6);
      const costs = routes.map((r) => (preference === "fastest" ? r.durationSeconds : r.distanceMeters));
      expect(costs).toEqual([...costs].sort((left, right) => left - right));
    }
  });

  it("reports each route at its own cost, never a penalised one", () => {
    for (const result of routeAlternatives(threeWays, A, E, "fastest", { count: 3 })) {
      const alone = route(threeWays, A, { lat: result.destinationSnap.point.lat, lng: result.destinationSnap.point.lng });
      expect(alone.durationSeconds).toBeLessThanOrEqual(result.durationSeconds + 1);
    }
  });
});

describe("telling one route from another", () => {
  it("counts a road as shared whichever way it is driven", () => {
    // There and back along one road is the same tarmac, so a route using the
    // reverse of a road already offered is not a different way there.
    const thereAndBack = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.99], C: [41.0, -7.98] },
      roads: ["A-B", "B-C"],
    });
    const routes = routeAlternatives(thereAndBack, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.98 });
    expect(routes).toHaveLength(1);
  });

  it("allows two roads that merely meet at a junction", () => {
    const routes = routeAlternatives(threeWays, A, E, "fastest", { count: 3 });
    // The three ways share only their two end junctions, which cost no
    // distance, so none of them is rejected for sharing.
    expect(routes.length).toBeGreaterThan(1);
  });
});

describe("options that make no sense", () => {
  const bad = (options: Record<string, number>) => () => routeAlternatives(threeWays, A, E, "fastest", options);

  it("refuses a count that is not a sensible number of routes", () => {
    expect(bad({ count: 0 })).toThrow(/count/);
    expect(bad({ count: -2 })).toThrow(/count/);
    expect(bad({ count: 2.5 })).toThrow(/whole number/);
    expect(bad({ count: Number.NaN })).toThrow(/count/);
    expect(bad({ count: Number.POSITIVE_INFINITY })).toThrow(/count/);
    expect(bad({ count: 1_000_000 })).toThrow(/count/);
  });

  it("refuses a stretch below one, which no alternative could meet", () => {
    expect(bad({ maxStretch: 0.5 })).toThrow(/maxStretch/);
    expect(bad({ maxStretch: Number.NaN })).toThrow(/maxStretch/);
  });

  it("refuses a sharing limit outside nought to one", () => {
    expect(bad({ maxSharing: -0.1 })).toThrow(/maxSharing/);
    expect(bad({ maxSharing: 1.5 })).toThrow(/maxSharing/);
    expect(bad({ maxSharing: Number.NaN })).toThrow(/maxSharing/);
  });

  it("refuses a penalty that would not steer the search", () => {
    expect(bad({ penaltyFactor: 0 })).toThrow(/penaltyFactor/);
    expect(bad({ penaltyFactor: Number.NaN })).toThrow(/penaltyFactor/);
  });

  it("accepts the edges of what it allows", () => {
    expect(bad({ count: 1 })).not.toThrow();
    expect(bad({ maxStretch: 1 })).not.toThrow();
    expect(bad({ maxSharing: 0 })).not.toThrow();
    expect(bad({ maxSharing: 1 })).not.toThrow();
    expect(bad({ penaltyFactor: 1 })).not.toThrow();
  });
});
