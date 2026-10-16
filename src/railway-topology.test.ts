/**
 * Railway topology, tested against the compiler that decides it.
 *
 * What connects to what is not a library decision: it comes out of which OSM
 * nodes two ways have in common, and that rule lives in the compiler. Testing
 * it against a reimplementation would prove nothing, so every case here writes
 * a real PBF, runs the real `roadgraph-compile`, and routes over the bundle
 * that comes out.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countRailwayBlocked, openRoadGraphBundle, route, RouterError, snapToGraph, routeAlternatives, railwayOf, ProfileId } from "./index";
import type { Coordinate, RoadGraph } from "./index";
import { rangeFetcher } from "./test-support";
import { writeOsmPbf, type PbfNode, type PbfWay } from "./test-support-pbf";

jest.setTimeout(120_000);

const workspace = mkdtempSync(join(tmpdir(), "roadgraph-rail-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const RAIL = { railway: "rail", gauge: "1668", electrified: "contact_line", voltage: "25000", frequency: "50", usage: "main" };
const compiled = new Map<string, Promise<Compiled>>();

type Compiled = { graph: RoadGraph; profiles: number[]; report: Record<string, unknown> };

/** Compiles a synthetic extract once and keeps the result for every test that asks. */
function compile(name: string, nodes: PbfNode[], ways: PbfWay[], args: string[] = ["--profile", "train"]) {
  const existing = compiled.get(name);
  if (existing) return existing;
  const made = (async () => {
    const input = join(workspace, `${name}.osm.pbf`);
    const output = join(workspace, `${name}.efrb`);
    writeFileSync(input, writeOsmPbf(nodes, ways));
    // The CLI reads the first occurrence of an option, so a default is only
    // supplied where the caller did not give one of its own.
    const defaults = ["--compression", "none", "--tile-size-km", "400"];
    const supplied: string[] = [];
    for (let index = 0; index < defaults.length; index += 2) {
      if (!args.includes(defaults[index])) supplied.push(defaults[index], defaults[index + 1]);
    }
    try {
      execFileSync(process.execPath, ["scripts/roadgraph-compile.mjs", input, "--output", output, ...args, ...supplied], { stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };
      throw new Error(`compiling ${name} failed: ${failure.stderr ?? ""}${failure.stdout ?? ""}`);
    }
    const bytes = readFileSync(output);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { fetcher } = rangeFetcher(buffer);
    const bundle = await openRoadGraphBundle(output, fetcher);
    const graph = await bundle.loadTiles(bundle.tiles);
    return { graph, profiles: bundle.profiles, report: JSON.parse(readFileSync(`${output}.json`, "utf8")) };
  })();
  compiled.set(name, made);
  return made;
}

const at = (lat: number, lon: number): Coordinate => ({ lat, lng: lon });
/** A straight line of nodes heading east, one per 0.01 degrees. */
function line(firstId: number, lat: number, startLon: number, count: number): PbfNode[] {
  return Array.from({ length: count }, (_, index) => ({ id: firstId + index, lat, lon: startLon + index * 0.01 }));
}

/** Routes without the courtesy of finishing on a nearby track: topology only. */
function strictRoute(graph: RoadGraph, from: Coordinate, to: Coordinate) {
  return route(graph, from, to, "shortest", { finishOnANearbyRoad: false });
}
function reaches(graph: RoadGraph, from: Coordinate, to: Coordinate) {
  try { strictRoute(graph, from, to); return true; } catch (error) {
    if (error instanceof RouterError) return false;
    throw error;
  }
}

describe("a junction is a shared node and nothing else", () => {
  // Two tracks meeting at node 3, which both ways name. This is the only thing
  // in OSM that makes a junction, and the compiler honours exactly it.
  it("joins two tracks that share a node", async () => {
    const { graph } = await compile("junction", [
      ...line(1, 41.0, -8.60, 3),
      { id: 10, lat: 41.02, lon: -8.58 },
    ], [
      { id: 100, refs: [1, 2, 3], tags: RAIL },
      { id: 101, refs: [3, 10], tags: RAIL },
    ]);
    const result = strictRoute(graph, at(41.0, -8.60), at(41.02, -8.58));
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(reaches(graph, at(41.02, -8.58), at(41.0, -8.60))).toBe(true);
  });

  // Two tracks laid across each other at the same coordinates, with no node in
  // common. On the ground that is a flyover, a tunnel, or simply two lines
  // that do not meet. Connecting them would invent a junction.
  it("does not join two tracks that merely cross on the map", async () => {
    const { graph } = await compile("crossing", [
      { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.0, lon: -8.58 },
      // Node 3 and node 4 straddle the crossing point; node 5 sits exactly on
      // it, with an id neither of the first way's nodes uses.
      { id: 3, lat: 40.99, lon: -8.59 }, { id: 4, lat: 41.01, lon: -8.59 },
    ], [
      { id: 100, refs: [1, 2], tags: RAIL },
      { id: 101, refs: [3, 4], tags: RAIL },
    ]);
    expect(reaches(graph, at(41.0, -8.60), at(41.01, -8.59))).toBe(false);
    expect(reaches(graph, at(40.99, -8.59), at(41.0, -8.58))).toBe(false);
    // Both tracks are there; they simply do not meet.
    expect(reaches(graph, at(41.0, -8.60), at(41.0, -8.58))).toBe(true);
    expect(reaches(graph, at(40.99, -8.59), at(41.01, -8.59))).toBe(true);
  });

  it("does not join a tunnel to the line above it", async () => {
    const { graph } = await compile("tunnel", [
      ...line(1, 41.0, -8.60, 3),
      { id: 20, lat: 40.99, lon: -8.59 }, { id: 21, lat: 41.01, lon: -8.59 },
    ], [
      { id: 100, refs: [1, 2, 3], tags: { ...RAIL, bridge: "yes", layer: "1" } },
      { id: 101, refs: [20, 21], tags: { ...RAIL, tunnel: "yes", layer: "-1" } },
    ]);
    expect(reaches(graph, at(41.0, -8.60), at(41.01, -8.59))).toBe(false);
  });

  // Two tracks of a double-track line run beside each other for their whole
  // length and are joined only where a crossover is mapped.
  it("keeps parallel tracks apart until a crossover joins them", async () => {
    const apart = await compile("parallel", [
      ...line(1, 41.0, -8.60, 4),
      ...line(11, 41.0005, -8.60, 4),
    ], [
      { id: 100, refs: [1, 2, 3, 4], tags: { ...RAIL, oneway: "yes" } },
      { id: 101, refs: [14, 13, 12, 11], tags: { ...RAIL, oneway: "yes" } },
    ]);
    // Each track runs one way only, and nothing crosses between them, so the
    // return journey is impossible however close the two lines are.
    expect(reaches(apart.graph, at(41.0, -8.60), at(41.0, -8.57))).toBe(true);
    expect(reaches(apart.graph, at(41.0, -8.57), at(41.0, -8.60))).toBe(false);

    const joined = await compile("parallel-crossover", [
      ...line(1, 41.0, -8.60, 4),
      ...line(11, 41.0005, -8.60, 4),
    ], [
      { id: 100, refs: [1, 2, 3, 4], tags: { ...RAIL, oneway: "yes" } },
      { id: 101, refs: [14, 13, 12, 11], tags: { ...RAIL, oneway: "yes" } },
      // The crossover is a mapped way joining node 4 to node 14.
      { id: 102, refs: [4, 14], tags: { ...RAIL, service: "crossover" } },
    ]);
    expect(reaches(joined.graph, at(41.0, -8.57), at(41.0005, -8.60))).toBe(true);
  });
});

describe("networks that do not reach each other", () => {
  it("reports no route between two disconnected networks rather than inventing one", async () => {
    const { graph } = await compile("disconnected", [
      ...line(1, 41.0, -8.60, 3),
      ...line(20, 38.7, -9.14, 3),
    ], [
      { id: 100, refs: [1, 2, 3], tags: RAIL },
      { id: 101, refs: [20, 21, 22], tags: RAIL },
    ]);
    expect(() => strictRoute(graph, at(41.0, -8.60), at(38.7, -9.12))).toThrow(RouterError);
    // Each island is routable on its own.
    expect(reaches(graph, at(41.0, -8.60), at(41.0, -8.58))).toBe(true);
    expect(reaches(graph, at(38.7, -9.14), at(38.7, -9.12))).toBe(true);
  });

  it("routes into a dead-end spur and refuses to continue past the stop block", async () => {
    const { graph } = await compile("dead-end", [
      ...line(1, 41.0, -8.60, 4),
      { id: 30, lat: 41.005, lon: -8.575 },
      { id: 31, lat: 41.008, lon: -8.572 },
    ], [
      { id: 100, refs: [1, 2, 3, 4], tags: RAIL },
      // A spur leaving the main line at node 3 and stopping at a buffer.
      { id: 101, refs: [3, 30, 31], tags: { ...RAIL, service: "spur" } },
    ]);
    expect(reaches(graph, at(41.0, -8.60), at(41.008, -8.572))).toBe(true);
    expect(reaches(graph, at(41.008, -8.572), at(41.0, -8.60))).toBe(true);
    // The spur ends where it ends; beyond it there is nothing to reach.
    expect(() => strictRoute(graph, at(41.0, -8.60), at(41.02, -8.55))).toThrow(RouterError);
  });
});

describe("a siding is track, not a shortcut", () => {
  // A loop beside the main line, joined at both ends. It is genuinely a path,
  // and it is genuinely slower: the search should prefer the main line when
  // minimising time, which is what keeps yards out of ordinary routes.
  it("prefers the main line over a parallel siding when minimising time", async () => {
    const { graph } = await compile("siding", [
      ...line(1, 41.0, -8.60, 4),
      { id: 20, lat: 41.0008, lon: -8.593 }, { id: 21, lat: 41.0008, lon: -8.587 },
    ], [
      { id: 100, refs: [1, 2, 3, 4], tags: RAIL },
      { id: 101, refs: [2, 20, 21, 3], tags: { ...RAIL, service: "siding" } },
    ]);
    const fastest = route(graph, at(41.0, -8.60), at(41.0, -8.57), "fastest");
    const used = [...fastest.edgeIds, fastest.originSnap.edge, fastest.destinationSnap.edge].filter((edge) => edge >= 0);
    expect(used.some((edge) => railwayOf(graph, edge)?.service !== 0)).toBe(false);
  });

  it("can be told to keep off service track altogether", async () => {
    const { graph } = await compile("siding", [], []);
    // The edges a route enters and leaves on are reported in its snaps rather
    // than in `edgeIds`, so both have to be counted to see every track used.
    const serviceEdges = (result: { edgeIds: number[]; originSnap: { edge: number }; destinationSnap: { edge: number } }) =>
      [...result.edgeIds, result.originSnap.edge, result.destinationSnap.edge]
        .filter((edge) => edge >= 0 && railwayOf(graph, edge)?.service !== 0);

    // The siding is reachable, and running to a point on it uses it.
    expect(serviceEdges(route(graph, at(41.0, -8.60), at(41.0008, -8.59), "shortest")).length).toBeGreaterThan(0);

    // Excluding service track closes those edges to the search and to
    // snapping both, so the route that comes back touches none of them —
    // it finishes on the main line alongside instead.
    expect(countRailwayBlocked(graph, { excludeServiceTracks: true })).toBeGreaterThan(0);
    const off = route(graph, at(41.0, -8.60), at(41.0008, -8.59), "shortest", { railway: { excludeServiceTracks: true } });
    expect(serviceEdges(off)).toEqual([]);
    // It finished on the main line alongside, and says how far short it fell.
    expect(off.destinationSnap.distanceMeters).toBeGreaterThan(0);
  });
});

describe("the track a route runs over", () => {
  it("keeps the geometry of the line it followed", async () => {
    const { graph } = await compile("junction", [], []);
    const result = strictRoute(graph, at(41.0, -8.60), at(41.02, -8.58));
    expect(result.geometry.type).toBe("LineString");
    expect(result.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    for (const [lon, lat] of result.geometry.coordinates) {
      expect(lat).toBeGreaterThan(40.9);
      expect(lat).toBeLessThan(41.1);
      expect(lon).toBeGreaterThan(-8.7);
      expect(lon).toBeLessThan(-8.5);
    }
  });

  it("carries what the track is through compilation into the bundle", async () => {
    const { graph, report } = await compile("junction", [], []);
    expect(railwayOf(graph, 0)).toMatchObject({ gaugeMm: 1668, voltage: 25000 });
    expect(report.networkKind).toBe("railway");
    expect(report.distinctRailwayAttributeRows).toBeGreaterThan(0);
  });

  it("enforces a gauge the track cannot answer for", async () => {
    const { graph } = await compile("junction", [], []);
    expect(() => route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest", { finishOnANearbyRoad: false, railway: { gaugeMm: 1435 } })).toThrow(RouterError);
    expect(route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest", { railway: { gaugeMm: 1668 } }).distanceMeters).toBeGreaterThan(0);
  });
});

// A corridor is stitched out of several tiles, and everything written against
// edge numbers has to be rebased when they change. Losing the track
// description in the stitching would make every constraint silently vacuous on
// exactly the long routes they matter most for.
describe("a route stitched from several tiles", () => {
  const long = (): [PbfNode[], PbfWay[]] => {
    // A line of 1668 mm track running ~60 km north-east, far enough to cross
    // several tiles. It is mapped as a chain of ways meeting end to end, as a
    // real line is, so the shared nodes survive simplification and the edges
    // are short enough to land in different tiles.
    const nodes = Array.from({ length: 13 }, (_, index) => ({ id: 1 + index, lat: 41.0 + index * 0.03, lon: -8.60 + index * 0.05 }));
    const ways = nodes.slice(0, -1).map((node, index) => ({ id: 100 + index, refs: [node.id, nodes[index + 1].id], tags: RAIL }));
    return [nodes, ways];
  };

  it("keeps the track description across tile boundaries", async () => {
    const { graph, report } = await compile("multi-tile", ...long(), ["--profile", "train", "--tile-size-km", "20"]);
    // Several tiles, so the corridor really was stitched out of them.
    expect(report.tiles as number).toBeGreaterThan(1);
    expect(graph.edgeTargets.length).toBeGreaterThan(12);
    expect(graph.nodeLatitudes.length).toBeGreaterThan(8);
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      expect(railwayOf(graph, edge)).toMatchObject({ gaugeMm: 1668, voltage: 25000 });
    }
  });

  it("still enforces a constraint over a stitched corridor", async () => {
    const { graph } = await compile("multi-tile", [], []);
    const ends = [at(41.0, -8.60), at(41.36, -8.00)] as const;
    expect(route(graph, ends[0], ends[1], "shortest", { railway: { gaugeMm: 1668 } }).distanceMeters).toBeGreaterThan(50_000);
    expect(() => route(graph, ends[0], ends[1], "shortest", { finishOnANearbyRoad: false, railway: { gaugeMm: 1435 } })).toThrow(RouterError);
  });
});

// A railway route is only as trustworthy as the survey behind it. The number
// that says so has to reach whoever is holding the result, not just whoever
// is holding the graph.
describe("what a route vouches for", () => {
  it("reports the track a route ran over, on the result itself", async () => {
    const { graph } = await compile("siding", [], []);
    const result = route(graph, at(41.0, -8.60), at(41.0008, -8.59), "shortest");
    expect(result.railway).toBeDefined();
    expect(result.railway!.gauges).toEqual([1668]);
    expect(result.railway!.unstated).toEqual([]);
    expect(result.railway!.statedMeters).toBeGreaterThan(0);
    // It ran onto the siding to get there, and says so.
    expect(result.railway!.serviceTrackMeters).toBeGreaterThan(0);
  });

  it("names the attribute a route could not answer for", async () => {
    // A line stating nothing but its class: every constraint is unanswered.
    const { graph } = await compile("silent", [
      ...line(1, 41.0, -8.60, 3), { id: 10, lat: 41.02, lon: -8.58 },
    ], [
      { id: 100, refs: [1, 2, 3], tags: { railway: "rail" } },
      { id: 101, refs: [3, 10], tags: { railway: "rail" } },
    ]);
    const result = route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest", { railway: { gaugeMm: 1668, requireElectrification: true } });
    // The route exists, because silence is not a refusal...
    expect(result.distanceMeters).toBeGreaterThan(0);
    // ...and it is never reported as though the track had answered.
    expect(result.railway!.statedMeters).toBe(0);
    expect(result.railway!.unstatedMeters).toBeGreaterThan(0);
    // Nothing whatever was stated, so the report says exactly that rather
    // than listing the attributes one by one.
    expect(result.railway!.unstated).toEqual(["railway attributes"]);
    expect(result.railway!.gauges).toEqual([]);

    // And `strictUnknown` refuses it outright.
    expect(() => route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest", { finishOnANearbyRoad: false, railway: { gaugeMm: 1668, strictUnknown: true } })).toThrow(RouterError);
  });

  it("says nothing about a road route, which has no track to describe", async () => {
    const { graph } = await compile("junction", [], []);
    expect(route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest").railway).toBeDefined();
    // The same topology read as a road graph makes no claim either way: the
    // field is for routes over track, and a car route is not one.
    const asRoad = { ...graph, edgeRailway: undefined, profileId: ProfileId.car, maxSpeedKph: 150 };
    expect(route(asRoad, at(41.0, -8.60), at(41.02, -8.58), "shortest").railway).toBeUndefined();
  });

  // A railway graph that describes nothing still answers, because the absence
  // of the field has to mean one thing only: "this is not a railway route".
  it("reports a wholly undescribed railway as wholly unstated", async () => {
    const { graph } = await compile("silent", [], []);
    expect(graph.edgeRailway).toBeUndefined();
    const result = route(graph, at(41.0, -8.60), at(41.02, -8.58), "shortest");
    expect(result.railway).toEqual({ statedMeters: 0, unstatedMeters: expect.any(Number), unstated: ["railway attributes"], serviceTrackMeters: 0, gauges: [] });
    expect(result.railway!.unstatedMeters).toBeGreaterThan(0);
  });
});

describe("snapping onto track", () => {
  it("snaps to the railway and only to the railway", async () => {
    // A road runs right beside the line. A train bundle holds no road at all,
    // so there is nothing but track to snap to.
    const { graph } = await compile("with-road", [
      ...line(1, 41.0, -8.60, 3),
      ...line(11, 41.0002, -8.60, 3),
    ], [
      { id: 100, refs: [1, 2, 3], tags: RAIL },
      { id: 101, refs: [11, 12, 13], tags: { highway: "primary" } },
    ]);
    const snap = snapToGraph(graph, at(41.0002, -8.595))!;
    expect(snap).not.toBeNull();
    // Everything in the graph is track, so whatever it snapped to is track.
    expect(graph.edgeTargets.length).toBeGreaterThan(0);
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
      expect(railwayOf(graph, edge)?.gaugeMm).toBe(1668);
    }
  });
});

describe("alternatives over track", () => {
  it("offers a second way round where the network holds one", async () => {
    const { graph } = await compile("alternatives", [
      { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.0, lon: -8.56 },
      { id: 10, lat: 41.02, lon: -8.58 }, { id: 20, lat: 40.98, lon: -8.58 },
    ], [
      { id: 100, refs: [1, 10, 2], tags: RAIL },
      { id: 101, refs: [1, 20, 2], tags: RAIL },
    ]);
    const routes = routeAlternatives(graph, at(41.0, -8.60), at(41.0, -8.56), "shortest", { count: 2 });
    expect(routes.length).toBe(2);
    expect(routes[0].distanceMeters).toBeLessThanOrEqual(routes[1].distanceMeters);
  });
});

describe("keeping the two railway networks apart", () => {
  // Metro do Porto meets the conventional network at a handful of nodes in the
  // real data. Sharing a node must not let a train run onto the metro.
  const network: [PbfNode[], PbfWay[]] = [[
    ...line(1, 41.15, -8.61, 3),
    { id: 30, lat: 41.16, lon: -8.59 }, { id: 31, lat: 41.17, lon: -8.57 },
  ], [
    { id: 100, refs: [1, 2, 3], tags: RAIL },
    // The metro leaves from node 3, which the main line also names.
    { id: 101, refs: [3, 30, 31], tags: { railway: "light_rail", gauge: "1435", electrified: "contact_line", voltage: "750", frequency: "0" } },
  ]];

  it("gives a train bundle no metro to run onto", async () => {
    const { graph } = await compile("mixed-train", ...network, ["--profile", "train"]);
    expect(reaches(graph, at(41.15, -8.61), at(41.17, -8.57))).toBe(false);
  });

  it("gives a metro bundle no main line to run onto", async () => {
    const { graph } = await compile("mixed-metro", ...network, ["--profile", "metro"]);
    expect(reaches(graph, at(41.17, -8.57), at(41.15, -8.61))).toBe(false);
  });

  // One bundle can carry both, because the two share geometry without sharing
  // a single usable edge: the access mask keeps each profile on its own metals.
  it("carries both in one bundle without letting either onto the other", async () => {
    const trainView = await compile("mixed-both-train", ...network, ["--profile", "train,metro"]);
    expect(trainView.profiles).toEqual([ProfileId.train, ProfileId.metro]);
    expect(reaches(trainView.graph, at(41.15, -8.61), at(41.17, -8.57))).toBe(false);
    expect(reaches(trainView.graph, at(41.15, -8.61), at(41.15, -8.59))).toBe(true);
  });

  it("refuses to compile a road and a railway into one bundle", async () => {
    const input = join(workspace, "refuse.osm.pbf");
    writeFileSync(input, writeOsmPbf(...network));
    expect(() => execFileSync(process.execPath, ["scripts/roadgraph-compile.mjs", input, "--output", join(workspace, "refuse.efrb"), "--profile", "car,train"], { stdio: "pipe", encoding: "utf8" }))
      .toThrow(/cannot mix road and railway/);
  });
});
