import { route } from "./router";
import { routeAlternatives } from "./alternatives";
import { buildGraph, pathOf } from "./test-support";

/**
 * Telling one physical road from another.
 *
 * A road has to be recognised as itself whichever way it is driven, and as
 * not-another-road however alike the two are. The hard case is two roads
 * between the same junctions: same ends, similar length, different shape.
 */
describe("what counts as one road", () => {
  const ends = [{ lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 }] as const;

  /** Two ways from A to C: one bowing north, one bowing south by as much. */
  const twoBows = () => buildGraph({
    nodes: { A: [41.0, -8.0], B: [41.0, -7.98], C: [41.0, -7.96] },
    roads: ["A-B", "B-C"],
    shapes: {
      "A>B": [[41.01, -7.99]],
      "B>A": [[41.01, -7.99]],
      "B>C": [[40.99, -7.97]],
      "C>B": [[40.99, -7.97]],
    },
  });

  it("gives the two directions of a road the same identity", () => {
    const graph = twoBows();
    const there = route(graph, ends[0], ends[1]);
    const back = route(graph, ends[1], ends[0]);
    expect(there.distanceMeters).toBeCloseTo(back.distanceMeters, 0);
    // Driving back along a road already offered is not a different way there.
    expect(routeAlternatives(graph, ends[0], ends[1], "fastest", { count: 3 })).toHaveLength(1);
  });

  it("separates roads whose shape points add up alike", () => {
    // 41.01 + -7.99 and 41.00 + -7.98 are the same number, so any identity
    // built by summing coordinates reads these two roads as one.
    expect(41.01 + -7.99).toBeCloseTo(41.0 + -7.98, 10);
    const summed = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.98] },
      roads: ["A-B"],
      shapes: { "A>B": [[41.01, -7.99]], "B>A": [[41.01, -7.99]] },
    });
    const alsoSummed = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.98] },
      roads: ["A-B"],
      shapes: { "A>B": [[41.0, -7.98]], "B>A": [[41.0, -7.98]] },
    });
    // The graphs differ in geometry, which the route lengths show.
    const first = route(summed, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.98 });
    const second = route(alsoSummed, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.98 });
    expect(first.distanceMeters).not.toBeCloseTo(second.distanceMeters, 0);
  });

  it("offers the longer way round when it is a different road", () => {
    // A direct link and a loop, both joining A to C.
    const withLoop = buildGraph({
      nodes: { A: [41.0, -8.0], C: [41.0, -7.96], L: [41.02, -7.98] },
      roads: ["A-C", "A-L", "L-C"],
      speedsKph: { "A-C": 50, "A-L": 80, "L-C": 80 },
    });
    const routes = routeAlternatives(withLoop, ends[0], ends[1], "fastest", { count: 3 });
    expect(routes.length).toBeGreaterThan(1);
    expect(pathOf(withLoop, routes[0].nodeIds)).not.toBe(pathOf(withLoop, routes[1].nodeIds));
  });

  it("does not depend on which end the route entered from", () => {
    const graph = twoBows();
    // Whole-route identity is the same set of roads either way round.
    const forward = routeAlternatives(graph, ends[0], ends[1], "fastest", { count: 3 });
    const reverse = routeAlternatives(graph, ends[1], ends[0], "fastest", { count: 3 });
    expect(forward).toHaveLength(reverse.length);
  });
});
