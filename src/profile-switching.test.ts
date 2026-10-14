import { encodeProfiledRoadGraphBundle } from "./bundle";
import { compactGraph } from "./compact";
import { RoadRouter } from "./road-router";
import { ProfileId } from "./routing-profile";
import { resolveVehicle } from "./vehicle";
import { buildGraph, rangeFetcher } from "./test-support";

const network = () => buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.98], C: [41.0, -7.96] },
  roads: ["A-B", "B-C"],
});

/** One bundle holding the three vehicles that can share a road network. */
async function threeVehicles() {
  const graph = compactGraph(network());
  const columns = (profileId: number, maxSpeedKph: number) => ({
    profileId, maxSpeedKph,
    edgeDurationScale: graph.edgeDurationScale ?? 1,
    edgeDurationsSeconds: graph.edgeDurationsSeconds as Uint16Array,
  });
  return encodeProfiledRoadGraphBundle([{
    id: 1,
    bounds: { minLat: 40.99, minLng: -8.01, maxLat: 41.01, maxLng: -7.95 },
    graph,
    profiles: [columns(ProfileId.truck, 90), columns(ProfileId.car, 150), columns(ProfileId.motorcycle, 150)],
  }], { compression: "none" });
}

const openTruck = async (vehicle?: string) =>
  RoadRouter.open("https://example.test/p.efrb", rangeFetcher(await threeVehicles()).fetcher, { profile: "truck", ...(vehicle ? { vehicle } : {}) });

describe("moving between vehicles on one bundle", () => {
  it("goes from a lorry with dimensions to a car and a motorcycle", async () => {
    // The whole sequence from a lorry outward, which used to throw on the
    // first step because the dimensions travelled with the options.
    const truck = await openTruck("articulated");
    expect(truck.vehicle).toEqual(resolveVehicle("articulated"));

    const car = truck.withProfile("car");
    expect(car.profile).toBe("car");
    expect(car.vehicle).toBeUndefined();

    const motorcycle = car.withProfile("motorcycle");
    expect(motorcycle.profile).toBe("motorcycle");
    expect(motorcycle.vehicle).toBeUndefined();
  });

  it("gives the lorry its dimensions back on the way round", async () => {
    const truck = await openTruck("us-semi");
    const returned = truck.withProfile("car").withProfile("motorcycle").withProfile("truck");
    expect(returned.profile).toBe("truck");
    expect(returned.vehicle).toEqual(resolveVehicle("us-semi"));
  });

  it("keeps dimensions given as an object, not only as a preset name", async () => {
    const bundle = await threeVehicles();
    const truck = await RoadRouter.open("https://example.test/p.efrb", rangeFetcher(bundle).fetcher, {
      profile: "truck", vehicle: { preset: "rigid", heightMeters: 4.4 },
    });
    const returned = truck.withProfile("car").withProfile("truck");
    expect(returned.vehicle).toEqual({ heightMeters: 4.4, widthMeters: 2.55, lengthMeters: 10, weightTonnes: 18 });
  });

  it("leaves a lorry with no dimensions on its default when it comes back", async () => {
    const truck = await openTruck();
    expect(truck.vehicle).toEqual(resolveVehicle("articulated"));
    expect(truck.withProfile("car").withProfile("truck").vehicle).toEqual(resolveVehicle("articulated"));
  });

  it("honours vehicle: null all the way round", async () => {
    const bundle = await threeVehicles();
    const truck = await RoadRouter.open("https://example.test/p.efrb", rangeFetcher(bundle).fetcher, { profile: "truck", vehicle: null });
    expect(truck.vehicle).toBeUndefined();
    expect(truck.withProfile("car").withProfile("truck").vehicle).toBeUndefined();
  });

  it("still routes after switching, for every vehicle the bundle holds", async () => {
    const truck = await openTruck("articulated");
    for (const name of ["truck", "car", "motorcycle"]) {
      const router = truck.withProfile(name);
      const result = await router.route({ lat: 41.0, lng: -8.0 }, { lat: 41.0, lng: -7.96 });
      expect(result.distanceMeters).toBeGreaterThan(0);
      expect(router.profile).toBe(name);
    }
  });

  it("reports which vehicles are on offer", async () => {
    const truck = await openTruck();
    expect(truck.profiles.sort()).toEqual(["car", "motorcycle", "truck"]);
    expect(() => truck.withProfile("bicycle")).toThrow(/does not hold/i);
  });
});

describe("pairing dimensions with a vehicle that cannot use them", () => {
  it("is refused where the caller made the pairing", async () => {
    const bundle = await threeVehicles();
    await expect(RoadRouter.open("https://example.test/p.efrb", rangeFetcher(bundle).fetcher, { profile: "car", vehicle: "van" }))
      .rejects.toThrow(/does not use vehicle dimensions/i);
  });

  it("is refused for a plain graph too", async () => {
    await expect(RoadRouter.open({ ...compactGraph(network()), profileId: ProfileId.car }, undefined, { vehicle: "van" }))
      .rejects.toThrow(/does not use vehicle dimensions/i);
  });

  it("is not refused when it is only passing through a switch", async () => {
    // The same dimensions, now travelling with the reader rather than aimed
    // at a car, which is the distinction that makes switching possible.
    const truck = await openTruck("van");
    expect(() => truck.withProfile("car")).not.toThrow();
  });
});
