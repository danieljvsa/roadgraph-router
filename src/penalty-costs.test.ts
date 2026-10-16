/**
 * The costs a search steers by, and the costs it reports.
 *
 * A penalty exists to change which way a route goes without changing what the
 * route is said to cost. That only works if every part of the journey is
 * priced the same way while the search is choosing — the edges in the middle,
 * the partial edge it starts on, the partial edge it finishes on, and the
 * case where those two are the same edge and there is no middle at all.
 */

import { ProfileId, packEdgeRailway, route, routeAlternatives } from "./index";
import type { EdgeRailway, RailwayAttributes, RoadGraph } from "./index";
import { buildGraph, pathOf, type GraphSpec } from "./test-support";

const RUNNING: RailwayAttributes = {
  gaugeMm: 1435, secondGaugeMm: 0, voltage: 750, secondVoltage: 0,
  electrification: 2, frequency: 1, secondFrequency: 0, usage: 1, service: 0,
};

/** A graph that describes its track, so station snaps keep their projections. */
function railway(spec: GraphSpec) {
  const graph = buildGraph(spec);
  const described = Array.from({ length: graph.edgeTargets.length }, (_, edge) => ({ edge, railway: RUNNING }));
  return {
    ...graph,
    profileId: ProfileId.train,
    maxSpeedKph: 300,
    edgeRailway: packEdgeRailway(described, graph.edgeTargets.length) as EdgeRailway,
  };
}

/** The directed edge joining two named nodes. */
function edgeBetween(graph: RoadGraph & { nodeIndex: Record<string, number> }, from: string, to: string) {
  const source = graph.nodeIndex[from];
  for (let edge = graph.edgeOffsets[source]; edge < graph.edgeOffsets[source + 1]; edge += 1) {
    if (graph.edgeTargets[edge] === graph.nodeIndex[to]) return edge;
  }
  throw new Error(`no edge ${from} -> ${to}`);
}

/**
 * A short way and a long way between the same two points. The short way is a
 * single edge, so a route between the two ends is the "direct" case: one
 * partial edge from end to end, with nothing in the middle.
 */
const TWO_WAYS: GraphSpec = {
  nodes: { A: [41.0, -8.600], B: [41.0, -8.580], C: [41.010, -8.590] },
  roads: ["A-B", "A-C", "C-B"],
};

describe("a penalty on the edge a direct route uses", () => {
  const graph = railway(TWO_WAYS);
  const at = (name: keyof typeof TWO_WAYS.nodes) => ({ lat: TWO_WAYS.nodes[name][0], lng: TWO_WAYS.nodes[name][1] });
  const direct = edgeBetween(graph, "A", "B");

  it("takes the short way when nothing is penalised", () => {
    const result = route(graph, at("A"), at("B"), "shortest");
    expect(result.distanceMeters).toBeLessThan(2_000);
  });

  // The whole journey is one partial edge, so it never reaches the search's
  // own cost table. A penalty that the search cannot see is not a penalty.
  it("goes the long way once that edge is made dear", () => {
    const result = route(graph, at("A"), at("B"), "shortest", {
      costPenalties: new Map([[direct, 100]]),
    });
    expect(pathOf(graph, result.nodeIds)).toContain("C");
    expect(result.distanceMeters).toBeGreaterThan(2_000);
  });

  // Steering is not pricing: the answer is reported at the graph's own cost.
  it("reports the long way at its true length, not its penalised one", () => {
    const plain = route(graph, at("A"), at("C"), "shortest");
    const penalised = route(graph, at("A"), at("B"), "shortest", {
      costPenalties: new Map([[direct, 100]]),
    });
    const viaC = plain.distanceMeters;
    expect(penalised.distanceMeters).toBeGreaterThan(viaC);
    // A-C-B at its real length, nowhere near a hundred times anything.
    expect(penalised.distanceMeters).toBeLessThan(viaC * 3);
  });
});

describe("a penalty on the edge a route starts or finishes on", () => {
  // Two ways out of A that both reach B, one of them much shorter.
  const spec: GraphSpec = {
    nodes: { A: [41.0, -8.600], M: [41.0, -8.594], B: [41.0, -8.580], C: [41.010, -8.590] },
    roads: ["A-M", "M-B", "A-C", "C-B"],
  };
  const graph = railway(spec);
  const start = { lat: 41.0, lng: -8.598 }; // part-way along A-M
  const finish = { lat: 41.0, lng: -8.580 };

  it("leaves by another road when the one underfoot is made dear", () => {
    const plain = route(graph, start, finish, "shortest");
    expect(pathOf(graph, plain.nodeIds)).not.toContain("C");

    const penalised = route(graph, start, finish, "shortest", {
      costPenalties: new Map([[edgeBetween(graph, "A", "M"), 100], [edgeBetween(graph, "M", "A"), 100], [edgeBetween(graph, "M", "B"), 100]]),
    });
    expect(pathOf(graph, penalised.nodeIds)).toContain("C");
  });
});

describe("alternative routes over a direct edge", () => {
  const graph = railway(TWO_WAYS);
  const at = (name: keyof typeof TWO_WAYS.nodes) => ({ lat: TWO_WAYS.nodes[name][0], lng: TWO_WAYS.nodes[name][1] });

  // The best route here is a single edge. Offering a second one means
  // penalising that edge and being listened to.
  it("offers the long way round as an alternative to a one-edge route", () => {
    const routes = routeAlternatives(graph, at("A"), at("B"), "shortest", { count: 2, maxStretch: 5 });
    expect(routes.length).toBe(2);
    expect(routes[0].distanceMeters).toBeLessThan(routes[1].distanceMeters);
    expect(pathOf(graph, routes[1].nodeIds)).toContain("C");
  });

  it("sorts what it offers by real cost, not by penalised cost", () => {
    const routes = routeAlternatives(graph, at("A"), at("B"), "shortest", { count: 3, maxStretch: 5 });
    for (let index = 1; index < routes.length; index += 1) {
      expect(routes[index].distanceMeters).toBeGreaterThanOrEqual(routes[index - 1].distanceMeters);
    }
  });

  it("respects maxStretch, which the long way here exceeds", () => {
    const routes = routeAlternatives(graph, at("A"), at("B"), "shortest", { count: 2, maxStretch: 1.1 });
    expect(routes.length).toBe(1);
  });
});
