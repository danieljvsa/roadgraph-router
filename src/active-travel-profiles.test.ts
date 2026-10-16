import { ProfileId, bicycleRoutingProfile, carRoutingProfile, getRoutingProfile, pedestrianRoutingProfile, routingProfiles } from "./routing-profile";

const foot = pedestrianRoutingProfile;
const bike = bicycleRoutingProfile;
const car = carRoutingProfile;

describe("which ways each can use", () => {
  it("opens the paths a road graph leaves out", () => {
    for (const highway of ["footway", "path", "pedestrian", "steps", "track"]) {
      expect(foot.evaluateWay({ highway })).not.toBeNull();
      expect(car.evaluateWay({ highway })).toBeNull();
    }
    expect(bike.evaluateWay({ highway: "cycleway" })).not.toBeNull();
    expect(car.evaluateWay({ highway: "cycleway" })).toBeNull();
  });

  it("keeps both off the roads they do not belong on", () => {
    for (const highway of ["motorway", "motorway_link", "trunk", "trunk_link"]) {
      expect(foot.evaluateWay({ highway })).toBeNull();
      expect(bike.evaluateWay({ highway })).toBeNull();
      expect(car.evaluateWay({ highway })).not.toBeNull();
    }
  });

  it("lets a cyclist use steps only where a pedestrian can", () => {
    expect(foot.evaluateWay({ highway: "steps" })).not.toBeNull();
    // Carrying a bicycle up steps is not cycling.
    expect(bike.evaluateWay({ highway: "steps" })).toBeNull();
  });
});

describe("access", () => {
  it("reads foot= for walking and bicycle= for cycling", () => {
    expect(foot.evaluateWay({ highway: "path", foot: "no" })).toBeNull();
    expect(bike.evaluateWay({ highway: "path", foot: "no" })).not.toBeNull();
    expect(bike.evaluateWay({ highway: "path", bicycle: "no" })).toBeNull();
    expect(foot.evaluateWay({ highway: "path", bicycle: "no" })).not.toBeNull();
  });

  it("treats a cyclist as a vehicle and a pedestrian as not one", () => {
    expect(bike.evaluateWay({ highway: "residential", vehicle: "no" })).toBeNull();
    // `vehicle=no` closes a street to traffic, not to someone walking down it.
    expect(foot.evaluateWay({ highway: "residential", vehicle: "no" })).not.toBeNull();
    expect(foot.evaluateWay({ highway: "residential", motor_vehicle: "no" })).not.toBeNull();
  });

  it("still obeys a blanket access=no", () => {
    expect(foot.evaluateWay({ highway: "footway", access: "no" })).toBeNull();
    expect(bike.evaluateWay({ highway: "cycleway", access: "no" })).toBeNull();
    expect(foot.evaluateWay({ highway: "footway", access: "no", foot: "yes" })).not.toBeNull();
  });
});

describe("one-way signs", () => {
  it("do not apply to someone on foot", () => {
    const street = { highway: "residential", oneway: "yes" };
    expect(foot.evaluateWay(street)).toMatchObject({ forward: true, backward: true });
    expect(car.evaluateWay(street)).toMatchObject({ forward: true, backward: false });
  });

  it("do apply to a cyclist, who is traffic", () => {
    expect(bike.evaluateWay({ highway: "residential", oneway: "yes" })).toMatchObject({ forward: true, backward: false });
  });

  it("are lifted for a cyclist by oneway:bicycle=no, which is how a contraflow lane is tagged", () => {
    expect(bike.evaluateWay({ highway: "residential", oneway: "yes", "oneway:bicycle": "no" })).toMatchObject({ forward: true, backward: true });
  });

  it("can be imposed on walking where oneway:foot says so", () => {
    expect(foot.evaluateWay({ highway: "footway", "oneway:foot": "yes" })).toMatchObject({ forward: true, backward: false });
  });

  it("leave a motorway-style implicit one-way out of it", () => {
    // Neither profile can use a motorway at all, so the implicit rule that
    // makes one one-way never reaches them.
    expect(bike.evaluateWay({ highway: "tertiary", junction: "roundabout" })).toMatchObject({ forward: true, backward: false });
    expect(foot.evaluateWay({ highway: "tertiary", junction: "roundabout" })).toMatchObject({ forward: true, backward: true });
  });
});

describe("how fast they go", () => {
  it("walks and rides at a pace the way suggests, not the posted limit", () => {
    expect(foot.evaluateWay({ highway: "footway" })?.forwardSpeedKph).toBe(5);
    // Steps are slower than level ground, and must not be rounded back up to
    // it by a speed floor meant for motor vehicles.
    expect(foot.evaluateWay({ highway: "steps" })?.forwardSpeedKph).toBe(2);
    expect(bike.evaluateWay({ highway: "cycleway" })?.forwardSpeedKph).toBe(18);
    // A 90 km/h sign does not make anyone walk or pedal faster.
    expect(foot.evaluateWay({ highway: "secondary", maxspeed: "90" })?.forwardSpeedKph).toBe(5);
    expect(bike.evaluateWay({ highway: "secondary", maxspeed: "90" })?.forwardSpeedKph).toBe(16);
  });

  it("lets a very low posted limit slow a cyclist, but not below a walking pace", () => {
    expect(bike.evaluateWay({ highway: "residential", maxspeed: "10" })?.forwardSpeedKph).toBe(10);
    expect(bike.evaluateWay({ highway: "residential", maxspeed: "1" })?.forwardSpeedKph).toBe(4);
  });

  it("keeps the two directions the same, since neither is affected by a gradient here", () => {
    const way = bike.evaluateWay({ highway: "residential" });
    expect(way?.forwardSpeedKph).toBe(way?.backwardSpeedKph);
  });

  it("bounds the A* heuristic well below a car's", () => {
    expect(foot.maxSpeedKph).toBe(7);
    expect(bike.maxSpeedKph).toBe(30);
    expect(car.maxSpeedKph).toBe(150);
  });
});

describe("turn restrictions", () => {
  it("are lifted where the relation excepts this traveller", () => {
    expect(foot.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "foot" })).toBeNull();
    expect(bike.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "bicycle" })).toBeNull();
    // A car's exception is not theirs.
    expect(bike.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "motorcar" })).toMatchObject({ kind: "no" });
  });

  it("prefer a value written for this traveller", () => {
    expect(bike.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", "restriction:bicycle": "only_straight_on" })).toMatchObject({ kind: "only" });
  });
});

describe("the registry", () => {
  it("offers every profile by name, the five road ones first", () => {
    expect(Object.keys(routingProfiles)).toEqual(["car", "motorcycle", "truck", "bicycle", "pedestrian", "train", "metro"]);
    expect(getRoutingProfile("bicycle")).toBe(bike);
    expect(getRoutingProfile("pedestrian")).toBe(foot);
  });

  it("uses the ids the format reserved for them", () => {
    expect(bike.id).toBe(ProfileId.bicycle);
    expect(foot.id).toBe(ProfileId.pedestrian);
  });

  it("asks the compiler only for the tags it reads", () => {
    expect(foot.wayTagKeys).toContain("foot");
    expect(foot.wayTagKeys).toContain("oneway:foot");
    expect(foot.wayTagKeys).not.toContain("motor_vehicle");
    expect(bike.wayTagKeys).toContain("oneway:bicycle");
    expect(bike.wayTagKeys).toContain("vehicle");
  });

  it("neither collects physical limits, which only a lorry needs", () => {
    expect(foot.usesPhysicalLimits).toBeUndefined();
    expect(bike.usesPhysicalLimits).toBeUndefined();
  });
});
