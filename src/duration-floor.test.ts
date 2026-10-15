import { compactGraph } from "./compact";
import { searchBoundsFor, straightLineAtMost } from "./search-bounds";
import { haversineMeters } from "./snap";
import { buildGraph } from "./test-support";
import type { RoadGraph } from "./types";

describe("quantising a short edge's duration", () => {
  it("never leaves an edge costing nothing to travel", () => {
    // Two nodes a few metres apart: at any sane speed the duration rounds to
    // zero, and a free edge is a shortcut the search will always take.
    const tiny = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.99995] },
      roads: ["A-B"],
      speedsKph: { "A-B": 120 },
    });
    const compacted = compactGraph(tiny);
    expect(compacted.edgeDistancesMeters.length).toBeGreaterThan(0);
    for (let edge = 0; edge < compacted.edgeDurationsSeconds.length; edge += 1) {
      expect(compacted.edgeDurationsSeconds[edge]).toBeGreaterThan(0);
    }
  });

  it("leaves an edge long enough to round normally alone", () => {
    const ordinary = compactGraph(buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.95] },
      roads: ["A-B"],
      speedsKph: { "A-B": 50 },
    }));
    expect(ordinary.edgeDurationsSeconds[0]).toBeGreaterThan(100);
  });
});

describe("the bounds a search measures from a graph", () => {
  const graph = compactGraph(buildGraph({
    nodes: { A: [41.0, -8.0], B: [41.0, -7.9], C: [41.1, -7.9] },
    roads: ["A-B", "B-C"],
    speedsKph: { "A-B": 120, "B-C": 30 },
  }));

  it("covers the fastest edge the graph actually holds", () => {
    const { maxSpeedMps } = searchBoundsFor(graph);
    const distanceScale = graph.edgeDistanceScale ?? 1;
    const durationScale = graph.edgeDurationScale ?? 1;
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      const seconds = graph.edgeDurationsSeconds[edge] * durationScale;
      if (seconds <= 0) continue;
      // An edge faster than the bound would make the heuristic overestimate,
      // and A* would settle for a route that is not the best one.
      expect((graph.edgeDistancesMeters[edge] * distanceScale) / seconds).toBeLessThanOrEqual(maxSpeedMps);
    }
  });

  it("is measured once and remembered with the graph", () => {
    expect(searchBoundsFor(graph)).toBe(searchBoundsFor(graph));
  });

  it("falls back to the profile's ceiling for a graph with no edges to measure", () => {
    const empty: RoadGraph = {
      nodeLatitudes: Int32Array.from([410000000]), nodeLongitudes: Int32Array.from([-80000000]),
      edgeOffsets: Uint32Array.from([0, 0]), edgeTargets: new Uint32Array(0),
      edgeDistancesMeters: new Uint16Array(0), edgeDurationsSeconds: new Uint16Array(0),
      coordinateScale: 10_000_000,
    };
    expect(searchBoundsFor(empty).maxSpeedMps).toBeCloseTo((150 * 1000) / 3600, 6);
  });
});

describe("the cheap straight-line estimate", () => {
  const { longitudeMetresPerDegree } = searchBoundsFor(compactGraph(buildGraph({
    nodes: { A: [36.9, -9.6], B: [42.2, -6.1] },
    roads: ["A-B"],
  })));

  it("never exceeds the great-circle distance it stands in for", () => {
    // Across the extent of a country-sized graph, in every direction.
    for (let lat = 36.9; lat <= 42.2; lat += 0.5) {
      for (let lng = -9.6; lng <= -6.1; lng += 0.5) {
        const estimate = straightLineAtMost(lat, lng, 38.7223, -9.1393, longitudeMetresPerDegree);
        const truth = haversineMeters({ lat, lng }, { lat: 38.7223, lng: -9.1393 });
        expect(estimate).toBeLessThanOrEqual(truth);
      }
    }
  });

  it("stays close enough to be worth using", () => {
    const estimate = straightLineAtMost(41.1579, -8.6291, 38.7223, -9.1393, longitudeMetresPerDegree);
    const truth = haversineMeters({ lat: 41.1579, lng: -8.6291 }, { lat: 38.7223, lng: -9.1393 });
    expect(estimate / truth).toBeGreaterThan(0.95);
  });

  it("is zero for a point on top of itself", () => {
    expect(straightLineAtMost(41, -8, 41, -8, longitudeMetresPerDegree)).toBe(0);
  });
});
