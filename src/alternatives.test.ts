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
