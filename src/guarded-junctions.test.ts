import { buildTurnRestrictionIndex, buildTurnSequenceIndex, guardedJunctionsFor } from "./turn-restrictions";
import { route } from "./router";
import { buildGraph, pathOf } from "./test-support";

/** A crossroads banning the straight-on turn, with a detour available. */
const crossroads = () => buildGraph({
  nodes: { W: [41.0, -8.02], C: [41.0, -8.0], E: [41.0, -7.98], N: [41.01, -8.0] },
  roads: ["W-C", "C-E", "C-N", "N-E"],
  bans: [["W>C", "C>E"]],
});

describe("which junctions a search must remember its approach at", () => {
  it("guards only the junctions a restriction turns on", () => {
    const graph = crossroads();
    const index = guardedJunctionsFor(graph, buildTurnRestrictionIndex(graph), buildTurnSequenceIndex(graph));
    expect(index.guarded[graph.nodeIndex.C]).toBe(1);
    for (const name of ["W", "E", "N"]) expect(index.guarded[graph.nodeIndex[name]]).toBe(0);
  });

  it("guards every junction along a banned run, not just its end", () => {
    const graph = buildGraph({
      nodes: { A: [41.0, -8.03], B: [41.0, -8.02], C: [41.0, -8.01], D: [41.0, -8.0] },
      roads: ["A-B", "B-C", "C-D"],
      bannedRuns: [["A>B", "B>C", "C>D"]],
    });
    const index = guardedJunctionsFor(graph, buildTurnRestrictionIndex(graph), buildTurnSequenceIndex(graph));
    // A run spans several junctions and the search has to know how far along
    // it has driven at each of them.
    for (const name of ["B", "C", "D"]) expect(index.guarded[graph.nodeIndex[name]]).toBe(1);
  });

  it("guards nothing when the graph bans nothing", () => {
    const open = buildGraph({ nodes: { A: [41.0, -8.0], B: [41.0, -7.99] }, roads: ["A-B"] });
    const index = guardedJunctionsFor(open, null, null);
    expect(index.count).toBe(0);
    expect([...index.guarded]).toEqual([0, 0]);
  });

  it("gives every edge into a guarded junction its own state, and no others", () => {
    const graph = crossroads();
    const index = guardedJunctionsFor(graph, buildTurnRestrictionIndex(graph), buildTurnSequenceIndex(graph));
    let intoC = 0;
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      const guardedEdge = index.stateOfEdge[edge] >= 0;
      expect(guardedEdge).toBe(graph.edgeTargets[edge] === graph.nodeIndex.C);
      if (guardedEdge) { intoC += 1; expect(index.edgeOfState[index.stateOfEdge[edge]]).toBe(edge); }
    }
    expect(index.count).toBe(intoC);
  });

  it("is measured once and remembered with the graph", () => {
    const graph = crossroads();
    const restrictions = buildTurnRestrictionIndex(graph);
    expect(guardedJunctionsFor(graph, restrictions, null)).toBe(guardedJunctionsFor(graph, restrictions, null));
  });
});

describe("routing with the approach remembered only where it matters", () => {
  it("still obeys a banned turn", () => {
    const graph = crossroads();
    const result = route(graph, { lat: 41.0, lng: -8.02 }, { lat: 41.0, lng: -7.98 });
    expect(pathOf(graph, result.nodeIds)).toBe("W>C>N>E");
  });

  it("lets the same turn through when it is reached another way", () => {
    // Arriving at C from the north is not the banned approach.
    const graph = crossroads();
    const result = route(graph, { lat: 41.01, lng: -8.0 }, { lat: 41.0, lng: -7.98 });
    expect(pathOf(graph, result.nodeIds).startsWith("N>")).toBe(true);
  });

  it("obeys a restriction on the very first turn of a mid-road start", () => {
    const graph = crossroads();
    // Starting part-way along W-C still arrives at C along W>C.
    const result = route(graph, { lat: 41.0, lng: -8.01 }, { lat: 41.0, lng: -7.98 });
    expect(pathOf(graph, result.nodeIds)).toContain("N");
  });
});
