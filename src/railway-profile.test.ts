import {
  Electrification, ProfileId, RailFrequency, RailService, RailUsage,
  createMetroProfile, createTrainProfile, getRoutingProfile, getRoutingProfileById,
  metroRoutingProfile, routingProfiles, trainRoutingProfile,
} from "./index";
import type { OsmTags, RoutingProfile } from "./index";

const train = trainRoutingProfile;
const metro = metroRoutingProfile;

const way = (profile: RoutingProfile, tags: OsmTags) => profile.evaluateWay(tags);
const usable = (profile: RoutingProfile, tags: OsmTags) => way(profile, tags) !== null;

describe("picking a railway profile", () => {
  it("offers train and metro by name, on the ids the format reserved", () => {
    expect(getRoutingProfile("train")).toBe(train);
    expect(getRoutingProfile("metro")).toBe(metro);
    expect(train.id).toBe(ProfileId.train);
    expect(metro.id).toBe(ProfileId.metro);
    expect(getRoutingProfileById(ProfileId.train)).toBe(train);
    expect(getRoutingProfileById(ProfileId.metro)).toBe(metro);
  });

  // The ids are part of the file format. Reusing one would make an older
  // bundle read back as the wrong vehicle, silently.
  it("gives every profile an id of its own, and leaves the road ones where they were", () => {
    const ids = Object.values(routingProfiles).map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ProfileId.car).toBe(1);
    expect(ProfileId.truck).toBe(2);
    expect(ProfileId.motorcycle).toBe(3);
    expect(ProfileId.bicycle).toBe(4);
    expect(ProfileId.pedestrian).toBe(5);
    expect(ProfileId.train).toBe(6);
    expect(ProfileId.metro).toBe(7);
  });

  it("says which network each profile travels over", () => {
    expect(train.networkKind).toBe("railway");
    expect(metro.networkKind).toBe("railway");
    for (const name of ["car", "truck", "motorcycle", "bicycle", "pedestrian"]) {
      expect(getRoutingProfile(name).networkKind).toBe("road");
    }
  });

  it("asks for railway tags and not for road ones", () => {
    for (const profile of [train, metro]) {
      expect(profile.wayTagKeys).toContain("railway");
      expect(profile.wayTagKeys).toContain("gauge");
      expect(profile.wayTagKeys).toContain("electrified");
      expect(profile.wayTagKeys).not.toContain("highway");
      expect(profile.wayTagKeys).not.toContain("motor_vehicle");
      expect(profile.relationTagKeys).toEqual([]);
    }
  });
});

describe("which track a train routes over", () => {
  it("routes over railway=rail", () => {
    expect(usable(train, { railway: "rail" })).toBe(true);
  });

  // An allowlist, not a denylist: `railway` carries dozens of values that are
  // not track, and a denylist would route trains along station platforms the
  // first time OSM invented a new one.
  it("refuses everything that is not track at all", () => {
    for (const railway of ["platform", "station", "turntable", "ventilation_shaft", "workshop", "halt", "signal_box", "subway_entrance", "something_new"]) {
      expect(usable(train, { railway })).toBe(false);
      expect(usable(metro, { railway })).toBe(false);
    }
  });

  it("refuses track that is gone, unbuilt or under construction", () => {
    for (const railway of ["abandoned", "razed", "dismantled", "demolished", "proposed", "construction"]) {
      expect(usable(train, { railway })).toBe(false);
    }
  });

  // The rails are still there, but nothing has run over them and OSM does not
  // say whether anything could. Excluded by default; available on request.
  it("leaves disused track out by default and lets a caller ask for it", () => {
    expect(usable(train, { railway: "disused" })).toBe(false);
    expect(usable(createTrainProfile({ include: ["disused"] }), { railway: "disused" })).toBe(true);
    // Asking for disused track does not also bring back track that was lifted.
    expect(usable(createTrainProfile({ include: ["disused"] }), { railway: "abandoned" })).toBe(false);
  });

  it("leaves narrow gauge out by default, because it is track a standard train cannot use", () => {
    expect(usable(train, { railway: "narrow_gauge" })).toBe(false);
    expect(usable(createTrainProfile({ include: ["narrow_gauge"] }), { railway: "narrow_gauge" })).toBe(true);
  });

  it("does not route a train over a metro, or a metro over a main line", () => {
    expect(usable(train, { railway: "subway" })).toBe(false);
    expect(usable(train, { railway: "light_rail" })).toBe(false);
    expect(usable(metro, { railway: "rail" })).toBe(false);
  });
});

describe("which track a metro routes over", () => {
  // Lisbon's metro is `subway` and Porto's is `light_rail`. A profile holding
  // only one of them would miss an entire network.
  it("holds subway and light rail together", () => {
    expect(usable(metro, { railway: "subway" })).toBe(true);
    expect(usable(metro, { railway: "light_rail" })).toBe(true);
  });

  it("leaves trams out by default and lets a system tagged that way opt in", () => {
    expect(usable(metro, { railway: "tram" })).toBe(false);
    expect(usable(createMetroProfile({ include: ["tram"] }), { railway: "tram" })).toBe(true);
  });
});

describe("direction along a track", () => {
  it("runs both ways over track that says nothing", () => {
    expect(way(train, { railway: "rail" })).toMatchObject({ forward: true, backward: true });
  });

  // 906 of the 1,139 Metro do Porto light-rail ways in the Portugal extract
  // carry `oneway=yes`. Assuming bidirectional running would route trains the
  // wrong way down half the network.
  it("obeys oneway where it is mapped, in both senses", () => {
    expect(way(metro, { railway: "light_rail", oneway: "yes" })).toMatchObject({ forward: true, backward: false });
    expect(way(metro, { railway: "light_rail", oneway: "-1" })).toMatchObject({ forward: false, backward: true });
    expect(way(metro, { railway: "light_rail", oneway: "no" })).toMatchObject({ forward: true, backward: true });
  });

  // `railway:preferred_direction` describes which way trains are normally run,
  // not which way the track permits. Reading it as a ban would invent a
  // restriction OSM never stated.
  it("does not turn a preferred direction into a restriction", () => {
    expect(way(metro, { railway: "subway", "railway:preferred_direction": "forward" })).toMatchObject({ forward: true, backward: true });
  });
});

describe("access on a railway", () => {
  it("closes track stated to be closed", () => {
    expect(usable(train, { railway: "rail", access: "no" })).toBe(false);
    expect(usable(train, { railway: "rail", access: "private" })).toBe(false);
    expect(usable(train, { railway: "rail", access: "military" })).toBe(false);
  });

  // The road ladder is not the railway's. `destination` and `delivery` say who
  // may drive down a street; neither says anything about a train.
  it("does not read road access keys, nor road access values", () => {
    expect(usable(train, { railway: "rail", motor_vehicle: "no" })).toBe(true);
    expect(usable(train, { railway: "rail", vehicle: "no" })).toBe(true);
    expect(usable(train, { railway: "rail", foot: "no" })).toBe(true);
    expect(usable(train, { railway: "rail", access: "destination" })).toBe(true);
  });

  it("lets the more specific key win", () => {
    expect(usable(train, { railway: "rail", access: "no", train: "yes" })).toBe(true);
  });
});

describe("how fast a track is assumed to be", () => {
  const speed = (profile: RoutingProfile, tags: OsmTags) => way(profile, tags)?.forwardSpeedKph;

  it("uses the posted line speed where the way states one", () => {
    expect(speed(train, { railway: "rail", maxspeed: "220" })).toBe(220);
    expect(speed(train, { railway: "rail", maxspeed: "140" })).toBe(140);
  });

  it("reads a direction-specific line speed", () => {
    const traversal = way(train, { railway: "rail", maxspeed: "100", "maxspeed:forward": "160" });
    expect(traversal?.forwardSpeedKph).toBe(160);
    expect(traversal?.backwardSpeedKph).toBe(100);
  });

  it("falls back on what the line is for, not on a single global guess", () => {
    expect(speed(train, { railway: "rail", usage: "main" })).toBe(100);
    expect(speed(train, { railway: "rail", usage: "branch" })).toBe(80);
    expect(speed(train, { railway: "rail", usage: "industrial" })).toBe(40);
    expect(speed(train, { railway: "rail", usage: "tourism" })).toBe(40);
  });

  // A yard that looked as quick as the main line would be chosen as a
  // shortcut through a station rather than avoided as the slow track it is.
  it("runs a siding, yard, spur or crossover at siding pace", () => {
    for (const service of ["siding", "yard", "spur", "crossover"]) {
      expect(speed(train, { railway: "rail", usage: "main", service })).toBe(25);
    }
  });

  it("keeps every speed inside the profile's own ceiling", () => {
    expect(train.maxSpeedKph).toBe(300);
    expect(metro.maxSpeedKph).toBe(120);
    expect(speed(train, { railway: "rail", maxspeed: "500" })).toBe(300);
    expect(speed(metro, { railway: "subway", maxspeed: "300" })).toBe(120);
    // A funicular tagged `maxspeed=2.52` is real, and 2.52 is what it gets:
    // a floor belongs under an *assumed* speed, not over a stated one. See
    // `railway-validation.test.ts`.
    expect(speed(createTrainProfile({ include: ["funicular"] }), { railway: "funicular", maxspeed: "2.52" })).toBeCloseTo(2.52, 5);
  });

  it("gives a subway and a light rail their own default pace", () => {
    expect(speed(metro, { railway: "subway" })).toBe(60);
    expect(speed(metro, { railway: "light_rail" })).toBe(50);
  });
});

describe("what a track says about itself", () => {
  it("reads the Linha do Norte as it is actually tagged", () => {
    expect(way(train, { railway: "rail", gauge: "1668", electrified: "contact_line", voltage: "25000", frequency: "50", usage: "main" })?.railway)
      .toEqual({ gaugeMm: 1668, secondGaugeMm: 0, electrification: Electrification.contactLine, voltage: 25000, secondVoltage: 0, frequency: RailFrequency.hz50, secondFrequency: RailFrequency.unknown, usage: RailUsage.main, service: RailService.running });
  });

  it("reads Metro do Porto as it is actually tagged", () => {
    expect(way(metro, { railway: "light_rail", gauge: "1435", electrified: "contact_line", voltage: "750", frequency: "0", oneway: "yes" })?.railway)
      .toMatchObject({ gaugeMm: 1435, voltage: 750, frequency: RailFrequency.dc, electrification: Electrification.contactLine });
  });

  it("reads the Lisbon metro's conductor rail", () => {
    expect(way(metro, { railway: "subway", gauge: "1435", electrified: "rail", voltage: "750", frequency: "0" })?.railway)
      .toMatchObject({ electrification: Electrification.conductorRail, frequency: RailFrequency.dc });
  });

  it("tells the compiler to keep what it read", () => {
    expect(train.usesRailwayAttributes).toBe(true);
    expect(metro.usesRailwayAttributes).toBe(true);
    expect(getRoutingProfile("car").usesRailwayAttributes).toBeUndefined();
  });
});

// OSM does not describe railway junctions with turn-restriction relations, and
// inventing them from the geometry of a switch is exactly the guessing these
// profiles exist to avoid.
describe("turn restrictions", () => {
  it("obeys none, and asks for none", () => {
    expect(train.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn" })).toBeNull();
    expect(metro.evaluateTurnRestriction({ type: "restriction", restriction: "only_straight_on" })).toBeNull();
  });
});
