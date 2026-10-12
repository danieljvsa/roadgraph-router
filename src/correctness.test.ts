import { compactGraph, decodeGraph, encodeCompactGraph, mergeRoadGraphs, route, snapToGraph } from "./index";
import { buildGraph, pathOf, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

describe("banned runs longer than a byte", () => {
  /** A straight one-way chain of `length` edges, with a parallel bypass. */
  function chain(length: number): GraphSpec {
    const nodes: GraphSpec["nodes"] = { BY: [0.01, 0] };
    for (let index = 0; index <= length; index += 1) nodes[`N${index}`] = [0, index * 0.001];
    const roads = Array.from({ length }, (_, index) => `N${index}>N${index + 1}`);
    return { nodes, roads: [...roads, `N0-BY`, `BY-N${length}`] };
  }

  it.each([3, 260, 300])("enforces a run of %i edges", (length) => {
    const spec = chain(length);
    const run = Array.from({ length }, (_, index) => `N${index}>N${index + 1}`);
    const open = viaDisk(spec);
    const banned = viaDisk({ ...spec, bannedRuns: [run] });
    const destination = point(0, length * 0.001);

    // Without the ban the chain is the direct way through.
    expect(route(open, point(0, 0), destination).nodeIds).toHaveLength(length + 1);
    // With it, the only legal way is the bypass. Packing a run position into a
    // fixed byte used to alias here and quietly stop enforcing the ban.
    expect(pathOf(banned, route(banned, point(0, 0), destination).nodeIds)).toBe(`N0>BY>N${length}`);
  });

  it("keeps runs distinct when one is longer than the packing stride", () => {
    const spec = chain(300);
    const long = Array.from({ length: 300 }, (_, index) => `N${index}>N${index + 1}`);
    const graph = viaDisk({ ...spec, bannedRuns: [long, ["N0>N1", "N1>N2", "N2>N3"]] });
    expect(graph.turnRestrictionSequenceOffsets).toHaveLength(3);
    expect(pathOf(graph, route(graph, point(0, 0), point(0, 0.3)).nodeIds)).toBe("N0>BY>N300");
  });
});

describe("snapping at complex intersections", () => {
  /** Six roads meeting at one junction, at 60-degree intervals. */
  const star: GraphSpec = {
    nodes: {
      C: [0, 0],
      A0: [0.01, 0], A1: [0.005, 0.00866], A2: [-0.005, 0.00866],
      A3: [-0.01, 0], A4: [-0.005, -0.00866], A5: [0.005, -0.00866],
    },
    roads: ["C-A0", "C-A1", "C-A2", "C-A3", "C-A4", "C-A5"],
  };

  it("snaps to the junction itself when standing on it", () => {
    const graph = viaDisk(star);
    expect(snapToGraph(graph, point(0, 0))).toMatchObject({ kind: "node", node: graph.nodeIndex.C });
  });

  it("picks the arm actually nearest, not merely the first", () => {
    const graph = viaDisk(star);
    // A point part-way along the A2 arm must snap to that arm.
    const snap = snapToGraph(graph, point(-0.0025, 0.00433));
    if (snap?.kind !== "edge") throw new Error("expected an edge snap");
    expect(snap.distanceMeters).toBeLessThan(5);
    // Both directions of that two-way arm are offered.
    expect(snap.projections).toHaveLength(2);
  });

  it("routes correctly from a point on one arm to every other arm", () => {
    const graph = viaDisk(star);
    for (const arm of ["A0", "A1", "A3", "A4", "A5"]) {
      const [lat, lng] = star.nodes[arm];
      const result = route(graph, point(-0.0025, 0.00433), point(lat, lng));
      expect(pathOf(graph, result.nodeIds)).toBe(`C>${arm}`);
    }
  });
});

describe("snapping between parallel roads", () => {
  /**
   * A dual carriageway: two one-way roads about 22 m apart running opposite
   * ways. Which one a coordinate belongs to decides which way it may travel.
   */
  const dual: GraphSpec = {
    nodes: { WN: [0.0001, 0], EN: [0.0001, 0.01], ES: [-0.0001, 0.01], WS: [-0.0001, 0] },
    roads: ["WN>EN", "ES>WS"],
  };

  it("snaps to the carriageway it is actually on", () => {
    const graph = viaDisk(dual);
    const north = snapToGraph(graph, point(0.00008, 0.005));
    const south = snapToGraph(graph, point(-0.00008, 0.005));
    if (north?.kind !== "edge" || south?.kind !== "edge") throw new Error("expected edge snaps");
    expect(north.projections).toHaveLength(1);
    expect(south.projections).toHaveLength(1);
    expect(north.projections[0].edge).not.toBe(south.projections[0].edge);
  });

  it("only travels the way its carriageway allows", () => {
    const graph = viaDisk(dual);
    // Standing on the eastbound side, the west end is not reachable.
    expect(pathOf(graph, route(graph, point(0.00008, 0.002), point(0.0001, 0.01)).nodeIds)).toBe("EN");
    expect(() => route(graph, point(0.00008, 0.002), point(0.0001, 0))).toThrow(/No car route/);
    // Standing on the westbound side, the reverse holds.
    expect(pathOf(graph, route(graph, point(-0.00008, 0.008), point(-0.0001, 0)).nodeIds)).toBe("WS");
  });

  it("does not merge the two carriageways into one road", () => {
    const graph = viaDisk(dual);
    const snap = snapToGraph(graph, point(0.00008, 0.005));
    // The opposite carriageway is further than the tie tolerance, so it is not
    // offered as an alternative direction for the same road.
    if (snap?.kind !== "edge") throw new Error("expected an edge snap");
    expect(snap.projections).toHaveLength(1);
  });
});

describe("merging preserves the graph it was split from", () => {
  /** A grid with geometry, one-ways, a banned pair and a banned run. */
  const world: GraphSpec = {
    nodes: {
      A: [0, 0], B: [0, 0.01], C: [0, 0.02], D: [0.01, 0.02],
      E: [0.01, 0.01], F: [0.01, 0], G: [0.005, 0.03],
    },
    roads: ["A-B", "B>C", "C-D", "D-E", "E-F", "F-A", "B-E", "C-G", "G-D"],
    shapes: { "A>B": [[0.002, 0.005]], "B>A": [[0.002, 0.005]], "C>D": [[0.005, 0.022]], "D>C": [[0.005, 0.022]] },
    bans: [["A>B", "B>E"]],
    bannedRuns: [["F>A", "A>B", "B>C"]],
  };

  /** Splits a graph into per-node-range tiles that each keep their own edges. */
  function split(spec: GraphSpec, groups: string[][]) {
    return groups.map((names) => {
      const kept = new Set(names);
      const roads = spec.roads.filter((road) => road.split(/[->]/).filter(Boolean).every((name) => kept.has(name)));
      return buildGraph({
        ...spec,
        nodes: Object.fromEntries(names.map((name) => [name, spec.nodes[name]])),
        roads,
        shapes: Object.fromEntries(Object.entries(spec.shapes ?? {}).filter(([key]) => key.split(">").every((name) => kept.has(name)))),
        bans: (spec.bans ?? []).filter((ban) => ban.flatMap((key) => key.split(">")).every((name) => kept.has(name))),
        bannedRuns: (spec.bannedRuns ?? []).filter((run) => run.flatMap((key) => key.split(">")).every((name) => kept.has(name))),
      });
    });
  }

  const whole = buildGraph(world);
  const merged = mergeRoadGraphs(split(world, [
    ["A", "B", "C", "E", "F"],
    ["B", "C", "D", "E", "G"],
    ["C", "D", "G"],
  ]));

  it("keeps every node and road exactly once", () => {
    expect(merged.nodeLatitudes).toHaveLength(whole.nodeLatitudes.length);
    expect(merged.edgeTargets).toHaveLength(whole.edgeTargets.length);
  });

  it("keeps the restrictions", () => {
    expect(merged.turnRestrictionFromEdges).toHaveLength(whole.turnRestrictionFromEdges!.length);
    expect(merged.turnRestrictionSequenceEdges).toHaveLength(whole.turnRestrictionSequenceEdges!.length);
  });

  it("returns the same routes as the graph it was split from", () => {
    const places = Object.entries(world.nodes).map(([name, [lat, lng]]) => [name, point(lat, lng)] as const);
    for (const [, from] of places) {
      for (const [, to] of places) {
        let expected: ReturnType<typeof route> | null = null;
        try { expected = route(whole, from, to); } catch { expected = null; }
        if (!expected) { expect(() => route(merged, from, to)).toThrow(); continue; }
        const actual = route(merged, from, to);
        expect(actual.distanceMeters).toBeCloseTo(expected.distanceMeters, 3);
        expect(actual.durationSeconds).toBeCloseTo(expected.durationSeconds, 3);
        expect(actual.geometry.coordinates).toEqual(expected.geometry.coordinates);
      }
    }
  });
});
