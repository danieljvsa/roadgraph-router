import { compactGraph, decodeGraph, encodeCompactGraph, route } from "./index";
import { buildGraph, pathOf, type GraphSpec } from "./test-support";

/**
 * A crossroads at C with a bypass road E-N, so every banned turn still leaves a
 * legal — but longer — way round. Coordinates form a regular grid, which keeps
 * "left", "right" and "straight on" meaningful when reading the assertions.
 *
 *            N
 *            | \
 *   W ------ C - E
 *            |
 *            S
 */
const crossroads: GraphSpec = {
  nodes: { C: [0.001, 0.001], N: [0.002, 0.001], S: [0, 0.001], E: [0.001, 0.002], W: [0.001, 0] },
  roads: ["W-C", "C-N", "C-S", "C-E", "E-N"],
};

const at = {
  C: { lat: 0.001, lng: 0.001 }, N: { lat: 0.002, lng: 0.001 },
  S: { lat: 0, lng: 0.001 }, E: { lat: 0.001, lng: 0.002 }, W: { lat: 0.001, lng: 0 },
};

/** Round-trips through EFR2 v4, so every assertion also covers the on-disk form. */
function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

/** Banning every exit from C except `mandatory` is how an `only_*` relation is compiled. */
function onlyTurn(approach: string, mandatory: string): GraphSpec {
  const exits = ["C>N", "C>S", "C>E", "C>W"];
  return { ...crossroads, bans: exits.filter((exit) => exit !== mandatory).map((exit) => [approach, exit] as [string, string]) };
}

describe("no_* turn restrictions", () => {
  it("takes the direct turn when nothing is banned", () => {
    const graph = viaDisk(crossroads);
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>N");
    expect(pathOf(graph, route(graph, at.W, at.S).nodeIds)).toBe("W>C>S");
    expect(pathOf(graph, route(graph, at.W, at.E).nodeIds)).toBe("W>C>E");
  });

  it("obeys no_left_turn by detouring over the bypass", () => {
    const open = viaDisk(crossroads);
    const graph = viaDisk({ ...crossroads, bans: [["W>C", "C>N"]] });
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>E>N");
    expect(route(graph, at.W, at.N).distanceMeters).toBeGreaterThan(route(open, at.W, at.N).distanceMeters);
  });

  it("obeys no_right_turn", () => {
    const graph = viaDisk({ ...crossroads, bans: [["W>C", "C>S"]] });
    // The only way to S is through C, so the route leaves, turns at E, and
    // comes back to C along an approach the relation does not name.
    expect(pathOf(graph, route(graph, at.W, at.S).nodeIds)).toBe("W>C>E>C>S");
    // Every other movement through the junction is untouched.
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>N");
    expect(pathOf(graph, route(graph, at.E, at.S).nodeIds)).toBe("E>C>S");
  });

  it("obeys no_straight_on", () => {
    const graph = viaDisk({ ...crossroads, bans: [["W>C", "C>E"]] });
    expect(pathOf(graph, route(graph, at.W, at.E).nodeIds)).toBe("W>C>N>E");
    expect(pathOf(graph, route(graph, at.S, at.E).nodeIds)).toBe("S>C>E");
  });

  it("applies a ban only to the approach the relation names", () => {
    const graph = viaDisk({ ...crossroads, bans: [["W>C", "C>N"]] });
    expect(pathOf(graph, route(graph, at.S, at.N).nodeIds)).toBe("S>C>N");
    expect(pathOf(graph, route(graph, at.E, at.N).nodeIds)).toBe("E>N");
  });

  it("obeys no_u_turn at a dual-carriageway crossover", () => {
    // Two one-way carriageways joined by a crossover J1-J2 and a link at the
    // far end. Turning around at the crossover is the short way back west.
    //   W1 >--- J1 >--- E1
    //           ||       |
    //   W2 <--- J2 <--- E2
    const divided: GraphSpec = {
      nodes: { W1: [0, 0], J1: [0, 0.001], E1: [0, 0.003], E2: [-0.0002, 0.003], J2: [-0.0002, 0.001], W2: [-0.0002, 0] },
      roads: ["W1>J1", "J1>E1", "E1>E2", "E2>J2", "J2>W2", "J1-J2"],
    };
    const open = viaDisk(divided);
    expect(pathOf(open, route(open, { lat: 0, lng: 0 }, { lat: -0.0002, lng: 0 }).nodeIds)).toBe("W1>J1>J2>W2");

    const banned = viaDisk({ ...divided, bans: [["W1>J1", "J1>J2"]] });
    expect(pathOf(banned, route(banned, { lat: 0, lng: 0 }, { lat: -0.0002, lng: 0 }).nodeIds)).toBe("W1>J1>E1>E2>J2>W2");
  });

  it("reports NO_ROUTE when the banned turn was the only continuation", () => {
    const graph = viaDisk({
      nodes: { W: [0.001, 0], C: [0.001, 0.001], N: [0.002, 0.001] },
      roads: ["W>C", "C>N"],
      bans: [["W>C", "C>N"]],
    });
    // Asked to be told plainly: no road a little further off instead.
    expect(() => route(graph, at.W, at.N, "fastest", { finishOnANearbyRoad: false })).toThrow(/No car route/);
  });
});

describe("only_* turn restrictions", () => {
  it("only_straight_on forces the through movement and blocks the others", () => {
    const graph = viaDisk(onlyTurn("W>C", "C>E"));
    expect(pathOf(graph, route(graph, at.W, at.E).nodeIds)).toBe("W>C>E");
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>E>N");
    // S is still reachable, but only after leaving the junction and returning
    // along an approach the relation does not constrain.
    expect(pathOf(graph, route(graph, at.W, at.S).nodeIds)).toBe("W>C>E>C>S");
  });

  it("only_left_turn forces the turn to N", () => {
    const graph = viaDisk(onlyTurn("W>C", "C>N"));
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>N");
    expect(pathOf(graph, route(graph, at.W, at.E).nodeIds)).toBe("W>C>N>E");
    expect(pathOf(graph, route(graph, at.W, at.S).nodeIds)).toBe("W>C>N>C>S");
  });

  it("only_right_turn forces the turn to S, banning even the u-turn back to W", () => {
    const graph = viaDisk(onlyTurn("W>C", "C>S"));
    expect(pathOf(graph, route(graph, at.W, at.S).nodeIds)).toBe("W>C>S");
    expect(pathOf(graph, route(graph, at.W, at.N).nodeIds)).toBe("W>C>S>C>N");
    // Every first departure from C other than C>S is banned, so a route that
    // leaves the junction straight away is never returned.
    expect(route(graph, at.W, at.E).nodeIds.slice(0, 3)).toEqual([graph.nodeIndex.W, graph.nodeIndex.C, graph.nodeIndex.S]);
  });

  it("leaves other approaches to the same junction free", () => {
    const graph = viaDisk(onlyTurn("W>C", "C>S"));
    expect(pathOf(graph, route(graph, at.E, at.N).nodeIds)).toBe("E>N");
    expect(pathOf(graph, route(graph, at.S, at.N).nodeIds)).toBe("S>C>N");
  });
});

describe("EFR2 round trip", () => {
  it("writes the packed layout by default and the older one on request", () => {
    const shapes = { "W>C": [[0.001, 0.0005]] as [number, number][] };
    const built = compactGraph(buildGraph({ ...crossroads, shapes, bans: [["W>C", "C>N"]] }));
    expect(new DataView(encodeCompactGraph(built)).getUint16(4, true)).toBe(6);

    const legacy = (spec: GraphSpec) => encodeCompactGraph(compactGraph(buildGraph(spec)), { layout: "legacy" });
    expect(new DataView(legacy(crossroads)).getUint16(4, true)).toBe(2);
    expect(new DataView(legacy({ ...crossroads, shapes })).getUint16(4, true)).toBe(3);
    const banned = legacy({ ...crossroads, shapes, bans: [["W>C", "C>N"]] });
    expect(new DataView(banned).getUint16(4, true)).toBe(4);
    expect(new DataView(banned).getUint32(28, true)).toBe(1);
    // A banned pair costs exactly two Uint32 values on top of the v3 chunk.
    expect(banned.byteLength).toBe(legacy({ ...crossroads, shapes }).byteLength + 8);
  });

  it("packs a graph smaller than the older layout did", () => {
    const built = compactGraph(buildGraph({ ...crossroads, shapes: { "W>C": [[0.001, 0.0005]] as [number, number][] } }));
    expect(encodeCompactGraph(built).byteLength).toBeLessThan(encodeCompactGraph(built, { layout: "legacy" }).byteLength);
  });

  it("reads back every layout it can write", () => {
    const built = compactGraph(buildGraph({ ...crossroads, shapes: { "W>C": [[0.001, 0.0005]] as [number, number][] }, bans: [["W>C", "C>N"]] }));
    for (const layout of ["packed", "legacy"] as const) {
      const decoded = decodeGraph(encodeCompactGraph(built, { layout }));
      expect(decoded.turnRestrictionFromEdges).toEqual(built.turnRestrictionFromEdges);
      expect(decoded.edgeShapeLatitudes).toEqual(built.edgeShapeLatitudes);
      expect(decoded.edgeTargets).toEqual(built.edgeTargets);
      expect(decoded.edgeOffsets).toEqual(built.edgeOffsets);
    }
  });

  it("decodes the same banned pairs it encoded", () => {
    const built = buildGraph({ ...crossroads, bans: [["W>C", "C>N"], ["W>C", "C>S"], ["E>C", "C>W"]] });
    const decoded = decodeGraph(encodeCompactGraph(compactGraph(built)));
    expect(decoded.turnRestrictionFromEdges).toEqual(built.turnRestrictionFromEdges);
    expect(decoded.turnRestrictionToEdges).toEqual(built.turnRestrictionToEdges);
    expect(decoded.turnRestrictionFromEdges).toHaveLength(3);
  });

  it("rejects a restriction that points outside the graph", () => {
    const built = compactGraph(buildGraph(crossroads));
    built.turnRestrictionFromEdges = new Uint32Array([0]);
    built.turnRestrictionToEdges = new Uint32Array([999]);
    expect(() => encodeCompactGraph(built)).toThrow(/outside the graph/);
  });

  it("keeps reading chunks that carry no restrictions", () => {
    const built = buildGraph(crossroads);
    const decoded = decodeGraph(encodeCompactGraph(compactGraph(built)));
    expect(decoded.turnRestrictionFromEdges).toBeUndefined();
    expect(pathOf({ ...decoded, ...built }, route(decoded, at.W, at.N).nodeIds)).toBe("W>C>N");
  });
});

describe("route results expose the edges they traversed", () => {
  it("returns one edge per hop, joining consecutive nodes", () => {
    const graph = viaDisk(crossroads);
    const result = route(graph, at.W, at.N);
    expect(result.edgeIds).toHaveLength(result.nodeIds.length - 1);
    for (let hop = 0; hop < result.edgeIds.length; hop += 1) {
      expect(graph.edgeTargets[result.edgeIds[hop]]).toBe(result.nodeIds[hop + 1]);
    }
  });

  it("never traverses a banned pair of consecutive edges", () => {
    const graph = viaDisk({ ...crossroads, bans: [["W>C", "C>S"]] });
    const banned = new Set([...graph.turnRestrictionFromEdges!].map((from, index) => `${from}:${graph.turnRestrictionToEdges![index]}`));
    for (const destination of [at.N, at.S, at.E, at.C]) {
      const { edgeIds } = route(graph, at.W, destination);
      for (let hop = 1; hop < edgeIds.length; hop += 1) expect(banned.has(`${edgeIds[hop - 1]}:${edgeIds[hop]}`)).toBe(false);
    }
  });
});
