import { encodeRoadGraphBundle, mergeRoadGraphs, RoadRouter, route } from "./index";
import type { BundleGraphTile } from "./bundle";
import { buildGraph, rangeFetcher, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

/** One degree of longitude per tile, so tile `n` covers [n, n + 1). */
const tileBounds = (column: number) => ({ minLat: -1, minLng: column, maxLat: 1, maxLng: column + 1 });

/**
 * A straight east-west road sampled every 0.5 degrees of longitude. Boundary
 * nodes land exactly on a tile edge, so two neighbouring tiles must agree on
 * their coordinates for the merge to stitch them.
 */
function highwayTile(column: number, options: { shapes?: boolean } = {}): BundleGraphTile {
  const names = [`n${column}a`, `n${column}b`, `n${column}c`];
  const longitudes = [column, column + 0.5, column + 1];
  const spec: GraphSpec = {
    nodes: Object.fromEntries(names.map((name, index) => [name, [0, longitudes[index]] as [number, number]])),
    roads: [`${names[0]}-${names[1]}`, `${names[1]}-${names[2]}`],
    ...(options.shapes ? {
      shapes: Object.fromEntries(names.slice(0, -1).flatMap((name, index) => [
        [`${name}>${names[index + 1]}`, [[0.01, longitudes[index] + 0.25]]],
        [`${names[index + 1]}>${name}`, [[0.01, longitudes[index] + 0.25]]],
      ])),
    } : {}),
  };
  return { id: column, bounds: tileBounds(column), graph: buildGraph(spec) };
}

describe("a long road crossing several tiles", () => {
  it("routes end to end across five tiles", async () => {
    const tiles = [0, 1, 2, 3, 4].map((column) => highwayTile(column));
    const bundle = encodeRoadGraphBundle(tiles);
    const { fetcher, stats } = rangeFetcher(bundle);
    const router = await RoadRouter.open("/routing/corridor.efrb", fetcher);

    const result = await router.route(point(0, 0), point(0, 5));
    // Every one of the 11 distinct nodes along the corridor is visited once.
    expect(result.nodeIds).toHaveLength(11);
    expect(result.geometry.coordinates[0]).toEqual([0, 0]);
    expect(result.geometry.coordinates.at(-1)).toEqual([5, 0]);
    // 5 degrees of longitude at the equator is roughly 556 km.
    expect(result.distanceMeters / 1000).toBeCloseTo(556, -1);
    // The header, the directory, and one chunk per tile in the corridor.
    expect(stats.requests).toBe(2 + tiles.length);
  });

  it("leaves out tiles that could not hold a better route", async () => {
    const tiles = [0, 1, 2, 3, 4].map((column) => highwayTile(column));
    const bundle = encodeRoadGraphBundle(tiles);
    const { fetcher, stats } = rangeFetcher(bundle);
    const router = await RoadRouter.open("/routing/corridor.efrb", fetcher);

    await router.route(point(0, 0), point(0, 2));
    // The far end of the corridor is too distant to beat the route found, so
    // it is never downloaded, and the whole bundle is never pulled.
    expect(stats.requests).toBeLessThan(2 + tiles.length);
    expect(stats.bytes).toBeLessThan(bundle.byteLength);
  });

  it("is consistent whichever direction it is driven", async () => {
    const tiles = [0, 1, 2, 3, 4].map((column) => highwayTile(column));
    const bundle = encodeRoadGraphBundle(tiles);
    const forward = await RoadRouter.open("/routing/corridor.efrb", rangeFetcher(bundle).fetcher);
    const backward = await RoadRouter.open("/routing/corridor.efrb", rangeFetcher(bundle).fetcher);
    const there = await forward.route(point(0, 0), point(0, 5));
    const back = await backward.route(point(0, 5), point(0, 0));
    expect(back.distanceMeters).toBeCloseTo(there.distanceMeters, 0);
    expect(back.geometry.coordinates).toEqual([...there.geometry.coordinates].reverse());
  });
});

describe("roads with no intersection near a tile boundary", () => {
  it("stitches two tiles that share only their boundary node", () => {
    // Each tile holds a single long edge; the only thing they have in common
    // is the node sitting exactly on the boundary at longitude 1.
    const west = buildGraph({ nodes: { W: [0, 0], M: [0, 1] }, roads: ["W-M"] });
    const east = buildGraph({ nodes: { M: [0, 1], E: [0, 2] }, roads: ["M-E"] });
    const merged = mergeRoadGraphs([west, east]);
    expect(merged.nodeLatitudes).toHaveLength(3);
    const result = route(merged, point(0, 0), point(0, 2));
    expect(result.nodeIds).toHaveLength(3);
    expect(result.distanceMeters / 1000).toBeCloseTo(222.6, 0);
  });

  it("reports no route when the boundary nodes do not line up", () => {
    // A tenth of a degree apart: close on a map, unconnected in the graph.
    const west = buildGraph({ nodes: { W: [0, 0], M: [0, 1] }, roads: ["W-M"] });
    const east = buildGraph({ nodes: { M: [0, 1.1], E: [0, 2] }, roads: ["M-E"] });
    const merged = mergeRoadGraphs([west, east]);
    expect(merged.nodeLatitudes).toHaveLength(4);
    expect(() => route(merged, point(0, 0), point(0, 2))).toThrow(/No car route/);
  });

  it("matches boundary nodes through fixed-point rounding, not float equality", () => {
    const west = buildGraph({ nodes: { W: [0, 0], M: [0.1234567, 1.7654321] }, roads: ["W-M"] });
    const east = buildGraph({ nodes: { M: [0.1234567, 1.7654321], E: [0.2, 2] }, roads: ["M-E"] });
    expect(mergeRoadGraphs([west, east]).nodeLatitudes).toHaveLength(3);
  });
});

describe("simplified road geometry across chunks", () => {
  it("keeps every shape point, in order, after tiles are merged", async () => {
    const tiles = [0, 1, 2].map((column) => highwayTile(column, { shapes: true }));
    const bundle = encodeRoadGraphBundle(tiles);
    const router = await RoadRouter.open("/routing/curved.efrb", rangeFetcher(bundle).fetcher);
    const result = await router.route(point(0, 0), point(0, 3));

    // Six directed edges, each contributing one shape point between its nodes.
    expect(result.geometry.coordinates).toEqual([
      [0, 0], [0.25, 0.01], [0.5, 0],
      [0.75, 0.01], [1, 0],
      [1.25, 0.01], [1.5, 0],
      [1.75, 0.01], [2, 0],
      [2.25, 0.01], [2.5, 0],
      [2.75, 0.01], [3, 0],
    ]);
  });

  it("keeps the merged geometry attached to the right edges", () => {
    // Two tiles whose edges land in a different CSR order once merged; the
    // shape stream must follow each edge rather than the input order.
    const west = buildGraph({
      nodes: { A: [0, 0], B: [0, 1] }, roads: ["A-B"],
      shapes: { "A>B": [[0.5, 0.5]], "B>A": [[-0.5, 0.5]] },
    });
    const east = buildGraph({
      nodes: { B: [0, 1], C: [0, 2] }, roads: ["B-C"],
      shapes: { "B>C": [[0.5, 1.5]], "C>B": [[-0.5, 1.5]] },
    });
    const merged = mergeRoadGraphs([west, east]);
    expect(route(merged, point(0, 0), point(0, 2)).geometry.coordinates)
      .toEqual([[0, 0], [0.5, 0.5], [1, 0], [1.5, 0.5], [2, 0]]);
    expect(route(merged, point(0, 2), point(0, 0)).geometry.coordinates)
      .toEqual([[2, 0], [1.5, -0.5], [1, 0], [0.5, -0.5], [0, 0]]);
  });
});

describe("merging several neighbouring tiles", () => {
  /** A 2x2 grid of tiles whose roads meet at the shared corner node at (0, 0). */
  function quadrant(id: number, latitude: number, longitude: number) {
    return {
      id,
      bounds: { minLat: Math.min(0, latitude), minLng: Math.min(0, longitude), maxLat: Math.max(0, latitude), maxLng: Math.max(0, longitude) },
      graph: buildGraph({ nodes: { O: [0, 0], P: [latitude, longitude] }, roads: ["O-P"] }),
    };
  }

  it("routes diagonally through four tiles that meet at one corner", async () => {
    const bundle = encodeRoadGraphBundle([quadrant(1, 1, 1), quadrant(2, 1, -1), quadrant(3, -1, 1), quadrant(4, -1, -1)]);
    const { fetcher, stats } = rangeFetcher(bundle);
    const router = await RoadRouter.open("/routing/quadrants.efrb", fetcher);
    const result = await router.route(point(-1, -1), point(1, 1));
    expect(result.nodeIds).toHaveLength(3);
    expect(result.geometry.coordinates).toEqual([[-1, -1], [0, 0], [1, 1]]);
    expect(stats.requests).toBe(2 + 4);
  });

  it("keeps each edge's geometry when merging reorders the edge array", () => {
    // Every tile's road starts at the shared corner O, so after merging, edges
    // from later tiles are grouped ahead of edges from earlier ones. The shape
    // stream has to follow that regrouping rather than the order tiles arrived.
    const arm = (name: string, latitude: number, longitude: number) => buildGraph({
      nodes: { O: [0, 0], [name]: [latitude, longitude] },
      roads: [`O-${name}`],
      shapes: { [`O>${name}`]: [[latitude / 2, longitude / 2]], [`${name}>O`]: [[latitude / 2, longitude / 2]] },
    });
    const merged = mergeRoadGraphs([arm("A", 1, 1), arm("B", 1, -1), arm("C", -1, 1), arm("D", -1, -1)]);
    expect(route(merged, point(1, 1), point(-1, -1)).geometry.coordinates)
      .toEqual([[1, 1], [0.5, 0.5], [0, 0], [-0.5, -0.5], [-1, -1]]);
    expect(route(merged, point(1, -1), point(-1, 1)).geometry.coordinates)
      .toEqual([[-1, 1], [-0.5, 0.5], [0, 0], [0.5, -0.5], [1, -1]]);
  });

  it("collapses the copies of a road that overlapping tiles both contain", () => {
    // Tiles overlap by design, so the same road is present in both chunks.
    const shared: GraphSpec = { nodes: { A: [0, 0], B: [0, 1], C: [0, 2] }, roads: ["A-B", "B-C"] };
    const merged = mergeRoadGraphs([buildGraph(shared), buildGraph(shared)]);
    expect(merged.nodeLatitudes).toHaveLength(3);
    expect(merged.edgeTargets).toHaveLength(4);
    expect(route(merged, point(0, 0), point(0, 2)).nodeIds).toHaveLength(3);
  });

  it("keeps parallel roads between the same pair of nodes distinct", () => {
    const direct = buildGraph({ nodes: { A: [0, 0], B: [0, 1] }, roads: ["A-B"] });
    const looping = buildGraph({ nodes: { A: [0, 0], B: [0, 1] }, roads: ["A-B"], shapes: { "A>B": [[0.5, 0.5]], "B>A": [[0.5, 0.5]] } });
    expect(mergeRoadGraphs([direct, looping]).edgeTargets).toHaveLength(4);
  });

  it("carries turn restrictions through the merge and keeps obeying them", () => {
    //  W - C - E in one tile, C - N in the next; the ban lives in the first.
    const west = buildGraph({
      nodes: { W: [0, 0], C: [0, 1], E: [0, 2] },
      roads: ["W-C", "C-E"],
      bans: [["W>C", "C>E"]],
    });
    const east = buildGraph({ nodes: { C: [0, 1], N: [1, 1], E: [0, 2] }, roads: ["C-N", "N-E"] });
    const merged = mergeRoadGraphs([west, east]);
    expect(merged.turnRestrictionFromEdges).toHaveLength(1);
    // The direct C>E hop is banned on this approach, so the detour via N is taken.
    expect(route(merged, point(0, 0), point(0, 2)).nodeIds).toHaveLength(4);
    // Coming from N, the same C>E edge is still legal.
    expect(route(merged, point(1, 1), point(0, 2)).nodeIds).toHaveLength(2);
  });

  it("keeps a restriction that only one of two overlapping tiles knows about", () => {
    const spec: GraphSpec = { nodes: { W: [0, 0], C: [0, 1], E: [0, 2], N: [1, 1] }, roads: ["W-C", "C-E", "C-N", "N-E"] };
    const withBan = buildGraph({ ...spec, bans: [["W>C", "C>E"]] });
    const withoutBan = buildGraph(spec);
    // A tile clipped short of the junction can legitimately miss the relation.
    // The union must still forbid the turn rather than offer a free copy of it.
    const merged = mergeRoadGraphs([withoutBan, withBan]);
    expect(merged.turnRestrictionFromEdges).toHaveLength(1);
    expect(route(merged, point(0, 0), point(0, 2)).nodeIds).toHaveLength(4);
  });
});
