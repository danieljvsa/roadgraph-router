import {
  Electrification, ProfileId, RailFrequency, RailService, RailUsage, UNKNOWN_RAILWAY,
  accessForRailway, combineProfiledGraph, countRailwayBlocked, decodeProfileChunk, decodeSharedGraph,
  edgeAllowed, encodeProfileChunk, encodeSharedGraph, packEdgeRailway, parseElectrification, parseFrequency,
  parseGaugeMm, parseService, parseUsage, parseVoltage, railwayAttributesFor, railwayCertainty, railwayOf, railwayRefusal,
} from "./index";
import type { EdgeRailway, RailwayAttributes, RailwayConstraints, RoadGraph } from "./index";
import { buildGraph } from "./test-support";

/* ------------------------------------------------------------- parsing --- */

describe("reading a gauge", () => {
  it("reads the gauges the data actually holds", () => {
    expect(parseGaugeMm("1668")).toEqual({ gaugeMm: 1668, secondGaugeMm: 0 });
    expect(parseGaugeMm("1435")).toEqual({ gaugeMm: 1435, secondGaugeMm: 0 });
    expect(parseGaugeMm("1000")).toEqual({ gaugeMm: 1000, secondGaugeMm: 0 });
  });

  // `gauge=1000;1668` is a real tag on Portuguese track: one formation, two
  // gauges, usable by trains of either.
  it("reads a dual-gauge track as both of its gauges", () => {
    expect(parseGaugeMm("1000;1668")).toEqual({ gaugeMm: 1000, secondGaugeMm: 1668 });
    expect(parseGaugeMm("1668;1000")).toEqual({ gaugeMm: 1000, secondGaugeMm: 1668 });
  });

  // Guessing that `standard` means 1435 is how a train ends up on track it
  // cannot run on; an unreadable gauge is unknown instead.
  it("treats anything that is not a measurement as unstated", () => {
    for (const value of [undefined, "", "standard", "narrow", "broad", "-1", "0"]) {
      expect(parseGaugeMm(value)).toEqual({ gaugeMm: 0, secondGaugeMm: 0 });
    }
  });
});

describe("reading an electrical system", () => {
  it("tells an unelectrified track from an undescribed one", () => {
    expect(parseElectrification("no")).toBe(Electrification.none);
    expect(parseElectrification(undefined)).toBe(Electrification.unknown);
    expect(parseElectrification("")).toBe(Electrification.unknown);
  });

  it("reads the systems the data holds", () => {
    expect(parseElectrification("contact_line")).toBe(Electrification.contactLine);
    expect(parseElectrification("rail")).toBe(Electrification.conductorRail);
    expect(parseElectrification("4th_rail")).toBe(Electrification.conductorRail);
    expect(parseElectrification("yes")).toBe(Electrification.yes);
    expect(parseElectrification("something_new")).toBe(Electrification.other);
  });

  it("reads a voltage, including the form the data really uses", () => {
    expect(parseVoltage("25000")).toEqual({ voltage: 25000, secondVoltage: 0 });
    expect(parseVoltage("750v")).toEqual({ voltage: 750, secondVoltage: 0 });
    expect(parseVoltage("1.5kV")).toEqual({ voltage: 1500, secondVoltage: 0 });
    expect(parseVoltage(undefined)).toEqual({ voltage: 0, secondVoltage: 0 });
    expect(parseVoltage("high")).toEqual({ voltage: 0, secondVoltage: 0 });
  });

  // A changeover line states both systems, and a train taking either can run
  // over it. 176 Swiss ways carry `frequency=0;16.7`, and 201 carry
  // `gauge=1000;1435`; keeping only the first value would turn a usable line
  // into a refusal.
  it("keeps both systems of a dual-system track", () => {
    expect(parseVoltage("1500;25000")).toEqual({ voltage: 1500, secondVoltage: 25000 });
    expect(parseFrequency("0;16.7")).toEqual({ frequency: RailFrequency.dc, secondFrequency: RailFrequency.hz16_7 });
    expect(parseFrequency("50;16.7")).toEqual({ frequency: RailFrequency.hz16_7, secondFrequency: RailFrequency.hz50 });
  });

  // `frequency=0` is a statement that the line is direct current. An absent
  // frequency is not, and conflating them would let a DC-only vehicle be
  // routed over an unsurveyed AC line as though it had been checked.
  it("tells direct current from an unstated frequency", () => {
    expect(parseFrequency("0").frequency).toBe(RailFrequency.dc);
    expect(parseFrequency(undefined).frequency).toBe(RailFrequency.unknown);
    expect(parseFrequency("50").frequency).toBe(RailFrequency.hz50);
    expect(parseFrequency("60").frequency).toBe(RailFrequency.hz60);
    expect(parseFrequency("25").frequency).toBe(RailFrequency.hz25);
    // `16 2/3` and `16.67` are the same Swiss and German system written three
    // ways; 29,992 Swiss ways carry one of them.
    for (const value of ["16.7", "16.67", "16 2/3", "16,7"]) expect(parseFrequency(value).frequency).toBe(RailFrequency.hz16_7);
  });
});

describe("reading what a line is for", () => {
  it("reads usage", () => {
    expect(parseUsage("main")).toBe(RailUsage.main);
    expect(parseUsage("branch")).toBe(RailUsage.branch);
    expect(parseUsage("industrial")).toBe(RailUsage.industrial);
    expect(parseUsage(undefined)).toBe(RailUsage.unknown);
    expect(parseUsage("something_new")).toBe(RailUsage.other);
  });

  // This is the one key where silence carries a meaning: in OSM, a track with
  // no `service` tag is a running line, not an unsurveyed one.
  it("reads an absent service tag as a running line", () => {
    expect(parseService(undefined)).toBe(RailService.running);
    expect(parseService("siding")).toBe(RailService.siding);
    expect(parseService("yard")).toBe(RailService.yard);
    expect(parseService("spur")).toBe(RailService.spur);
    expect(parseService("crossover")).toBe(RailService.crossover);
  });

  it("reads a whole way at once", () => {
    expect(railwayAttributesFor({})).toEqual(UNKNOWN_RAILWAY);
  });
});

/* ------------------------------------------------------------- storage --- */

const LINHA_DO_NORTE: RailwayAttributes = { gaugeMm: 1668, secondGaugeMm: 0, electrification: Electrification.contactLine, voltage: 25000, secondVoltage: 0, frequency: RailFrequency.hz50, secondFrequency: RailFrequency.unknown, usage: RailUsage.main, service: RailService.running };
const SIDING: RailwayAttributes = { ...LINHA_DO_NORTE, usage: RailUsage.unknown, service: RailService.siding };
const UNELECTRIFIED_METRE: RailwayAttributes = { gaugeMm: 1000, secondGaugeMm: 0, electrification: Electrification.none, voltage: 0, secondVoltage: 0, frequency: RailFrequency.unknown, secondFrequency: RailFrequency.unknown, usage: RailUsage.branch, service: RailService.running };

describe("storing what the track is", () => {
  it("folds every edge saying the same thing onto one row", () => {
    const table = packEdgeRailway([0, 1, 2, 3].map((edge) => ({ edge, railway: LINHA_DO_NORTE })), 4)!;
    // Row 0 is the empty row, so one distinct statement makes two rows in all.
    expect(table.gaugeMm.length).toBe(2);
    expect([...table.edgeRows]).toEqual([1, 1, 1, 1]);
  });

  it("keeps distinct statements apart", () => {
    const table = packEdgeRailway([
      { edge: 0, railway: LINHA_DO_NORTE }, { edge: 1, railway: SIDING }, { edge: 2, railway: UNELECTRIFIED_METRE },
    ], 4)!;
    expect(table.gaugeMm.length).toBe(4);
    // Edge 3 was never described, so it points at the row that says nothing.
    expect(table.edgeRows[3]).toBe(0);
  });

  it("says nothing at all rather than storing a table of nothing", () => {
    expect(packEdgeRailway([{ edge: 0, railway: UNKNOWN_RAILWAY }], 2)).toBeUndefined();
    expect(packEdgeRailway([], 2)).toBeUndefined();
  });

  it("refuses to describe an edge that is not in the graph", () => {
    expect(() => packEdgeRailway([{ edge: 9, railway: LINHA_DO_NORTE }], 4)).toThrow(/outside the graph/);
  });

  it("reads one edge back out", () => {
    const edgeRailway = packEdgeRailway([{ edge: 1, railway: LINHA_DO_NORTE }], 3)!;
    expect(railwayOf({ edgeRailway }, 1)).toEqual(LINHA_DO_NORTE);
    expect(railwayOf({ edgeRailway }, 0)).toEqual(UNKNOWN_RAILWAY);
    expect(railwayOf({ edgeRailway: undefined }, 0)).toBeUndefined();
  });
});

/* --------------------------------------------------------- constraints --- */

const refuse = (railway: RailwayAttributes, constraints: RailwayConstraints) => railwayRefusal(railway, constraints);

describe("deciding whether a train can run on a track", () => {
  it("asks nothing when nothing was asked", () => {
    expect(refuse(UNELECTRIFIED_METRE, {})).toBeNull();
  });

  it("keeps a train off track of a gauge it cannot run on", () => {
    expect(refuse(LINHA_DO_NORTE, { gaugeMm: 1668 })).toBeNull();
    expect(refuse(UNELECTRIFIED_METRE, { gaugeMm: 1668 })).toMatch(/1000 mm gauge/);
    // A gauge-changing or dual-gauge vehicle takes a list.
    expect(refuse(UNELECTRIFIED_METRE, { gaugeMm: [1668, 1000] })).toBeNull();
  });

  it("lets either gauge of a dual-gauge track answer", () => {
    const dual: RailwayAttributes = { ...LINHA_DO_NORTE, gaugeMm: 1000, secondGaugeMm: 1668 };
    expect(refuse(dual, { gaugeMm: 1668 })).toBeNull();
    expect(refuse(dual, { gaugeMm: 1000 })).toBeNull();
    expect(refuse(dual, { gaugeMm: 1435 })).toMatch(/1000\/1668 mm gauge/);
  });

  it("keeps an electric train off track stated to be unelectrified", () => {
    expect(refuse(UNELECTRIFIED_METRE, { requireElectrification: true })).toMatch(/unelectrified/);
    expect(refuse(LINHA_DO_NORTE, { requireElectrification: true })).toBeNull();
  });

  it("matches the electrical system, not just the presence of one", () => {
    expect(refuse(LINHA_DO_NORTE, { voltage: 750 })).toMatch(/25000 V/);
    expect(refuse(LINHA_DO_NORTE, { voltage: [25000, 1500] })).toBeNull();
    expect(refuse(LINHA_DO_NORTE, { frequency: "dc" })).toMatch(/different electrical frequency/);
    expect(refuse(LINHA_DO_NORTE, { frequency: ["50", "dc"] })).toBeNull();
    // Either system of a changeover line answers for a train taking it.
    const changeover: RailwayAttributes = { ...LINHA_DO_NORTE, voltage: 1500, secondVoltage: 25000, frequency: RailFrequency.dc, secondFrequency: RailFrequency.hz50 };
    expect(refuse(changeover, { voltage: 25000, frequency: "50" })).toBeNull();
    expect(refuse(changeover, { voltage: 1500, frequency: "dc" })).toBeNull();
    expect(refuse(changeover, { voltage: 750 })).toMatch(/1500\/25000 V/);
  });

  it("keeps a route off sidings and yards when asked", () => {
    expect(refuse(SIDING, { excludeServiceTracks: true })).toMatch(/siding, yard, spur or crossover/);
    expect(refuse(LINHA_DO_NORTE, { excludeServiceTracks: true })).toBeNull();
  });

  it("keeps a route to the usages asked for", () => {
    expect(refuse(LINHA_DO_NORTE, { usage: ["main"] })).toBeNull();
    expect(refuse(UNELECTRIFIED_METRE, { usage: ["main"] })).toMatch(/different usage/);
  });
});

describe("the policy for a track that states nothing", () => {
  const silent = UNKNOWN_RAILWAY;

  // Silence in OSM is an absent survey, not a statement of incompatibility.
  // Excluding every unstated track would reduce most networks to nothing.
  it("does not exclude a track for failing to answer", () => {
    expect(refuse(silent, { gaugeMm: 1668 })).toBeNull();
    expect(refuse(silent, { requireElectrification: true })).toBeNull();
    expect(refuse(silent, { voltage: 25000 })).toBeNull();
    expect(refuse(silent, { frequency: "50" })).toBeNull();
    expect(refuse(silent, { usage: ["main"] })).toBeNull();
  });

  // ...and it never claims the silence was an answer. `strictUnknown` is for
  // a caller who would rather have no route than an unverified one.
  it("excludes it on request, naming what was not stated", () => {
    expect(refuse(silent, { gaugeMm: 1668, strictUnknown: true })).toMatch(/states no gauge/);
    expect(refuse(silent, { requireElectrification: true, strictUnknown: true })).toMatch(/states no electrification/);
    expect(refuse(silent, { voltage: 25000, strictUnknown: true })).toMatch(/states no voltage/);
    expect(refuse(silent, { frequency: "50", strictUnknown: true })).toMatch(/states no frequency/);
    expect(refuse(silent, { usage: ["main"], strictUnknown: true })).toMatch(/states no usage/);
  });

  // A stated fact outranks strictness: being told the gauge is 1668 is an
  // answer, so a 1668 train is not turned away for want of a survey.
  it("still accepts a track that did answer", () => {
    expect(refuse(LINHA_DO_NORTE, { gaugeMm: 1668, requireElectrification: true, voltage: 25000, frequency: "50", strictUnknown: true })).toBeNull();
  });
});

/* ------------------------------------------------------------ the mask --- */

function railwayGraph(railwayByEdge: (RailwayAttributes | null)[]): RoadGraph {
  const graph = buildGraph({
    nodes: { A: [41, -8.6], B: [41, -8.59], C: [41, -8.58], D: [41.001, -8.59] },
    roads: ["A>B", "B>C", "B>D"],
  });
  const described = railwayByEdge.flatMap((railway, edge) => railway ? [{ edge, railway }] : []);
  return { ...graph, edgeRailway: packEdgeRailway(described, graph.edgeTargets.length) as EdgeRailway };
}

describe("turning constraints into an access mask", () => {
  it("leaves the mask alone when nothing is constrained", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNELECTRIFIED_METRE, LINHA_DO_NORTE]);
    expect(accessForRailway(graph, undefined)).toBeUndefined();
    expect(accessForRailway(graph, {})).toBeUndefined();
    expect(accessForRailway(graph, { strictUnknown: true })).toBeUndefined();
  });

  it("closes exactly the edges the track rules out", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNELECTRIFIED_METRE, LINHA_DO_NORTE]);
    const mask = accessForRailway(graph, { gaugeMm: 1668 })!;
    expect(edgeAllowed(mask, 0)).toBe(true);
    expect(edgeAllowed(mask, 1)).toBe(false);
    expect(edgeAllowed(mask, 2)).toBe(true);
    expect(countRailwayBlocked(graph, { gaugeMm: 1668 })).toBe(1);
  });

  // The mask narrows whatever it is handed, exactly as the vehicle mask does,
  // so the two compose in either order.
  it("narrows the mask it is given rather than replacing it", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNELECTRIFIED_METRE, LINHA_DO_NORTE]);
    const base = new Uint8Array([0b011]); // edge 2 already closed
    const mask = accessForRailway(graph, { gaugeMm: 1668 }, base)!;
    expect(edgeAllowed(mask, 0)).toBe(true);
    expect(edgeAllowed(mask, 1)).toBe(false);
    expect(edgeAllowed(mask, 2)).toBe(false);
    expect([...base]).toEqual([0b011]);
  });

  it("does nothing to a graph that holds no track description", () => {
    const graph = buildGraph({ nodes: { A: [41, -8.6], B: [41, -8.59] }, roads: ["A-B"] });
    expect(accessForRailway(graph, { gaugeMm: 1668 })).toBeUndefined();
  });
});

/* ----------------------------------------------------------- certainty --- */

describe("saying how much of a route was actually surveyed", () => {
  it("separates track that answered from track that did not", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNKNOWN_RAILWAY, LINHA_DO_NORTE]);
    const certainty = railwayCertainty(graph, [0, 1], { gaugeMm: 1668 });
    expect(certainty.statedMeters).toBeGreaterThan(0);
    expect(certainty.unstatedMeters).toBeGreaterThan(0);
    expect(certainty.unstated).toEqual(["gauge"]);
    expect(certainty.gauges).toEqual([1668]);
  });

  it("reports a gauge change along the route, which no constraint was asked to catch", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNELECTRIFIED_METRE, LINHA_DO_NORTE]);
    expect(railwayCertainty(graph, [0, 1, 2]).gauges).toEqual([1000, 1668]);
  });

  it("reports how far the route ran over service track", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, SIDING, LINHA_DO_NORTE]);
    expect(railwayCertainty(graph, [0, 1]).serviceTrackMeters).toBeGreaterThan(0);
    expect(railwayCertainty(graph, [0, 2]).serviceTrackMeters).toBe(0);
  });

  it("asks nothing of track where nothing was constrained", () => {
    const graph = railwayGraph([LINHA_DO_NORTE, UNKNOWN_RAILWAY, UNKNOWN_RAILWAY]);
    expect(railwayCertainty(graph, [0, 1], {}).unstated).toEqual([]);
    expect(railwayCertainty(graph, [0, 1], {}).unstatedMeters).toBe(0);
  });

  // A graph with no table at all cannot vouch for a single metre of itself,
  // and says so rather than reporting silence as agreement.
  it("reports a graph that describes no track at all as entirely unstated", () => {
    const bare = buildGraph({ nodes: { A: [41, -8.6], B: [41, -8.59] }, roads: ["A-B"] });
    const certainty = railwayCertainty(bare, [0], { gaugeMm: 1668 });
    expect(certainty.statedMeters).toBe(0);
    expect(certainty.unstatedMeters).toBeGreaterThan(0);
    expect(certainty.unstated).toEqual(["railway attributes"]);
  });
});

/* -------------------------------------------------------------- binary --- */

describe("writing the track description into a bundle", () => {
  const graph = railwayGraph([LINHA_DO_NORTE, SIDING, UNELECTRIFIED_METRE]);
  const edges = graph.edgeTargets.length;

  const chunk = () => ({
    profileId: ProfileId.train,
    maxSpeedKph: 300,
    edgeDurationScale: 1,
    edgeDurationsSeconds: Uint16Array.from({ length: edges }, () => 10),
    edgeRailway: graph.edgeRailway,
  });

  it("survives a round trip through a profile chunk", () => {
    const decoded = decodeProfileChunk(encodeProfileChunk(chunk()));
    expect(decoded.profileId).toBe(ProfileId.train);
    expect(decoded.edgeRailway).toEqual(graph.edgeRailway);
  });

  it("reaches the routable graph through the shared chunk it belongs to", () => {
    const shared = decodeSharedGraph(encodeSharedGraph({ ...graph, nodeLatitudes: graph.nodeLatitudes as Int32Array, edgeDistancesMeters: Uint16Array.from(graph.edgeDistancesMeters), edgeDurationsSeconds: Uint16Array.from({ length: edges }, () => 1) }));
    const combined = combineProfiledGraph(shared, decodeProfileChunk(encodeProfileChunk(chunk())));
    expect(railwayOf(combined, 0)).toEqual(LINHA_DO_NORTE);
    expect(railwayOf(combined, 2)).toEqual(UNELECTRIFIED_METRE);
    expect(countRailwayBlocked(combined, { gaugeMm: 1668 })).toBe(1);
  });

  // A road vehicle has no track to describe, so its chunk must come out
  // exactly as long as it always did.
  it("costs a road profile nothing at all", () => {
    const withoutTrack = { ...chunk(), profileId: ProfileId.car, maxSpeedKph: 150, edgeRailway: undefined };
    expect(decodeProfileChunk(encodeProfileChunk(withoutTrack)).edgeRailway).toBeUndefined();
    expect(encodeProfileChunk(withoutTrack).byteLength).toBeLessThan(encodeProfileChunk(chunk()).byteLength);
  });

  it("refuses a table that does not match the graph", () => {
    expect(() => encodeProfileChunk({ ...chunk(), edgeRailway: { ...graph.edgeRailway!, edgeRows: new Uint16Array(2) } }))
      .toThrow(/row for every edge/);
    expect(() => encodeProfileChunk({ ...chunk(), edgeRailway: { ...graph.edgeRailway!, edgeRows: Uint16Array.from({ length: edges }, () => 99) } }))
      .toThrow(/not in the table/);
    expect(() => encodeProfileChunk({ ...chunk(), edgeRailway: { ...graph.edgeRailway!, usage: new Uint8Array(1) } }))
      .toThrow(/same length/);
  });

  it("reports a truncated chunk rather than reading past the end", () => {
    const encoded = encodeProfileChunk(chunk());
    expect(() => decodeProfileChunk(encoded.slice(0, encoded.byteLength - 4))).toThrow(/Truncated/);
  });
});
