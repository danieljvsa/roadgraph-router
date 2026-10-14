import { decodeGraph, encodeCompactGraph } from "./codec";
import { encodeRoadGraphBundle, openRoadGraphBundle } from "./bundle";
import { mergeRoadGraphs } from "./merge";
import { compactGraph } from "./compact";
import { route } from "./router";
import { ProfileId, carRoutingProfile, getRoutingProfileById, maxSpeedMpsFor, profileOf } from "./routing-profile";
import { buildGraph, pathOf, rangeFetcher } from "./test-support";
import type { RoadGraph } from "./types";

const grid = () => buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.99], C: [41.01, -7.99], D: [41.01, -8.0] },
  roads: ["A-B", "B-C", "C-D", "D-A"],
});

const roundTrip = (graph: RoadGraph) => decodeGraph(encodeCompactGraph(compactGraph(graph)));

describe("profile metadata in a packed graph", () => {
  it("carries the profile and its speed ceiling through a round trip", () => {
    const decoded = roundTrip({ ...grid(), profileId: ProfileId.car, maxSpeedKph: 110 });
    expect(decoded.profileId).toBe(ProfileId.car);
    expect(decoded.maxSpeedKph).toBe(110);
  });

  it("refuses an id that is reserved but not implemented in this build", () => {
    // A truck graph opened by a build with no truck rules would route a lorry
    // by car rules. Refusing is the point; this starts passing as a round trip
    // when the profile itself lands.
    expect(() => roundTrip({ ...grid(), profileId: ProfileId.truck })).toThrow(/unsupported profile/i);
  });

  it("writes nothing for a graph that names no profile", () => {
    const encoded = encodeCompactGraph(compactGraph(grid()));
    const view = new DataView(encoded);
    // The spare header bytes stay zero, which is what every bundle published
    // before this existed already holds.
    expect(view.getUint8(60)).toBe(0);
    expect(view.getUint16(62, true)).toBe(0);
    expect(decodeGraph(encoded).profileId).toBeUndefined();
  });

  it("reads a graph with no profile as a car graph", () => {
    const decoded = roundTrip(grid());
    expect(profileOf(decoded)).toBe(carRoutingProfile);
    expect(maxSpeedMpsFor(decoded)).toBeCloseTo((carRoutingProfile.maxSpeedKph * 1000) / 3600, 6);
  });

  it("prefers the stored ceiling over this build's table", () => {
    expect(maxSpeedMpsFor({ profileId: ProfileId.car, maxSpeedKph: 80 })).toBeCloseTo(80_000 / 3600, 6);
  });

  it("refuses a profile this build does not know", () => {
    const encoded = encodeCompactGraph(compactGraph(grid()));
    new DataView(encoded).setUint8(60, 200);
    expect(() => decodeGraph(encoded)).toThrow(/unsupported profile/i);
  });

  it("refuses an implausible speed ceiling", () => {
    const encoded = encodeCompactGraph(compactGraph(grid()));
    new DataView(encoded).setUint16(62, 9000, true);
    expect(() => decodeGraph(encoded)).toThrow(/implausible/i);
  });

  it("refuses to write a profiled graph into the legacy layout", () => {
    const graph = compactGraph(grid());
    expect(() => encodeCompactGraph({ ...graph, profileId: ProfileId.truck }, { layout: "legacy" })).toThrow(/legacy/i);
    expect(() => encodeCompactGraph(graph, { layout: "legacy" })).not.toThrow();
  });
});

describe("profile metadata in a bundle", () => {
  const bounds = { minLat: 40.99, minLng: -8.01, maxLat: 41.02, maxLng: -7.98 };

  it("is readable from the header before any tile is downloaded", async () => {
    const graph = { ...compactGraph(grid()), profileId: ProfileId.car, maxSpeedKph: 110 };
    const bundle = encodeRoadGraphBundle([{ id: 1, bounds, graph }]);
    const fetcher = rangeFetcher(bundle);
    const opened = await openRoadGraphBundle("https://example.test/car.efrb", fetcher.fetcher);
    expect(opened.profileId).toBe(ProfileId.car);
    expect(opened.maxSpeedKph).toBe(110);
    expect(opened.profiles).toEqual([ProfileId.car]);
    // Only the header and the directory, no chunk.
    expect(fetcher.stats.requests).toBe(2);
  });

  it("refuses at open a bundle whose profile this build cannot route", async () => {
    const graph = { ...compactGraph(grid()), profileId: ProfileId.pedestrian, maxSpeedKph: 6 };
    const bundle = encodeRoadGraphBundle([{ id: 1, bounds, graph }]);
    // Better here than on the first tile: nothing has been downloaded yet.
    await expect(openRoadGraphBundle("https://example.test/foot.efrb", rangeFetcher(bundle).fetcher))
      .rejects.toThrow(/does not support/i);
  });

  it("reads a bundle written before profiles as a car bundle", async () => {
    const bundle = encodeRoadGraphBundle([{ id: 1, bounds, graph: compactGraph(grid()) }]);
    const opened = await openRoadGraphBundle("https://example.test/car.efrb", rangeFetcher(bundle).fetcher);
    expect(opened.profileId).toBe(0);
    expect(profileOf({ profileId: opened.profileId })).toBe(carRoutingProfile);
  });

  it("refuses to build a bundle mixing profiles", () => {
    const car = compactGraph(grid());
    const foot = { ...compactGraph(grid()), profileId: ProfileId.pedestrian };
    expect(() => encodeRoadGraphBundle([
      { id: 1, bounds, graph: car },
      { id: 2, bounds, graph: foot },
    ])).toThrow(/different profiles/i);
  });
});

describe("merging graphs", () => {
  it("refuses to merge different profiles", () => {
    expect(() => mergeRoadGraphs([
      { ...grid(), profileId: ProfileId.car },
      { ...grid(), profileId: ProfileId.bicycle },
    ])).toThrow(/different routing profiles/i);
  });

  it("carries the profile onto the merged graph", () => {
    const merged = mergeRoadGraphs([
      { ...grid(), profileId: ProfileId.bicycle, maxSpeedKph: 25 },
      { ...grid(), profileId: ProfileId.bicycle, maxSpeedKph: 25 },
    ]);
    expect(merged.profileId).toBe(ProfileId.bicycle);
    expect(merged.maxSpeedKph).toBe(25);
  });
});

describe("the speed ceiling and routing", () => {
  it("returns the same route whichever ceiling the graph declares", () => {
    const graph = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.98], C: [41.0, -7.96], D: [41.005, -7.98] },
      roads: ["A-B", "B-C", "A-D", "D-C"],
      speedsKph: { "A-B": 90, "B-C": 90, "A-D": 20, "D-C": 20 },
    });
    const fast = route({ ...graph, profileId: ProfileId.car, maxSpeedKph: 150 }, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    const slow = route({ ...graph, profileId: ProfileId.car, maxSpeedKph: 20 }, { lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
    expect(pathOf(graph, fast.nodeIds)).toBe("A>B>C");
    expect(pathOf(graph, slow.nodeIds)).toBe(pathOf(graph, fast.nodeIds));
    expect(slow.durationSeconds).toBeCloseTo(fast.durationSeconds, 6);
  });

  it("names the profile when no route exists", () => {
    const split = buildGraph({
      nodes: { A: [41.0, -8.0], B: [41.0, -7.999], C: [41.5, -8.0], D: [41.5, -7.999] },
      roads: ["A-B", "C-D"],
    });
    expect(() => route({ ...split, profileId: ProfileId.car }, { lat: 41.0, lng: -8.0 }, { lat: 41.5, lng: -7.999 })).toThrow(/No car route/);
  });
});

it("maps every reserved id to at most one profile", () => {
  expect(getRoutingProfileById(ProfileId.car)).toBe(carRoutingProfile);
  expect(getRoutingProfileById(ProfileId.unspecified)).toBe(carRoutingProfile);
  expect(getRoutingProfileById(ProfileId.truck)).toBeNull();
  expect(getRoutingProfileById(99)).toBeNull();
});
