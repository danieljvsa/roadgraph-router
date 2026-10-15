import { packEdgeConditions, ConditionKind, countClosedAt, conditionsOf } from "./conditional";
import { decodeProfileChunk, encodeProfileChunk } from "./codec";
import { compactGraph } from "./compact";
import { route } from "./router";
import { mergeRoadGraphs } from "./merge";
import { buildGraph, pathOf } from "./test-support";
import type { RoadGraph } from "./types";

/** The index of the directed edge running from one named node to another. */
function edgeFrom(graph: ReturnType<typeof buildGraph>, from: string, to: string) {
  const start = graph.nodeIndex[from];
  const target = graph.nodeIndex[to];
  for (let edge = graph.edgeOffsets[start]; edge < graph.edgeOffsets[start + 1]; edge += 1) {
    if (graph.edgeTargets[edge] === target) return edge;
  }
  throw new Error(`No edge ${from}>${to}`);
}

/**
 * A short straight road through B, and a longer way round through D. Closing
 * the straight one at certain hours should push the route onto the detour and
 * nowhere else.
 */
function townWithADetour() {
  const graph = buildGraph({
    nodes: { A: [41.0, -8.0], B: [41.0, -7.99], C: [41.0, -7.98], D: [41.01, -7.99] },
    roads: ["A-B", "B-C", "A-D", "D-C"],
    speedsKph: { "A-B": 50, "B-C": 50, "A-D": 50, "D-C": 50 },
  });
  return graph;
}

const CLOSED_IN_WORKING_HOURS = "no @ (Mo-Fr 07:00-19:00)";
const mondayMorning = new Date(2026, 9, 12, 8, 0);
const sundayMorning = new Date(2026, 9, 18, 8, 0);

function graphWithClosure(value = CLOSED_IN_WORKING_HOURS): RoadGraph & { nodeNames: string[]; nodeIndex: Record<string, number> } {
  const built = townWithADetour();
  // Both directions of the road through B, as a closure applies to the way.
  const edges = [edgeFrom(built, "B", "C"), edgeFrom(built, "C", "B")].sort((a, b) => a - b);
  return {
    ...built,
    edgeConditions: packEdgeConditions(edges.map((edge) => ({ edge, kind: ConditionKind.access, value }))),
  };
}

describe("routing around a road closed at this hour", () => {
  const graph = graphWithClosure();
  const from = { lat: 41.0, lng: -8.0 };
  const to = { lat: 41.0, lng: -7.98 };

  it("takes the short way when no departure time is given", () => {
    expect(pathOf(graph as never, route(graph, from, to).nodeIds)).toBe("A>B>C");
  });

  it("takes the detour when the road is shut", () => {
    const result = route(graph, from, to, "fastest", { departAt: mondayMorning });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>D>C");
  });

  it("takes the short way again on a Sunday", () => {
    const result = route(graph, from, to, "fastest", { departAt: sundayMorning });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>B>C");
  });

  it("takes the short way again after the ban lifts", () => {
    const result = route(graph, from, to, "fastest", { departAt: new Date(2026, 9, 12, 20, 0) });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>B>C");
  });

  it("answers the same from a travel time as from a date", () => {
    const result = route(graph, from, to, "fastest", { departAt: { weekday: 0, minutes: 8 * 60, month: 10 } });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>D>C");
  });

  it("obeys the closure when routing for distance too", () => {
    const result = route(graph, from, to, "shortest", { departAt: mondayMorning });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>D>C");
  });

  it("counts the roads the hour closes", () => {
    const parsed = conditionsOf(graph);
    expect(countClosedAt(graph, parsed, { weekday: 0, minutes: 8 * 60, month: 10 })).toBe(2);
    expect(countClosedAt(graph, parsed, { weekday: 6, minutes: 8 * 60, month: 10 })).toBe(0);
  });
});

describe("a value this library cannot act on", () => {
  it("leaves the road open rather than guessing at the weather", () => {
    const graph = graphWithClosure("no @ (wet)");
    const result = route(graph, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.98 }, "fastest", { departAt: mondayMorning });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>B>C");
  });

  it("treats a residents-only hour as closed, having no notion of who is driving", () => {
    const graph = graphWithClosure("destination @ (Mo-Fr 07:00-19:00)");
    const result = route(graph, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.98 }, "fastest", { departAt: mondayMorning });
    expect(pathOf(graph as never, result.nodeIds)).toBe("A>D>C");
  });
});

describe("a conditional speed limit", () => {
  const built = townWithADetour();
  const slowAtNight = {
    ...built,
    edgeConditions: packEdgeConditions([edgeFrom(built, "A", "B"), edgeFrom(built, "B", "A")].sort((a, b) => a - b)
      .map((edge) => ({ edge, kind: ConditionKind.maxspeed, value: "20 @ (22:00-06:00)" }))),
  };
  const from = { lat: 41.0, lng: -8.0 };
  const to = { lat: 41.0, lng: -7.99 };

  it("slows the road while it applies", () => {
    const byDay = route(slowAtNight, from, to, "fastest", { departAt: new Date(2026, 9, 12, 12, 0) });
    const byNight = route(slowAtNight, from, to, "fastest", { departAt: new Date(2026, 9, 12, 23, 0) });
    expect(byNight.durationSeconds).toBeGreaterThan(byDay.durationSeconds * 2);
    expect(byNight.distanceMeters).toBeCloseTo(byDay.distanceMeters, 0);
  });

  it("never makes a road quicker than the graph says", () => {
    const quick = {
      ...built,
      edgeConditions: packEdgeConditions([{ edge: edgeFrom(built, "A", "B"), kind: ConditionKind.maxspeed, value: "200 @ (06:00-22:00)" }]),
    };
    const plain = route(built, from, to, "fastest");
    const raised = route(quick, from, to, "fastest", { departAt: new Date(2026, 9, 12, 12, 0) });
    expect(raised.durationSeconds).toBeCloseTo(plain.durationSeconds, 5);
  });
});

describe("carrying conditions through a profile chunk", () => {
  const compacted = compactGraph(townWithADetour());
  const conditions = packEdgeConditions([
    { edge: 0, kind: ConditionKind.access, value: CLOSED_IN_WORKING_HOURS },
    { edge: 0, kind: ConditionKind.maxspeed, value: "30 @ (Mo-Fr 08:00-09:00)" },
    { edge: 2, kind: ConditionKind.access, value: CLOSED_IN_WORKING_HOURS },
  ])!;

  it("round-trips through the format", () => {
    const decoded = decodeProfileChunk(encodeProfileChunk({
      profileId: 1,
      maxSpeedKph: 130,
      edgeDurationScale: 1,
      edgeDurationsSeconds: Uint16Array.from(compacted.edgeDurationsSeconds),
      edgeConditions: conditions,
    }));
    expect(decoded.edgeConditions?.values).toEqual([CLOSED_IN_WORKING_HOURS, "30 @ (Mo-Fr 08:00-09:00)"]);
    expect([...decoded.edgeConditions!.edges]).toEqual([0, 0, 2]);
    expect([...decoded.edgeConditions!.kinds]).toEqual([ConditionKind.access, ConditionKind.maxspeed, ConditionKind.access]);
    expect([...decoded.edgeConditions!.rules]).toEqual([0, 1, 0]);
  });

  it("writes the same bytes as before when no road carries one", () => {
    const chunk = {
      profileId: 1,
      maxSpeedKph: 130,
      edgeDurationScale: 1,
      edgeDurationsSeconds: Uint16Array.from(compacted.edgeDurationsSeconds),
    };
    expect(encodeProfileChunk(chunk).byteLength).toBe(encodeProfileChunk({ ...chunk, edgeConditions: undefined }).byteLength);
  });

  it("stores one copy of a value however many roads share it", () => {
    expect(conditions.values).toHaveLength(2);
    expect(conditions.edges).toHaveLength(3);
  });

  it("refuses a condition naming an edge the graph does not have", () => {
    expect(() => encodeProfileChunk({
      profileId: 1,
      maxSpeedKph: 130,
      edgeDurationScale: 1,
      edgeDurationsSeconds: Uint16Array.from(compacted.edgeDurationsSeconds),
      edgeConditions: packEdgeConditions([{ edge: 9999, kind: ConditionKind.access, value: CLOSED_IN_WORKING_HOURS }]),
    })).toThrow(/outside the graph/);
  });
});

describe("conditions crossing a tile boundary", () => {
  const westTile = {
    nodeLatitudes: new Float64Array([37, 37]), nodeLongitudes: new Float64Array([-8, -7.9]),
    edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]),
    edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
    edgeConditions: packEdgeConditions([{ edge: 0, kind: ConditionKind.access, value: CLOSED_IN_WORKING_HOURS }]),
  };
  const eastTile = {
    nodeLatitudes: new Float64Array([37, 37]), nodeLongitudes: new Float64Array([-7.9, -7.8]),
    edgeOffsets: new Uint32Array([0, 1, 1]), edgeTargets: new Uint32Array([1]),
    edgeDistancesMeters: new Float32Array([100]), edgeDurationsSeconds: new Float32Array([10]),
    edgeConditions: packEdgeConditions([{ edge: 0, kind: ConditionKind.access, value: "no @ (Sa,Su)" }]),
  };

  it("keeps what each tile said, rebased onto the merged edges", () => {
    const merged = mergeRoadGraphs([westTile, eastTile]);
    expect(merged.edgeConditions?.values.sort()).toEqual([CLOSED_IN_WORKING_HOURS, "no @ (Sa,Su)"].sort());
    expect(merged.edgeConditions?.edges).toHaveLength(2);
    expect(merged.edgeConditions!.edges[0]).not.toBe(merged.edgeConditions!.edges[1]);
  });

  it("closes the road the hour closes and leaves the other open", () => {
    const merged = mergeRoadGraphs([westTile, eastTile]);
    const parsed = conditionsOf(merged);
    expect(countClosedAt(merged, parsed, { weekday: 0, minutes: 8 * 60, month: 3 })).toBe(1);
    expect(countClosedAt(merged, parsed, { weekday: 5, minutes: 8 * 60, month: 3 })).toBe(1);
    expect(countClosedAt(merged, parsed, { weekday: 0, minutes: 22 * 60, month: 3 })).toBe(0);
  });

  it("stops a route that has to cross a shut road", () => {
    const merged = mergeRoadGraphs([westTile, eastTile]);
    const ends = [{ lat: 37, lng: -8 }, { lat: 37, lng: -7.8 }] as const;
    expect(route(merged, ends[0], ends[1]).distanceMeters).toBe(200);
    expect(() => route(merged, ends[0], ends[1], "fastest", { departAt: mondayMorning })).toThrow();
  });

  it("keeps one copy when overlapping tiles both describe the same road", () => {
    const sameRoadTwice = mergeRoadGraphs([westTile, { ...westTile }]);
    expect(sameRoadTwice.edgeConditions?.edges).toHaveLength(1);
  });
});
