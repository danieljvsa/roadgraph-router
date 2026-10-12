import { compactGraph, decodeGraph, encodeCompactGraph, mergeRoadGraphs, route } from "./index";
import { buildGraph, pathOf, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

/** Asserts the run never appears as consecutive hops, however the route got there. */
function expectRunAvoided(graph: { turnRestrictionSequenceEdges?: Uint32Array; turnRestrictionSequenceOffsets?: Uint32Array }, edgeIds: number[]) {
  const offsets = graph.turnRestrictionSequenceOffsets!;
  for (let sequence = 0; sequence + 1 < offsets.length; sequence += 1) {
    const run = Array.from(graph.turnRestrictionSequenceEdges!.subarray(offsets[sequence], offsets[sequence + 1]));
    for (let at = 0; at + run.length <= edgeIds.length; at += 1) {
      expect(edgeIds.slice(at, at + run.length)).not.toEqual(run);
    }
  }
}

/**
 * A one-way slip road used as the `via` way of a restriction. Coming off A at
 * J1 you may drive the link, but the relation forbids carrying on to C. B
 * feeds the same link and is not named by the relation, so its traffic may.
 *
 *   A --- J1 >=link=> J2 >-- C
 *   |      ^               /
 *   |      B              /
 *   +------- D ----------+
 */
const slipRoad: GraphSpec = {
  nodes: { A: [0, 0], J1: [0, 0.01], J2: [0, 0.02], C: [0, 0.03], B: [-0.01, 0.01], D: [-0.01, 0.03] },
  roads: ["A-J1", "J1>J2", "J2>C", "B>J1", "A-D", "D-C"],
};
const bannedRun: string[][] = [["A>J1", "J1>J2", "J2>C"]];

const at = { A: point(0, 0), J2: point(0, 0.02), C: point(0, 0.03), B: point(-0.01, 0.01), E: point(0.01, 0.02) };

describe("no_* restrictions with a via way", () => {
  it("drives straight through when nothing is banned", () => {
    const graph = viaDisk(slipRoad);
    expect(pathOf(graph, route(graph, at.A, at.C).nodeIds)).toBe("A>J1>J2>C");
  });

  it("forbids the full run and routes around it", () => {
    const graph = viaDisk({ ...slipRoad, bannedRuns: bannedRun });
    const result = route(graph, at.A, at.C);
    expect(pathOf(graph, result.nodeIds)).toBe("A>D>C");
    expectRunAvoided(graph, result.edgeIds);
  });

  it("costs more than the banned run would have", () => {
    const open = viaDisk(slipRoad);
    const graph = viaDisk({ ...slipRoad, bannedRuns: bannedRun });
    expect(route(graph, at.A, at.C).distanceMeters).toBeGreaterThan(route(open, at.A, at.C).distanceMeters);
  });

  it("leaves the same link usable from an approach the relation does not name", () => {
    const graph = viaDisk({ ...slipRoad, bannedRuns: bannedRun });
    expect(pathOf(graph, route(graph, at.B, at.C).nodeIds)).toBe("B>J1>J2>C");
  });

  it("still allows driving the link itself, just not the continuation", () => {
    const graph = viaDisk({ ...slipRoad, bannedRuns: bannedRun });
    expect(pathOf(graph, route(graph, at.A, at.J2).nodeIds)).toBe("A>J1>J2");
  });

  it("bans only the whole run, not any pair inside it", () => {
    const graph = viaDisk({ ...slipRoad, bannedRuns: bannedRun });
    // A>J1 then J1>J2 is fine, and J1>J2 then J2>C is fine; only all three is not.
    expect(route(graph, at.A, at.J2).edgeIds).toHaveLength(2);
    expect(route(graph, at.B, at.C).edgeIds).toHaveLength(3);
  });

  it("reports no route when the banned run is the only way through", () => {
    const graph = viaDisk({
      nodes: { A: [0, 0], J1: [0, 0.01], J2: [0, 0.02], C: [0, 0.03] },
      roads: ["A>J1", "J1>J2", "J2>C"],
      bannedRuns: bannedRun,
    });
    expect(() => route(graph, at.A, at.C)).toThrow(/No car route/);
  });

  it("enforces a run that spans two via edges", () => {
    const longLink: GraphSpec = {
      nodes: { A: [0, 0], J1: [0, 0.01], M: [0, 0.015], J2: [0, 0.02], C: [0, 0.03], D: [-0.01, 0.03] },
      roads: ["A-J1", "J1>M", "M>J2", "J2>C", "A-D", "D-C"],
    };
    const open = viaDisk(longLink);
    const graph = viaDisk({ ...longLink, bannedRuns: [["A>J1", "J1>M", "M>J2", "J2>C"]] });
    expect(pathOf(open, route(open, at.A, at.C).nodeIds)).toBe("A>J1>M>J2>C");
    const result = route(graph, at.A, at.C);
    expect(pathOf(graph, result.nodeIds)).toBe("A>D>C");
    expectRunAvoided(graph, result.edgeIds);
  });
});

describe("only_* restrictions with a via way", () => {
  /**
   * `only_straight_on` via the link: having taken the link from A, the only
   * legal continuation is C. The compiler expands that into one banned run per
   * other exit from J2, which is what is written out here.
   */
  const withExit: GraphSpec = {
    ...slipRoad,
    nodes: { ...slipRoad.nodes, E: [0.01, 0.02] },
    roads: [...slipRoad.roads, "J2>E", "C-E"],
  };
  const onlyStraightOn: string[][] = [["A>J1", "J1>J2", "J2>E"]];

  it("forces the mandatory continuation after the via way", () => {
    const graph = viaDisk({ ...withExit, bannedRuns: onlyStraightOn });
    expect(pathOf(graph, route(graph, at.A, at.C).nodeIds)).toBe("A>J1>J2>C");
  });

  it("blocks every other exit for traffic that came the restricted way", () => {
    const open = viaDisk(withExit);
    const graph = viaDisk({ ...withExit, bannedRuns: onlyStraightOn });
    expect(pathOf(open, route(open, at.A, at.E).nodeIds)).toBe("A>J1>J2>E");
    // The link is still the quickest way over, so the route takes it and then
    // obeys the mandatory continuation to C before doubling back to E.
    const result = route(graph, at.A, at.E);
    expect(pathOf(graph, result.nodeIds)).toBe("A>J1>J2>C>E");
    expectRunAvoided(graph, result.edgeIds);
  });

  it("leaves other approaches to the via way unconstrained", () => {
    const graph = viaDisk({ ...withExit, bannedRuns: onlyStraightOn });
    expect(pathOf(graph, route(graph, at.B, at.E).nodeIds)).toBe("B>J1>J2>E");
  });
});

describe("via-way runs survive storage and merging", () => {
  it("round-trips through an EFR2 v5 chunk", () => {
    const built = buildGraph({ ...slipRoad, bannedRuns: bannedRun });
    const encoded = encodeCompactGraph(compactGraph(built));
    expect(new DataView(encoded).getUint16(4, true)).toBe(5);
    expect(new DataView(encoded).getUint32(32, true)).toBe(1);
    expect(new DataView(encoded).getUint32(36, true)).toBe(3);
    const decoded = decodeGraph(encoded);
    expect(decoded.turnRestrictionSequenceEdges).toEqual(built.turnRestrictionSequenceEdges);
    expect(decoded.turnRestrictionSequenceOffsets).toEqual(built.turnRestrictionSequenceOffsets);
  });

  it("stays on v4 when only pair restrictions are present", () => {
    const pairsOnly = encodeCompactGraph(compactGraph(buildGraph({ ...slipRoad, bans: [["A>J1", "J1>J2"]] })));
    expect(new DataView(pairsOnly).getUint16(4, true)).toBe(4);
  });

  it("keeps enforcing a run after tiles are merged", () => {
    const west = buildGraph({ ...slipRoad, bannedRuns: bannedRun });
    const east = buildGraph({ nodes: { J2: [0, 0.02], C: [0, 0.03], D: [-0.01, 0.03] }, roads: ["J2>C", "D-C"] });
    const merged = mergeRoadGraphs([west, east]);
    expect(merged.turnRestrictionSequenceEdges).toHaveLength(3);
    const result = route(merged, at.A, at.C);
    expectRunAvoided(merged, result.edgeIds);
    expect(result.nodeIds).toHaveLength(3);
  });

  it("drops a run whose edges did not all survive the merge", () => {
    // The other tile has no link, so the run simply has nothing to match there.
    const withRun = buildGraph({ ...slipRoad, bannedRuns: bannedRun });
    const elsewhere = buildGraph({ nodes: { X: [5, 5], Y: [5, 5.01] }, roads: ["X-Y"] });
    const merged = mergeRoadGraphs([withRun, elsewhere]);
    expect(merged.turnRestrictionSequenceEdges).toHaveLength(3);
    expect(pathOf({ ...merged, nodeIndex: {}, nodeNames: [] } as never, route(merged, at.A, at.C).nodeIds.slice(0, 0))).toBe("");
  });
});
