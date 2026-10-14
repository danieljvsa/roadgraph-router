import { buildTurnRestrictionIndex, buildTurnSequenceIndex, isTurnBanned } from "./turn-restrictions";
import { combineProfiledGraph, decodeProfileChunk, decodeSharedGraph, encodeProfileChunk, encodeSharedGraph } from "./codec";
import { accessMaskFor } from "./access";
import { compactGraph } from "./compact";
import { route } from "./router";
import { ProfileId } from "./routing-profile";
import { buildGraph, pathOf } from "./test-support";

/** A crossroads where the straight-on turn is banned, with a way round. */
const junction = () => buildGraph({
  nodes: { W: [41.0, -8.02], C: [41.0, -8.0], E: [41.0, -7.98], N: [41.01, -8.0], S: [40.99, -8.0] },
  roads: ["W-C", "C-E", "C-N", "N-E", "C-S"],
  bans: [["W>C", "C>E"]],
});

const chunkFor = (graph: ReturnType<typeof compactGraph>, obeys: boolean, restrictions: number) => ({
  profileId: ProfileId.car,
  maxSpeedKph: 150,
  edgeDurationScale: graph.edgeDurationScale ?? 1,
  edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
  restrictionCount: restrictions,
  restrictionMask: accessMaskFor(restrictions, () => obeys),
});

describe("the per-vehicle restriction mask", () => {
  const built = junction();
  const graph = compactGraph(built);
  const restrictions = graph.turnRestrictionFromEdges!.length;

  const rebuild = (obeys: boolean) => combineProfiledGraph(
    decodeSharedGraph(encodeSharedGraph(graph)),
    decodeProfileChunk(encodeProfileChunk(chunkFor(graph, obeys, restrictions))),
  );

  it("has something to mask", () => {
    expect(restrictions).toBeGreaterThan(0);
  });

  it("keeps the ban for a vehicle that obeys it", () => {
    const obeying = rebuild(true);
    expect(obeying.restrictionMask).toBeUndefined(); // all bits set, so not stored
    const index = buildTurnRestrictionIndex(obeying)!;
    expect(index).not.toBeNull();
    const result = route(obeying, { lat: 41.0, lng: -8.02 }, { lat: 41.0, lng: -7.98 });
    expect(pathOf(built, result.nodeIds)).toBe("W>C>N>E");
  });

  it("lifts the ban for a vehicle the restriction excepts", () => {
    const exempt = rebuild(false);
    expect(exempt.restrictionMask).toBeDefined();
    expect(buildTurnRestrictionIndex(exempt)).toBeNull();
    const result = route(exempt, { lat: 41.0, lng: -8.02 }, { lat: 41.0, lng: -7.98 });
    expect(pathOf(built, result.nodeIds)).toBe("W>C>E");
  });

  it("can lift one restriction and keep another", () => {
    const first = graph.turnRestrictionFromEdges![0];
    const chunk = { ...chunkFor(graph, true, restrictions), restrictionMask: accessMaskFor(restrictions, (index) => index !== 0) };
    const rebuilt = combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk(chunk)));
    const index = buildTurnRestrictionIndex(rebuilt);
    expect(index?.get(first)?.has(graph.turnRestrictionToEdges![0])).not.toBe(true);
  });

  it("refuses a mask that does not cover every restriction", () => {
    expect(() => encodeProfileChunk({ ...chunkFor(graph, false, restrictions), restrictionMask: new Uint8Array(99) }))
      .toThrow(/restriction mask/i);
  });
});

describe("banned sequences under a mask", () => {
  const built = buildGraph({
    nodes: { A: [41.0, -8.03], B: [41.0, -8.02], C: [41.0, -8.01], D: [41.0, -8.0], E: [41.005, -8.01] },
    roads: ["A-B", "B-C", "C-D", "B-E", "E-D"],
    bannedRuns: [["A>B", "B>C", "C>D"]],
  });
  const graph = compactGraph(built);

  it("drops a run the vehicle is excepted from", () => {
    const pairs = graph.turnRestrictionFromEdges?.length ?? 0;
    const runs = (graph.turnRestrictionSequenceOffsets?.length ?? 1) - 1;
    const total = pairs + runs;
    expect(runs).toBeGreaterThan(0);
    const lifted = combineProfiledGraph(decodeSharedGraph(encodeSharedGraph(graph)), decodeProfileChunk(encodeProfileChunk({
      profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: graph.edgeDurationScale ?? 1,
      edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
      restrictionCount: total, restrictionMask: accessMaskFor(total, (index) => index < pairs),
    })));
    expect(buildTurnSequenceIndex(lifted)).toBeNull();
    expect(pathOf(built, route(lifted, { lat: 41.0, lng: -8.03 }, { lat: 41.0, lng: -8.0 }).nodeIds)).toBe("A>B>C>D");
  });
});
