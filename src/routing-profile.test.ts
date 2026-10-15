import { carRoutingProfile, getRoutingProfile, parseMaxSpeedKph } from "./routing-profile";

const car = carRoutingProfile;

describe("car routing profile: access", () => {
  it("rejects ways that are not a car-usable highway class", () => {
    expect(car.evaluateWay({ highway: "footway" })).toBeNull();
    expect(car.evaluateWay({ highway: "cycleway" })).toBeNull();
    expect(car.evaluateWay({ building: "yes" })).toBeNull();
    expect(car.evaluateWay({ highway: "residential" })).not.toBeNull();
  });

  it.each(["no", "private", "agricultural", "forestry", "military", "emergency"])(
    "rejects access=%s", (value) => expect(car.evaluateWay({ highway: "service", access: value })).toBeNull(),
  );

  it.each(["destination", "customers", "delivery", "permissive", "designated", "yes"])(
    "allows access=%s", (value) => expect(car.evaluateWay({ highway: "service", access: value })).not.toBeNull(),
  );

  it("lets the most specific access key override a broader one", () => {
    expect(car.evaluateWay({ highway: "residential", access: "no" })).toBeNull();
    expect(car.evaluateWay({ highway: "residential", access: "no", motor_vehicle: "yes" })).not.toBeNull();
    expect(car.evaluateWay({ highway: "residential", access: "no", vehicle: "yes", motorcar: "no" })).toBeNull();
    expect(car.evaluateWay({ highway: "residential", vehicle: "no", motorcar: "yes" })).not.toBeNull();
  });
});

describe("car routing profile: direction", () => {
  it.each(["yes", "true", "1"])("treats oneway=%s as forward only", (value) => {
    expect(car.evaluateWay({ highway: "residential", oneway: value })).toMatchObject({ forward: true, backward: false });
  });

  it.each(["-1", "reverse"])("treats oneway=%s as backward only", (value) => {
    expect(car.evaluateWay({ highway: "residential", oneway: value })).toMatchObject({ forward: false, backward: true });
  });

  it.each(["no", "false", "0", "reversible", "alternating"])("keeps oneway=%s two-way", (value) => {
    expect(car.evaluateWay({ highway: "residential", oneway: value })).toMatchObject({ forward: true, backward: true });
  });

  it("makes roundabouts and motorways one-way by default", () => {
    expect(car.evaluateWay({ highway: "tertiary", junction: "roundabout" })).toMatchObject({ forward: true, backward: false });
    expect(car.evaluateWay({ highway: "tertiary", junction: "circular" })).toMatchObject({ forward: true, backward: false });
    expect(car.evaluateWay({ highway: "motorway" })).toMatchObject({ forward: true, backward: false });
    expect(car.evaluateWay({ highway: "motorway_link" })).toMatchObject({ forward: true, backward: false });
  });

  it("lets an explicit oneway tag override the roundabout default", () => {
    expect(car.evaluateWay({ highway: "tertiary", junction: "roundabout", oneway: "no" })).toMatchObject({ forward: true, backward: true });
    expect(car.evaluateWay({ highway: "motorway", oneway: "no" })).toMatchObject({ forward: true, backward: true });
  });
});

describe("car routing profile: speed", () => {
  it("reads plain and unit-qualified maxspeed values", () => {
    expect(parseMaxSpeedKph("50")).toBe(50);
    expect(parseMaxSpeedKph("50 km/h")).toBe(50);
    expect(parseMaxSpeedKph("80 kmh")).toBe(80);
    expect(parseMaxSpeedKph("30.5")).toBe(30.5);
  });

  it("converts mph to km/h", () => {
    expect(parseMaxSpeedKph("30 mph")).toBeCloseTo(48.28, 2);
    expect(parseMaxSpeedKph("70MPH")).toBeCloseTo(112.65, 2);
    expect(car.evaluateWay({ highway: "primary", maxspeed: "60 mph" })?.forwardSpeedKph).toBeCloseTo(96.56, 2);
  });

  it("falls back to the highway class default for non-numeric values", () => {
    for (const value of ["none", "signals", "variable", "PT:urban", "DE:motorway", "", "unknown"]) {
      expect(parseMaxSpeedKph(value)).toBeNull();
      expect(car.evaluateWay({ highway: "motorway", maxspeed: value })?.forwardSpeedKph).toBe(110);
    }
    expect(car.evaluateWay({ highway: "residential" })?.forwardSpeedKph).toBe(30);
  });

  it("maps maxspeed=walk to a walking pace", () => {
    expect(car.evaluateWay({ highway: "living_street", maxspeed: "walk" })?.forwardSpeedKph).toBe(7);
  });

  it("clamps speeds into the profile range the A* heuristic assumes", () => {
    expect(car.evaluateWay({ highway: "motorway", maxspeed: "400" })?.forwardSpeedKph).toBe(car.maxSpeedKph);
    expect(car.evaluateWay({ highway: "service", maxspeed: "1" })?.forwardSpeedKph).toBe(5);
  });

  it("honours per-direction maxspeed tags", () => {
    const way = car.evaluateWay({ highway: "primary", maxspeed: "90", "maxspeed:forward": "100", "maxspeed:backward": "50 mph" });
    expect(way?.forwardSpeedKph).toBe(100);
    expect(way?.backwardSpeedKph).toBeCloseTo(80.47, 2);
  });
});

describe("car routing profile: turn restriction relations", () => {
  it.each([
    ["no_left_turn", "no"], ["no_right_turn", "no"], ["no_straight_on", "no"], ["no_u_turn", "no"],
    ["only_left_turn", "only"], ["only_right_turn", "only"], ["only_straight_on", "only"],
  ])("classifies restriction=%s as %s", (value, kind) => {
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: value })).toEqual({ kind, value });
  });

  it("ignores relations that are not car turn restrictions", () => {
    expect(car.evaluateTurnRestriction({ type: "route", restriction: "no_left_turn" })).toBeNull();
    expect(car.evaluateTurnRestriction({ type: "restriction" })).toBeNull();
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "give_way" })).toBeNull();
  });

  it("skips restrictions that explicitly except cars", () => {
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "bicycle" })).not.toBeNull();
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "bicycle;motorcar" })).toBeNull();
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "motor_vehicle" })).toBeNull();
  });

  it("prefers the most specific restriction key", () => {
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", "restriction:motorcar": "only_straight_on" })).toMatchObject({ kind: "only" });
  });
});

it("reports unknown profiles by name", () => {
  expect(getRoutingProfile("car")).toBe(car);
  expect(() => getRoutingProfile("hovercraft")).toThrow(/Unknown routing profile/);
});
