import { carRoutingProfile, truckRoutingProfile, motorcycleRoutingProfile, bicycleRoutingProfile, pedestrianRoutingProfile } from "./routing-profile";
import { ConditionKind } from "./conditional";

const conditionsOn = (profile: { evaluateWay: (tags: Record<string, string>) => { conditions?: { kind: number; value: string }[] } | null }, tags: Record<string, string>) =>
  profile.evaluateWay({ highway: "residential", ...tags })?.conditions ?? [];

const accessValue = (profile: Parameters<typeof conditionsOn>[0], tags: Record<string, string>) =>
  conditionsOn(profile, tags).find((entry) => entry.kind === ConditionKind.access)?.value;

describe("which conditional tag answers for which vehicle", () => {
  it("takes the vehicle's own key over the general one", () => {
    const tags = { "access:conditional": "no @ (Mo-Fr)", "hgv:conditional": "yes @ (Mo-Fr)" };
    expect(accessValue(truckRoutingProfile, tags)).toBe("yes @ (Mo-Fr)");
    // A car is not an hgv, so the general rule is the one that answers for it.
    expect(accessValue(carRoutingProfile, tags)).toBe("no @ (Mo-Fr)");
  });

  it("keeps one answer rather than stacking a general rule on a specific one", () => {
    const tags = {
      "access:conditional": "no @ (Mo-Fr 07:00-19:00)",
      "motor_vehicle:conditional": "yes @ (Mo-Fr 07:00-19:00)",
      "motorcar:conditional": "destination @ (Mo-Fr 07:00-19:00)",
    };
    const found = conditionsOn(carRoutingProfile, tags).filter((entry) => entry.kind === ConditionKind.access);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe("destination @ (Mo-Fr 07:00-19:00)");
  });

  it("walks the ladder in the order OSM defines", () => {
    expect(accessValue(carRoutingProfile, { "access:conditional": "no @ (Mo)", "vehicle:conditional": "yes @ (Mo)" })).toBe("yes @ (Mo)");
    expect(accessValue(carRoutingProfile, { "vehicle:conditional": "no @ (Mo)", "motor_vehicle:conditional": "yes @ (Mo)" })).toBe("yes @ (Mo)");
    expect(accessValue(motorcycleRoutingProfile, { "motor_vehicle:conditional": "no @ (Mo)", "motorcycle:conditional": "yes @ (Mo)" })).toBe("yes @ (Mo)");
  });

  it("does not let one vehicle's rule answer for another", () => {
    const tags = { "hgv:conditional": "no @ (Mo-Fr)" };
    expect(accessValue(truckRoutingProfile, tags)).toBe("no @ (Mo-Fr)");
    expect(accessValue(carRoutingProfile, tags)).toBeUndefined();
    expect(accessValue(motorcycleRoutingProfile, tags)).toBeUndefined();
  });

  it("answers for walking and cycling from their own keys", () => {
    expect(accessValue(bicycleRoutingProfile, { "bicycle:conditional": "no @ (Mo-Fr)" })).toBe("no @ (Mo-Fr)");
    expect(accessValue(pedestrianRoutingProfile, { "foot:conditional": "no @ (Mo-Fr)" })).toBe("no @ (Mo-Fr)");
    // A cycle is a vehicle; a pedestrian is not, and must not take a
    // vehicle-wide rule as its own.
    expect(accessValue(bicycleRoutingProfile, { "vehicle:conditional": "no @ (Mo-Fr)" })).toBe("no @ (Mo-Fr)");
    expect(accessValue(pedestrianRoutingProfile, { "vehicle:conditional": "no @ (Mo-Fr)" })).toBeUndefined();
  });

  it("gives walking and cycling no conditional speed limit", () => {
    // A posted limit does not make anyone pedal harder, conditional or not.
    const tags = { "maxspeed:conditional": "30 @ (Mo-Fr)" };
    expect(conditionsOn(bicycleRoutingProfile, tags)).toHaveLength(0);
    expect(conditionsOn(carRoutingProfile, tags).some((entry) => entry.kind === ConditionKind.maxspeed)).toBe(true);
  });

  it("takes the vehicle's own speed key over the general one", () => {
    const tags = { "maxspeed:conditional": "90 @ (Mo-Fr)", "maxspeed:hgv:conditional": "60 @ (Mo-Fr)" };
    const speedOf = (profile: Parameters<typeof conditionsOn>[0]) =>
      conditionsOn(profile, tags).find((entry) => entry.kind === ConditionKind.maxspeed)?.value;
    expect(speedOf(truckRoutingProfile)).toBe("60 @ (Mo-Fr)");
    expect(speedOf(carRoutingProfile)).toBe("90 @ (Mo-Fr)");
  });
});
