import { componentSizes, componentsFor } from "./connectivity";
import { route } from "./router";
import { snapToGraph } from "./snap";
import { buildGraph, pathOf } from "./test-support";
import { RouterError } from "./types";

/**
 * A through road, and a two-node fragment joined to nothing, sitting a metre
 * north of the road's far end — the shape of a path behind a fence or a
 * service road in a compound.
 */
const roadAndFragment = () => buildGraph({
  nodes: {
    A: [41.0, -8.03], B: [41.0, -8.02], C: [41.0, -8.01], D: [41.0, -8.0],
    X: [41.00001, -8.0002], Y: [41.00001, -8.0004],
  },
  roads: ["A-B", "B-C", "C-D", "X-Y"],
});

describe("labelling the pieces of a network", () => {
  it("separates a fragment from the road it is not joined to", () => {
    const graph = roadAndFragment();
    const labels = componentsFor(graph);
    expect(labels[graph.nodeIndex.A]).toBe(labels[graph.nodeIndex.D]);
    expect(labels[graph.nodeIndex.X]).toBe(labels[graph.nodeIndex.Y]);
    expect(labels[graph.nodeIndex.X]).not.toBe(labels[graph.nodeIndex.A]);
  });

  it("joins two nodes whichever way the road between them points", () => {
    // A one-way street still joins its ends: you cannot drive back along it,
    // but you are not in a different part of the map.
    const oneWay = buildGraph({ nodes: { A: [41.0, -8.0], B: [41.0, -7.99] }, roads: ["A>B"] });
    const labels = componentsFor(oneWay);
    expect(labels[0]).toBe(labels[1]);
  });

  it("counts how big each piece is", () => {
    const sizes = componentSizes(componentsFor(roadAndFragment()));
    expect([...sizes.values()].sort((a, b) => b - a)).toEqual([4, 2]);
  });

  it("is measured once and remembered with the graph", () => {
    const graph = roadAndFragment();
    expect(componentsFor(graph)).toBe(componentsFor(graph));
  });
});

describe("a route whose end snaps to the wrong piece", () => {
  const graph = roadAndFragment();
  /** Right on the fragment, with the through road a few metres away. */
  const besideTheFragment = { lat: 41.00001, lng: -8.0003 };

  it("snaps to the fragment when nothing says otherwise", () => {
    const snap = snapToGraph(graph, besideTheFragment);
    const node = snap!.kind === "node" ? snap!.node : snap!.projections[0].source;
    expect([graph.nodeIndex.X, graph.nodeIndex.Y]).toContain(node);
  });

  it("routes anyway, by snapping again to the road the other end can reach", () => {
    const result = route(graph, { lat: 41.0, lng: -8.03 }, besideTheFragment);
    expect(pathOf(graph, result.nodeIds)).toBe("A>B>C");
    // It finishes part-way along the far road rather than on the fragment,
    // which sits a metre north of it.
    expect(result.destinationSnap.point.lat).toBeCloseTo(41.0, 6);
    expect(result.destinationSnap.distanceMeters).toBeLessThan(5);
    expect(result.distanceMeters).toBeGreaterThan(2000);
  });

  it("works when it is the origin that landed on the fragment", () => {
    const result = route(graph, besideTheFragment, { lat: 41.0, lng: -8.03 });
    expect(pathOf(graph, result.nodeIds)).toContain("A");
    expect(result.originSnap.point.lat).toBeCloseTo(41.0, 6);
  });

  it("can be asked to snap only to the piece the other end is in", () => {
    const labels = componentsFor(graph);
    const road = labels[graph.nodeIndex.A];
    const snap = snapToGraph(graph, besideTheFragment, undefined, undefined, (node) => labels[node] === road);
    const node = snap!.kind === "node" ? snap!.node : snap!.projections[0].source;
    expect([graph.nodeIndex.X, graph.nodeIndex.Y]).not.toContain(node);
  });
});

describe("a route that is genuinely impossible", () => {
  it("still reports no route when the two halves never meet", () => {
    const split = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.999], C: [41.5, -8.0], D: [41.5, -7.999] },
      roads: ["A-B", "C-D"],
    });
    // Both ends are a long way from the other half, so snapping again cannot
    // mend it and the original answer stands.
    expect(() => route(split, { lat: 41.0, lng: -8.0 }, { lat: 41.5, lng: -7.999 })).toThrow(RouterError);
  });

  it("still reports nothing in reach when a point is nowhere near a road", () => {
    const graph = roadAndFragment();
    expect(() => route(graph, { lat: 41.0, lng: -8.03 }, { lat: 42.5, lng: -7.0 })).toThrow(/close to the destination/i);
  });
});
