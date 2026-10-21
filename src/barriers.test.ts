import { bicycleRoutingProfile, carRoutingProfile, pedestrianRoutingProfile, routingProfiles, truckRoutingProfile } from "./routing-profile";

const car = carRoutingProfile;
const bike = bicycleRoutingProfile;
const foot = pedestrianRoutingProfile;

const passes = (profile: typeof car, tags: Record<string, string>) => profile.evaluateBarrier!(tags);

describe("who gets past what", () => {
  it("lets a bollard stop a car and nobody else", () => {
    expect(passes(car, { barrier: "bollard" })).toBe(false);
    expect(passes(bike, { barrier: "bollard" })).toBe(true);
    expect(passes(foot, { barrier: "bollard" })).toBe(true);
  });

  it("lets a stile stop everything but walking", () => {
    expect(passes(foot, { barrier: "stile" })).toBe(true);
    expect(passes(bike, { barrier: "stile" })).toBe(false);
    expect(passes(car, { barrier: "stile" })).toBe(false);
  });

  it("stops a cyclist at a cycle barrier but not someone on foot", () => {
    expect(passes(foot, { barrier: "cycle_barrier" })).toBe(true);
    expect(passes(bike, { barrier: "cycle_barrier" })).toBe(false);
  });

  it("treats a gate as open, because most are", () => {
    for (const profile of [car, bike, foot]) expect(passes(profile, { barrier: "gate" })).toBe(true);
  });

  it("stops everyone at a wall", () => {
    for (const profile of [car, bike, foot]) expect(passes(profile, { barrier: "wall" })).toBe(false);
  });
});

describe("what the node itself says", () => {
  it("lets an access tag overrule the default", () => {
    // A bollard a cyclist may not pass, and a gate a car may not.
    expect(passes(bike, { barrier: "bollard", bicycle: "no" })).toBe(false);
    expect(passes(car, { barrier: "gate", access: "private" })).toBe(false);
    expect(passes(foot, { barrier: "wall", foot: "yes" })).toBe(true);
  });

  it("reads the most specific key, as everywhere else", () => {
    expect(passes(car, { barrier: "gate", access: "no", motorcar: "yes" })).toBe(true);
    expect(passes(bike, { barrier: "gate", vehicle: "no", bicycle: "yes" })).toBe(true);
    // A pedestrian is not a vehicle, so a vehicle restriction is not theirs.
    expect(passes(foot, { barrier: "gate", vehicle: "no" })).toBe(true);
  });

  it("closes a locked gate, unless it is explicitly open to you", () => {
    expect(passes(car, { barrier: "gate", locked: "yes" })).toBe(false);
    expect(passes(foot, { barrier: "gate", locked: "yes" })).toBe(false);
    expect(passes(foot, { barrier: "gate", locked: "yes", foot: "yes" })).toBe(true);
  });
});

describe("a node that is not a barrier, or not one we know", () => {
  it("is passed without comment", () => {
    for (const profile of [car, bike, foot]) {
      expect(passes(profile, {})).toBe(true);
      expect(passes(profile, { barrier: "no" })).toBe(true);
      expect(passes(profile, { highway: "crossing" })).toBe(true);
    }
  });

  it("is left open when the kind is unfamiliar", () => {
    // Inventing a closure severs a road that is probably passable, and the
    // tag may simply be one this table has not met.
    expect(passes(car, { barrier: "something_new" })).toBe(true);
    expect(passes(foot, { barrier: "something_new" })).toBe(true);
    // Unless the node says otherwise itself.
    expect(passes(car, { barrier: "something_new", access: "no" })).toBe(false);
  });
});

describe("every profile", () => {
  it("answers about barriers and asks for the tags to do it", () => {
    for (const profile of Object.values(routingProfiles).filter((entry) => entry.networkKind === "road")) {
      expect(typeof profile.evaluateBarrier).toBe("function");
      expect(profile.nodeTagKeys).toContain("barrier");
      expect(profile.nodeTagKeys).toContain("locked");
    }
  });

  // A bollard is not a thing that happens to a railway. Reading the barrier
  // table for a train would let a gate across a footpath cut a main line, so
  // a railway profile asks for no node tags and answers about no barriers —
  // which also means a rail-only compile never reads node tags at all.
  it("leaves barriers to the road, because a railway has none", () => {
    for (const profile of Object.values(routingProfiles).filter((entry) => entry.networkKind === "railway")) {
      expect(profile.evaluateBarrier).toBeUndefined();
      expect(profile.nodeTagKeys ?? []).toEqual([]);
    }
  });

  it("stops a lorry wherever it stops a car", () => {
    for (const barrier of ["bollard", "stile", "wall", "block"]) {
      expect(passes(truckRoutingProfile, { barrier })).toBe(passes(car, { barrier }));
    }
  });
});
