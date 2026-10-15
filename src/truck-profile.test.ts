import { carRoutingProfile, parseLengthMeters, parseWeightTonnes, truckRoutingProfile } from "./routing-profile";
import { DEFAULT_VEHICLE_PRESET, VEHICLE_PRESETS, resolveVehicle, vehiclePreset } from "./vehicle";
import { ProfileId } from "./routing-profile";

const truck = truckRoutingProfile;
const car = carRoutingProfile;

describe("reading a signed length", () => {
  it("reads metric values, with or without a unit", () => {
    expect(parseLengthMeters("3.5")).toBe(3.5);
    expect(parseLengthMeters("4 m")).toBe(4);
    expect(parseLengthMeters("4.1m")).toBeCloseTo(4.1, 6);
    expect(parseLengthMeters("380 cm")).toBeCloseTo(3.8, 6);
  });

  it("reads feet and inches, which is how the sign reads where it is signed that way", () => {
    expect(parseLengthMeters("13'6\"")).toBeCloseTo(4.1148, 4);
    expect(parseLengthMeters("14'")).toBeCloseTo(4.2672, 4);
    expect(parseLengthMeters("12 ft")).toBeCloseTo(3.6576, 4);
  });

  it("treats a sign that states no number as unknown, never as zero", () => {
    for (const value of ["default", "below_default", "none", "unsigned", "no_sign", "yes", "", undefined]) {
      expect(parseLengthMeters(value)).toBeNull();
    }
  });
});

describe("reading a signed weight", () => {
  it("takes a bare number as tonnes, as OSM defines it", () => {
    expect(parseWeightTonnes("7.5")).toBe(7.5);
    expect(parseWeightTonnes("40 t")).toBe(40);
    expect(parseWeightTonnes("16000 kg")).toBe(16);
    expect(parseWeightTonnes("80000 lbs")).toBeCloseTo(36.287, 2);
  });

  it("treats a non-measurement as unknown", () => {
    expect(parseWeightTonnes("none")).toBeNull();
    expect(parseWeightTonnes("heavy")).toBeNull();
  });
});

describe("truck access", () => {
  it("reads hgv= where a car reads motorcar=", () => {
    expect(truck.evaluateWay({ highway: "primary", hgv: "no" })).toBeNull();
    expect(car.evaluateWay({ highway: "primary", hgv: "no" })).not.toBeNull();
    expect(truck.evaluateWay({ highway: "primary", motorcar: "no" })).not.toBeNull();
  });

  it("obeys the broader access tags above its own", () => {
    expect(truck.evaluateWay({ highway: "service", motor_vehicle: "no" })).toBeNull();
    expect(truck.evaluateWay({ highway: "service", motor_vehicle: "no", hgv: "yes" })).not.toBeNull();
  });

  it("is not let off a turn restriction by except=motorcar", () => {
    expect(truck.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "motorcar" })).toMatchObject({ kind: "no" });
    expect(truck.evaluateTurnRestriction({ type: "restriction", restriction: "no_left_turn", except: "hgv" })).toBeNull();
  });
});

describe("truck speeds", () => {
  it("is held below the posted limit where the road is signed above its cap", () => {
    expect(truck.evaluateWay({ highway: "motorway" })?.forwardSpeedKph).toBe(90);
    expect(car.evaluateWay({ highway: "motorway" })?.forwardSpeedKph).toBe(110);
    expect(truck.evaluateWay({ highway: "motorway", maxspeed: "120" })?.forwardSpeedKph).toBe(90);
  });

  it("uses the posted limit where it is below the cap", () => {
    expect(truck.evaluateWay({ highway: "residential" })?.forwardSpeedKph).toBe(30);
    expect(truck.evaluateWay({ highway: "primary", maxspeed: "50" })?.forwardSpeedKph).toBe(50);
  });

  it("honours a limit signed for lorries", () => {
    expect(truck.evaluateWay({ highway: "primary", maxspeed: "90", "maxspeed:hgv": "60" })?.forwardSpeedKph).toBe(60);
  });

  it("bounds the A* heuristic at the same cap", () => {
    expect(truck.maxSpeedKph).toBe(90);
    expect(car.maxSpeedKph).toBe(150);
  });
});

describe("truck physical limits", () => {
  it("carries the four limits a way states", () => {
    const way = truck.evaluateWay({ highway: "primary", maxheight: "4.2", maxwidth: "3", maxlength: "18", maxweight: "7.5" });
    expect(way?.forwardLimits).toEqual({ heightMeters: 4.2, widthMeters: 3, lengthMeters: 18, weightTonnes: 7.5 });
  });

  it("leaves limits absent where the way states none", () => {
    expect(truck.evaluateWay({ highway: "primary" })?.forwardLimits).toBeUndefined();
  });

  it("takes the stricter of a signed and a physical limit", () => {
    const way = truck.evaluateWay({ highway: "primary", maxheight: "4.5", "maxheight:physical": "3.9" });
    expect(way?.forwardLimits?.heightMeters).toBe(3.9);
  });

  it("prefers a limit signed for this direction, then for lorries, then the general one", () => {
    const way = truck.evaluateWay({ highway: "primary", maxweight: "40", "maxweight:hgv": "26", "maxweight:forward": "12" });
    expect(way?.forwardLimits?.weightTonnes).toBe(12);
    expect(way?.backwardLimits?.weightTonnes).toBe(26);
  });

  it("is the only profile that collects them", () => {
    expect(truck.usesPhysicalLimits).toBe(true);
    expect(car.usesPhysicalLimits).toBeUndefined();
    expect(car.evaluateWay({ highway: "primary", maxheight: "3.5" })?.forwardLimits).toBeUndefined();
  });

  it("asks the compiler for the limit tags", () => {
    for (const key of ["maxheight", "maxweight", "maxwidth", "maxlength", "maxheight:physical", "maxweight:hgv"]) {
      expect(truck.wayTagKeys).toContain(key);
    }
    expect(car.wayTagKeys).not.toContain("maxheight");
  });

  it("uses the reserved truck id", () => {
    expect(truck.id).toBe(ProfileId.truck);
  });
});

describe("vehicle presets", () => {
  it("defaults to an articulated lorry", () => {
    expect(resolveVehicle(undefined)).toEqual(VEHICLE_PRESETS[DEFAULT_VEHICLE_PRESET]);
    expect(resolveVehicle(undefined)).toEqual({ heightMeters: 4.0, widthMeters: 2.55, lengthMeters: 16.5, weightTonnes: 40 });
  });

  it("covers the classes a caller is likely to mean", () => {
    expect(Object.keys(VEHICLE_PRESETS)).toEqual(["van", "rigid", "articulated", "road-train", "us-semi"]);
    expect(vehiclePreset("us-semi").heightMeters).toBeCloseTo(4.11, 2);
    expect(vehiclePreset("van").weightTonnes).toBe(3.5);
  });

  it("merges an override over a preset rather than leaving the rest unset", () => {
    expect(resolveVehicle({ preset: "articulated", heightMeters: 4.3 })).toEqual({ heightMeters: 4.3, widthMeters: 2.55, lengthMeters: 16.5, weightTonnes: 40 });
    expect(resolveVehicle({ weightTonnes: 7.5 }).lengthMeters).toBe(16.5);
  });

  it("refuses a preset it does not have, and a dimension that is not one", () => {
    expect(() => vehiclePreset("lorry")).toThrow(/Unknown vehicle preset/);
    expect(() => resolveVehicle({ heightMeters: 0 })).toThrow(/positive/);
    expect(() => resolveVehicle({ weightTonnes: Number.NaN })).toThrow(/positive/);
  });

  it("returns a copy, so a caller cannot edit the preset table", () => {
    const first = vehiclePreset("van");
    first.heightMeters = 99;
    expect(vehiclePreset("van").heightMeters).toBe(2.6);
  });
});
