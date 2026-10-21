/**
 * What adding railways must not have changed.
 *
 * The hashes below were produced by the v0.3.0 build, before any of this
 * release existed. They are not a snapshot of the current code: they are the
 * bytes the previous version wrote, kept here so that any change to a road
 * bundle's layout has to be a deliberate one.
 */

import { createHash } from "node:crypto";
import {
  ProfileId, accessMaskFor, decodeGraph, decodeProfileChunk, decodeSharedGraph, encodeCompactGraph,
  encodeProfileChunk, encodeSharedGraph, encodeProfiledRoadGraphBundle, encodeRoadGraphBundle,
  getRoutingProfile, getRoutingProfileById, openRoadGraphBundle, packEdgeConditions, packEdgeLimits,
  packEdgeRailway, railwayOf, RoadRouter, route, routingProfiles,
} from "./index";
import type { RoadGraph } from "./index";
import { rangeFetcher } from "./test-support";

const nodes = 6;
const edges = 10;

/** The same graph the v0.3.0 goldens were taken over. */
const roadGraph: RoadGraph = {
  nodeLatitudes: Int32Array.from({ length: nodes }, (_, i) => 410000000 + i * 1000),
  nodeLongitudes: Int32Array.from({ length: nodes }, (_, i) => -86000000 + i * 1700),
  edgeOffsets: Uint32Array.from([0, 2, 4, 6, 8, 9, 10]),
  edgeTargets: Uint32Array.from([1, 2, 0, 3, 1, 4, 2, 5, 5, 4]),
  edgeDistancesMeters: Uint16Array.from({ length: edges }, (_, i) => 100 + i * 7),
  edgeDurationsSeconds: Uint16Array.from({ length: edges }, (_, i) => 10 + i),
  coordinateScale: 10_000_000, edgeDistanceScale: 1, edgeDurationScale: 1,
  profileId: ProfileId.car, maxSpeedKph: 150,
  edgeShapeOffsets: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4]),
  edgeShapeLatitudes: Int32Array.from([410000500, 410001500, 410002500, 410003500]),
  edgeShapeLongitudes: Int32Array.from([-85999150, -85997450, -85995750, -85994050]),
  turnRestrictionFromEdges: Uint32Array.from([0, 3]),
  turnRestrictionToEdges: Uint32Array.from([5, 7]),
};

const hash = (buffer: ArrayBuffer) => createHash("sha256").update(new Uint8Array(buffer)).digest("hex").slice(0, 32);

describe("a road bundle is the file the previous version wrote", () => {
  it("writes every chunk layout byte for byte as v0.3.0 did", () => {
    expect(hash(encodeCompactGraph(roadGraph))).toBe("56975b2559ec39ce953b421d20e4272c");
    expect(hash(encodeCompactGraph({ ...roadGraph, profileId: undefined, maxSpeedKph: undefined }, { layout: "legacy" }))).toBe("c7387f89bbd752b17a9c47392d1471c2");
    expect(hash(encodeSharedGraph(roadGraph))).toBe("0a64bf217790076a21aebb44a8527c89");
    expect(hash(encodeProfileChunk({
      profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array,
      edgeAccess: accessMaskFor(edges, (edge) => edge !== 4),
    }))).toBe("e80557f6ec35f579bae15fc18695a3b0");
    expect(hash(encodeProfileChunk({
      profileId: ProfileId.truck, maxSpeedKph: 90, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array,
      edgeLimits: packEdgeLimits([{ edge: 2, limits: { heightMeters: 4.1, weightTonnes: 18 } }]),
      edgeConditions: packEdgeConditions([{ edge: 1, kind: 0, value: "no @ (Mo-Fr 07:00-10:00)" }]),
    }))).toBe("2eb4ca0eb40d9babaca91655d6165e90");
  });

  // The railway table lives in four header bytes no chunk had ever written.
  // A road chunk leaves them zero, which is what makes the hashes above hold.
  it("leaves the railway header field zero on a road chunk", () => {
    const chunk = encodeProfileChunk({
      profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array,
    });
    expect(new DataView(chunk).getUint32(40, true)).toBe(0);
    expect(decodeProfileChunk(chunk).edgeRailway).toBeUndefined();
  });
});

describe("bundles written by earlier versions still open", () => {
  const tile = { id: 0, bounds: { minLat: 40.9, minLng: -8.7, maxLat: 41.1, maxLng: -8.5 }, graph: roadGraph };

  it("opens and routes a v1 single-chunk bundle", async () => {
    const bundle = encodeRoadGraphBundle([tile]);
    const { fetcher } = rangeFetcher(bundle);
    const opened = await openRoadGraphBundle("road.efrb", fetcher);
    expect(opened.profileId).toBe(ProfileId.car);
    expect(opened.profiles).toEqual([ProfileId.car]);
    const graph = await opened.loadTiles(opened.tiles);
    expect(graph.edgeTargets.length).toBe(edges);
    expect(graph.edgeRailway).toBeUndefined();
  });

  it("opens a v2 multi-profile road bundle and keeps each vehicle's columns apart", async () => {
    const bundle = await encodeProfiledRoadGraphBundle([{
      ...tile,
      profiles: [
        { profileId: ProfileId.car, maxSpeedKph: 150, edgeDurationScale: 1, edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array },
        { profileId: ProfileId.bicycle, maxSpeedKph: 30, edgeDurationScale: 1, edgeDurationsSeconds: Uint16Array.from({ length: edges }, () => 40) },
      ],
    }], { compression: "none" });
    const { fetcher, stats } = rangeFetcher(bundle);
    const opened = await openRoadGraphBundle("road.efrb", fetcher, { profile: "bicycle" });
    expect(opened.profiles).toEqual([ProfileId.car, ProfileId.bicycle]);
    const graph = await opened.loadTiles(opened.tiles);
    expect(graph.profileId).toBe(ProfileId.bicycle);
    expect(graph.edgeDurationsSeconds[0]).toBe(40);
    // The car's columns were never fetched: a range reader downloads the
    // shared chunk and the one vehicle it asked for.
    expect(stats.requests).toBeGreaterThan(0);
  });

  // A v2-v5 graph predates profile metadata, and every one of them is a car.
  it("still reads a legacy chunk as the car graph it is", () => {
    const legacy = encodeCompactGraph({ ...roadGraph, profileId: undefined, maxSpeedKph: undefined }, { layout: "legacy" });
    const decoded = decodeGraph(legacy);
    expect(decoded.profileId).toBeUndefined();
    expect(decoded.edgeRailway).toBeUndefined();
    expect(decoded.edgeTargets.length).toBe(edges);
  });

  it("still routes a road graph to the same answer", () => {
    const first = route(roadGraph, { lat: 41.0, lng: -8.6 }, { lat: 41.00005, lng: -8.59915 }, "shortest");
    expect(first.distanceMeters).toBeGreaterThan(0);
    expect(first.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("telling a railway bundle from a road one", () => {
  const railGraph: RoadGraph = {
    ...roadGraph,
    profileId: ProfileId.train,
    maxSpeedKph: 300,
    edgeRailway: packEdgeRailway([{ edge: 0, railway: { gaugeMm: 1668, secondGaugeMm: 0, electrification: 2, voltage: 25000, secondVoltage: 0, frequency: 4, secondFrequency: 0, usage: 1, service: 0 } }], edges),
  };

  it("says which network a profile belongs to", () => {
    const railway = Object.values(routingProfiles).filter((profile) => profile.networkKind === "railway").map((profile) => profile.name);
    expect(railway.sort()).toEqual(["metro", "train"]);
  });

  it("names the profile in the bundle header, before a tile is downloaded", async () => {
    const bundle = await encodeProfiledRoadGraphBundle([{
      id: 0, bounds: { minLat: 40.9, minLng: -8.7, maxLat: 41.1, maxLng: -8.5 }, graph: railGraph,
      profiles: [{
        profileId: ProfileId.train, maxSpeedKph: 300, edgeDurationScale: 1,
        edgeDurationsSeconds: railGraph.edgeDurationsSeconds as Uint16Array,
        edgeRailway: railGraph.edgeRailway,
      }],
    }], { compression: "none" });
    const { fetcher } = rangeFetcher(bundle);
    const opened = await openRoadGraphBundle("rail.efrb", fetcher);
    expect(opened.profileId).toBe(ProfileId.train);
    expect(getRoutingProfileById(opened.profileId)?.networkKind).toBe("railway");
    const graph = await opened.loadTiles(opened.tiles);
    expect(railwayOf(graph, 0)).toMatchObject({ gaugeMm: 1668 });
  });

  // A railway bundle still has no business accepting a lorry's dimensions.
  it("refuses vehicle dimensions a railway profile cannot act on", async () => {
    await expect(RoadRouter.open(railGraph, undefined, { vehicle: "articulated" }))
      .rejects.toThrow(/does not use vehicle dimensions/);
  });
});

describe("a file this build cannot read says so", () => {
  it("names an unsupported profile rather than routing with the wrong rules", () => {
    const chunk = encodeProfileChunk({
      profileId: ProfileId.train, maxSpeedKph: 300, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array,
    });
    // Byte 7 names the profile; a value no build knows must be refused.
    const corrupted = chunk.slice(0);
    new DataView(corrupted).setUint8(7, 99);
    expect(() => decodeProfileChunk(corrupted)).toThrow(/unsupported profile \(id 99\)/);
  });

  it("refuses to write a chunk for a profile that does not exist", () => {
    expect(() => encodeProfileChunk({
      profileId: 99, maxSpeedKph: 100, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array,
    })).toThrow(/unsupported profile/);
  });

  it("explains a shared chunk handed over on its own", () => {
    expect(() => decodeGraph(encodeSharedGraph(roadGraph))).toThrow(/combined with the shared chunk|stores several profiles/);
    expect(() => decodeSharedGraph(encodeCompactGraph(roadGraph))).toThrow(/Unsupported shared routing graph/);
  });

  it("reports a truncated railway chunk instead of reading past the end", () => {
    const railway = packEdgeRailway([{ edge: 0, railway: { gaugeMm: 1668, secondGaugeMm: 0, electrification: 2, voltage: 25000, secondVoltage: 0, frequency: 4, secondFrequency: 0, usage: 1, service: 0 } }], edges);
    const chunk = encodeProfileChunk({
      profileId: ProfileId.train, maxSpeedKph: 300, edgeDurationScale: 1,
      edgeDurationsSeconds: roadGraph.edgeDurationsSeconds as Uint16Array, edgeRailway: railway,
    });
    expect(() => decodeProfileChunk(chunk.slice(0, chunk.byteLength - 6))).toThrow(/Truncated/);
  });
});

describe("the public surface stayed where it was", () => {
  it("still answers to every road profile by name", () => {
    for (const name of ["car", "truck", "motorcycle", "bicycle", "pedestrian"]) {
      expect(getRoutingProfile(name).name).toBe(name);
      expect(getRoutingProfile(name).networkKind).toBe("road");
    }
  });

  it("opens a railway bundle through the same RoadRouter as a road one", async () => {
    const router = await RoadRouter.open({ ...roadGraph, profileId: ProfileId.train, maxSpeedKph: 300 });
    expect(router.profile).toBe("train");
  });
});
