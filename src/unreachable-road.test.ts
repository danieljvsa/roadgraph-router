import { compactGraph, decodeGraph, encodeCompactGraph, route } from "./index";
import { buildGraph, pathOf, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

function viaDisk(spec: GraphSpec) {
  const built = buildGraph(spec);
  return { ...decodeGraph(encodeCompactGraph(compactGraph(built))), nodeIndex: built.nodeIndex, nodeNames: built.nodeNames };
}

/**
 * A through road, and a side street leaving it that nothing may turn into.
 * The side street can be driven out of but never entered, which is what a
 * pocket of one-way streets behind banned turns looks like in miniature.
 */
const pocket: GraphSpec = {
  nodes: {
    A: [0, 0], B: [0, 0.001], C: [0, 0.002],
    // The side street, one-way back out onto the through road at C.
    P: [0.0004, 0.001],
  },
  roads: ["A>B", "B>C", "B>P", "P>C"],
  // The one turn into the side street, from the one road that approaches it.
  bans: [["A>B", "B>P"]],
};

describe("a destination on a road nothing can reach", () => {
  const graph = viaDisk(pocket);
  const start = point(0, 0);
  // Right beside P, so the nearest road is the one that cannot be entered.
  const inThePocket = point(0.0004, 0.00102);

  it("finishes on a road it can reach rather than refusing", () => {
    const result = route(graph, start, inThePocket);
    expect(result.distanceMeters).toBeGreaterThan(0);
    // It drives the through road and stops beside the side street it may not
    // turn into, rather than reporting that there is no route at all.
    expect(pathOf(graph, result.nodeIds)).toBe("A>B");
  });

  it("says how far short of the point it finished", () => {
    const result = route(graph, start, inThePocket);
    expect(result.destinationSnap.distanceMeters).toBeGreaterThan(20);
  });

  it("refuses outright when asked to be told plainly", () => {
    expect(() => route(graph, start, inThePocket, "fastest", { finishOnANearbyRoad: false })).toThrow(/No car route/);
  });

  it("never reaches the pocket, whichever way it answers", () => {
    const result = route(graph, start, inThePocket);
    expect(pathOf(graph, result.nodeIds)).not.toContain("P");
  });
});

describe("the road nearest the destination is reachable", () => {
  const graph = viaDisk({
    nodes: { A: [0, 0], B: [0, 0.001], C: [0, 0.002] },
    roads: ["A-B", "B-C"],
  });

  it("uses it, and finishes on the point asked for", () => {
    const result = route(graph, point(0, 0), point(0, 0.002));
    expect(pathOf(graph, result.nodeIds)).toBe("A>B>C");
    expect(result.destinationSnap.distanceMeters).toBeLessThan(1);
  });

  it("does not go looking further afield when there is no need", () => {
    // Every road here is reachable, so turning the fallback off changes nothing.
    const strict = route(graph, point(0, 0), point(0, 0.002), "fastest", { finishOnANearbyRoad: false });
    const relaxed = route(graph, point(0, 0), point(0, 0.002));
    expect(strict.distanceMeters).toBe(relaxed.distanceMeters);
  });
});

describe("a destination genuinely off the network", () => {
  const graph = viaDisk({ nodes: { A: [0, 0], B: [0, 0.001] }, roads: ["A-B"] });

  it("still reports nothing nearby rather than inventing a road", () => {
    expect(() => route(graph, point(0, 0), point(10, 10))).toThrow(/close to the destination/);
  });
});
