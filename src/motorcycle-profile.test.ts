import { ProfileId, carRoutingProfile, getRoutingProfile, getRoutingProfileById, motorcycleRoutingProfile, routingProfiles } from "./routing-profile";

const bike = motorcycleRoutingProfile;
const car = carRoutingProfile;

describe("motorcycle access", () => {
  it("uses the same roads a car does", () => {
    for (const highway of ["motorway", "trunk", "primary", "residential", "service", "living_street"]) {
      expect(bike.evaluateWay({ highway })).not.toBeNull();
    }
    expect(bike.evaluateWay({ highway: "footway" })).toBeNull();
    expect(bike.evaluateWay({ highway: "cycleway" })).toBeNull();
  });

  it("reads motorcycle= where a car reads motorcar=", () => {
    const closedToBikes = { highway: "primary", motorcycle: "no" };
    expect(bike.evaluateWay(closedToBikes)).toBeNull();
    // The same road stays open to cars, which is the point of the tag.
    expect(car.evaluateWay(closedToBikes)).not.toBeNull();

    const closedToCars = { highway: "primary", motorcar: "no" };
    expect(car.evaluateWay(closedToCars)).toBeNull();
    expect(bike.evaluateWay(closedToCars)).not.toBeNull();
  });

  it("still obeys the broader access tags above its own", () => {
    expect(bike.evaluateWay({ highway: "service", access: "no" })).toBeNull();
    expect(bike.evaluateWay({ highway: "service", motor_vehicle: "no" })).toBeNull();
    expect(bike.evaluateWay({ highway: "service", vehicle: "no" })).toBeNull();
    // Most specific wins, as everywhere else in the hierarchy.
    expect(bike.evaluateWay({ highway: "service", motor_vehicle: "no", motorcycle: "yes" })).not.toBeNull();
  });
});

describe("motorcycle one-way exceptions", () => {
  it("lets oneway:motorcycle open a street signed one-way", () => {
    const street = { highway: "residential", oneway: "yes", "oneway:motorcycle": "no" };
    expect(bike.evaluateWay(street)).toMatchObject({ forward: true, backward: true });
    expect(car.evaluateWay(street)).toMatchObject({ forward: true, backward: false });
  });

  it("lets oneway:motor_vehicle apply to both", () => {
    const street = { highway: "residential", "oneway:motor_vehicle": "yes" };
    expect(bike.evaluateWay(street)).toMatchObject({ forward: true, backward: false });
    expect(car.evaluateWay(street)).toMatchObject({ forward: true, backward: false });
  });

  it("keeps the mode-specific tag beneath nothing else", () => {
    // oneway:motorcar must not reach a motorcycle.
    expect(bike.evaluateWay({ highway: "residential", "oneway:motorcar": "yes" })).toMatchObject({ backward: true });
    expect(car.evaluateWay({ highway: "residential", "oneway:motorcar": "yes" })).toMatchObject({ backward: false });
  });

  it("is still one-way on a motorway and a roundabout by default", () => {
    expect(bike.evaluateWay({ highway: "motorway" })).toMatchObject({ forward: true, backward: false });
    expect(bike.evaluateWay({ highway: "tertiary", junction: "roundabout" })).toMatchObject({ forward: true, backward: false });
  });
});

describe("motorcycle speeds", () => {
  it("falls back to the same class defaults as a car", () => {
    expect(bike.evaluateWay({ highway: "motorway" })?.forwardSpeedKph).toBe(car.evaluateWay({ highway: "motorway" })?.forwardSpeedKph);
    expect(bike.evaluateWay({ highway: "residential" })?.forwardSpeedKph).toBe(30);
  });

  it("honours a motorcycle-specific limit over the general one", () => {
    const way = bike.evaluateWay({ highway: "primary", maxspeed: "90", "maxspeed:motorcycle": "70" });
    expect(way?.forwardSpeedKph).toBe(70);
    expect(car.evaluateWay({ highway: "primary", maxspeed: "90", "maxspeed:motorcycle": "70" })?.forwardSpeedKph).toBe(90);
  });

  it("still lets a per-direction limit win", () => {
    const way = bike.evaluateWay({ highway: "primary", "maxspeed:motorcycle": "70", "maxspeed:forward": "50" });
    expect(way?.forwardSpeedKph).toBe(50);
    expect(way?.backwardSpeedKph).toBe(70);
  });
});

describe("motorcycle turn restrictions", () => {
  it("is not let off by except=motorcar", () => {
    const relation = { type: "restriction", restriction: "no_left_turn", except: "motorcar" };
    expect(bike.evaluateTurnRestriction(relation)).toMatchObject({ kind: "no" });
    expect(car.evaluateTurnRestriction(relation)).toBeNull();
  });

  it("is let off by its own exception, and by the broader ones", () => {
    for (const except of ["motorcycle", "motor_vehicle", "vehicle", "bicycle;motorcycle"]) {
      expect(bike.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except })).toBeNull();
    }
  });

  it("prefers restriction:motorcycle over the general value", () => {
    expect(bike.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", "restriction:motorcycle": "only_straight_on" })).toMatchObject({ kind: "only" });
    // A car ignores the motorcycle-specific override.
    expect(car.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", "restriction:motorcycle": "only_straight_on" })).toMatchObject({ kind: "no" });
  });
});

describe("the profile registry", () => {
  it("offers motorcycle by name and by id", () => {
    expect(getRoutingProfile("motorcycle")).toBe(bike);
    expect(getRoutingProfileById(ProfileId.motorcycle)).toBe(bike);
    expect(Object.keys(routingProfiles)).toContain("motorcycle");
  });

  it("asks the compiler for the tags it actually reads", () => {
    for (const key of ["motorcycle", "oneway:motorcycle", "maxspeed:motorcycle"]) {
      expect(bike.wayTagKeys).toContain(key);
      expect(car.wayTagKeys).not.toContain(key);
    }
    expect(bike.relationTagKeys).toContain("restriction:motorcycle");
  });

  it("keeps the two vehicles on separate ids", () => {
    expect(bike.id).not.toBe(car.id);
  });
});
