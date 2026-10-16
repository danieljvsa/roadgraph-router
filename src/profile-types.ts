/**
 * The vocabulary every routing profile is written in, kept apart from the
 * profiles themselves so that a profile for one kind of network can be
 * defined without importing the profiles for another. `routing-profile.ts`
 * re-exports all of it, so nothing outside this package has to know.
 */

export type OsmTags = Record<string, string | undefined>;

/** How a profile may traverse one OSM way. */
export type WayTraversal = {
  /**
   * Conditional restrictions tagged on the way, kept as written for the
   * router to evaluate against a departure time. They apply to both
   * directions: OSM states these per vehicle class, not per direction.
   */
  conditions?: { kind: number; value: string }[];
  /** Travel from the first node reference towards the last is allowed. */
  forward: boolean;
  /** Travel from the last node reference towards the first is allowed. */
  backward: boolean;
  /** Travel speed in km/h in each direction; both are clamped to the profile range. */
  forwardSpeedKph: number;
  backwardSpeedKph: number;
  /** Physical limits in force along this way, where the data states any. */
  forwardLimits?: VehicleLimits;
  backwardLimits?: VehicleLimits;
  /**
   * What the track itself is, for a railway profile. Unlike a height limit
   * this is a property of the way rather than of one direction along it: a
   * track does not change gauge depending on which way a train runs over it.
   */
  railway?: RailwayAttributes;
};

/** A turn restriction relation reduced to the only two cases routing cares about. */
export type TurnRestrictionKind = "no" | "only";

/**
 * A physical limit OSM states for a way. Every field is optional because an
 * untagged limit is unknown, not absent: most bridges carry no `maxheight` at
 * all, and treating silence as "no limit" is the assumption this library makes
 * and says so, rather than inventing a number.
 */
export type VehicleLimits = {
  heightMeters?: number;
  widthMeters?: number;
  lengthMeters?: number;
  weightTonnes?: number;
};

/**
 * What a railway way states about itself. Every field is a *stated* fact or
 * `unknown`; nothing here is inferred, because an untagged track is one
 * nobody has described, not one that is unelectrified or standard gauge.
 */
export type RailwayAttributes = {
  /** Track gauge in millimetres, or 0 when the way does not state one. */
  gaugeMm: number;
  /** The second gauge of a dual-gauge track, or 0. `gauge=1000;1668` is real. */
  secondGaugeMm: number;
  /** See `Electrification`. */
  electrification: number;
  /** Contact system voltage, or 0 when unstated. */
  voltage: number;
  /** The second voltage of a dual-system track, or 0. `voltage=1500;25000` is real. */
  secondVoltage: number;
  /** See `RailFrequency`; direct current is a stated value, not an absent one. */
  frequency: number;
  /** The second frequency of a dual-system track, or `unknown`. `frequency=0;16.7` is real. */
  secondFrequency: number;
  /** See `RailUsage`. */
  usage: number;
  /** See `RailService`. */
  service: number;
};

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
  train: 6,
  metro: 7,
} as const;
export type ProfileId = (typeof ProfileId)[keyof typeof ProfileId];

/**
 * Which physical network a profile routes over. Two profiles on the same
 * network can share one compiled topology; two on different networks cannot,
 * because a road and a railway have nothing in common but the ground they
 * cross. Mixing them in one bundle is refused rather than silently allowed.
 */
export type NetworkKind = "road" | "railway";

export interface RoutingProfile {
  readonly name: string;
  /** The id this profile is stored under. See `ProfileId`. */
  readonly id: ProfileId;
  /** The network this profile travels over. See `NetworkKind`. */
  readonly networkKind: NetworkKind;
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
  /**
   * Whether this profile's routes depend on the vehicle's physical size, which
   * tells the compiler to keep the limits `evaluateWay` reports.
   */
  readonly usesPhysicalLimits?: boolean;
  /**
   * Whether this profile's routes depend on what the track is — its gauge, its
   * electrification, what it is for — which tells the compiler to keep the
   * railway attributes `evaluateWay` reports.
   */
  readonly usesRailwayAttributes?: boolean;
  /** Node tag keys the compiler must request, for barriers. */
  readonly nodeTagKeys?: readonly string[];
  /**
   * Whether this traveller gets past a barrier on the road. Returns true when
   * the node is not a barrier at all, so an absent answer means "carry on".
   */
  evaluateBarrier?(tags: OsmTags): boolean;
}
