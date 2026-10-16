/**
 * Routing profiles turn raw OSM tags into routable facts: may a vehicle use
 * this way, in which directions, and how fast. Keeping the rules behind one
 * interface lets the compiler stay generic — it never inspects a tag itself —
 * and lets the rules be unit-tested without a PBF file.
 */

import { ConditionKind } from "./conditional";
import { ProfileId, type OsmTags, type ParsedTurnRestriction, type RoutingProfile, type TurnRestrictionKind, type VehicleLimits } from "./profile-types";
import { metroRoutingProfile, trainRoutingProfile } from "./railway-profile";
import { parseMaxSpeedKph } from "./speed";

export { parseMaxSpeedKph };

export {
  ProfileId,
  type NetworkKind,
  type OsmTags,
  type ParsedTurnRestriction,
  type RailwayAttributes,
  type RoutingProfile,
  type TurnRestrictionKind,
  type VehicleLimits,
  type WayTraversal,
} from "./profile-types";

const MINIMUM_SPEED_KPH = 5;
const MAXIMUM_SPEED_KPH = 150;

/** Values that deny passage, from most to least common. `destination`, `customers`,
 *  `delivery` and `permissive` all still allow a vehicle through, so they are absent. */
const BLOCKED_ACCESS = new Set(["no", "private", "agricultural", "forestry", "military", "emergency", "use_sidepath"]);

/** Highway classes a motor vehicle may drive on, with their default free-flow speed in km/h. */
const MOTOR_VEHICLE_SPEEDS: Record<string, number> = {
  motorway: 110,
  motorway_link: 50,
  trunk: 90,
  trunk_link: 50,
  primary: 70,
  primary_link: 45,
  secondary: 60,
  secondary_link: 40,
  tertiary: 50,
  tertiary_link: 35,
  unclassified: 35,
  residential: 30,
  living_street: 10,
  service: 20,
  road: 25,
};

/** Restriction values this package understands. Anything else is ignored rather than guessed at. */
const TURN_RESTRICTION_KINDS: Record<string, TurnRestrictionKind> = {
  no_left_turn: "no",
  no_right_turn: "no",
  no_straight_on: "no",
  no_u_turn: "no",
  no_entry: "no",
  no_exit: "no",
  only_left_turn: "only",
  only_right_turn: "only",
  only_straight_on: "only",
  only_u_turn: "only",
};

/**
 * What stands across a road, and who it stops.
 *
 * A barrier is a node, not a way, and the same gate stops different travellers
 * differently: a bollard is nothing to someone walking and the end of the road
 * for a car, while a stile is the reverse. Where a barrier carries its own
 * access tags those decide; the defaults below only apply when it says nothing,
 * which is the common case.
 *
 * `true` means this traveller gets through. A barrier this table has never
 * heard of is treated as passable rather than guessed at, because inventing a
 * closure severs a road that is probably open.
 */
const BARRIER_DEFAULTS: Record<string, { motor: boolean; bicycle: boolean; foot: boolean }> = {
  bollard: { motor: false, bicycle: true, foot: true },
  block: { motor: false, bicycle: true, foot: true },
  jersey_barrier: { motor: false, bicycle: true, foot: true },
  planter: { motor: false, bicycle: true, foot: true },
  cycle_barrier: { motor: false, bicycle: false, foot: true },
  stile: { motor: false, bicycle: false, foot: true },
  turnstile: { motor: false, bicycle: false, foot: true },
  kissing_gate: { motor: false, bicycle: false, foot: true },
  fence: { motor: false, bicycle: false, foot: false },
  wall: { motor: false, bicycle: false, foot: false },
  hedge: { motor: false, bicycle: false, foot: false },
  ditch: { motor: false, bicycle: false, foot: false },
  // A gate or a boom is usually open, or opens for you; `access` and `locked`
  // say when it is not.
  gate: { motor: true, bicycle: true, foot: true },
  lift_gate: { motor: true, bicycle: true, foot: true },
  swing_gate: { motor: true, bicycle: true, foot: true },
  bus_trap: { motor: false, bicycle: true, foot: true },
  sally_port: { motor: true, bicycle: true, foot: true },
  toll_booth: { motor: true, bicycle: true, foot: true },
  border_control: { motor: true, bicycle: true, foot: true },
  entrance: { motor: true, bicycle: true, foot: true },
};

/** The keys every profile reads off a barrier node. */
const BARRIER_TAG_KEYS = ["barrier", "locked", "access", "foot", "bicycle", "vehicle", "motor_vehicle", "motorcar", "motorcycle", "hgv"] as const;

/**
 * Whether `mode` gets past this node. The access ladder is read first, because
 * an explicit `bicycle=yes` on a gate outranks any default; then `locked=yes`,
 * which closes anything; then the table above.
 */
function barrierAllows(tags: OsmTags, accessKeys: readonly string[], kind: "motor" | "bicycle" | "foot") {
  const barrier = tags.barrier?.trim().toLowerCase();
  if (!barrier || barrier === "no") return true;
  let decided: boolean | undefined;
  for (const key of accessKeys) {
    const value = tags[key];
    if (value !== undefined) decided = !BLOCKED_ACCESS.has(value);
  }
  if (decided !== undefined) return decided;
  if (tags.locked?.trim().toLowerCase() === "yes") return false;
  const defaults = BARRIER_DEFAULTS[barrier];
  // An unknown barrier is left open: inventing a closure severs a road that is
  // probably passable, and the tag may simply be one this table has not met.
  return defaults ? defaults[kind] : true;
}

/** Highway classes OSM treats as implicitly one-way when no `oneway` tag is present. */
const IMPLICITLY_ONEWAY = new Set(["motorway", "motorway_link"]);

function clampSpeed(value: number) {
  if (!Number.isFinite(value)) return MINIMUM_SPEED_KPH;
  return Math.min(MAXIMUM_SPEED_KPH, Math.max(MINIMUM_SPEED_KPH, value));
}

/**
 * Reads a `maxspeed`-style value. Returns null for every value that is not a
 * plain number with an optional unit — country codes such as `PT:urban`,
 * `none`, `signals` and `variable` included — so the caller can fall back to a
 * class default instead of inventing a country-specific table.
 */


/** Values that are not a measurement: a sign exists, or does not, but neither states a number. */
const UNMEASURED = new Set(["default", "below_default", "none", "unsigned", "no_sign", "no", "yes", "unknown"]);

const FEET_METERS = 0.3048;
const INCH_METERS = 0.0254;

/**
 * Reads a `maxheight`-style value in metres. Feet and inches are accepted
 * because they are how the limit is written wherever it is signed that way;
 * anything that is not a measurement reads as unknown rather than as zero,
 * which would close the road to everything.
 */
export function parseLengthMeters(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (UNMEASURED.has(text)) return null;
  const imperial = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch(?:es)?)?)?$/.exec(text);
  if (imperial) {
    const metres = Number(imperial[1]) * FEET_METERS + Number(imperial[2] ?? 0) * INCH_METERS;
    return metres > 0 ? metres : null;
  }
  const metric = /^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|cm)?$/.exec(text);
  if (!metric) return null;
  const amount = Number(metric[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return metric[2] === "cm" ? amount / 100 : amount;
}

/** Reads a `maxweight`-style value in tonnes. A bare number is tonnes, as OSM defines it. */
export function parseWeightTonnes(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (UNMEASURED.has(text)) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(t|tonnes?|tons?|kg|lbs?|pounds?)?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "kg") return amount / 1000;
  if (match[2] === "lb" || match[2] === "lbs" || match[2] === "pound" || match[2] === "pounds") return amount * 0.00045359237;
  return amount;
}

/** The four limit keys, with the direction-specific forms OSM also allows. */
const LIMIT_KEYS = [
  ["heightMeters", "maxheight", parseLengthMeters],
  ["widthMeters", "maxwidth", parseLengthMeters],
  ["lengthMeters", "maxlength", parseLengthMeters],
  ["weightTonnes", "maxweight", parseWeightTonnes],
] as const;

function limitsFor(tags: OsmTags, mode: string, direction: "forward" | "backward"): VehicleLimits | undefined {
  const limits: VehicleLimits = {};
  let found = false;
  for (const [field, key, parse] of LIMIT_KEYS) {
    // Most specific first: a signed limit for this direction, then one for
    // this vehicle class, then the general one. `maxheight:physical` is the
    // structure itself rather than a legal sign, and is the stricter of the two.
    const value = parse(tags[`${key}:${direction}`]) ?? parse(tags[`${key}:${mode}`]) ?? parse(tags[key]);
    const physical = key === "maxheight" || key === "maxwidth" ? parse(tags[`${key}:physical`]) : null;
    const resolved = value !== null && physical !== null ? Math.min(value, physical) : value ?? physical;
    if (resolved !== null && resolved !== undefined) { limits[field] = resolved; found = true; }
  }
  return found ? limits : undefined;
}

/**
 * The conditional restrictions on a way that this vehicle must obey.
 *
 * Access follows the same ladder as the plain tags, where the most specific
 * key present wins: `hgv:conditional` answers for a lorry even where
 * `access:conditional` says otherwise. Only one access rule is kept, because a
 * more specific key replaces a less specific one rather than adding to it.
 */
function conditionsFor(tags: OsmTags, accessKeys: readonly string[], speedKeys: readonly string[]) {
  const found: { kind: number; value: string }[] = [];
  let access: string | undefined;
  for (const key of accessKeys) {
    const value = tags[`${key}:conditional`];
    if (value !== undefined) access = value;
  }
  if (access) found.push({ kind: ConditionKind.access, value: access });
  let speed: string | undefined;
  for (const key of speedKeys) {
    const value = tags[`${key}:conditional`];
    if (value !== undefined) speed = value;
  }
  if (speed) found.push({ kind: ConditionKind.maxspeed, value: speed });
  return found.length ? found : undefined;
}

/** Resolves the OSM access hierarchy, where the most specific tag present wins. */
function accessAllowed(tags: OsmTags, keys: readonly string[]) {
  let allowed = true;
  for (const key of keys) {
    const value = tags[key];
    if (value === undefined) continue;
    allowed = !BLOCKED_ACCESS.has(value);
  }
  return allowed;
}

/**
 * Resolves `oneway`, letting a mode-specific tag override the general one. A
 * street signed one-way for cars can be two-way for motorcycles in some
 * places, and `oneway:motorcycle=no` is how OSM says so.
 */
function onewayDirections(tags: OsmTags, highway: string | undefined, keys: readonly string[]) {
  let oneway: string | undefined;
  for (const key of keys) if (tags[key] !== undefined) oneway = tags[key];
  const value = oneway?.trim().toLowerCase();
  if (value === "yes" || value === "true" || value === "1") return { forward: true, backward: false };
  if (value === "-1" || value === "reverse") return { forward: false, backward: true };
  // `reversible` and `alternating` carriageways change direction over time;
  // treating them as two-way keeps them routable rather than silently removed.
  if (value !== undefined && value !== "") return { forward: true, backward: true };
  const junction = tags.junction?.trim().toLowerCase();
  if (junction === "roundabout" || junction === "circular") return { forward: true, backward: false };
  if (highway && IMPLICITLY_ONEWAY.has(highway)) return { forward: true, backward: false };
  return { forward: true, backward: true };
}

/**
 * Every motor vehicle reads the same tags in the same order; what changes is
 * the mode name at the bottom of each hierarchy. A car resolves `motorcar`
 * where a motorcycle resolves `motorcycle`, and the rest — the access ladder,
 * the oneway rules, the speed table, the restriction ladder — is shared. One
 * implementation keeps those rules from drifting apart between vehicles.
 */
function motorVehicleProfile(options: { name: string; id: ProfileId; mode: string; speeds?: Record<string, number>; speedCeilingKph?: number; physicalLimits?: boolean }): RoutingProfile {
  const { name, id, mode } = options;
  const speeds = options.speeds ?? MOTOR_VEHICLE_SPEEDS;
  const ceiling = options.speedCeilingKph ?? MAXIMUM_SPEED_KPH;
  const limit = (value: number) => Math.min(ceiling, value);
  const accessKeys = ["access", "vehicle", "motor_vehicle", mode] as const;
  const onewayKeys = ["oneway", "oneway:motor_vehicle", `oneway:${mode}`] as const;
  const restrictionKeys = ["restriction", "restriction:vehicle", "restriction:motor_vehicle", `restriction:${mode}`] as const;
  // `except=motorcar` lifts a restriction for cars but not for motorcycles, so
  // the exempting modes are the vehicle's own ladder rather than a fixed list.
  const exceptModes = new Set([mode, "motor_vehicle", "vehicle"]);

  return {
    name,
    id,
    networkKind: "road",
    wayTagKeys: [
      "highway", "junction", "maxspeed", "maxspeed:forward", "maxspeed:backward", `maxspeed:${mode}`,
      ...accessKeys, ...onewayKeys,
      // The conditional forms of the same keys, which the router reads against
      // a departure time rather than the compiler against nothing.
      ...accessKeys.map((key) => `${key}:conditional`), "maxspeed:conditional", `maxspeed:${mode}:conditional`,
      ...(options.physicalLimits ? LIMIT_KEYS.flatMap(([, key]) => [key, `${key}:${mode}`, `${key}:forward`, `${key}:backward`, ...(key === "maxheight" || key === "maxwidth" ? [`${key}:physical`] : [])]) : []),
    ],
    relationTagKeys: ["type", "except", ...restrictionKeys, ...restrictionKeys.map((key) => `${key}:conditional`)],
    maxSpeedKph: ceiling,
    nodeTagKeys: BARRIER_TAG_KEYS,
    evaluateBarrier: (tags) => barrierAllows(tags, accessKeys, "motor"),
    ...(options.physicalLimits ? { usesPhysicalLimits: true } : {}),

    evaluateWay(tags) {
      const highway = tags.highway;
      if (!highway || !(highway in speeds)) return null;
      if (!accessAllowed(tags, accessKeys)) return null;
      const { forward, backward } = onewayDirections(tags, highway, onewayKeys);
      if (!forward && !backward) return null;
      const base = parseMaxSpeedKph(tags[`maxspeed:${mode}`]) ?? parseMaxSpeedKph(tags.maxspeed) ?? speeds[highway];
      return {
        forward,
        backward,
        // A vehicle class with a lower legal ceiling does not reach the posted
        // limit on a road signed above it, so the ceiling caps the speed
        // rather than only bounding the A* heuristic.
        forwardSpeedKph: clampSpeed(limit(parseMaxSpeedKph(tags["maxspeed:forward"]) ?? base)),
        backwardSpeedKph: clampSpeed(limit(parseMaxSpeedKph(tags["maxspeed:backward"]) ?? base)),
        ...(options.physicalLimits ? {
          forwardLimits: limitsFor(tags, mode, "forward"),
          backwardLimits: limitsFor(tags, mode, "backward"),
        } : {}),
        ...((conditions) => conditions ? { conditions } : {})(conditionsFor(tags, accessKeys, ["maxspeed", `maxspeed:${mode}`])),
      };
    },

    evaluateTurnRestriction(tags) {
      if (tags.type !== "restriction") return null;
      const except = tags.except?.split(";").map((value) => value.trim().toLowerCase()) ?? [];
      if (except.some((value) => exceptModes.has(value))) return null;
      let value: string | undefined;
      for (const key of restrictionKeys) if (tags[key] !== undefined) value = tags[key];
      if (!value) return null;
      const kind = TURN_RESTRICTION_KINDS[value.trim().toLowerCase()];
      return kind ? { kind, value } : null;
    },
  };
}

export const carRoutingProfile = motorVehicleProfile({ name: "car", id: ProfileId.car, mode: "motorcar" });

/**
 * Motorcycles use the same roads and the same speed limits as cars almost
 * everywhere, so the difference is which tags apply to them: `motorcycle=no`
 * closes a road a car may still use, `oneway:motorcycle=no` opens one, and
 * `except=motorcar` on a turn restriction does not let a motorcycle through.
 */
export const motorcycleRoutingProfile = motorVehicleProfile({ name: "motorcycle", id: ProfileId.motorcycle, mode: "motorcycle" });

/**
 * Heavy goods vehicles. `hgv` is the OSM key for them, and it sits below
 * `motor_vehicle` in the same ladder every motor vehicle uses.
 *
 * Two things set a lorry apart. It is slower: a heavy vehicle is capped below
 * the posted limit almost everywhere, so a truck graph that reused car
 * durations would give wrong arrival times on roads it is perfectly entitled
 * to use. And it is large: height, width, length and weight limits decide
 * whether a road is usable at all, which depends on the lorry rather than on
 * the map, so those limits are carried through to be applied at routing time.
 */
export const truckRoutingProfile = motorVehicleProfile({
  name: "truck",
  id: ProfileId.truck,
  mode: "hgv",
  // Heavy vehicles are held below the posted limit nearly everywhere; 90 is
  // at or above the cap in the regimes this library has to serve at once.
  speedCeilingKph: 90,
  physicalLimits: true,
});

/* --------------------------------------------------- walking and cycling --- */

/**
 * Walking and cycling are not motor vehicles with different numbers. Three
 * rules change shape rather than value, which is why they do not come from the
 * factory above.
 *
 * A posted speed limit does not make anyone walk faster, so the class decides
 * the speed and `maxspeed` only ever lowers it. A one-way street is one-way
 * for traffic, not for people on foot, and a cyclist very often has a legal
 * contraflow where a driver does not. And the roads themselves differ: a
 * footway or a path is the network here, while a motorway is not part of it
 * at all.
 */

/** How fast each kind of way is walked, in km/h. Steps are slower than level ground. */
const WALKING_SPEEDS: Record<string, number> = {
  footway: 5,
  // A shared path is often tagged as a cycleway; where walking is genuinely
  // forbidden, `foot=no` says so and the access ladder catches it.
  cycleway: 5,
  path: 5,
  pedestrian: 5,
  living_street: 5,
  residential: 5,
  service: 5,
  unclassified: 5,
  road: 5,
  tertiary: 5,
  tertiary_link: 5,
  secondary: 5,
  secondary_link: 5,
  primary: 5,
  primary_link: 5,
  track: 4,
  bridleway: 4,
  corridor: 5,
  steps: 2,
};

/** How fast each kind of way is ridden, in km/h. */
const CYCLING_SPEEDS: Record<string, number> = {
  cycleway: 18,
  residential: 15,
  living_street: 10,
  service: 12,
  unclassified: 15,
  road: 14,
  tertiary: 16,
  tertiary_link: 14,
  secondary: 16,
  secondary_link: 14,
  primary: 15,
  primary_link: 13,
  path: 11,
  footway: 7,
  pedestrian: 7,
  track: 9,
  bridleway: 8,
};

/**
 * Walking and cycling both reach a way through `access` and then their own
 * key, with no vehicle ladder in between for a pedestrian. A cyclist is a
 * vehicle, so `vehicle` applies to them and not to someone on foot.
 */
function activeTravelProfile(options: {
  name: string;
  id: ProfileId;
  mode: string;
  speeds: Record<string, number>;
  ceilingKph: number;
  accessKeys: readonly string[];
  /** True where a one-way sign governs traffic rather than this traveller. */
  ignoresOneway: boolean;
  /**
   * The slowest this traveller is ever modelled as moving. The motor-vehicle
   * floor of 5 km/h is walking pace, so applying it here would make a flight
   * of steps as quick as level ground.
   */
  floorKph: number;
}): RoutingProfile {
  const { name, id, mode, speeds, ceilingKph, accessKeys, ignoresOneway, floorKph } = options;
  const onewayKeys = [`oneway:${mode}`] as const;
  const restrictionKeys = ["restriction", `restriction:${mode}`] as const;
  const exceptModes = new Set([mode]);

  return {
    name,
    id,
    networkKind: "road",
    wayTagKeys: [
      "highway", "junction", "maxspeed", ...accessKeys, "oneway", ...onewayKeys,
      ...accessKeys.map((key) => `${key}:conditional`),
    ],
    relationTagKeys: ["type", "except", ...restrictionKeys, ...restrictionKeys.map((key) => `${key}:conditional`)],
    maxSpeedKph: ceilingKph,
    nodeTagKeys: BARRIER_TAG_KEYS,
    evaluateBarrier: (tags) => barrierAllows(tags, accessKeys, mode === "foot" ? "foot" : "bicycle"),

    evaluateWay(tags) {
      const highway = tags.highway;
      if (!highway || !(highway in speeds)) return null;
      if (!accessAllowed(tags, accessKeys)) return null;

      // A one-way sign restrains traffic. Someone on foot is not traffic, and
      // a cyclist is often signed out of it explicitly.
      const own = tags[`oneway:${mode}`]?.trim().toLowerCase();
      let forward = true;
      let backward = true;
      if (own !== undefined && own !== "") {
        forward = own !== "-1" && own !== "reverse";
        backward = own === "no" || own === "false" || own === "0" || own === "-1" || own === "reverse";
      } else if (!ignoresOneway) {
        ({ forward, backward } = onewayDirections(tags, highway, ["oneway"]));
      }
      if (!forward && !backward) return null;

      // The class decides the pace; a posted limit can only slow it down,
      // never speed it up, because a sign does not make anyone pedal harder.
      const posted = parseMaxSpeedKph(tags.maxspeed);
      const wanted = Math.min(speeds[highway], posted !== null && posted > 0 ? posted : Infinity);
      const speed = Math.min(ceilingKph, Math.max(floorKph, wanted));
      // A walker or a cyclist is held up by a closure but not by a speed
      // limit, so only the access side is kept.
      const conditions = conditionsFor(tags, accessKeys, []);
      return { forward, backward, forwardSpeedKph: speed, backwardSpeedKph: speed, ...(conditions ? { conditions } : {}) };
    },

    evaluateTurnRestriction(tags) {
      if (tags.type !== "restriction") return null;
      const except = tags.except?.split(";").map((value) => value.trim().toLowerCase()) ?? [];
      if (except.some((value) => exceptModes.has(value))) return null;
      let value: string | undefined;
      for (const key of restrictionKeys) if (tags[key] !== undefined) value = tags[key];
      if (!value) return null;
      const kind = TURN_RESTRICTION_KINDS[value.trim().toLowerCase()];
      return kind ? { kind, value } : null;
    },
  };
}

/**
 * Cycling. A cyclist is a vehicle, so the vehicle access ladder applies, and
 * a one-way street is one-way for them too unless `oneway:bicycle=no` says
 * otherwise — which is how a contraflow cycle lane is tagged, and there are
 * a great many of them.
 */
export const bicycleRoutingProfile: RoutingProfile = activeTravelProfile({
  name: "bicycle",
  id: ProfileId.bicycle,
  mode: "bicycle",
  speeds: CYCLING_SPEEDS,
  ceilingKph: 30,
  accessKeys: ["access", "vehicle", "bicycle"],
  ignoresOneway: false,
  floorKph: 4,
});

/**
 * Walking. Someone on foot is not a vehicle, so neither `vehicle` nor
 * `motor_vehicle` reaches them, and a one-way sign does not either. Only
 * `oneway:foot` can make a way one-way for walking, which is rare and usually
 * means a barrier or a turnstile.
 */
export const pedestrianRoutingProfile: RoutingProfile = activeTravelProfile({
  name: "pedestrian",
  id: ProfileId.pedestrian,
  mode: "foot",
  speeds: WALKING_SPEEDS,
  ceilingKph: 7,
  accessKeys: ["access", "foot"],
  ignoresOneway: true,
  floorKph: 1,
});

export const routingProfiles: Record<string, RoutingProfile> = {
  car: carRoutingProfile,
  motorcycle: motorcycleRoutingProfile,
  truck: truckRoutingProfile,
  bicycle: bicycleRoutingProfile,
  pedestrian: pedestrianRoutingProfile,
  train: trainRoutingProfile,
  metro: metroRoutingProfile,
};

export function getRoutingProfile(name: string): RoutingProfile {
  const profile = routingProfiles[name];
  if (!profile) throw new Error(`Unknown routing profile "${name}". Available: ${Object.keys(routingProfiles).join(", ")}.`);
  return profile;
}

/** The profile a stored id refers to, or null when this build does not know it. */
export function getRoutingProfileById(id: number): RoutingProfile | null {
  if (id === ProfileId.unspecified) return carRoutingProfile;
  return Object.values(routingProfiles).find((profile) => profile.id === id) ?? null;
}

/**
 * A graph compiled before profiles were recorded is a car graph, which is what
 * every bundle published up to v0.1.0 holds.
 */
export function profileOf(graph: { profileId?: number }): RoutingProfile {
  return getRoutingProfileById(graph.profileId ?? ProfileId.unspecified) ?? carRoutingProfile;
}

/**
 * The speed ceiling a search may assume, in metres per second. The value
 * stored in the graph wins over this build's table, so a bundle compiled by a
 * newer version still bounds an older reader's heuristic correctly.
 */
export function maxSpeedMpsFor(graph: { profileId?: number; maxSpeedKph?: number }) {
  return ((graph.maxSpeedKph ?? profileOf(graph).maxSpeedKph) * 1000) / 3600;
}
