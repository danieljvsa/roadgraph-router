import { combineProfiledGraph, decodeGraph, decodeProfileChunk, decodeSharedGraph, encodeCompactGraph, encodeProfileChunk, encodeSharedGraph } from "./codec";
import { accessMaskFor, edgeAllowed } from "./access";
import { compactGraph } from "./compact";
import { route } from "./router";
import { ProfileId } from "./routing-profile";
import { buildGraph, pathOf } from "./test-support";
import { RouterError } from "./types";

/** A motorway and a slower parallel road, so a profile banned from one still has a way through. */
const network = () => buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.98], C: [41.0, -7.96], D: [41.004, -7.98] },
  roads: ["A-B", "B-C", "A-D", "D-C"],
  speedsKph: { "A-B": 120, "B-C": 120, "A-D": 40, "D-C": 40 },
});

const split = (graph = compactGraph(network())) => {
  const shared = encodeSharedGraph(graph);
  const profile = encodeProfileChunk({
    profileId: ProfileId.car,
    maxSpeedKph: 150,
    edgeDurationScale: graph.edgeDurationScale ?? 1,
    edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
  });
  return { graph, shared, profile };
};

describe("the shared and profile chunks", () => {
  it("rebuild the graph the single-chunk layout holds", () => {
    const { graph, shared, profile } = split();
    const rebuilt = combineProfiledGraph(decodeSharedGraph(shared), decodeProfileChunk(profile));
    const whole = decodeGraph(encodeCompactGraph(graph));
    expect(rebuilt.nodeLatitudes).toEqual(whole.nodeLatitudes);
    expect(rebuilt.edgeTargets).toEqual(whole.edgeTargets);
    expect(rebuilt.edgeDistancesMeters).toEqual(whole.edgeDistancesMeters);
    expect(rebuilt.edgeDurationsSeconds).toEqual(whole.edgeDurationsSeconds);
    expect(rebuilt.edgeShapeOffsets).toEqual(whole.edgeShapeOffsets);
  });

  it("leaves the vehicle-dependent part as the small half", () => {
    const { shared, profile } = split();
    // Durations are one per-edge column out of everything a tile holds, so the
    // profile chunk should be a fraction of the shared one.
    expect(profile.byteLength).toBeLessThan(shared.byteLength);
  });

  it("routes over a rebuilt graph exactly as over a whole one", () => {
    const built = network();
    const { graph, shared, profile } = split(compactGraph(built));
    const rebuilt = combineProfiledGraph(decodeSharedGraph(shared), decodeProfileChunk(profile));
    const direct = route(decodeGraph(encodeCompactGraph(graph)), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    const viaChunks = route(rebuilt, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    expect(pathOf(built, viaChunks.nodeIds)).toBe(pathOf(built, direct.nodeIds));
    expect(viaChunks.durationSeconds).toBeCloseTo(direct.durationSeconds, 6);
  });

  it("carries the profile and its ceiling on the rebuilt graph", () => {
    const { shared, profile } = split();
    const rebuilt = combineProfiledGraph(decodeSharedGraph(shared), decodeProfileChunk(profile));
    expect(rebuilt.profileId).toBe(ProfileId.car);
    expect(rebuilt.maxSpeedKph).toBe(150);
  });

  it("refuses a profile chunk that belongs to a different tile", () => {
    const { shared } = split();
    const other = encodeProfileChunk({
      profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1,
      edgeDurationsSeconds: new Uint16Array(3),
    });
    expect(() => combineProfiledGraph(decodeSharedGraph(shared), decodeProfileChunk(other))).toThrow(/does not match/i);
  });

  it("refuses to route either half on its own", () => {
    const { shared, profile } = split();
    expect(() => decodeGraph(shared)).toThrow(/several profiles/i);
    expect(() => decodeGraph(profile)).toThrow(/profile chunk/i);
  });

  it("refuses a truncated or mislabelled chunk", () => {
    const { shared, profile } = split();
    expect(() => decodeProfileChunk(shared)).toThrow(/Unsupported routing profile chunk/i);
    expect(() => decodeSharedGraph(profile)).toThrow(/Unsupported shared routing graph/i);
    expect(() => decodeProfileChunk(profile.slice(0, profile.byteLength - 2))).toThrow(/Truncated/i);
  });

  it("writes a chunk for any profile this build implements", () => {
    const columns = { profileId: ProfileId.truck, maxSpeedKph: 90, edgeDurationScale: 1, edgeDurationsSeconds: new Uint16Array(4) };
    expect(decodeProfileChunk(encodeProfileChunk(columns))).toMatchObject({ profileId: ProfileId.truck, maxSpeedKph: 90 });
  });

  it("refuses a profile chunk naming a profile this build cannot route", () => {
    expect(() => encodeProfileChunk({ profileId: ProfileId.bicycle, maxSpeedKph: 25, edgeDurationScale: 1, edgeDurationsSeconds: new Uint16Array(4) })).toThrow(/unsupported profile/i);
  });
});

describe("the per-profile access mask", () => {
  const built = network();
  const graph = compactGraph(built);
  const edges = graph.edgeTargets.length;

  /** Bans both directions of the fast A-B-C pair, leaving only the slow detour. */
  const banFastRoad = () => {
    const names = built.nodeNames;
    const blocked = new Set(["A>B", "B>A", "B>C", "C>B"]);
    return accessMaskFor(edges, (edge) => {
      let source = 0;
      while (graph.edgeOffsets[source + 1] <= edge) source += 1;
      return !blocked.has(`${names[source]}>${names[graph.edgeTargets[edge]]}`);
    });
  };

  const withMask = (mask: Uint8Array) => combineProfiledGraph(
    decodeSharedGraph(encodeSharedGraph(graph)),
    decodeProfileChunk(encodeProfileChunk({
      profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: graph.edgeDurationScale ?? 1,
      edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array, edgeAccess: mask,
    })),
  );

  it("survives a round trip and keeps the banned edges banned", () => {
    const rebuilt = withMask(banFastRoad());
    expect(rebuilt.edgeAccess).toBeDefined();
    let banned = 0;
    for (let edge = 0; edge < edges; edge += 1) if (!edgeAllowed(rebuilt.edgeAccess, edge)) banned += 1;
    expect(banned).toBe(4);
  });

  it("sends the route the long way round rather than over a banned road", () => {
    const open = route(withMask(accessMaskFor(edges, () => true)), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    const restricted = route(withMask(banFastRoad()), { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    expect(pathOf(built, open.nodeIds)).toBe("A>B>C");
    expect(pathOf(built, restricted.nodeIds)).toBe("A>D>C");
    expect(restricted.durationSeconds).toBeGreaterThan(open.durationSeconds);
  });

  it("is left out when it bans nothing", () => {
    const rebuilt = withMask(accessMaskFor(edges, () => true));
    expect(rebuilt.edgeAccess).toBeUndefined();
  });

  it("reports no route when every road out is banned for this profile", () => {
    const sealed = withMask(accessMaskFor(edges, () => false));
    expect(() => route(sealed, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 })).toThrow(RouterError);
  });
});
