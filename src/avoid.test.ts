import { accessAvoiding, countAvoided, touchesArea } from "./avoid";
import { edgeAllowed } from "./access";
import { route } from "./router";
import { routeAlternatives } from "./alternatives";
import { buildGraph, pathOf } from "./test-support";

/** A short way through B and a longer way round through D. */
const town = () => buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.99], C: [41.0, -7.98], D: [41.004, -7.99] },
  roads: ["A-B", "B-C", "A-D", "D-C"],
  speedsKph: { "A-B": 50, "B-C": 50, "A-D": 50, "D-C": 50 },
});

const A = { lat: 41.0, lng: -8.0 };
const C = { lat: 41.0, lng: -7.98 };
/** On the road through B, away from either end of it. */
const onTheMiddleRoad = { lat: 41.0, lng: -7.985, radiusMeters: 120 };

describe("roads the caller says are shut", () => {
  const graph = town();

  it("routes the usual way when nothing is closed", () => {
    expect(pathOf(graph, route(graph, A, C).nodeIds)).toBe("A>B>C");
  });

  it("goes round a closure", () => {
    const result = route(graph, A, C, "fastest", { avoid: [onTheMiddleRoad] });
    expect(pathOf(graph, result.nodeIds)).toBe("A>D>C");
  });

  it("leaves the map alone for the next route", () => {
    route(graph, A, C, "fastest", { avoid: [onTheMiddleRoad] });
    expect(pathOf(graph, route(graph, A, C).nodeIds)).toBe("A>B>C");
  });

  it("counts what a closure takes away", () => {
    expect(countAvoided(graph, [onTheMiddleRoad])).toBeGreaterThan(0);
    expect(countAvoided(graph, [])).toBe(0);
    expect(countAvoided(graph, undefined)).toBe(0);
  });

  it("closes nothing when the circle is somewhere else", () => {
    expect(countAvoided(graph, [{ lat: 45.0, lng: -2.0, radiusMeters: 500 }])).toBe(0);
  });

  it("will not start a route inside a closure", () => {
    // The origin sits on the closed road, so the route has to begin on
    // another one rather than drive out through the closure.
    const inside = { lat: 41.0, lng: -7.985 };
    const result = route(graph, inside, C, "fastest", { avoid: [onTheMiddleRoad] });
    expect(result.originSnap.distanceMeters).toBeGreaterThan(50);
  });

  it("reports no route when every way is shut", () => {
    const everything = [{ lat: 41.002, lng: -7.99, radiusMeters: 5_000 }];
    expect(() => route(graph, A, C, "fastest", { avoid: everything, finishOnANearbyRoad: false })).toThrow();
  });

  it("applies to every alternative, not only the first", () => {
    const routes = routeAlternatives(graph, A, C, "fastest", { count: 3, avoid: [onTheMiddleRoad] });
    for (const result of routes) expect(pathOf(graph, result.nodeIds)).not.toContain("B");
  });

  it("takes several closures at once", () => {
    const both = [onTheMiddleRoad, { lat: 41.004, lng: -7.99, radiusMeters: 120 }];
    expect(() => route(graph, A, C, "fastest", { avoid: both, finishOnANearbyRoad: false })).toThrow();
  });

  it("refuses a circle that is not one", () => {
    const bad = (area: Record<string, number>) => () => route(graph, A, C, "fastest", { avoid: [area as never] });
    expect(bad({ lat: 200, lng: 0, radiusMeters: 10 })).toThrow(/latitude/);
    expect(bad({ lat: 41, lng: 400, radiusMeters: 10 })).toThrow(/longitude/);
    expect(bad({ lat: 41, lng: -8, radiusMeters: 0 })).toThrow(/positive distance/);
    expect(bad({ lat: 41, lng: -8, radiusMeters: Number.NaN })).toThrow(/positive distance/);
  });
});

describe("the index offers every road a closure touches", () => {
  /**
   * A correct intersection test is no use if the spatial index never hands
   * the road over, so this asks every edge directly and checks the two
   * answers agree.
   */
  const brokenDownBy = (graph: ReturnType<typeof town>, area: { lat: number; lng: number; radiusMeters: number }) => {
    const byHand = new Set<number>();
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      if (touchesArea(graph, edge, area)) byHand.add(edge);
    }
    const mask = accessAvoiding(graph, [area]);
    const byIndex = new Set<number>();
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      if (!edgeAllowed(mask, edge)) byIndex.add(edge);
    }
    return { byHand, byIndex };
  };

  it("agrees with asking every road, for a small closure", () => {
    const graph = town();
    const { byHand, byIndex } = brokenDownBy(graph, onTheMiddleRoad);
    expect([...byIndex].sort()).toEqual([...byHand].sort());
    expect(byHand.size).toBeGreaterThan(0);
  });

  it("agrees for a closure larger than the whole graph", () => {
    const graph = town();
    const { byHand, byIndex } = brokenDownBy(graph, { lat: 41.002, lng: -7.99, radiusMeters: 50_000 });
    expect([...byIndex].sort()).toEqual([...byHand].sort());
    expect(byHand.size).toBe(graph.edgeTargets.length);
  });

  it("agrees for a closure on a long road with distant ends", () => {
    const long = buildGraph({ nodes: { A: [41.0, -8.6], B: [41.0, -7.4] }, roads: ["A-B"] });
    const area = { lat: 41.0, lng: -8.0, radiusMeters: 200 };
    const byHand = new Set<number>();
    for (let edge = 0; edge < long.edgeTargets.length; edge += 1) if (touchesArea(long, edge, area)) byHand.add(edge);
    const mask = accessAvoiding(long, [area]);
    const byIndex = new Set<number>();
    for (let edge = 0; edge < long.edgeTargets.length; edge += 1) if (!edgeAllowed(mask, edge)) byIndex.add(edge);
    expect([...byIndex].sort()).toEqual([...byHand].sort());
    expect(byHand.size).toBe(2);
  });

  it("agrees across the date line", () => {
    const pacific = buildGraph({ nodes: { A: [10.0, 179.99], B: [10.0, -179.99] }, roads: ["A-B"] });
    const area = { lat: 10.0, lng: 180.0, radiusMeters: 500 };
    expect(touchesArea(pacific, 0, area)).toBe(true);
    expect(countAvoided(pacific, [area])).toBe(2);
  });

  it("agrees at a high latitude", () => {
    const arctic = buildGraph({ nodes: { A: [78.0, 15.0], B: [78.0, 15.02] }, roads: ["A-B"] });
    expect(countAvoided(arctic, [{ lat: 78.0, lng: 15.01, radiusMeters: 300 }])).toBe(2);
  });

  it("takes overlapping closures as one", () => {
    const graph = town();
    const overlapping = [onTheMiddleRoad, { ...onTheMiddleRoad, radiusMeters: 200 }];
    expect(countAvoided(graph, overlapping)).toBe(countAvoided(graph, [overlapping[1]]));
  });

  it("copes with a road of no length at all", () => {
    const degenerate = buildGraph({ nodes: { A: [41.0, -8.0], B: [41.0, -8.0] }, roads: ["A-B"] });
    expect(() => countAvoided(degenerate, [{ lat: 41.0, lng: -8.0, radiusMeters: 50 }])).not.toThrow();
  });
});
