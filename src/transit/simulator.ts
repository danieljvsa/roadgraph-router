import type { GeoJsonLineString } from "../types";
import { ServiceCalendar } from "./calendar";
import { haversineMeters } from "./compile";
import { buildStopPatternIndex, type StopPatternIndex } from "./raptor";
import { dateOfDay, localServiceTime, serviceDayOrigin } from "./time";
import {
  TRANSIT_MODES,
  type TransitLine, type TransitMode, type TransitStop, type TransitTimetable,
} from "./types";

export type TransitSimulatorOptions = {
  /** Only these modes' vehicles. Default: all. */
  modes?: TransitMode[];
  /** Only these feeds' vehicles, by compile id. Default: all. */
  feeds?: string[];
  /**
   * What to do when a feed's timetable does not cover the day: `"none"`
   * (default) shows none of its vehicles; `"same-weekday"` runs the nearest
   * covered day with the same weekday, as `TransitRouter.plan` does.
   */
  dateFallback?: "none" | "same-weekday";
};

/**
 * Where every running vehicle is at one instant, in flat arrays so a frame of
 * a few thousand vehicles is a handful of allocations and can be posted from
 * a worker without copying (transfer the buffers).
 *
 * Vehicle i is trip `trips[i]` of route `routes[i]`, at longitude
 * `coords[3i]`, latitude `coords[3i + 1]`, heading `coords[3i + 2]` degrees
 * clockwise from north.
 */
export type VehiclePositions = {
  count: number;
  /** Trip index, for `tripDetails`. */
  trips: Uint32Array;
  /** Route index, for the line's colour and for filtering. */
  routes: Uint32Array;
  coords: Float32Array;
  /** 1 while the vehicle waits at a stop, 0 while it moves between two. */
  atStop: Uint8Array;
  /** Which service day the trip belongs to: 0 today, -1 yesterday's running past midnight. */
  dayOffsets: Int8Array;
};

/** One trip, as run on one service day. */
export type TripDetails = {
  trip: number;
  line: TransitLine;
  headsign: string;
  /** Every stop called at, with when (epoch ms). */
  stops: (TransitStop & { arriveAt: number; departAt: number })[];
  /** The stop the vehicle is at or heading to at the instant asked about, as an index into `stops`. */
  nextStop: number;
  departAt: number;
  arriveAt: number;
  geometry: GeoJsonLineString;
  /** The service day it was read from, YYYYMMDD: another week's when a fallback was used. */
  serviceDate: string;
};

/** One scheduled departure from a stop. */
export type Departure = {
  trip: number;
  line: TransitLine;
  headsign: string;
  /** Epoch ms. */
  departAt: number;
  stop: TransitStop;
  /** The service day it was read from, YYYYMMDD: another week's when a fallback was used. */
  serviceDate: string;
};

export type DeparturesOptions = {
  /** How far from the point a stop may be. Default 60 m: a stop, or a station's platforms. */
  radiusMeters?: number;
  /** Only these feeds' lines, by compile id. Default: all the simulator shows. */
  feeds?: string[];
  /** At most this many departures. Default 12. */
  limit?: number;
  /** How far ahead to look. Default 3 hours. */
  windowSeconds?: number;
};

/** The service days a running vehicle can belong to: one that set out yesterday, or today. */
const DAY_OFFSETS = [-1, 0] as const;

/**
 * Every vehicle running at a given moment, from a compiled timetable: where
 * it is, interpolated along the ride geometry between the times it is due at
 * each stop, and which way it faces.
 *
 *     const sim = new TransitSimulator(timetable, { dateFallback: "same-weekday" });
 *     const frame = sim.positions(Date.now());
 *     for (let i = 0; i < frame.count; i += 1) draw(frame.coords[3 * i], frame.coords[3 * i + 1]);
 *
 * Scheduled positions, not live ones: a vehicle is where the timetable says
 * it should be.
 */
export class TransitSimulator {
  private readonly calendar: ServiceCalendar;
  private readonly tripPattern: Uint32Array;
  /** First departure and last arrival of each trip, in its service day's seconds. */
  private readonly tripStart: Int32Array;
  private readonly tripEnd: Int32Array;
  /** Metres from the start of its hop to each hop point. */
  private readonly pointMeters: Float32Array;
  private readonly tripAllowed: Uint8Array;
  private readonly dateFallback: "none" | "same-weekday";
  /** Active services per (day, offset), cached: a day's set changes once a day. */
  private activeCache = new Map<string, Uint8Array>();
  /** Which patterns call at each stop; built on the first departures request. */
  private stopIndex: StopPatternIndex | null = null;

  constructor(readonly timetable: TransitTimetable, options: TransitSimulatorOptions = {}) {
    const t = timetable;
    this.calendar = new ServiceCalendar(t);
    this.dateFallback = options.dateFallback ?? "none";

    this.tripPattern = new Uint32Array(t.tripCount);
    this.tripStart = new Int32Array(t.tripCount);
    this.tripEnd = new Int32Array(t.tripCount);
    for (let p = 0; p < t.patternCount; p += 1) {
      const stops = t.patternStopOffset[p + 1] - t.patternStopOffset[p];
      for (let trip = t.patternTripOffset[p]; trip < t.patternTripOffset[p + 1]; trip += 1) {
        const base = t.tripTimeOffset[trip];
        this.tripPattern[trip] = p;
        this.tripStart[trip] = t.tripTimes[base + 1];
        this.tripEnd[trip] = t.tripTimes[base + 2 * (stops - 1)];
      }
    }

    const points = t.hopPointOffset[t.hopPointOffset.length - 1] ?? 0;
    this.pointMeters = new Float32Array(points);
    for (let hop = 0; hop + 1 < t.hopPointOffset.length; hop += 1) {
      let meters = 0;
      for (let i = t.hopPointOffset[hop] + 1; i < t.hopPointOffset[hop + 1]; i += 1) {
        meters += haversineMeters(t.hopCoords[2 * i - 1], t.hopCoords[2 * i - 2], t.hopCoords[2 * i + 1], t.hopCoords[2 * i]);
        this.pointMeters[i] = meters;
      }
    }

    const modes = new Set(options.modes ?? TRANSIT_MODES);
    const feeds = options.feeds ? new Set(options.feeds) : null;
    this.tripAllowed = new Uint8Array(t.tripCount);
    for (let trip = 0; trip < t.tripCount; trip += 1) {
      const r = t.patternRoute[this.tripPattern[trip]];
      this.tripAllowed[trip] = modes.has(t.routeModes[r]) && (!feeds || feeds.has(t.feeds[t.routeFeed[r]].id)) ? 1 : 0;
    }
  }

  /** How many vehicles are running at `ms`: cheaper than `positions` when only the count is wanted. */
  count(ms: number): number {
    let n = 0;
    this.eachRunning(ms, () => {
      n += 1;
    });
    return n;
  }

  /** Every vehicle running at instant `ms` (epoch milliseconds). */
  positions(ms: number): VehiclePositions {
    const found: { trip: number; offset: number; seconds: number }[] = [];
    this.eachRunning(ms, (trip, offset, seconds) => found.push({ trip, offset, seconds }));
    const t = this.timetable;
    const out: VehiclePositions = {
      count: found.length,
      trips: new Uint32Array(found.length),
      routes: new Uint32Array(found.length),
      coords: new Float32Array(found.length * 3),
      atStop: new Uint8Array(found.length),
      dayOffsets: new Int8Array(found.length),
    };
    const place = [0, 0, 0];
    found.forEach(({ trip, offset, seconds }, i) => {
      out.trips[i] = trip;
      out.routes[i] = t.patternRoute[this.tripPattern[trip]];
      out.dayOffsets[i] = offset;
      out.atStop[i] = this.locate(trip, seconds, place) ? 1 : 0;
      out.coords[3 * i] = place[0];
      out.coords[3 * i + 1] = place[1];
      out.coords[3 * i + 2] = place[2];
    });
    return out;
  }

  /**
   * One trip's line, stops and times as it runs around instant `ms`: on the
   * service day it is running on then, or, when it is not running, the
   * nearest one it runs on. Null for an unknown trip or one that does not run
   * today or yesterday.
   */
  tripDetails(trip: number, ms: number): TripDetails | null {
    const t = this.timetable;
    if (!(trip >= 0 && trip < t.tripCount)) return null;
    const { day, seconds } = localServiceTime(ms, t.timezone);
    const origin = serviceDayOrigin(day, t.timezone);
    const service = t.tripService[trip];
    let chosen: { offset: number; base: number } | null = null;
    for (const offset of [0, -1]) {
      const { active, shift, bases } = this.layer(day, offset, origin);
      const base = bases[t.serviceFeed[service]];
      if (base === null || !active[service]) continue;
      const local = seconds - shift;
      const running = local >= this.tripStart[trip] && local <= this.tripEnd[trip];
      if (!chosen || running) chosen = { offset, base };
      if (running) break;
    }
    if (!chosen) return null;
    const dayOrigin = serviceDayOrigin(day + chosen.offset, t.timezone);
    const at = (s: number) => dayOrigin + s * 1000;
    const p = this.tripPattern[trip];
    const stopBase = t.patternStopOffset[p];
    const count = t.patternStopOffset[p + 1] - stopBase;
    const timeBase = t.tripTimeOffset[trip];
    const stops: TripDetails["stops"] = [];
    let nextStop = count - 1;
    for (let pos = 0; pos < count; pos += 1) {
      const s = t.patternStops[stopBase + pos];
      const arriveAt = at(t.tripTimes[timeBase + 2 * pos]);
      const departAt = at(t.tripTimes[timeBase + 2 * pos + 1]);
      if (departAt >= ms && nextStop === count - 1 && pos < count - 1) nextStop = pos;
      stops.push({ id: t.stopIds[s], name: t.stopNames[s], lat: t.stopLat[s], lng: t.stopLng[s], arriveAt, departAt });
    }
    const r = t.patternRoute[p];
    return {
      trip,
      line: {
        id: t.routeIds[r], shortName: t.routeShortNames[r], longName: t.routeLongNames[r],
        color: t.routeColors[r], textColor: t.routeTextColors[r], mode: t.routeModes[r], feed: t.feeds[t.routeFeed[r]].id,
      },
      headsign: t.patternHeadsigns[p],
      stops,
      nextStop,
      departAt: stops[0].departAt,
      arriveAt: stops[count - 1].arriveAt,
      geometry: { type: "LineString", coordinates: this.patternCoordinates(p) },
      serviceDate: dateOfDay(chosen.base),
    };
  }

  /**
   * The next departures from the stops near a point, from instant `ms`:
   * each trip once per stop it leaves from (not from its last stop), soonest
   * first. Stops are matched by position, so a station whose platforms are
   * separate stops in the feed answers as one.
   */
  departures(point: { lat: number; lng: number }, ms: number, options: DeparturesOptions = {}): Departure[] {
    const t = this.timetable;
    const radius = options.radiusMeters ?? 60;
    const limit = options.limit ?? 12;
    const window = options.windowSeconds ?? 3 * 3600;
    const feeds = options.feeds ? new Set(options.feeds) : null;
    this.stopIndex ??= buildStopPatternIndex(t);
    const index = this.stopIndex;

    const latSpan = radius / 111_320;
    const lngSpan = latSpan / Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
    const stops: number[] = [];
    for (let s = 0; s < t.stopCount; s += 1) {
      if (Math.abs(t.stopLat[s] - point.lat) > latSpan || Math.abs(t.stopLng[s] - point.lng) > lngSpan) continue;
      if (feeds && !feeds.has(t.feeds[t.stopFeed[s]].id)) continue;
      if (haversineMeters(point.lat, point.lng, t.stopLat[s], t.stopLng[s]) <= radius) stops.push(s);
    }

    const { day, seconds } = localServiceTime(ms, t.timezone);
    const origin = serviceDayOrigin(day, t.timezone);
    const found: Departure[] = [];
    // Yesterday's trips running past midnight, today's, and tomorrow's when
    // the window reaches past it.
    for (const offset of [-1, 0, 1]) {
      const { active, shift, bases } = this.layer(day, offset, origin);
      const from = seconds - shift;
      const to = from + window;
      if (to < 0) continue;
      const dayOrigin = serviceDayOrigin(day + offset, t.timezone);
      for (const s of stops) {
        for (let i = index.offset[s]; i < index.offset[s + 1]; i += 1) {
          const p = index.pattern[i];
          const pos = index.position[i];
          const count = t.patternStopOffset[p + 1] - t.patternStopOffset[p];
          if (pos === count - 1) continue; // arrives there, departs nowhere
          for (let trip = t.patternTripOffset[p]; trip < t.patternTripOffset[p + 1]; trip += 1) {
            if (!this.tripAllowed[trip]) continue;
            const service = t.tripService[trip];
            if (!active[service]) continue;
            const departs = t.tripTimes[t.tripTimeOffset[trip] + 2 * pos + 1];
            if (departs < from || departs > to) continue;
            const r = t.patternRoute[p];
            found.push({
              trip,
              line: {
                id: t.routeIds[r], shortName: t.routeShortNames[r], longName: t.routeLongNames[r],
                color: t.routeColors[r], textColor: t.routeTextColors[r], mode: t.routeModes[r], feed: t.feeds[t.routeFeed[r]].id,
              },
              headsign: t.patternHeadsigns[p] || t.stopNames[t.patternStops[t.patternStopOffset[p + 1] - 1]],
              departAt: dayOrigin + departs * 1000,
              stop: { id: t.stopIds[s], name: t.stopNames[s], lat: t.stopLat[s], lng: t.stopLng[s] },
              serviceDate: dateOfDay(bases[t.serviceFeed[service]] ?? day + offset),
            });
          }
        }
      }
    }
    found.sort((a, b) => a.departAt - b.departAt || a.line.shortName.localeCompare(b.line.shortName));
    return found.slice(0, limit);
  }

  /** Calls `visit` for each allowed trip running at `ms`, with its service-day offset and local seconds. */
  private eachRunning(ms: number, visit: (trip: number, offset: number, seconds: number) => void) {
    const t = this.timetable;
    const { day, seconds } = localServiceTime(ms, t.timezone);
    const origin = serviceDayOrigin(day, t.timezone);
    for (const offset of DAY_OFFSETS) {
      const { active, shift } = this.layer(day, offset, origin);
      const local = seconds - shift;
      for (let trip = 0; trip < t.tripCount; trip += 1) {
        if (local < this.tripStart[trip] || local > this.tripEnd[trip]) continue;
        if (!this.tripAllowed[trip] || !active[t.tripService[trip]]) continue;
        visit(trip, offset, local);
      }
    }
  }

  /**
   * The services running on the day `offset` days from `day`, each feed read
   * on that day or, with the fallback, the covered day standing in for it;
   * and how many seconds that day's origin lies before `day`'s.
   */
  private layer(day: number, offset: number, origin: number) {
    const t = this.timetable;
    const key = `${day}:${offset}`;
    let active = this.activeCache.get(key);
    // Each service day is mapped on its own: on the day before a feed starts,
    // tomorrow is covered even though today is not.
    const bases = t.feeds.map((_, index) => this.calendar.dayFor(index, day + offset, this.dateFallback));
    if (!active) {
      active = new Uint8Array(t.serviceCount);
      for (let s = 0; s < t.serviceCount; s += 1) {
        const base = bases[t.serviceFeed[s]];
        active[s] = base !== null && this.calendar.runsOn(s, base) ? 1 : 0;
      }
      if (this.activeCache.size > 8) this.activeCache.clear();
      this.activeCache.set(key, active);
    }
    // Seconds, DST included: yesterday's origin is 23–25 hours before today's.
    const shift = Math.round((serviceDayOrigin(day + offset, t.timezone) - origin) / 1000);
    return { active, shift, bases };
  }

  /**
   * Where trip `trip` is `seconds` into its service day: writes longitude,
   * latitude and heading into `out`, and returns whether it is standing at a stop.
   */
  private locate(trip: number, seconds: number, out: number[]): boolean {
    const t = this.timetable;
    const p = this.tripPattern[trip];
    const count = t.patternStopOffset[p + 1] - t.patternStopOffset[p];
    const base = t.tripTimeOffset[trip];
    const firstHop = t.geometryHopOffset[t.patternGeometry[p]];
    // The last stop whose arrival is not after `seconds`: binary search, the times are in order.
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.tripTimes[base + 2 * mid] <= seconds) lo = mid;
      else hi = mid - 1;
    }
    const pos = lo;
    const departs = t.tripTimes[base + 2 * pos + 1];
    if (pos === count - 1 || seconds <= departs) {
      // Standing at stop `pos`: at the start of the hop out of it, or the end of the last one.
      const hop = firstHop + Math.min(pos, count - 2);
      this.pointOnHop(hop, pos === count - 1 ? 1 : 0, out);
      return true;
    }
    const arrives = t.tripTimes[base + 2 * (pos + 1)];
    const fraction = arrives > departs ? (seconds - departs) / (arrives - departs) : 1;
    this.pointOnHop(firstHop + pos, fraction, out);
    return false;
  }

  /** The point `fraction` of the way along hop `hop`, by distance, and the heading there. */
  private pointOnHop(hop: number, fraction: number, out: number[]) {
    const t = this.timetable;
    const first = t.hopPointOffset[hop];
    const last = t.hopPointOffset[hop + 1] - 1;
    if (last <= first) {
      out[0] = t.hopCoords[2 * first];
      out[1] = t.hopCoords[2 * first + 1];
      out[2] = 0;
      return;
    }
    const target = Math.min(1, Math.max(0, fraction)) * this.pointMeters[last];
    // The segment [i, i + 1] containing `target`.
    let lo = first;
    let hi = last - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pointMeters[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const length = this.pointMeters[i + 1] - this.pointMeters[i];
    const f = length > 0 ? (target - this.pointMeters[i]) / length : 0;
    const lng0 = t.hopCoords[2 * i];
    const lat0 = t.hopCoords[2 * i + 1];
    const lng1 = t.hopCoords[2 * i + 2];
    const lat1 = t.hopCoords[2 * i + 3];
    out[0] = lng0 + (lng1 - lng0) * f;
    out[1] = lat0 + (lat1 - lat0) * f;
    out[2] = bearing(lat0, lng0, lat1, lng1);
  }

  private patternCoordinates(p: number): number[][] {
    const t = this.timetable;
    const g = t.patternGeometry[p];
    const coordinates: number[][] = [];
    for (let hop = t.geometryHopOffset[g]; hop < t.geometryHopOffset[g + 1]; hop += 1) {
      for (let i = t.hopPointOffset[hop]; i < t.hopPointOffset[hop + 1]; i += 1) {
        const point = [t.hopCoords[2 * i], t.hopCoords[2 * i + 1]];
        const prior = coordinates[coordinates.length - 1];
        if (!prior || prior[0] !== point[0] || prior[1] !== point[1]) coordinates.push(point);
      }
    }
    return coordinates;
  }
}

/** Initial heading from one point to another, degrees clockwise from north. */
function bearing(lat0: number, lng0: number, lat1: number, lng1: number) {
  const rad = Math.PI / 180;
  const y = Math.sin((lng1 - lng0) * rad) * Math.cos(lat1 * rad);
  const x = Math.cos(lat0 * rad) * Math.sin(lat1 * rad) - Math.sin(lat0 * rad) * Math.cos(lat1 * rad) * Math.cos((lng1 - lng0) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
