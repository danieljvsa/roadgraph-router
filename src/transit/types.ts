import type { Coordinate, GeoJsonLineString } from "../types";

/**
 * What kind of vehicle a line runs. GTFS `route_type` has a basic set (0–12)
 * and an extended set (100–1700); both collapse onto these, which is the
 * granularity a person choosing "bus or metro" thinks in.
 */
export type TransitMode = "tram" | "metro" | "rail" | "bus" | "ferry" | "cable" | "funicular" | "other";

export const TRANSIT_MODES: readonly TransitMode[] = ["tram", "metro", "rail", "bus", "ferry", "cable", "funicular", "other"];

/** Where a ride's drawn geometry came from, so a caller can tell a surveyed track from a guess. */
export const HopSource = {
  /** A straight line between the two stops: nothing better was available. */
  Straight: 0,
  /** The feed's own shapes.txt, cut between the two stops. */
  Shape: 1,
  /** Routed over mapped track or road with a roadgraph bundle at compile time. */
  Routed: 2,
} as const;

export type TransitFeedInfo = {
  /** The id the feed was compiled under, which prefixes its stop and route ids. */
  id: string;
  publisher: string;
  timezone: string;
  /** First and last day with any service, as YYYYMMDD. */
  firstServiceDate: string;
  lastServiceDate: string;
  version: string;
};

/**
 * A compiled timetable, decoded and ready to search.
 *
 * Everything is index-addressed and stored in typed arrays, so a city's
 * timetable is a few megabytes of numbers rather than hundreds of thousands
 * of objects.
 *
 * Trips are grouped into *patterns*: trips of one line calling at the same
 * stops in the same order, sorted by departure and split wherever one trip
 * would overtake another. Within a pattern every stop's departures are
 * therefore in order, which is what lets the search find the next departure
 * with a binary search.
 */
export interface TransitTimetable {
  feeds: TransitFeedInfo[];
  timezone: string;

  stopCount: number;
  stopIds: string[];
  stopNames: string[];
  stopLat: Float64Array;
  stopLng: Float64Array;
  stopFeed: Uint16Array;

  routeCount: number;
  routeIds: string[];
  routeShortNames: string[];
  routeLongNames: string[];
  /** `#rrggbb`, or the empty string when the feed gives no colour. */
  routeColors: string[];
  routeTextColors: string[];
  routeModes: TransitMode[];
  routeFeed: Uint16Array;

  /** Day number (days since 1970-01-01) of bit 0 in every service's day set. */
  firstDay: number;
  dayCount: number;
  serviceCount: number;
  serviceFeed: Uint16Array;
  /** One bit per day from `firstDay`, `ceil(dayCount / 8)` bytes per service. */
  serviceDays: Uint8Array;

  patternCount: number;
  patternRoute: Uint32Array;
  patternHeadsigns: string[];
  /** `patternStops[patternStopOffset[p] .. patternStopOffset[p + 1])` are the stops of pattern p, in order. */
  patternStopOffset: Uint32Array;
  patternStops: Uint32Array;
  /** Trips of pattern p are `patternTripOffset[p] .. patternTripOffset[p + 1]`, sorted by departure. */
  patternTripOffset: Uint32Array;
  patternGeometry: Uint32Array;

  tripCount: number;
  tripService: Uint32Array;
  /**
   * Seconds after the service day's noon-minus-twelve-hours, two per stop
   * (arrival, departure), starting at `tripTimeOffset[t]`. Values past 86 400
   * are trips running after midnight on the service day.
   */
  tripTimeOffset: Uint32Array;
  tripTimes: Int32Array;

  /** Walking links between stops: `transferTo[transferOffset[s] .. transferOffset[s + 1])`. */
  transferOffset: Uint32Array;
  transferTo: Uint32Array;
  transferSeconds: Uint32Array;
  transferMeters: Uint32Array;

  /**
   * Ride geometry, shared by every pattern with the same line and stop
   * sequence. Geometry g has one hop per consecutive pair of its stops; hop
   * `geometryHopOffset[g] + i` runs from stop i to stop i + 1 and its points
   * are `hopCoords[2 * hopPointOffset[h] .. 2 * hopPointOffset[h + 1])` as
   * longitude, latitude pairs.
   */
  geometryCount: number;
  geometryHopOffset: Uint32Array;
  hopPointOffset: Uint32Array;
  hopCoords: Float64Array;
  hopSource: Uint8Array;
}

/** What a compile understood and what it had to approximate. */
export type TransitCompileReport = {
  feeds: TransitFeedInfo[];
  stops: number;
  routes: number;
  trips: number;
  patterns: number;
  stopTimes: number;
  transfers: number;
  /** Trips left out, and why: unknown route, unknown stop, fewer than two timed stops, … */
  skippedTrips: Record<string, number>;
  /** Stop times without a time of their own whose time was interpolated between neighbours. */
  interpolatedStopTimes: number;
  /**
   * Calendar services that have dates but no trips. A feed whose weekday
   * service is listed here runs nothing on those weekdays, which is nearly
   * always a broken export rather than a real timetable.
   */
  servicesWithoutTrips: { service: string; days: number; first: string; last: string }[];
  hops: { total: number; shape: number; routed: number; straight: number };
  /** Hops that wanted a routed geometry and fell back to a straight line, with the reason. */
  hopFallbacks: { route: string; from: string; to: string; reason: string }[];
  /**
   * Rail stops moved onto the track their routed rides run along, and how far,
   * when a feed placed them at an entrance or on the street.
   */
  stopsPlacedOnTrack: { stop: string; name: string; meters: number }[];
  timetableBytes?: number;
};

/** A walking leg: to the first stop, between stops, or from the last stop. */
export type WalkLeg = {
  kind: "walk";
  from: Coordinate;
  to: Coordinate;
  /** Set when the end of the leg is a stop. */
  fromStop?: TransitStop;
  toStop?: TransitStop;
  departAt: number;
  arriveAt: number;
  durationSeconds: number;
  distanceMeters: number;
  /** True when the walk was routed over the street network rather than estimated. */
  routed: boolean;
  geometry: GeoJsonLineString;
};

export type TransitStop = { id: string; name: string; lat: number; lng: number };

export type TransitLine = {
  id: string;
  shortName: string;
  longName: string;
  color: string;
  textColor: string;
  mode: TransitMode;
  feed: string;
};

export type RideLeg = {
  kind: "ride";
  line: TransitLine;
  headsign: string;
  from: TransitStop;
  to: TransitStop;
  /** Stops passed through between boarding and alighting, not including either, with when the vehicle is there. */
  intermediateStops: (TransitStop & { arriveAt: number })[];
  departAt: number;
  arriveAt: number;
  durationSeconds: number;
  geometry: GeoJsonLineString;
  /** How the geometry was obtained, per hop: see `HopSource`. */
  geometrySource: "shape" | "routed" | "straight" | "mixed";
};

/**
 * Driving or cycling to the first station, where the car or bicycle is
 * left (`TransitPlanOptions.access`). The ride after it leaves at least
 * `parkSeconds` after `arriveAt`.
 */
export type VehicleLeg = {
  kind: "drive" | "cycle";
  from: Coordinate;
  to: Coordinate;
  toStop: TransitStop;
  departAt: number;
  arriveAt: number;
  durationSeconds: number;
  distanceMeters: number;
  /** Time allowed after arriving to park or lock up and reach the platform. */
  parkSeconds: number;
  geometry: GeoJsonLineString;
};

export type TransitLeg = WalkLeg | RideLeg | VehicleLeg;

export type TransitJourney = {
  departAt: number;
  arriveAt: number;
  durationSeconds: number;
  rides: number;
  walkMeters: number;
  legs: TransitLeg[];
};

export type TransitPlan = {
  journeys: TransitJourney[];
  /**
   * For each feed, the date whose timetable was used. It differs from the
   * requested date only when `dateFallback` substituted one because the feed
   * does not cover the requested day.
   */
  serviceDates: { feed: string; requested: string; used: string; substituted: boolean }[];
};
