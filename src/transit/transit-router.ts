import type { Coordinate, GeoJsonLineString } from "../types";
import { decodeTransitTimetable } from "./codec";
import { definedOnly, haversineMeters } from "./compile";
import { buildStopPatternIndex, raptor, type DayLayer, type RaptorJourney, type StopPatternIndex } from "./raptor";
import { ServiceCalendar } from "./calendar";
import { dateOfDay, localServiceTime, serviceDayOrigin } from "./time";
import {
  HopSource, TRANSIT_MODES,
  type RideLeg, type TransitJourney, type TransitLeg, type TransitLine, type TransitMode, type TransitPlan,
  type TransitStop, type TransitTimetable, type WalkLeg,
} from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Anything that can walk between two points. A `RoadRouter` opened on a
 * pedestrian bundle fits as is; without one, walks are estimated from the
 * straight line.
 */
export type WalkRouter = {
  route(from: Coordinate, to: Coordinate): Promise<{ distanceMeters: number; durationSeconds: number; geometry: GeoJsonLineString }>;
};

export type TransitPlanOptions = {
  /** When to leave. Default: now. */
  departAt?: Date | number;
  /** Only ride these modes, e.g. `["metro"]` or `["bus", "tram"]`. Default: all. */
  modes?: TransitMode[];
  /** Only ride these feeds' lines, by compile id (`"metro"`, `"stcp"`). Default: all. */
  feeds?: string[];
  /** At most this many vehicles per journey. Default 4. */
  maxRides?: number;
  /** How far to walk, in a straight line, to the first stop or from the last. Default 1000 m. */
  maxWalkMeters?: number;
  /** Extra time allowed for a change of vehicle at the same stop. Default 60 s. */
  minTransferSeconds?: number;
  /**
   * How many later departures to offer besides the earliest arrival: each is
   * the best journey leaving after the previous option. Default 0. Journeys
   * come back ordered by when they leave.
   */
  alternatives?: number;
  /** Walking pace, for estimated walks. Default 1.25 m/s. */
  walkSpeedMps?: number;
  /** How much longer than the straight line an estimated walk is. Default 1.3. */
  walkDetourFactor?: number;
  /**
   * What to do when a feed's timetable does not cover the requested day.
   * `"none"` (default) plans with no service from that feed. `"same-weekday"`
   * uses the nearest covered day falling on the same weekday, and says so in
   * `TransitPlan.serviceDates`: a timetable from another week is an estimate,
   * not a schedule.
   */
  dateFallback?: "none" | "same-weekday";
  /** Overrides the router's walk router for this plan; `null` estimates walks. */
  walkRouter?: WalkRouter | null;
};

export type TransitRouterOptions = { walkRouter?: WalkRouter };

const DEFAULTS = {
  alternatives: 0,
  maxRides: 4,
  maxWalkMeters: 1000,
  minTransferSeconds: 60,
  walkSpeedMps: 1.25,
  walkDetourFactor: 1.3,
};

/** Candidate stops at each end: the nearest few, plus the nearest stop of every line within reach. */
const NEAREST_ALWAYS = 4;
const MAX_CANDIDATE_STOPS = 40;

export class TransitRouter {
  private readonly index: StopPatternIndex;
  private readonly stopRoutes: Uint32Array[];
  private readonly calendar: ServiceCalendar;
  private walkRouter: WalkRouter | undefined;

  constructor(readonly timetable: TransitTimetable, options: TransitRouterOptions = {}) {
    this.index = buildStopPatternIndex(timetable);
    this.walkRouter = options.walkRouter;
    this.calendar = new ServiceCalendar(timetable);
    this.stopRoutes = [];
    for (let s = 0; s < timetable.stopCount; s += 1) {
      const routes = new Set<number>();
      for (let i = this.index.offset[s]; i < this.index.offset[s + 1]; i += 1) routes.add(timetable.patternRoute[this.index.pattern[i]]);
      this.stopRoutes.push(Uint32Array.from(routes));
    }
  }

  /** Opens an EFTT timetable from a URL, its bytes, or an already-decoded timetable. */
  static async open(source: string | ArrayBuffer | Uint8Array | TransitTimetable, fetcher: FetchLike = fetch, options: TransitRouterOptions = {}) {
    if (typeof source === "string") {
      const response = await fetcher(source);
      if (!response.ok) throw new Error(`Unable to load transit timetable (${response.status}).`);
      return new TransitRouter(await decodeTransitTimetable(await response.arrayBuffer()), options);
    }
    if (source instanceof ArrayBuffer || source instanceof Uint8Array) return new TransitRouter(await decodeTransitTimetable(source), options);
    return new TransitRouter(source, options);
  }

  /** Sets the router used for walks, e.g. once a pedestrian bundle has loaded. */
  setWalkRouter(router: WalkRouter | undefined) {
    this.walkRouter = router;
  }

  /** The modes this timetable has lines for. */
  get modes(): TransitMode[] {
    const present = new Set(this.timetable.routeModes);
    return TRANSIT_MODES.filter((mode) => present.has(mode));
  }

  get feeds() {
    return this.timetable.feeds;
  }

  line(route: number): TransitLine {
    const t = this.timetable;
    return {
      id: t.routeIds[route], shortName: t.routeShortNames[route], longName: t.routeLongNames[route],
      color: t.routeColors[route], textColor: t.routeTextColors[route], mode: t.routeModes[route], feed: t.feeds[t.routeFeed[route]].id,
    };
  }

  stop(index: number): TransitStop {
    const t = this.timetable;
    return { id: t.stopIds[index], name: t.stopNames[index], lat: t.stopLat[index], lng: t.stopLng[index] };
  }

  async plan(from: Coordinate, to: Coordinate, options: TransitPlanOptions = {}): Promise<TransitPlan> {
    const t = this.timetable;
    const o = { ...DEFAULTS, ...definedOnly(options) };
    const walkRouter = options.walkRouter === null ? undefined : options.walkRouter ?? this.walkRouter;
    const departMs = options.departAt === undefined ? Date.now() : typeof options.departAt === "number" ? options.departAt : options.departAt.getTime();
    const { day, seconds: departSeconds } = localServiceTime(departMs, t.timezone);
    const origin = serviceDayOrigin(day, t.timezone);

    // Which service day each feed's timetable is read on.
    const serviceDates: TransitPlan["serviceDates"] = [];
    const feedDay = t.feeds.map((feed, index) => {
      const used = this.calendar.dayFor(index, day, o.dateFallback ?? "none");
      serviceDates.push({ feed: feed.id, requested: dateOfDay(day), used: used === null ? "" : dateOfDay(used), substituted: used !== null && used !== day });
      return used;
    });
    const layers: DayLayer[] = [-1, 0, 1].map((offset) => {
      const active = new Uint8Array(t.serviceCount);
      for (let s = 0; s < t.serviceCount; s += 1) {
        const base = feedDay[t.serviceFeed[s]];
        if (base !== null) active[s] = this.calendar.runsOn(s, base + offset) ? 1 : 0;
      }
      // Exact seconds between the two service-day origins, DST included.
      return { shift: Math.round((serviceDayOrigin(day + offset, t.timezone) - origin) / 1000), active };
    });

    const allowedModes = new Set(o.modes ?? TRANSIT_MODES);
    const allowedFeeds = o.feeds ? new Set(o.feeds) : null;
    const routeAllowed = new Uint8Array(t.routeCount);
    for (let r = 0; r < t.routeCount; r += 1) {
      routeAllowed[r] = allowedModes.has(t.routeModes[r]) && (!allowedFeeds || allowedFeeds.has(t.feeds[t.routeFeed[r]].id)) ? 1 : 0;
    }
    const patternAllowed = new Uint8Array(t.patternCount);
    for (let p = 0; p < t.patternCount; p += 1) patternAllowed[p] = routeAllowed[t.patternRoute[p]];

    const estimate = (meters: number) => Math.ceil((meters * o.walkDetourFactor) / o.walkSpeedMps);
    const access = this.candidates(from, o.maxWalkMeters, routeAllowed);
    const egress = this.candidates(to, o.maxWalkMeters, routeAllowed);

    // Walks to the nearest few stops are worth routing for real before the
    // search, because whether a departure can be caught depends on them.
    const accessSeconds = new Map<number, number>();
    const egressSeconds = new Map<number, number>();
    const walks = new Map<string, Awaited<ReturnType<WalkRouter["route"]>> | null>();
    const walk = async (a: Coordinate, b: Coordinate, key: string) => {
      if (!walkRouter) return null;
      if (!walks.has(key)) walks.set(key, await walkRouter.route(a, b).catch(() => null));
      return walks.get(key)!;
    };
    await Promise.all([
      ...access.map(async ({ stop, meters }, i) => {
        const routed = i < NEAREST_ALWAYS ? await walk(from, this.coord(stop), `a${stop}`) : null;
        accessSeconds.set(stop, routed ? Math.round(routed.durationSeconds) : estimate(meters));
      }),
      ...egress.map(async ({ stop, meters }, i) => {
        const routed = i < NEAREST_ALWAYS ? await walk(this.coord(stop), to, `e${stop}`) : null;
        egressSeconds.set(stop, routed ? Math.round(routed.durationSeconds) : estimate(meters));
      }),
    ]);

    // Search; then route the walks the answers actually use and, if any took
    // a different time from its estimate, search again with the real time.
    // Each stop is routed at most once, so this settles in a few passes.
    const search = async (startSeconds: number) => {
      let found: RaptorJourney[] = [];
      for (let pass = 0; pass < 4; pass += 1) {
        found = raptor(t, this.index, {
          sources: access.map(({ stop }) => ({ stop, arrival: startSeconds + accessSeconds.get(stop)! })),
          targets: egressSeconds,
          layers,
          patternAllowed,
          maxRides: o.maxRides,
          minTransferSeconds: o.minTransferSeconds,
        });
        if (!walkRouter) break;
        let changed = false;
        for (const journey of found) {
          const first = journey.steps[0];
          if (first?.kind === "access") {
            const routed = await walk(from, this.coord(first.stop), `a${first.stop}`);
            if (routed && Math.round(routed.durationSeconds) !== accessSeconds.get(first.stop)) {
              accessSeconds.set(first.stop, Math.round(routed.durationSeconds));
              changed = true;
            }
          }
          const routed = await walk(this.coord(journey.egressStop), to, `e${journey.egressStop}`);
          if (routed && Math.round(routed.durationSeconds) !== egressSeconds.get(journey.egressStop)) {
            egressSeconds.set(journey.egressStop, Math.round(routed.durationSeconds));
            changed = true;
          }
        }
        if (!changed) break;
      }
      return found;
    };

    const at = (seconds: number) => origin + seconds * 1000;
    const journeys: TransitJourney[] = [];
    const seen = new Set<string>();
    const wanted = 1 + Math.max(0, Math.floor(o.alternatives));
    // Later departures: search again from just after the earliest option found
    // so far leaves, which yields the next departure, until enough distinct
    // journeys are in hand. A bounded number of searches either way.
    let startSeconds = departSeconds;
    for (let round = 0; round < wanted * 2 && journeys.length < wanted; round += 1) {
      const found = await search(startSeconds);
      if (found.length === 0) break;
      let earliestLeave = Infinity;
      for (const result of found) {
        const journey = await this.buildJourney(result, from, to, startSeconds, at, walk, accessSeconds, egressSeconds);
        earliestLeave = Math.min(earliestLeave, journey.departAt);
        const key = journey.legs.map((leg) => (leg.kind === "ride" ? `${leg.line.id}@${leg.departAt}` : "")).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        journeys.push(journey);
      }
      if (!Number.isFinite(earliestLeave)) break;
      startSeconds = Math.max(startSeconds + 60, Math.round((earliestLeave - origin) / 1000) + 60);
    }
    journeys.sort((a, b) => a.departAt - b.departAt || a.arriveAt - b.arriveAt);

    // Walking the whole way is a journey too, and sometimes the best one.
    const directMeters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    if (directMeters <= Math.max(o.maxWalkMeters * 2, 1500) || journeys.length === 0) {
      const routed = await walk(from, to, "direct");
      const seconds = routed ? Math.round(routed.durationSeconds) : estimate(directMeters);
      const earliest = journeys.reduce((min, j) => Math.min(min, j.arriveAt), Infinity);
      if (at(departSeconds + seconds) <= earliest || (journeys.length === 0 && directMeters <= o.maxWalkMeters * 3)) {
        const leg = walkLeg(from, to, at(departSeconds), seconds, routed, directMeters * o.walkDetourFactor);
        journeys.unshift({ departAt: leg.departAt, arriveAt: leg.arriveAt, durationSeconds: seconds, rides: 0, walkMeters: leg.distanceMeters, legs: [leg] });
      }
    }
    return { journeys, serviceDates };
  }

  private coord(stop: number): Coordinate {
    return { lat: this.timetable.stopLat[stop], lng: this.timetable.stopLng[stop] };
  }

  /**
   * Stops within reach of a point: always the nearest few, then the nearest
   * stop of each line not yet covered, so a metro station 800 m away is not
   * crowded out by a dozen bus stops 200 m away.
   */
  private candidates(point: Coordinate, maxMeters: number, routeAllowed: Uint8Array) {
    const t = this.timetable;
    const near: { stop: number; meters: number }[] = [];
    const latSpan = maxMeters / 111_320;
    const lngSpan = latSpan / Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
    for (let s = 0; s < t.stopCount; s += 1) {
      if (Math.abs(t.stopLat[s] - point.lat) > latSpan || Math.abs(t.stopLng[s] - point.lng) > lngSpan) continue;
      if (!this.stopRoutes[s].some((r) => routeAllowed[r])) continue;
      const meters = haversineMeters(point.lat, point.lng, t.stopLat[s], t.stopLng[s]);
      if (meters <= maxMeters) near.push({ stop: s, meters });
    }
    near.sort((a, b) => a.meters - b.meters);
    const covered = new Set<number>();
    const chosen: { stop: number; meters: number }[] = [];
    for (const candidate of near) {
      const routes = this.stopRoutes[candidate.stop];
      const adds = routes.some((r) => routeAllowed[r] && !covered.has(r));
      if (chosen.length < NEAREST_ALWAYS || adds) {
        chosen.push(candidate);
        routes.forEach((r) => covered.add(r));
        if (chosen.length >= MAX_CANDIDATE_STOPS) break;
      }
    }
    return chosen;
  }

  private async buildJourney(
    result: RaptorJourney,
    from: Coordinate,
    to: Coordinate,
    departSeconds: number,
    at: (seconds: number) => number,
    walk: (a: Coordinate, b: Coordinate, key: string) => Promise<Awaited<ReturnType<WalkRouter["route"]>> | null>,
    accessSeconds: Map<number, number>,
    egressSeconds: Map<number, number>,
  ): Promise<TransitJourney> {
    const legs: TransitLeg[] = [];
    const firstRide = result.steps.find((step) => step.kind === "ride");
    for (const step of result.steps) {
      if (step.kind === "access") {
        const stop = this.coord(step.stop);
        const meters = haversineMeters(from.lat, from.lng, stop.lat, stop.lng);
        const routed = await walk(from, stop, `a${step.stop}`);
        // The time the search used, so the journey agrees with the departure it found.
        const seconds = accessSeconds.get(step.stop)!;
        // Leave just in time for the first departure rather than at the requested time.
        const board = firstRide?.kind === "ride" ? firstRide.ride.departure : departSeconds + seconds;
        const leg = walkLeg(from, stop, at(board - seconds), seconds, routed, meters * 1.3);
        leg.toStop = this.stop(step.stop);
        if (seconds > 0 || meters > 1) legs.push(leg);
      } else if (step.kind === "walk") {
        const previous = legs[legs.length - 1];
        const start = previous ? (previous.arriveAt - at(0)) / 1000 : departSeconds;
        const a = this.coord(step.from);
        const b = this.coord(step.to);
        const leg = walkLeg(a, b, at(start), step.seconds, null, step.meters);
        leg.fromStop = this.stop(step.from);
        leg.toStop = this.stop(step.to);
        legs.push(leg);
      } else {
        legs.push(this.rideLeg(step.ride, at));
      }
    }
    const lastStop = this.coord(result.egressStop);
    const last = legs[legs.length - 1];
    const routed = await walk(lastStop, to, `e${result.egressStop}`);
    const meters = haversineMeters(lastStop.lat, lastStop.lng, to.lat, to.lng);
    const seconds = egressSeconds.get(result.egressStop) ?? result.egressSeconds;
    if (seconds > 0 || meters > 1) {
      const leg = walkLeg(lastStop, to, last.arriveAt, seconds, routed, meters * 1.3);
      leg.fromStop = this.stop(result.egressStop);
      legs.push(leg);
    }
    const departAt = legs[0].departAt;
    const arriveAt = legs[legs.length - 1].arriveAt;
    return {
      departAt,
      arriveAt,
      durationSeconds: Math.round((arriveAt - departAt) / 1000),
      rides: legs.filter((leg) => leg.kind === "ride").length,
      walkMeters: Math.round(legs.reduce((sum, leg) => sum + (leg.kind === "walk" ? leg.distanceMeters : 0), 0)),
      legs,
    };
  }

  private rideLeg(ride: { pattern: number; trip: number; boardPos: number; alightPos: number; departure: number; arrival: number }, at: (s: number) => number): RideLeg {
    const t = this.timetable;
    const stopBase = t.patternStopOffset[ride.pattern];
    const geometry = t.patternGeometry[ride.pattern];
    const coordinates: number[][] = [];
    const sources = new Set<number>();
    for (let pos = ride.boardPos; pos < ride.alightPos; pos += 1) {
      const hop = t.geometryHopOffset[geometry] + pos;
      sources.add(t.hopSource[hop]);
      for (let i = t.hopPointOffset[hop]; i < t.hopPointOffset[hop + 1]; i += 1) {
        const point = [t.hopCoords[2 * i], t.hopCoords[2 * i + 1]];
        const prior = coordinates[coordinates.length - 1];
        if (!prior || prior[0] !== point[0] || prior[1] !== point[1]) coordinates.push(point);
      }
    }
    const tripBase = t.tripTimeOffset[ride.trip];
    const shift = ride.departure - t.tripTimes[tripBase + 2 * ride.boardPos + 1];
    const intermediateStops: (TransitStop & { arriveAt: number })[] = [];
    for (let pos = ride.boardPos + 1; pos < ride.alightPos; pos += 1) {
      intermediateStops.push({ ...this.stop(t.patternStops[stopBase + pos]), arriveAt: at(t.tripTimes[tripBase + 2 * pos] + shift) });
    }
    const source = sources.size > 1 ? "mixed" : sources.has(HopSource.Shape) ? "shape" : sources.has(HopSource.Routed) ? "routed" : "straight";
    return {
      kind: "ride",
      line: this.line(t.patternRoute[ride.pattern]),
      headsign: t.patternHeadsigns[ride.pattern],
      from: this.stop(t.patternStops[stopBase + ride.boardPos]),
      to: this.stop(t.patternStops[stopBase + ride.alightPos]),
      intermediateStops,
      departAt: at(ride.departure),
      arriveAt: at(ride.arrival),
      durationSeconds: ride.arrival - ride.departure,
      geometry: { type: "LineString", coordinates },
      geometrySource: source,
    };
  }
}

function walkLeg(from: Coordinate, to: Coordinate, departAt: number, seconds: number, routed: Awaited<ReturnType<WalkRouter["route"]>> | null, estimatedMeters: number): WalkLeg {
  return {
    kind: "walk",
    from,
    to,
    departAt,
    arriveAt: departAt + seconds * 1000,
    durationSeconds: seconds,
    distanceMeters: Math.round(routed ? routed.distanceMeters : estimatedMeters),
    routed: Boolean(routed),
    geometry: routed?.geometry ?? { type: "LineString", coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
  };
}
