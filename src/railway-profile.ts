/**
 * Railway profiles: routing over mapped track rather than over roads.
 *
 * A railway is not a road with different numbers, and almost none of the road
 * rules survive the move. There is no access ladder — `vehicle`, `foot` and
 * `motor_vehicle` say nothing about a train, and reading them would let a
 * footpath tag close a main line. There are no turn-restriction relations,
 * because OSM does not describe railway junctions that way. There are no
 * barrier nodes, because a bollard is not a thing that happens to a railway.
 * What a railway has instead is a class of track, a direction where one is
 * explicitly mapped, and a set of physical facts about the track itself —
 * gauge, electrification, what the line is for — which `./railway.ts` reads
 * and stores, and which decide whether a particular train can run there at all.
 *
 * ### What is included, and what is not
 *
 * Inclusion is an allowlist of `railway=` values, never a denylist. The key
 * carries dozens of values that are not track at all — `platform`, `station`,
 * `turntable`, `ventilation_shaft`, `workshop` — and a denylist would route
 * trains along station platforms the first time OSM invented a new value.
 *
 * Track that is not currently track is excluded by default and cannot be
 * opted back in casually: `abandoned`, `razed`, `dismantled`, `demolished` and
 * `proposed` describe where a railway used to be or might one day be, and
 * `construction` describes one that cannot yet carry anything.
 *
 * `disused` is the one genuinely arguable case: the rails are still there and
 * the alignment is intact, but nothing has run over it, sometimes for decades,
 * and OSM does not say whether it could. It is therefore **excluded by
 * default and available as an explicit opt-in**, because including it
 * silently would offer routes over track whose usability nobody has asserted,
 * while refusing it outright would be wrong for the infrastructure-analysis
 * work this profile exists to serve.
 */

import { ConditionKind } from "./conditional";
import { ProfileId, type NetworkKind, type OsmTags, type RoutingProfile, type WayTraversal } from "./profile-types";
import { RAILWAY_ATTRIBUTE_KEYS, RailService, RailUsage, railwayAttributesFor } from "./railway";
import { parseMaxSpeedKph } from "./speed";

/**
 * Values that close a track. Deliberately short, and deliberately not the road
 * list: `destination`, `customers` and `delivery` describe who may drive down
 * a street and mean nothing on a railway, while `private` and `military` do
 * describe track a general operator cannot use.
 */
const RAILWAY_BLOCKED_ACCESS = new Set(["no", "private", "military"]);

/** The access keys a railway reads. `vehicle` and the road modes are not among them. */
const RAILWAY_ACCESS_KEYS = ["access", "train"] as const;

/** Classes of track that are optional extras rather than part of a profile's own network. */
export type RailwayInclusion = "disused" | "narrow_gauge" | "tram" | "light_rail" | "monorail" | "funicular" | "subway" | "rail";

/**
 * Every class that may be asked for, and nothing else.
 *
 * The type above constrains a TypeScript caller, and constrains nothing at
 * all at the compiler's command line, where `--railway-include` arrives as
 * plain text. Without this the documented guarantee — that track which is
 * gone or not yet built cannot be opted back in — held only for callers who
 * were already going to get it right.
 */
export const RAILWAY_INCLUSIONS: readonly RailwayInclusion[] = [
  "rail", "subway", "light_rail", "narrow_gauge", "tram", "monorail", "funicular", "disused",
];

/**
 * Classes that are refused by name rather than merely absent, so that asking
 * for one is answered with the reason instead of with silence.
 */
const NEVER_ROUTABLE: Record<string, string> = {
  abandoned: "the track has been lifted",
  razed: "the track has been lifted",
  dismantled: "the track has been lifted",
  demolished: "the track has been lifted",
  proposed: "the line has not been built",
  construction: "the line is not finished",
  platform: "a platform is not track",
  station: "a station is not track",
  turntable: "a turntable is not a through route",
  yard: "use service=yard on a routable class instead",
};

function assertInclusions(include: readonly string[]) {
  for (const name of include) {
    if ((RAILWAY_INCLUSIONS as readonly string[]).includes(name)) continue;
    const because = NEVER_ROUTABLE[name];
    throw new RangeError(because
      ? `railway class "${name}" cannot be routed over: ${because}. Routable classes are: ${RAILWAY_INCLUSIONS.join(", ")}.`
      : `"${name}" is not a railway class this package routes over. Routable classes are: ${RAILWAY_INCLUSIONS.join(", ")}.`);
  }
}

/**
 * Every class this package knows how to route over, with the speed in km/h to
 * assume where the way states none. These are engineering-plausible line
 * speeds for the class of infrastructure, not service speeds: see the speed
 * note in the README.
 */
const CLASS_SPEEDS: Record<string, number> = {
  rail: 100,
  narrow_gauge: 60,
  subway: 60,
  light_rail: 50,
  tram: 30,
  monorail: 50,
  funicular: 15,
  // Rails in the ground that nobody has run over in years. Routed only when
  // asked for, and then at the pace of track in unknown condition.
  disused: 25,
};

/** Where `usage` is stated, it says more about the line speed than the class does. */
const USAGE_SPEEDS: Partial<Record<number, number>> = {
  [RailUsage.main]: 100,
  [RailUsage.branch]: 80,
  [RailUsage.industrial]: 40,
  [RailUsage.military]: 40,
  [RailUsage.tourism]: 40,
  [RailUsage.freight]: 80,
  [RailUsage.test]: 60,
};

/**
 * Sidings, yards, spurs and crossovers are track, and leaving them out would
 * disconnect the stations they serve. They are slow instead: 25 km/h is about
 * what they are run at, and it keeps a yard from ever looking like a shortcut
 * to a search that is minimising time.
 */
const SERVICE_TRACK_SPEED_KPH = 25;

/**
 * The slowest an *assumed* speed is ever taken to be. It exists so that a
 * class with no table entry cannot produce a free edge, which a search would
 * treat as a shortcut.
 *
 * It is deliberately not applied to a speed the data actually states. A track
 * signed at 3 km/h is a track signed at 3 km/h, and raising it to 5 would let
 * the engine travel faster than the posted limit and report a journey shorter
 * than the infrastructure permits. The only floor on a tagged value is the one
 * below, which exists to keep a pathological tag from overflowing the stored
 * duration — `parseMaxSpeedKph` already rejects zero and negative values.
 */
const ASSUMED_SPEED_FLOOR_KPH = 5;
const TAGGED_SPEED_FLOOR_KPH = 0.1;

export type RailwayProfileOptions = {
  /** Extra `railway=` classes to route over, beyond the profile's own. */
  include?: readonly RailwayInclusion[];
};

function railwayProfile(options: {
  name: string;
  id: ProfileId;
  classes: readonly string[];
  ceilingKph: number;
  include?: readonly RailwayInclusion[];
}): RoutingProfile {
  const { name, id, ceilingKph } = options;
  assertInclusions(options.include ?? []);
  const classes = new Set<string>([...options.classes, ...(options.include ?? [])]);
  const networkKind: NetworkKind = "railway";

  return {
    name,
    id,
    networkKind,
    usesRailwayAttributes: true,
    maxSpeedKph: ceilingKph,
    wayTagKeys: [
      "railway", "maxspeed", "maxspeed:forward", "maxspeed:backward", "oneway",
      ...RAILWAY_ACCESS_KEYS, ...RAILWAY_ACCESS_KEYS.map((key) => `${key}:conditional`),
      ...RAILWAY_ATTRIBUTE_KEYS,
    ],
    // OSM does not describe railway junctions with turn-restriction relations,
    // so none are requested and none are obeyed. Inventing them from the
    // geometry of a switch is exactly the guessing this profile avoids.
    relationTagKeys: [],

    evaluateWay(tags: OsmTags): WayTraversal | null {
      const railway = tags.railway?.trim().toLowerCase();
      if (!railway || !classes.has(railway)) return null;

      // One ladder, two keys. The most specific present wins, as everywhere
      // else in OSM, but the ladder itself is a railway's and not a road's.
      let allowed = true;
      for (const key of RAILWAY_ACCESS_KEYS) {
        const value = tags[key]?.trim().toLowerCase();
        if (value !== undefined) allowed = !RAILWAY_BLOCKED_ACCESS.has(value);
      }
      if (!allowed) return null;

      // Direction is taken only from `oneway`, which is how single-direction
      // running is actually mapped — 906 of the 1,139 Metro do Porto ways in
      // the Portugal extract carry it. `railway:preferred_direction` is a
      // statement about operating practice rather than about what the track
      // permits, so it is read by nothing here; see the README.
      const oneway = tags.oneway?.trim().toLowerCase();
      let forward = true;
      let backward = true;
      if (oneway === "yes" || oneway === "true" || oneway === "1") backward = false;
      else if (oneway === "-1" || oneway === "reverse") forward = false;
      if (!forward && !backward) return null;

      const attributes = railwayAttributesFor(tags);
      // What to assume where the way states nothing: the service track it is,
      // else what the line is for, else the class of track.
      const assumed = Math.min(ceilingKph, Math.max(ASSUMED_SPEED_FLOOR_KPH, attributes.service !== RailService.running
        ? SERVICE_TRACK_SPEED_KPH
        : USAGE_SPEEDS[attributes.usage] ?? CLASS_SPEEDS[railway] ?? ASSUMED_SPEED_FLOOR_KPH));
      const posted = parseMaxSpeedKph(tags.maxspeed);
      /**
       * A direction's speed: the limit signed for that direction, else the
       * one signed for the way, else what the class assumes. A stated limit is
       * used as stated — only the profile's own ceiling may lower it, because
       * no train of this class exceeds that whatever a way claims.
       */
      const speedFor = (direction: "forward" | "backward") => {
        const stated = parseMaxSpeedKph(tags[`maxspeed:${direction}`]) ?? posted;
        return stated === null ? assumed : Math.min(ceilingKph, Math.max(TAGGED_SPEED_FLOOR_KPH, stated));
      };

      let access: string | undefined;
      for (const key of RAILWAY_ACCESS_KEYS) {
        const value = tags[`${key}:conditional`];
        if (value !== undefined) access = value;
      }

      return {
        forward,
        backward,
        forwardSpeedKph: speedFor("forward"),
        backwardSpeedKph: speedFor("backward"),
        railway: attributes,
        ...(access ? { conditions: [{ kind: ConditionKind.access, value: access }] } : {}),
      };
    },

    /** OSM states no turn restrictions for railways, so this profile obeys none. */
    evaluateTurnRestriction() {
      return null;
    },
  };
}

/**
 * Conventional railway. `railway=rail` is the whole of it by default, as the
 * overwhelming majority of main-line track is tagged that way; narrow-gauge
 * lines are real conventional infrastructure but run on track a standard or
 * Iberian-gauge train cannot use, so they are an opt-in rather than a silent
 * addition to the network.
 *
 * The ceiling is 300 km/h: high enough for any line speed OSM states, which
 * keeps the A* heuristic admissible on a high-speed line, and low enough to
 * stay a meaningful bound.
 */
export function createTrainProfile(options: RailwayProfileOptions = {}): RoutingProfile {
  return railwayProfile({ name: "train", id: ProfileId.train, classes: ["rail"], ceilingKph: 300, include: options.include });
}

/**
 * Metro and light rail. `subway` and `light_rail` together, because systems
 * split between the two by local convention rather than by anything physical:
 * Lisbon's metro is `subway` and Porto's is `light_rail`, and a profile
 * holding only one of them would miss an entire network. `tram` is not
 * included by default — a tram shares the street with road traffic, which is
 * a different thing to route over — and is available as an opt-in for systems
 * tagged that way.
 */
export function createMetroProfile(options: RailwayProfileOptions = {}): RoutingProfile {
  return railwayProfile({ name: "metro", id: ProfileId.metro, classes: ["subway", "light_rail"], ceilingKph: 120, include: options.include });
}

export const trainRoutingProfile: RoutingProfile = createTrainProfile();
export const metroRoutingProfile: RoutingProfile = createMetroProfile();

/** Whether a profile travels by rail, for the few places that must keep the networks apart. */
export function isRailwayProfile(profile: { networkKind?: NetworkKind } | null | undefined) {
  return profile?.networkKind === "railway";
}
