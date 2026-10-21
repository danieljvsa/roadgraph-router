/**
 * Constraints a caller got wrong, and the speeds a way states for itself.
 *
 * Both of these are about the same failure: a value that is quietly not what
 * it appears to be. A malformed constraint that is read rather than refused
 * closes the whole network and reports "no route" for what is really a typo;
 * a tagged speed that is quietly raised reports a journey shorter than the
 * infrastructure permits.
 */

import {
  RoadRouter, assertRailwayConstraints, packEdgeRailway, route, routeAlternatives,
  trainRoutingProfile, metroRoutingProfile, createTrainProfile, UNKNOWN_RAILWAY,
} from "./index";
import type { EdgeRailway, RailwayAttributes, RoadGraph } from "./index";
import { ProfileId } from "./index";
import { buildGraph } from "./test-support";

/* ------------------------------------------------------- the speeds ----- */

const train = trainRoutingProfile;
const speeds = (tags: Record<string, string | undefined>) => {
  const traversal = train.evaluateWay({ railway: "rail", ...tags });
  return traversal && { forward: traversal.forwardSpeedKph, backward: traversal.backwardSpeedKph };
};

describe("the speed a railway way states for itself", () => {
  // The bug this covers: a floor of 5 km/h was applied to tagged values as
  // well as assumed ones, so a track signed at 3 was routed at 5 — faster
  // than the limit, and arriving sooner than the track allows.
  it("uses a stated limit as stated, however slow", () => {
    expect(speeds({ maxspeed: "3" })).toEqual({ forward: 3, backward: 3 });
    expect(speeds({ maxspeed: "5" })).toEqual({ forward: 5, backward: 5 });
    expect(speeds({ maxspeed: "30" })).toEqual({ forward: 30, backward: 30 });
    expect(speeds({ maxspeed: "1" })).toEqual({ forward: 1, backward: 1 });
    // A funicular tagged `maxspeed=2.52` is in the Portugal extract.
    expect(speeds({ maxspeed: "2.52" })?.forward).toBeCloseTo(2.52, 5);
  });

  it("converts the units the data actually uses", () => {
    // 896 Irish `railway=rail` ways are signed in miles per hour.
    expect(speeds({ maxspeed: "80 mph" })?.forward).toBeCloseTo(128.75, 2);
    expect(speeds({ maxspeed: "70 mph" })?.forward).toBeCloseTo(112.65, 2);
    expect(speeds({ maxspeed: "100 km/h" })?.forward).toBe(100);
  });

  it("reads a limit signed for one direction only", () => {
    expect(speeds({ maxspeed: "100", "maxspeed:forward": "20" })).toEqual({ forward: 20, backward: 100 });
    expect(speeds({ maxspeed: "100", "maxspeed:backward": "40" })).toEqual({ forward: 100, backward: 40 });
    expect(speeds({ "maxspeed:forward": "20", "maxspeed:backward": "40" })).toEqual({ forward: 20, backward: 40 });
  });

  // Where nothing is stated, a floor still applies: an assumed speed of zero
  // would be a free edge, which a search takes as a shortcut.
  it("keeps a floor under an assumed speed, where the way states none", () => {
    expect(speeds({ usage: "main" })).toEqual({ forward: 100, backward: 100 });
    expect(speeds({ service: "siding" })).toEqual({ forward: 25, backward: 25 });
    expect(speeds({})).toEqual({ forward: 100, backward: 100 });
  });

  it("still holds every speed under the profile's own ceiling", () => {
    expect(speeds({ maxspeed: "500" })).toEqual({ forward: 300, backward: 300 });
    expect(metroRoutingProfile.evaluateWay({ railway: "subway", maxspeed: "400" })?.forwardSpeedKph).toBe(120);
    expect(train.maxSpeedKph).toBe(300);
  });

  // An unreadable value is not a speed, and falls back to the assumption
  // rather than to zero or to the text's length or anything else.
  it("falls back where the value is not a speed at all", () => {
    for (const value of ["none", "signals", "variable", "PT:urban", "", "-5", "0"]) {
      expect(speeds({ maxspeed: value, usage: "branch" })).toEqual({ forward: 80, backward: 80 });
    }
  });

  // A slower edge only ever costs more, so the heuristic built from the
  // profile's ceiling stays a lower bound and A* stays admissible.
  it("never reports a speed above the ceiling the heuristic is built from", () => {
    for (const profile of [train, metroRoutingProfile, createTrainProfile({ include: ["funicular"] })]) {
      for (const value of ["1", "3", "80 mph", "500", "220", undefined]) {
        const traversal = profile.evaluateWay({ railway: profile === metroRoutingProfile ? "subway" : "rail", ...(value ? { maxspeed: value } : {}) });
        if (!traversal) continue;
        expect(traversal.forwardSpeedKph).toBeLessThanOrEqual(profile.maxSpeedKph);
        expect(traversal.forwardSpeedKph).toBeGreaterThan(0);
      }
    }
  });
});

/* --------------------------------------------------- the constraints ---- */

describe("constraints a caller got wrong", () => {
  const rejected = (constraints: unknown) => {
    expect(() => assertRailwayConstraints(constraints)).toThrow(RangeError);
    try { assertRailwayConstraints(constraints); } catch (error) { return (error as Error).message; }
    throw new Error("expected a rejection");
  };

  it("refuses the malformed values named in the review", () => {
    expect(rejected({ gaugeMm: -1 })).toMatch(/gaugeMm must be a whole number/);
    expect(rejected({ gaugeMm: NaN })).toMatch(/gaugeMm must be a whole number/);
    expect(rejected({ voltage: Infinity })).toMatch(/voltage must be a number/);
    expect(rejected({ voltage: -25000 })).toMatch(/voltage must be a number/);
    expect(rejected({ frequency: "invalid" })).toMatch(/frequency must be one of/);
    expect(rejected({ gaugeMm: [] })).toMatch(/non-empty list/);
    expect(rejected({ usage: ["invalid"] })).toMatch(/usage must be one of/);
  });

  it("refuses values of the wrong shape", () => {
    expect(rejected({ gaugeMm: "1668" })).toMatch(/gaugeMm/);
    expect(rejected({ gaugeMm: 1668.5 })).toMatch(/whole number/);
    expect(rejected({ requireElectrification: "yes" })).toMatch(/true or false/);
    expect(rejected({ excludeServiceTracks: 1 })).toMatch(/true or false/);
    expect(rejected({ strictUnknown: null })).toMatch(/true or false/);
    expect(rejected({ usage: "main" })).toMatch(/must be a list of/);
    expect(rejected({ voltage: [] })).toMatch(/non-empty list/);
    expect(rejected({ frequency: ["50", "nope"] })).toMatch(/frequency must be one of/);
    expect(rejected([])).toMatch(/must be an object/);
    expect(rejected("1668")).toMatch(/must be an object/);
  });

  it("refuses a value outside what a railway could be", () => {
    expect(rejected({ gaugeMm: 99 })).toMatch(/between 100 and 65535/);
    expect(rejected({ gaugeMm: 70000 })).toMatch(/between 100 and 65535/);
    expect(rejected({ voltage: 0 })).toMatch(/between 1 and 65535/);
    expect(rejected({ voltage: 1e9 })).toMatch(/between 1 and 65535/);
  });

  // A misspelled constraint is one that silently does not apply, which is the
  // most expensive kind of mistake to find.
  it("refuses a key that is not a constraint, and says what the constraints are", () => {
    expect(rejected({ gauge: 1668 })).toMatch(/gauge is not a railway constraint.*gaugeMm/s);
    expect(rejected({ electrified: true })).toMatch(/not a railway constraint/);
    expect(rejected({ gaugeMM: 1668 })).toMatch(/not a railway constraint/);
  });

  it("accepts everything the documentation offers", () => {
    for (const constraints of [
      undefined, null, {},
      { gaugeMm: 1668 }, { gaugeMm: [1668, 1435, 1000] },
      { voltage: 25000 }, { voltage: [25000, 1500, 750] },
      { frequency: "dc" as const }, { frequency: ["50", "16.7"] as const },
      { usage: ["main", "branch"] as const },
      { requireElectrification: true }, { excludeServiceTracks: true }, { strictUnknown: true },
      { gaugeMm: 1668, requireElectrification: true, voltage: 25000, frequency: "50" as const, usage: ["main"] as const, excludeServiceTracks: false, strictUnknown: false },
      // An explicit `undefined` is "not asked", not a malformed value.
      { gaugeMm: undefined, strictUnknown: undefined },
    ]) {
      expect(() => assertRailwayConstraints(constraints)).not.toThrow();
    }
  });
});

/* ------------------------------------- where the validation is applied --- */

const LINHA_DO_NORTE: RailwayAttributes = {
  gaugeMm: 1668, secondGaugeMm: 0, electrification: 2, voltage: 25000, secondVoltage: 0,
  frequency: 4, secondFrequency: 0, usage: 1, service: 0,
};

function railGraph(): RoadGraph {
  const graph = buildGraph({
    nodes: { A: [41.0, -8.60], B: [41.0, -8.59], C: [41.0, -8.58] },
    roads: ["A-B", "B-C"],
  });
  const described = Array.from({ length: graph.edgeTargets.length }, (_, edge) => ({ edge, railway: LINHA_DO_NORTE }));
  return {
    ...graph,
    profileId: ProfileId.train,
    maxSpeedKph: 300,
    edgeRailway: packEdgeRailway(described, graph.edgeTargets.length) as EdgeRailway,
  };
}

describe("a bad constraint is caught before any work is done", () => {
  const graph = railGraph();
  const from = { lat: 41.0, lng: -8.60 };
  const to = { lat: 41.0, lng: -8.58 };

  it("is refused by route()", () => {
    expect(() => route(graph, from, to, "shortest", { railway: { gaugeMm: -1 } as never })).toThrow(/gaugeMm/);
    expect(route(graph, from, to, "shortest", { railway: { gaugeMm: 1668 } }).distanceMeters).toBeGreaterThan(0);
  });

  it("is refused by routeAlternatives()", () => {
    expect(() => routeAlternatives(graph, from, to, "shortest", { railway: { frequency: "invalid" } as never })).toThrow(/frequency/);
    expect(routeAlternatives(graph, from, to, "shortest", { railway: { frequency: "50" } }).length).toBeGreaterThan(0);
  });

  // The point of checking here is that it happens before a bundle's header,
  // directory or any tile has been fetched.
  it("is refused by RoadRouter.open, before anything is downloaded", async () => {
    let fetched = 0;
    const counting = async () => { fetched += 1; return new Response(new Uint8Array(0), { status: 206 }); };
    await expect(RoadRouter.open("rail.efrb", counting, { railway: { voltage: Infinity } as never })).rejects.toThrow(/voltage/);
    expect(fetched).toBe(0);
  });

  it("is refused by a per-route override on a router that is already open", async () => {
    const router = await RoadRouter.open(graph);
    await expect(router.route(from, to, "shortest", { railway: { usage: ["nope"] } as never })).rejects.toThrow(/usage/);
    expect((await router.route(from, to, "shortest", { railway: { usage: ["main"] } })).distanceMeters).toBeGreaterThan(0);
  });

  // Nothing about this reaches a road graph, which has no constraints to get
  // wrong and must keep behaving exactly as it did.
  it("leaves a road route alone", () => {
    const road = buildGraph({ nodes: { A: [41.0, -8.60], B: [41.0, -8.59] }, roads: ["A-B"] });
    expect(() => route(road, { lat: 41.0, lng: -8.60 }, { lat: 41.0, lng: -8.59 }, "fastest")).not.toThrow();
    expect(() => assertRailwayConstraints(undefined)).not.toThrow();
  });
});

describe("an unknown-but-valid constraint still behaves", () => {
  it("treats an all-unknown table under strictUnknown as a closed network", () => {
    const graph = railGraph();
    const silent = { ...graph, edgeRailway: packEdgeRailway([{ edge: 0, railway: UNKNOWN_RAILWAY }], graph.edgeTargets.length) };
    expect(silent.edgeRailway).toBeUndefined();
    expect(() => route({ ...silent, edgeRailway: undefined }, { lat: 41.0, lng: -8.60 }, { lat: 41.0, lng: -8.58 }, "shortest",
      { finishOnANearbyRoad: false, railway: { gaugeMm: 1668, strictUnknown: true } })).toThrow();
  });
});
