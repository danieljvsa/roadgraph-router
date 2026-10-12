import { compactGraph, decodeGraph, encodeCompactGraph, route, RouterError } from "./index";
import { buildGraph, haversineMeters, pathOf, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

describe("one-way roads", () => {
  it("travels along a one-way road but never against it", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0, 0.001], C: [0, 0.002] },
      roads: ["A>B", "B>C"],
    });
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.002)).nodeIds)).toBe("A>B>C");
    expect(() => route(graph, point(0, 0.002), point(0, 0))).toThrow(/No car route/);
  });

  it("uses a parallel return road rather than driving the wrong way", () => {
    //  A >--- B >--- C
    //  ^              |
    //  +---- D <------+
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [-0.001, 0.001] },
      roads: ["A>B", "B>C", "C>D", "D>A"],
    });
    expect(pathOf(graph, route(graph, point(0, 0.002), point(0, 0)).nodeIds)).toBe("C>D>A");
  });

  it("respects a reversed one-way road", () => {
    const forward = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["A>B"] });
    const reversed = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["B>A"] });
    expect(pathOf(forward, route(forward, point(0, 0), point(0, 0.001)).nodeIds)).toBe("A>B");
    expect(() => route(reversed, point(0, 0), point(0, 0.001))).toThrow(/No car route/);
    expect(pathOf(reversed, route(reversed, point(0, 0.001), point(0, 0)).nodeIds)).toBe("B>A");
  });
});

describe("two-way roads", () => {
  it("routes in both directions with the same cost", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001], C: [0, 0.002] }, roads: ["A-B", "B-C"] });
    const there = route(graph, point(0, 0), point(0, 0.002));
    const back = route(graph, point(0, 0.002), point(0, 0));
    expect(pathOf(graph, there.nodeIds)).toBe("A>B>C");
    expect(pathOf(graph, back.nodeIds)).toBe("C>B>A");
    expect(back.distanceMeters).toBeCloseTo(there.distanceMeters, 3);
    expect(back.durationSeconds).toBeCloseTo(there.durationSeconds, 3);
  });

  it("prefers the faster of two two-way roads when asked for the fastest route", () => {
    //  A - B - C is short but slow; A - D - C is longer but fast.
    const spec: GraphSpec = {
      nodes: { A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [0.002, 0.001] },
      roads: ["A-B", "B-C", "A-D", "D-C"],
      speedsKph: { "A-B": 20, "B-C": 20, "A-D": 120, "D-C": 120 },
    };
    const graph = viaDisk(spec);
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.002), "fastest").nodeIds)).toBe("A>D>C");
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.002), "shortest").nodeIds)).toBe("A>B>C");
  });
});

describe("roundabouts", () => {
  // A square roundabout driven anticlockwise, with four approach arms.
  const roundabout: GraphSpec = {
    nodes: {
      R1: [0.001, 0.001], R2: [0.001, 0.002], R3: [0.002, 0.002], R4: [0.002, 0.001],
      S: [0, 0.001], E: [0.001, 0.004], N: [0.004, 0.001], W: [0.002, -0.002],
    },
    roads: ["R1>R2", "R2>R3", "R3>R4", "R4>R1", "S-R1", "E-R2", "N-R4", "W-R4"],
  };

  it("drives around the ring in its one legal direction", () => {
    const graph = viaDisk(roundabout);
    // S enters at R1; E leaves at R2, one hop with the flow.
    expect(pathOf(graph, route(graph, point(0, 0.001), point(0.001, 0.004)).nodeIds)).toBe("S>R1>R2>E");
    // N leaves at R4, which is three hops with the flow rather than one against it.
    expect(pathOf(graph, route(graph, point(0, 0.001), point(0.004, 0.001)).nodeIds)).toBe("S>R1>R2>R3>R4>N");
  });

  it("never traverses a ring segment backwards", () => {
    const graph = viaDisk(roundabout);
    const ring = route(graph, point(0.001, 0.004), point(0, 0.001)).nodeIds;
    expect(pathOf(graph, ring)).toBe("E>R2>R3>R4>R1>S");
  });

  it("obeys an only_straight_on relation that forces an exit", () => {
    // Entering from S, the only legal exit is W via R4, so the normal shortest
    // hop to E is no longer available on that approach.
    const graph = viaDisk({ ...roundabout, bans: [["S>R1", "R1>R2"]] });
    expect(() => route(graph, point(0, 0.001), point(0.001, 0.004))).toThrow(/No car route/);
  });
});

describe("disconnected roads", () => {
  it("reports NO_ROUTE between two unconnected components", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0, 0.001], C: [0.01, 0], D: [0.01, 0.001] },
      roads: ["A-B", "C-D"],
    });
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.001)).nodeIds)).toBe("A>B");
    try {
      route(graph, point(0, 0), point(0.01, 0.001));
      throw new Error("expected the route to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("NO_ROUTE");
    }
  });

  it("reports which endpoint is off the network", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["A-B"] });
    expect(() => route(graph, point(10, 10), point(0, 0.001))).toThrow(/close to the origin/);
    expect(() => route(graph, point(0, 0), point(10, 10))).toThrow(/close to the destination/);
  });

  it("returns an empty route when both ends snap to the same node", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["A-B"] });
    const result = route(graph, point(0, 0), point(0, 0));
    expect(result.nodeIds).toEqual([graph.nodeIndex.A]);
    expect(result.distanceMeters).toBe(0);
    expect(result.geometry.coordinates).toEqual([[0, 0]]);
    expect(result.originSnap).toMatchObject({ node: graph.nodeIndex.A, edge: -1 });
  });

  it("routes the short way along one road rather than collapsing to a node", () => {
    const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["A-B"] });
    // A metre past the junction is a point on the road, not the junction.
    const result = route(graph, point(0, 0), point(0, 0.00001));
    expect(result.distanceMeters).toBeCloseTo(1.11, 1);
    expect(result.edgeIds).toEqual([]);
    expect(result.destinationSnap.edge).toBeGreaterThanOrEqual(0);
    expect(result.geometry.coordinates[0]).toEqual([0, 0]);
    expect(result.geometry.coordinates.at(-1)![0]).toBeCloseTo(0.00001, 7);
  });
});

describe("curved roads with simplified topology", () => {
  // One directed edge standing in for a curved road whose interior OSM nodes
  // were dropped by topology simplification but kept as shape points.
  const curve: [number, number][] = [[0.0002, 0.0003], [0.0006, 0.0005], [0.0009, 0.0007]];
  const curved: GraphSpec = {
    nodes: { A: [0, 0], B: [0.001, 0.001] },
    roads: ["A-B"],
    shapes: { "A>B": curve, "B>A": [...curve].reverse() },
  };

  it("returns the curve rather than a straight line between the two nodes", () => {
    const graph = viaDisk(curved);
    const result = route(graph, point(0, 0), point(0.001, 0.001));
    expect(result.geometry.coordinates).toEqual([
      [0, 0], [0.0003, 0.0002], [0.0005, 0.0006], [0.0007, 0.0009], [0.001, 0.001],
    ]);
  });

  it("mirrors the geometry when the same road is driven the other way", () => {
    const graph = viaDisk(curved);
    const there = route(graph, point(0, 0), point(0.001, 0.001)).geometry.coordinates;
    const back = route(graph, point(0.001, 0.001), point(0, 0)).geometry.coordinates;
    expect(back).toEqual([...there].reverse());
  });

  it("prices the edge by its curved length, not the straight-line distance", () => {
    const graph = viaDisk(curved);
    const result = route(graph, point(0, 0), point(0.001, 0.001));
    expect(result.distanceMeters).toBeGreaterThan(haversineMeters([0, 0], [0.001, 0.001]));
  });

  it("keeps shape points out of the node path", () => {
    const graph = viaDisk(curved);
    expect(route(graph, point(0, 0), point(0.001, 0.001)).nodeIds).toHaveLength(2);
  });
});

describe("access-restricted roads", () => {
  it("routes around a road the compiler left out because access was denied", () => {
    // The compiler emits no edge for a denied way, so the graph simply lacks
    // the shortcut: A-C here stands for the private road being absent.
    const open = viaDisk({
      nodes: { A: [0, 0], B: [0.002, 0.001], C: [0, 0.002] },
      roads: ["A-C", "A-B", "B-C"],
    });
    const gated = viaDisk({
      nodes: { A: [0, 0], B: [0.002, 0.001], C: [0, 0.002] },
      roads: ["A-B", "B-C"],
    });
    expect(pathOf(open, route(open, point(0, 0), point(0, 0.002)).nodeIds)).toBe("A>C");
    expect(pathOf(gated, route(gated, point(0, 0), point(0, 0.002)).nodeIds)).toBe("A>B>C");
    expect(route(gated, point(0, 0), point(0, 0.002)).distanceMeters)
      .toBeGreaterThan(route(open, point(0, 0), point(0, 0.002)).distanceMeters);
  });
});

describe("mph speed limits", () => {
  it("turns an mph limit into the matching duration", () => {
    // 30 mph is 48.28 km/h, so a 1 km road takes about 74.6 seconds. The
    // tolerance absorbs the Uint16 quantisation of the compact chunk.
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0.00898315, 0] },
      roads: ["A-B"],
      speedsKph: { "A-B": 30 * 1.609344 },
    });
    const result = route(graph, point(0, 0), point(0.00898315, 0));
    expect(result.distanceMeters).toBeCloseTo(1000, -1);
    expect(result.durationSeconds).toBeCloseTo(74.6, -1);
    expect(result.distanceMeters / result.durationSeconds).toBeCloseTo((30 * 1.609344 * 1000) / 3600, 0);
  });

  it("prefers a 60 mph road over a 50 km/h road of the same length", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], B: [0.002, 0.001], C: [-0.002, 0.001], D: [0, 0.002] },
      roads: ["A-B", "B-D", "A-C", "C-D"],
      speedsKph: { "A-B": 60 * 1.609344, "B-D": 60 * 1.609344, "A-C": 50, "C-D": 50 },
    });
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.002), "fastest").nodeIds)).toBe("A>B>D");
  });
});
