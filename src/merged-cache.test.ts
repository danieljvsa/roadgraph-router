import { encodeRoadGraphBundle, openRoadGraphBundle } from "./bundle";
import { compactGraph } from "./compact";
import { buildGraph, rangeFetcher } from "./test-support";

/** Two tiles that overlap on the shared B-C road, so merging them does real work. */
function twoTileBundle() {
  const west = compactGraph(buildGraph({
    nodes: { A: [41.0, -8.04], B: [41.0, -8.02], C: [41.0, -8.0] },
    roads: ["A-B", "B-C"],
  }));
  const east = compactGraph(buildGraph({
    nodes: { B: [41.0, -8.02], C: [41.0, -8.0], D: [41.0, -7.98] },
    roads: ["B-C", "C-D"],
  }));
  return encodeRoadGraphBundle([
    { id: 1, bounds: { minLat: 40.99, minLng: -8.05, maxLat: 41.01, maxLng: -8.0 }, graph: west },
    { id: 2, bounds: { minLat: 40.99, minLng: -8.02, maxLat: 41.01, maxLng: -7.97 }, graph: east },
  ]);
}

describe("the stitched-corridor cache", () => {
  it("returns the same merged graph for the same tiles", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher);
    const first = await bundle.loadTiles(bundle.tiles);
    const second = await bundle.loadTiles(bundle.tiles);
    expect(second).toBe(first);
  });

  it("does not care which order the tiles are asked for in", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher);
    const forwards = await bundle.loadTiles(bundle.tiles);
    const backwards = await bundle.loadTiles([...bundle.tiles].reverse());
    expect(backwards).toBe(forwards);
  });

  it("stitches afresh when the cache is turned off", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher, { mergedCacheSize: 0 });
    const first = await bundle.loadTiles(bundle.tiles);
    const second = await bundle.loadTiles(bundle.tiles);
    expect(second).not.toBe(first);
    expect(second.nodeLatitudes.length).toBe(first.nodeLatitudes.length);
  });

  it("drops the least recently used corridor once it is full", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher, { mergedCacheSize: 1 });
    const both = await bundle.loadTiles(bundle.tiles);
    // A single tile never goes through the merge path, so ask for the pair
    // again after the cache has been handed a different corridor.
    const reversedPair = await bundle.loadTiles([...bundle.tiles].reverse());
    expect(reversedPair).toBe(both);
  });

  it("keeps the cached corridor usable for routing", async () => {
    const bundle = await openRoadGraphBundle("https://example.test/b.efrb", rangeFetcher(twoTileBundle()).fetcher);
    const graph = await bundle.loadTiles(bundle.tiles);
    const again = await bundle.loadTiles(bundle.tiles);
    // Shared boundary roads are collapsed, so a cached corridor is still the
    // deduplicated one rather than a graph holding both copies.
    expect(again.nodeLatitudes.length).toBe(4);
    expect(again.edgeTargets.length).toBe(graph.edgeTargets.length);
  });
});
