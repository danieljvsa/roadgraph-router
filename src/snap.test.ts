import { compactGraph, decodeGraph, encodeCompactGraph, route, snapToGraph } from "./index";
import { buildGraph, haversineMeters, pathOf, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

/**
 * A single 11 km road with a junction only at each end — the rural shape that
 * topology simplification produces and that node-only snapping cannot handle.
 */
const longRoad: GraphSpec = {
  nodes: { A: [0, 0], B: [0, 0.1] },
  roads: ["A-B"],
};

describe("snapping to the nearest road", () => {
  it("snaps to a road that has no node anywhere near", () => {
    const graph = viaDisk(longRoad);
    const middle = point(0, 0.05);
    // The nearest junction is 5.5 km away, far beyond the 500 m budget.
    expect(haversineMeters([0, 0.05], [0, 0])).toBeGreaterThan(5000);
    const snap = snapToGraph(graph, middle);
    expect(snap?.kind).toBe("edge");
    expect(snap!.distanceMeters).toBeLessThan(1);
  });

  it("routes from a point in the middle of a long road", () => {
    const graph = viaDisk(longRoad);
    const result = route(graph, point(0, 0.05), point(0, 0.1));
    // Half the road, not the whole of it, and not a failure.
    expect(result.distanceMeters).toBeCloseTo(haversineMeters([0, 0.05], [0, 0.1]), 0);
    expect(result.geometry.coordinates[0][0]).toBeCloseTo(0.05, 6);
    expect(result.geometry.coordinates.at(-1)).toEqual([0.1, 0]);
  });

  it("reports how far the requested point was from the road", () => {
    const graph = viaDisk(longRoad);
    // 0.001 degrees of latitude off the road is about 111 m.
    const result = route(graph, point(0.001, 0.05), point(0, 0.1));
    expect(result.originSnap.distanceMeters).toBeCloseTo(111, -1);
    expect(result.originSnap.edge).toBeGreaterThanOrEqual(0);
    expect(result.originSnap.node).toBe(-1);
  });

  it("still refuses a point that is genuinely nowhere near a road", () => {
    const graph = viaDisk(longRoad);
    expect(() => route(graph, point(1, 1), point(0, 0.1))).toThrow(/close to the origin/);
    expect(() => route(graph, point(0, 0.05), point(1, 1))).toThrow(/close to the destination/);
  });

  it("reports a junction as a node snap, keeping exact-node routing unchanged", () => {
    const graph = viaDisk(longRoad);
    const snap = snapToGraph(graph, point(0, 0));
    expect(snap).toMatchObject({ kind: "node", node: graph.nodeIndex.A });
  });
});

describe("both ends on the same road", () => {
  it("returns just the stretch between them", () => {
    const graph = viaDisk(longRoad);
    const result = route(graph, point(0, 0.02), point(0, 0.08));
    expect(result.nodeIds).toEqual([]);
    expect(result.edgeIds).toEqual([]);
    expect(result.distanceMeters).toBeCloseTo(haversineMeters([0, 0.02], [0, 0.08]), 0);
    expect(result.geometry.coordinates).toHaveLength(2);
  });

  it("drives the other way round when the destination is behind on a one-way", () => {
    //  A >--- B >--- C, with a return road C >--- D >--- A.
    const loop: GraphSpec = {
      nodes: { A: [0, 0], B: [0, 0.05], C: [0, 0.1], D: [-0.05, 0.05] },
      roads: ["A>B", "B>C", "C>D", "D>A"],
    };
    const graph = viaDisk(loop);
    // Both points sit on A>B, but the destination is behind the origin.
    const result = route(graph, point(0, 0.04), point(0, 0.01));
    expect(pathOf(graph, result.nodeIds)).toBe("B>C>D>A");
    expect(result.distanceMeters).toBeGreaterThan(haversineMeters([0, 0.04], [0, 0.01]));
  });
});

describe("mid-edge starts respect direction and restrictions", () => {
  it("cannot set off against a one-way road", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.1] }, roads: ["A>B"] });
    // Starting mid-road, the only legal direction is towards B.
    expect(route(graph, point(0, 0.05), point(0, 0.1)).geometry.coordinates.at(-1)).toEqual([0.1, 0]);
    expect(() => route(graph, point(0, 0.05), point(0, 0.01))).toThrow(/No car route/);
  });

  it("may set off either way along a two-way road", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.1] }, roads: ["A-B"] });
    expect(route(graph, point(0, 0.05), point(0, 0.1)).geometry.coordinates.at(-1)).toEqual([0.1, 0]);
    expect(route(graph, point(0, 0.05), point(0, 0)).geometry.coordinates.at(-1)).toEqual([0, 0]);
  });

  it("obeys a turn restriction on the first turn after a mid-edge start", () => {
    //  W --- C --- E with a bypass C --- N --- E; the approach W>C may not
    //  turn into C>E, and the start is half way along W-C.
    const spec: GraphSpec = {
      nodes: { W: [0, 0], C: [0, 0.05], E: [0, 0.1], N: [0.05, 0.05] },
      roads: ["W-C", "C-E", "C-N", "N-E"],
    };
    const open = viaDisk(spec);
    const banned = viaDisk({ ...spec, bans: [["W>C", "C>E"]] });
    expect(pathOf(open, route(open, point(0, 0.025), point(0, 0.1)).nodeIds)).toBe("C>E");
    expect(pathOf(banned, route(banned, point(0, 0.025), point(0, 0.1)).nodeIds)).toBe("C>N>E");
  });

  it("obeys a turn restriction on the last turn before a mid-edge finish", () => {
    const spec: GraphSpec = {
      nodes: { W: [0, 0], C: [0, 0.05], E: [0, 0.1], N: [0.05, 0.05] },
      roads: ["W-C", "C-E", "C-N", "N-E"],
    };
    const open = viaDisk(spec);
    const banned = viaDisk({ ...spec, bans: [["W>C", "C>E"]] });
    // Without the ban, the route reaches C and finishes part-way along C-E.
    const direct = route(open, point(0, 0), point(0, 0.075));
    expect(pathOf(open, direct.nodeIds)).toBe("W>C");

    // Finishing half way along C-E still counts as taking the banned turn, so
    // the route leaves C and comes back along an approach that is allowed.
    const detour = route(banned, point(0, 0), point(0, 0.075));
    expect(pathOf(banned, detour.nodeIds)).toBe("W>C>N>C");
    expect(detour.distanceMeters).toBeGreaterThan(direct.distanceMeters);
  });
});

describe("geometry of partial edges", () => {
  it("keeps the shape points that lie between the snapped points", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0, 0.1] },
      roads: ["A-B"],
      shapes: { "A>B": [[0.01, 0.025], [0.01, 0.05], [0.01, 0.075]], "B>A": [[0.01, 0.075], [0.01, 0.05], [0.01, 0.025]] },
    });
    const result = route(graph, point(0.01, 0.03), point(0.01, 0.07));
    // Starts on the road, passes the middle shape point, ends on the road.
    expect(result.geometry.coordinates).toHaveLength(3);
    expect(result.geometry.coordinates[1]).toEqual([0.05, 0.01]);
    expect(result.geometry.coordinates[0][0]).toBeCloseTo(0.03, 3);
    expect(result.geometry.coordinates.at(-1)![0]).toBeCloseTo(0.07, 3);
  });

  it("joins a partial start to the full edges that follow it", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0, 0.05], C: [0, 0.1] },
      roads: ["A-B", "B-C"],
      shapes: { "A>B": [[0.01, 0.025]], "B>A": [[0.01, 0.025]] },
    });
    const result = route(graph, point(0.005, 0.0125), point(0, 0.1));
    expect(result.geometry.coordinates[0][0]).toBeCloseTo(0.0125, 2);
    // The shape point, then node B, then node C.
    expect(result.geometry.coordinates.slice(-3)).toEqual([[0.025, 0.01], [0.05, 0], [0.1, 0]]);
    expect(pathOf(graph, result.nodeIds)).toBe("B>C");
  });
});
