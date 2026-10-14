/**
 * Routing profiles turn raw OSM tags into routable facts: may a vehicle use
 * this way, in which directions, and how fast. Keeping the rules behind one
 * interface lets the compiler stay generic — it never inspects a tag itself —
 * and lets the rules be unit-tested without a PBF file.
 */

export type OsmTags = Record<string, string | undefined>;

/** How a profile may traverse one OSM way. */
export type WayTraversal = {
  /** Travel from the first node reference towards the last is allowed. */
  forward: boolean;
  /** Travel from the last node reference towards the first is allowed. */
  backward: boolean;
  /** Travel speed in km/h in each direction; both are clamped to the profile range. */
  forwardSpeedKph: number;
  backwardSpeedKph: number;
};

/** A turn restriction relation reduced to the only two cases routing cares about. */
export type TurnRestrictionKind = "no" | "only";

export type ParsedTurnRestriction = {
  kind: TurnRestrictionKind;
  /** The raw OSM value, kept for diagnostics only. */
  value: string;
};

/**
 * Stable numeric ids written into compiled graphs. They are part of the file
 * format, so a value is never reused for a different profile; 0 is reserved
 * for graphs compiled before profiles were recorded, which were all cars.
 */
export const ProfileId = {
  unspecified: 0,
  car: 1,
  truck: 2,
  motorcycle: 3,
  bicycle: 4,
  pedestrian: 5,
} as const;
export type ProfileId = (typeof ProfileId)[keyof typeof ProfileId];

export interface RoutingProfile {
  readonly name: string;
  /** The id this profile is stored under. See `ProfileId`. */
  readonly id: ProfileId;
  /** Way tag keys the compiler must request from the PBF reader. */
  readonly wayTagKeys: readonly string[];
  /** Relation tag keys the compiler must request from the PBF reader. */
  readonly relationTagKeys: readonly string[];
  /** The fastest speed the profile can ever return, used for admissible A* heuristics. */
  readonly maxSpeedKph: number;
  /** Returns null when the way is not usable by this profile at all. */
  evaluateWay(tags: OsmTags): WayTraversal | null;
  /** Returns null when the relation is not a turn restriction this profile obeys. */
  evaluateTurnRestriction(tags: OsmTags): ParsedTurnRestriction | null;
}

const MINIMUM_SPEED_KPH = 5;
const MAXIMUM_SPEED_KPH = 150;

/** Values that deny passage, from most to least common. `destination`, `customers`,
 *  `delivery` and `permissive` all still allow a car through, so they are absent. */
const BLOCKED_ACCESS = new Set(["no", "private", "agricultural", "forestry", "military", "emergency", "use_sidepath"]);

/** Highway classes a car may drive on, with their default free-flow speed in km/h. */
const CAR_HIGHWAY_SPEEDS: Record<string, number> = {
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

/** Access keys from least to most specific; a later key overrides an earlier one. */
const CAR_ACCESS_KEYS = ["access", "vehicle", "motor_vehicle", "motorcar"] as const;

/** Restriction keys from least to most specific, mirroring the access hierarchy. */
const CAR_RESTRICTION_KEYS = ["restriction", "restriction:vehicle", "restriction:motor_vehicle", "restriction:motorcar"] as const;

/** Transport modes that exempt a car from a restriction carrying `except`. */
const CAR_EXCEPT_MODES = new Set(["motorcar", "motor_vehicle", "vehicle"]);

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
export function parseMaxSpeedKph(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text === "walk") return 7;
  const match = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "mph") return amount * 1.609344;
  if (match[2] === "knots") return amount * 1.852;
  return amount;
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

function onewayDirections(tags: OsmTags, highway: string | undefined) {
  const oneway = tags.oneway?.trim().toLowerCase();
  if (oneway === "yes" || oneway === "true" || oneway === "1") return { forward: true, backward: false };
  if (oneway === "-1" || oneway === "reverse") return { forward: false, backward: true };
  // `reversible` and `alternating` carriageways change direction over time;
  // treating them as two-way keeps them routable rather than silently removed.
  if (oneway !== undefined && oneway !== "") return { forward: true, backward: true };
  const junction = tags.junction?.trim().toLowerCase();
  if (junction === "roundabout" || junction === "circular") return { forward: true, backward: false };
  if (highway && IMPLICITLY_ONEWAY.has(highway)) return { forward: true, backward: false };
  return { forward: true, backward: true };
}

export const carRoutingProfile: RoutingProfile = {
  name: "car",
  id: ProfileId.car,
  wayTagKeys: ["highway", "oneway", "junction", "access", "vehicle", "motor_vehicle", "motorcar", "maxspeed", "maxspeed:forward", "maxspeed:backward"],
  relationTagKeys: ["type", "except", ...CAR_RESTRICTION_KEYS],
  maxSpeedKph: MAXIMUM_SPEED_KPH,

  evaluateWay(tags) {
    const highway = tags.highway;
    if (!highway || !(highway in CAR_HIGHWAY_SPEEDS)) return null;
    if (!accessAllowed(tags, CAR_ACCESS_KEYS)) return null;
    const { forward, backward } = onewayDirections(tags, highway);
    if (!forward && !backward) return null;
    const base = parseMaxSpeedKph(tags.maxspeed) ?? CAR_HIGHWAY_SPEEDS[highway];
    return {
      forward,
      backward,
      forwardSpeedKph: clampSpeed(parseMaxSpeedKph(tags["maxspeed:forward"]) ?? base),
      backwardSpeedKph: clampSpeed(parseMaxSpeedKph(tags["maxspeed:backward"]) ?? base),
    };
  },

  evaluateTurnRestriction(tags) {
    if (tags.type !== "restriction") return null;
    const except = tags.except?.split(";").map((mode) => mode.trim().toLowerCase()) ?? [];
    if (except.some((mode) => CAR_EXCEPT_MODES.has(mode))) return null;
    let value: string | undefined;
    for (const key of CAR_RESTRICTION_KEYS) if (tags[key] !== undefined) value = tags[key];
    if (!value) return null;
    const kind = TURN_RESTRICTION_KINDS[value.trim().toLowerCase()];
    return kind ? { kind, value } : null;
  },
};

export const routingProfiles: Record<string, RoutingProfile> = { car: carRoutingProfile };

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
