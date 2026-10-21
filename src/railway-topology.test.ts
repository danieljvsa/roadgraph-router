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

/** The same compiled fixture, loaded as a different profile in the bundle. */
async function openAs(name: string, profileId: number) {
  const output = join(workspace, `${name}.efrb`);
  const bytes = readFileSync(output);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const bundle = await openRoadGraphBundle(output, rangeFetcher(buffer).fetcher);
  return bundle.loadTiles(bundle.tiles, profileId);
}
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

/**
 * Where a railway route begins.
 *
 * Both of these came out of a screenshot of Metro do Porto rather than a test,
 * and both made a correct search produce a route no operator would recognise.
 */
describe("choosing a platform to start from", () => {
  // A station: the running line through it, a yard track a metre nearer the
  // station node, and a crossover joining them — the shape of every terminus
  // and most through stations.
  const station: [PbfNode[], PbfWay[]] = [[
    // The running line, south to north.
    { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.010, lon: -8.6000 }, { id: 3, lat: 41.020, lon: -8.6000 },
    // A yard track beside it, slightly closer to where the caller points.
    { id: 11, lat: 41.0098, lon: -8.60012 }, { id: 12, lat: 41.0102, lon: -8.60012 },
    // The crossover that joins the yard back to the running line.
    { id: 13, lat: 41.010, lon: -8.6000 },
  ], [
    { id: 100, refs: [1, 2], tags: RAIL },
    { id: 101, refs: [2, 3], tags: RAIL },
    { id: 102, refs: [11, 12], tags: { ...RAIL, service: "yard" } },
    { id: 103, refs: [12, 2], tags: { ...RAIL, service: "crossover" } },
  ]];

  // Standing on the platform, the yard track is the nearest rail. It is not
  // the one a train leaves from.
  it("prefers the running line to a siding that is marginally nearer", async () => {
    const { graph } = await compile("platform-choice", ...station, ["--profile", "train"]);
    const result = route(graph, at(41.0100, -8.60006), at(41.020, -8.6000), "shortest");
    // Every track the route touches — including the ones it entered and left
    // on, which are reported in the snaps rather than in `edgeIds`.
    const touched = [...result.edgeIds, result.originSnap.edge, result.destinationSnap.edge].filter((edge) => edge >= 0);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((edge) => railwayOf(graph, edge)?.service === 0)).toBe(true);
  });

  // The preference is worth 30 m, so a siding wins where it is more than that
  // nearer than any running line — which is what being inside a yard means.
  // It is a preference between near-ties, not a refusal to see service track.
  it("still snaps into a yard for a point that is really in one", async () => {
    const { graph } = await compile("deep-yard", [
      { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.010, lon: -8.6000 }, { id: 3, lat: 41.020, lon: -8.6000 },
      // A yard well away from the running line, not a track beside a platform.
      { id: 11, lat: 41.009, lon: -8.6020 }, { id: 12, lat: 41.011, lon: -8.6020 },
    ], [
      { id: 100, refs: [1, 2], tags: RAIL },
      { id: 101, refs: [2, 3], tags: RAIL },
      { id: 102, refs: [11, 12], tags: { ...RAIL, service: "yard" } },
    ], ["--profile", "train"]);
    const snapped = snapToGraph(graph, at(41.0100, -8.6020), 200);
    expect(snapped).not.toBeNull();
    const edge = snapped!.kind === "edge" ? snapped!.projections[0].edge : -1;
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(railwayOf(graph, edge)?.service).not.toBe(0);
  });
});

describe("starting in the direction the journey needs", () => {
  // Two one-way tracks a few metres apart, as a railway builds its two
  // directions — not as a road carries them on one carriageway.
  const doubleTrack: [PbfNode[], PbfWay[]] = [[
    { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.010, lon: -8.6000 }, { id: 3, lat: 41.020, lon: -8.6000 },
    { id: 11, lat: 41.000, lon: -8.60010 }, { id: 12, lat: 41.010, lon: -8.60010 }, { id: 13, lat: 41.020, lon: -8.60010 },
  ], [
    // Northbound, on the track about 8 m to the west. The two share no node,
    // exactly as two running lines between crossovers do not.
    { id: 100, refs: [11, 12, 13], tags: { ...RAIL, oneway: "yes" } },
    // Southbound, on the track the caller happens to be standing nearer.
    { id: 101, refs: [3, 2, 1], tags: { ...RAIL, oneway: "yes" } },
  ]];

  // Half a metre of tie tolerance keeps only the nearer of two parallel
  // one-way tracks, which forces the route to leave in that track's direction
  // however far out of its way that is. On Metro do Porto it turned an 11.9 km
  // journey into 16.1 km.
  it("may start on either track of a double-track line, not just the nearer one", async () => {
    const { graph } = await compile("double-track", ...doubleTrack, ["--profile", "train"]);
    // Standing on the platform between the two tracks, a little nearer the
    // southbound one — but travelling north. Only the northbound track can
    // carry the journey, and nothing joins the two.
    // Mid-track, not on a node: a snap that lands on a junction is reported
    // as that node, and the choice of parallel track with it.
    const north = route(graph, at(41.0020, -8.60003), at(41.0180, -8.60003), "shortest");
    expect(north.distanceMeters).toBeGreaterThan(1_500);
    expect(north.distanceMeters).toBeLessThan(2_100);
    // It really did leave on the northbound track rather than turning round.
    expect(railwayOf(graph, north.originSnap.edge)).toBeDefined();
    const first = north.geometry.coordinates[0];
    const last = north.geometry.coordinates[north.geometry.coordinates.length - 1];
    expect(last[1]).toBeGreaterThan(first[1]);

    // And the opposite journey still uses the southbound track.
    const south = route(graph, at(41.0180, -8.60003), at(41.0020, -8.60003), "shortest");
    expect(south.distanceMeters).toBeLessThan(2_100);
    expect(south.geometry.coordinates[south.geometry.coordinates.length - 1][1]).toBeLessThan(south.geometry.coordinates[0][1]);
  });

  // A station node sits on one of the platform tracks. Reporting a snap that
  // lands on it as "that node" threw away every other track at the station,
  // so the route had to leave in that one track's direction: 36 of Metro do
  // Porto's 49 stations collapsed this way, and Aliados to Faria Guimarães,
  // two stops apart on one line, was 7.4 km one way and 1.0 km the other.
  it("does not collapse a station snap to one node and lose the other platforms", async () => {
    const { graph } = await compile("station-node", [
      // Northbound track, with a node exactly at the station.
      { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.010, lon: -8.6000 }, { id: 3, lat: 41.020, lon: -8.6000 },
      // Southbound track beside it, 8 m west, with no node at the station.
      { id: 11, lat: 41.000, lon: -8.60010 }, { id: 13, lat: 41.020, lon: -8.60010 },
    ], [
      { id: 100, refs: [1, 2], tags: { ...RAIL, oneway: "yes" } },
      { id: 101, refs: [2, 3], tags: { ...RAIL, oneway: "yes" } },
      { id: 102, refs: [13, 11], tags: { ...RAIL, oneway: "yes" } },
    ], ["--profile", "train"]);

    // Standing at the station node itself, which is on the northbound track.
    const atStation = at(41.010, -8.6000);
    const snapped = snapToGraph(graph, atStation, 60);
    // Track keeps its projections rather than collapsing to the node, so the
    // southbound platform is still a candidate.
    expect(snapped?.kind).toBe("edge");

    // Northwards is on the track under your feet.
    expect(route(graph, atStation, at(41.020, -8.6000), "shortest").distanceMeters).toBeLessThan(1_500);
    // Southwards needs the other platform, and finds it.
    const south = route(graph, atStation, at(41.0005, -8.60010), "shortest");
    expect(south.distanceMeters).toBeLessThan(3_000);
  });

  // The wider tolerance is for graphs that describe track. A road must keep
  // the half-metre rule, or a route would start on the wrong street.
  it("leaves a road graph on the tight tolerance it has always used", async () => {
    const { graph } = await compile("road-tolerance", [
      ...line(1, 41.0, -8.60, 3), ...line(11, 41.0002, -8.60, 3),
    ], [
      { id: 100, refs: [1, 2, 3], tags: { highway: "primary" } },
      { id: 101, refs: [11, 12, 13], tags: { highway: "residential" } },
    ], ["--profile", "car"]);
    expect(graph.edgeRailway).toBeUndefined();
    const snapped = snapToGraph(graph, at(41.00001, -8.595), 60);
    // Only the one road, as both directions of it: not the parallel street.
    expect(snapped?.kind).toBe("edge");
    if (snapped?.kind === "edge") {
      const spread = Math.max(...snapped.projections.map((p) => p.distanceMeters))
        - Math.min(...snapped.projections.map((p) => p.distanceMeters));
      expect(spread).toBeLessThanOrEqual(0.5);
    }
  });
});

/**
 * A siding is often the shortest way between two parallel running lines, so a
 * shortest-distance search will cut through the depot to change track unless
 * something stops it. Leaving Trindade it took 83 m of yard to cross from one
 * line to another, which no operator does.
 */
describe("what a siding costs to cross", () => {
  // A running line, and a shorter path between the same two points that goes
  // through a yard. On distance alone the yard wins.
  const shortcut: [PbfNode[], PbfWay[]] = [[
    { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.004, lon: -8.6060 }, { id: 3, lat: 41.008, lon: -8.6000 },
    { id: 4, lat: 41.004, lon: -8.6002 },
  ], [
    // The running line, bowing west through node 2.
    { id: 100, refs: [1, 2], tags: RAIL },
    { id: 101, refs: [2, 3], tags: RAIL },
    // A yard track cutting the corner, straight through node 4.
    { id: 102, refs: [1, 4], tags: { ...RAIL, service: "yard" } },
    { id: 103, refs: [4, 3], tags: { ...RAIL, service: "yard" } },
  ]];

  it("keeps a shortest route on the running line rather than through the yard", async () => {
    const { graph } = await compile("yard-shortcut", ...shortcut, ["--profile", "train"]);
    const ends = [at(41.000, -8.6000), at(41.008, -8.6000)] as const;
    for (const preference of ["shortest", "fastest"] as const) {
      const result = route(graph, ends[0], ends[1], preference);
      const used = [...result.edgeIds, result.originSnap.edge, result.destinationSnap.edge].filter((edge) => edge >= 0);
      expect(used.every((edge) => railwayOf(graph, edge)?.service === 0)).toBe(true);
    }
  });

  // Dearer, not forbidden: where the yard is the only way, it is still used.
  it("still crosses a siding when it is the only way through", async () => {
    const { graph } = await compile("yard-only", [
      { id: 1, lat: 41.000, lon: -8.6000 }, { id: 2, lat: 41.004, lon: -8.6000 }, { id: 3, lat: 41.008, lon: -8.6000 },
    ], [
      { id: 100, refs: [1, 2], tags: RAIL },
      { id: 101, refs: [2, 3], tags: { ...RAIL, service: "siding" } },
    ], ["--profile", "train"]);
    const result = route(graph, at(41.000, -8.6000), at(41.008, -8.6000), "shortest");
    expect(result.distanceMeters).toBeGreaterThan(500);
    expect(result.railway!.serviceTrackMeters).toBeGreaterThan(0);
  });

  // The penalty steers the search and never reaches the answer.
  it("reports the graph's own distance, not the penalised one", async () => {
    const { graph } = await compile("yard-only", [], []);
    const result = route(graph, at(41.000, -8.6000), at(41.008, -8.6000), "shortest");
    // Two segments of about 444 m each; nothing is multiplied in the answer.
    expect(result.distanceMeters).toBeGreaterThan(800);
    expect(result.distanceMeters).toBeLessThan(950);
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

/* ------------------------------------------------------- the compiler --- */

describe("what the compiler puts in, and leaves out", () => {
  // One way of every class, so a single compile answers for all of them.
  const everyClass: [PbfNode[], PbfWay[]] = [(() => {
    const nodes: PbfNode[] = [];
    for (let index = 0; index < 14; index += 1) nodes.push({ id: 1 + index, lat: 41.0 + index * 0.02, lon: -8.60 + index * 0.01 });
    return nodes;
  })(), [
    { id: 100, refs: [1, 2], tags: RAIL },
    { id: 101, refs: [3, 4], tags: { ...RAIL, railway: "disused" } },
    { id: 102, refs: [5, 6], tags: { ...RAIL, railway: "abandoned" } },
    { id: 103, refs: [7, 8], tags: { ...RAIL, railway: "construction" } },
    { id: 104, refs: [9, 10], tags: { ...RAIL, railway: "razed" } },
    { id: 105, refs: [11, 12], tags: { ...RAIL, railway: "narrow_gauge", gauge: "1000" } },
    { id: 106, refs: [13, 14], tags: { railway: "platform" } },
  ]];

  it("takes railway=rail and nothing else, by default", async () => {
    const { report } = await compile("classes-default", ...everyClass, ["--profile", "train"]);
    expect(report.relevantOsmWays).toBe(1);
    expect(report.networkKind).toBe("railway");
    expect(report.railwayInclude).toEqual([]);
  });

  it("adds exactly the classes --railway-include names", async () => {
    const { report } = await compile("classes-included", ...everyClass,
      ["--profile", "train", "--railway-include", "disused,narrow_gauge"]);
    // rail + disused + narrow_gauge; nothing else came with them.
    expect(report.relevantOsmWays).toBe(3);
    expect(report.railwayInclude).toEqual(["disused", "narrow_gauge"]);
  });

  // Track that is gone or not yet built is not opt-in at all, and asking for
  // it is refused by name rather than quietly obeyed. Before this was checked
  // at run time the type stopped a TypeScript caller and nothing stopped the
  // command line, where `--railway-include` arrives as plain text.
  it("refuses to route over track that is gone or unbuilt, however it is asked for", async () => {
    const input = join(workspace, "refused-classes.osm.pbf");
    writeFileSync(input, writeOsmPbf(...everyClass));
    for (const [name, reason] of [
      ["abandoned", /has been lifted/], ["razed", /has been lifted/],
      ["construction", /not finished/], ["proposed", /not been built/],
      ["platform", /not track/], ["nonsense", /not a railway class/],
    ] as const) {
      expect(() => execFileSync(process.execPath,
        ["scripts/roadgraph-compile.mjs", input, "--output", join(workspace, "refused.efrb"), "--profile", "train", "--railway-include", name],
        { stdio: "pipe", encoding: "utf8" })).toThrow(reason);
    }
    // One good name alongside a bad one still fails, rather than compiling
    // half of what was asked for.
    expect(() => execFileSync(process.execPath,
      ["scripts/roadgraph-compile.mjs", input, "--output", join(workspace, "refused.efrb"), "--profile", "train", "--railway-include", "disused,abandoned"],
      { stdio: "pipe", encoding: "utf8" })).toThrow(/has been lifted/);
  });

  it("describes the graph it actually produced", async () => {
    const { graph, report } = await compile("classes-included", [], []);
    expect(report.routingEdges).toBe(graph.edgeTargets.length);
    expect(report.routingNodesAfterSimplification).toBe(graph.nodeLatitudes.length);
    expect(report.layout).toBe("shared-plus-profile");
    expect(report.distinctRailwayAttributeRows as number).toBeGreaterThan(0);
    expect(report.profile).toBe("train");
  });

  // Every attribute the profile read has to survive two passes, the tile
  // encoder, gzip and the range reader to be worth anything.
  it("carries every stated attribute through compilation unchanged", async () => {
    const { graph } = await compile("attributes", [
      ...line(1, 41.0, -8.60, 2), ...line(11, 41.1, -8.60, 2),
    ], [
      { id: 100, refs: [1, 2], tags: { railway: "rail", gauge: "1000;1668", electrified: "contact_line", voltage: "25000", frequency: "50", usage: "branch", service: "siding" } },
      { id: 101, refs: [11, 12], tags: { railway: "rail", gauge: "1435", electrified: "no" } },
    ], ["--profile", "train"]);
    const seen = [];
    for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) seen.push(railwayOf(graph, edge));
    // Dual gauge survives as both of its gauges, not as the first one.
    expect(seen).toContainEqual(expect.objectContaining({
      gaugeMm: 1000, secondGaugeMm: 1668, voltage: 25000, electrification: 2, frequency: 4, usage: 2, service: 1,
    }));
    // And an explicit "not electrified" is not confused with an absent tag.
    expect(seen).toContainEqual(expect.objectContaining({ gaugeMm: 1435, electrification: 1, voltage: 0, frequency: 0 }));
  });

  // A line of track at one latitude has a bounding box with no height. The
  // tiling loop produced no rows for it at all, and the compile failed with
  // "Invalid routing bundle directory" — a message about the output, for a
  // problem with the input.
  it("compiles a region with no height or no width", async () => {
    const flat = await compile("flat-extent", [
      { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.0, lon: -8.59 }, { id: 3, lat: 41.0, lon: -8.58 },
    ], [{ id: 100, refs: [1, 2, 3], tags: RAIL }], ["--profile", "train"]);
    expect(flat.report.tiles).toBe(1);
    expect(reaches(flat.graph, at(41.0, -8.60), at(41.0, -8.58))).toBe(true);

    const narrow = await compile("narrow-extent", [
      { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.01, lon: -8.60 }, { id: 3, lat: 41.02, lon: -8.60 },
    ], [{ id: 100, refs: [1, 2, 3], tags: RAIL }], ["--profile", "train"]);
    expect(narrow.report.tiles).toBe(1);
    expect(reaches(narrow.graph, at(41.0, -8.60), at(41.02, -8.60))).toBe(true);
  });

  it("refuses --railway-include on a road profile", async () => {
    const input = join(workspace, "road-include.osm.pbf");
    writeFileSync(input, writeOsmPbf(...everyClass));
    expect(() => execFileSync(process.execPath,
      ["scripts/roadgraph-compile.mjs", input, "--output", join(workspace, "road-include.efrb"), "--profile", "car", "--railway-include", "disused"],
      { stdio: "pipe", encoding: "utf8" })).toThrow(/only applies to the train and metro profiles/);
  });

  it("names an unknown profile rather than guessing", async () => {
    const input = join(workspace, "unknown-profile.osm.pbf");
    writeFileSync(input, writeOsmPbf(...everyClass));
    expect(() => execFileSync(process.execPath,
      ["scripts/roadgraph-compile.mjs", input, "--output", join(workspace, "u.efrb"), "--profile", "tram"],
      { stdio: "pipe", encoding: "utf8" })).toThrow(/Unknown routing profile "tram"/);
  });
});

/* ------------------------------------------- constraints over a bundle --- */

describe("constraints against a compiled network", () => {
  // Two gauges meeting at a shared node: the only path from one end to the
  // other crosses a gauge change. A train of either gauge must be refused,
  // because no real train changes gauge at a junction.
  const mixedGauge: [PbfNode[], PbfWay[]] = [[
    ...line(1, 41.0, -8.60, 3),
    { id: 10, lat: 41.0, lon: -8.57 }, { id: 11, lat: 41.0, lon: -8.56 },
  ], [
    { id: 100, refs: [1, 2, 3], tags: { railway: "rail", gauge: "1668", electrified: "contact_line", voltage: "25000", frequency: "50" } },
    { id: 101, refs: [3, 10, 11], tags: { railway: "rail", gauge: "1000", electrified: "no" } },
  ]];

  it("stops a train where the only route crosses a gauge it cannot use", async () => {
    const { graph } = await compile("mixed-gauge", ...mixedGauge, ["--profile", "train"]);
    const [west, east] = [at(41.0, -8.60), at(41.0, -8.56)];
    // Unconstrained, the route runs straight across the gauge change...
    expect(reaches(graph, west, east)).toBe(true);
    // ...and says so, which is the only warning an unconstrained caller gets.
    expect(route(graph, west, east, "shortest").railway!.gauges).toEqual([1000, 1668]);
    // Constrained, neither gauge can make the whole journey.
    for (const gaugeMm of [1668, 1000]) {
      expect(() => route(graph, west, east, "shortest", { finishOnANearbyRoad: false, railway: { gaugeMm } })).toThrow(RouterError);
    }
    // Each can still run on its own half of the network.
    expect(route(graph, west, at(41.0, -8.58), "shortest", { railway: { gaugeMm: 1668 } }).distanceMeters).toBeGreaterThan(0);
    expect(route(graph, east, at(41.0, -8.57), "shortest", { railway: { gaugeMm: 1000 } }).distanceMeters).toBeGreaterThan(0);
  });

  it("stops an electric train where the only route is unelectrified", async () => {
    const { graph } = await compile("mixed-gauge", [], []);
    const [west, east] = [at(41.0, -8.60), at(41.0, -8.56)];
    expect(() => route(graph, west, east, "shortest", { finishOnANearbyRoad: false, railway: { requireElectrification: true } })).toThrow(RouterError);
    const certainty = route(graph, west, at(41.0, -8.58), "shortest", { railway: { requireElectrification: true } }).railway!;
    expect(certainty.unstated).toEqual([]);
  });

  it("lets a dual-gauge track answer for either gauge", async () => {
    const { graph } = await compile("dual-gauge", [
      ...line(1, 41.0, -8.60, 3),
    ], [
      { id: 100, refs: [1, 2, 3], tags: { railway: "rail", gauge: "1000;1668", electrified: "contact_line", voltage: "25000", frequency: "50" } },
    ], ["--profile", "train"]);
    const [west, east] = [at(41.0, -8.60), at(41.0, -8.58)];
    for (const gaugeMm of [1668, 1000]) {
      expect(route(graph, west, east, "shortest", { railway: { gaugeMm } }).distanceMeters).toBeGreaterThan(0);
    }
    expect(() => route(graph, west, east, "shortest", { finishOnANearbyRoad: false, railway: { gaugeMm: 1435 } })).toThrow(RouterError);
  });

  it("matches a multi-system train against either of a changeover line's systems", async () => {
    const { graph } = await compile("changeover", [...line(1, 41.0, -8.60, 3)], [
      { id: 100, refs: [1, 2, 3], tags: { railway: "rail", gauge: "1435", electrified: "contact_line", voltage: "1500;25000", frequency: "0;50" } },
    ], ["--profile", "train"]);
    const [west, east] = [at(41.0, -8.60), at(41.0, -8.58)];
    expect(route(graph, west, east, "shortest", { railway: { voltage: 25000, frequency: "50" } }).distanceMeters).toBeGreaterThan(0);
    expect(route(graph, west, east, "shortest", { railway: { voltage: 1500, frequency: "dc" } }).distanceMeters).toBeGreaterThan(0);
    expect(() => route(graph, west, east, "shortest", { finishOnANearbyRoad: false, railway: { voltage: 750 } })).toThrow(RouterError);
  });
});

describe("alternatives over track", () => {
  it("offers a second way round where the network holds one", async () => {
    // Each branch is mapped as two ways meeting at its middle, so that middle
    // node is named by two ways and survives simplification. A branch that
    // collapses to one edge makes the whole journey a single edge, which has
    // no alternatives to offer and is not what a network looks like.
    const { graph } = await compile("alternatives", [
      { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.0, lon: -8.56 },
      { id: 10, lat: 41.02, lon: -8.585 }, { id: 11, lat: 41.02, lon: -8.575 },
      { id: 20, lat: 40.98, lon: -8.585 }, { id: 21, lat: 40.98, lon: -8.575 },
    ], [
      { id: 100, refs: [1, 10], tags: RAIL }, { id: 101, refs: [10, 11], tags: RAIL }, { id: 102, refs: [11, 2], tags: RAIL },
      { id: 103, refs: [1, 20], tags: RAIL }, { id: 104, refs: [20, 21], tags: RAIL }, { id: 105, refs: [21, 2], tags: RAIL },
    ]);
    const routes = routeAlternatives(graph, at(41.0, -8.60), at(41.0, -8.56), "shortest", { count: 2 });
    expect(routes.length).toBe(2);
    expect(routes[0].distanceMeters).toBeLessThanOrEqual(routes[1].distanceMeters);
  });
});

/**
 * The Portugal `train,metro` bundle holds 26,052 edges where the two separate
 * bundles hold 23,273 and 2,777 — 26,050. Two more, on identical node counts.
 *
 * This reproduces the cause exactly, so the claim rests on a test rather than
 * on an explanation: at two nodes in Portugal a light-rail way runs through
 * the *end* of a conventional rail way. Compiled alone the metro's node there
 * is interior to a single way and is simplified away; compiled alongside the
 * railway it is a junction between two ways, so the light-rail way is split at
 * it. It is a topology split, not a connection — which the access-mask tests
 * below are what actually prove.
 */
describe("the two extra edges in a shared bundle", () => {
  // A rail way whose END is an interior node of a light-rail way: the exact
  // shape found at nodes 12512182982 and 12512182981 in the Portugal extract.
  const touching: [PbfNode[], PbfWay[]] = [[
    { id: 1, lat: 41.15, lon: -8.61 }, { id: 2, lat: 41.16, lon: -8.60 },
    { id: 3, lat: 41.17, lon: -8.59 }, { id: 4, lat: 41.18, lon: -8.58 },
    { id: 5, lat: 41.19, lon: -8.57 },
  ], [
    // The rail way ends at node 3.
    { id: 100, refs: [1, 2, 3], tags: RAIL },
    // The light-rail way passes straight through node 3 without stopping.
    { id: 101, refs: [5, 3, 4], tags: { railway: "light_rail", gauge: "1435", electrified: "contact_line", voltage: "750", frequency: "0" } },
  ]];

  it("splits the metro way at the junction, and adds exactly that", async () => {
    const alone = await compile("touch-metro", ...touching, ["--profile", "metro"]);
    const both = await compile("touch-both", ...touching, ["--profile", "train,metro"]);
    const rail = await compile("touch-train", ...touching, ["--profile", "train"]);

    const edges = (compiled: Compiled) => compiled.report.routingEdges as number;
    const nodes = (compiled: Compiled) => compiled.report.routingNodesAfterSimplification as number;

    // Compiled alone, node 3 is interior to one metro way and is simplified
    // out, so the metro is a single two-way edge pair.
    expect(edges(alone)).toBe(2);
    // Compiled together, node 3 is named by two ways, so it is kept and the
    // metro way is split in two — one extra edge per direction.
    expect(edges(both)).toBe(edges(rail) + edges(alone) + 2);
    // And the node was already in the train graph as that way's endpoint, so
    // the node counts are unchanged.
    expect(nodes(both)).toBe(nodes(rail) + nodes(alone));
  });

  // The split is only safe because it does not join the networks. This is the
  // assertion that matters: a train standing at that very junction still
  // cannot continue onto the metro.
  it("adds a junction without adding a connection", async () => {
    const { graph } = await compile("touch-both", [], []);
    // Along the rail way to its end at node 3 — fine.
    expect(reaches(graph, at(41.15, -8.61), at(41.17, -8.59))).toBe(true);
    // Through node 3 and onto the light rail beyond — refused, in both
    // directions, although the two share that node.
    expect(reaches(graph, at(41.15, -8.61), at(41.18, -8.58))).toBe(false);
    expect(reaches(graph, at(41.15, -8.61), at(41.19, -8.57))).toBe(false);
  });

  it("lets the metro run through the junction it owns", async () => {
    const metro = await compile("touch-both", [], []);
    const asMetro = await openAs("touch-both", ProfileId.metro);
    expect(reaches(asMetro, at(41.19, -8.57), at(41.18, -8.58))).toBe(true);
    // ...and the metro cannot use the railway either.
    expect(reaches(asMetro, at(41.19, -8.57), at(41.15, -8.61))).toBe(false);
    expect(metro.profiles).toEqual([ProfileId.train, ProfileId.metro]);
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
