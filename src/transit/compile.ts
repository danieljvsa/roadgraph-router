import type { Coordinate } from "../types";
import { parseCsv, type CsvRow } from "./csv";
import { dateOfDay, dayNumber, parseGtfsTime, weekdayOfDay } from "./time";
import { HopSource, type TransitCompileReport, type TransitFeedInfo, type TransitMode, type TransitTimetable } from "./types";

/** One GTFS feed: its files' text by file name (`stops.txt`, …). */
export type GtfsFeedInput = {
  /** A short id such as `metro` or `stcp`, used to keep ids from different feeds apart. */
  id: string;
  files: Record<string, string | undefined>;
};

/** A request for the geometry of one ride between two consecutive stops. */
export type HopGeometryRequest = {
  mode: TransitMode;
  route: string;
  from: Coordinate;
  to: Coordinate;
};

export type CompileTransitOptions = {
  /** Stops at most this far apart, in a straight line, are linked by a walking transfer. Default 250 m. */
  transferRadiusMeters?: number;
  /** Walking pace used for transfers. Default 1.25 m/s, 4.5 km/h. */
  walkSpeedMps?: number;
  /** How much longer than the straight line a walk is assumed to be. Default 1.3. */
  walkDetourFactor?: number;
  /**
   * Supplies a routed geometry for a hop whose feed shape is missing or does
   * not follow the way (a metro feed whose "shapes" are straight lines between
   * stations, for instance). Return `[lng, lat]` positions, or null to fall
   * back to a straight line. Usually a `RoadRouter` over a railway bundle for
   * rail modes; see the `roadgraph-compile-gtfs` CLI.
   */
  routeHop?: (request: HopGeometryRequest) => Promise<number[][] | null>;
  /** Which modes `routeHop` is asked about. Default: the rail modes. */
  routeHopModes?: TransitMode[];
};

const DEFAULTS = {
  transferRadiusMeters: 250,
  walkSpeedMps: 1.25,
  walkDetourFactor: 1.3,
  routeHopModes: ["metro", "tram", "rail", "funicular"] as TransitMode[],
};

/** A routed hop longer than this multiple of the straight line, plus slack, is taken to be wrong. */
const ROUTED_HOP_MAX_STRETCH = 2.5;
const ROUTED_HOP_SLACK_METERS = 1500;
/** A stop further than this from its trip's shape means the shape is not that trip's path. */
const SHAPE_MAX_STOP_OFFSET_METERS = 200;
const MAX_REPORTED_FALLBACKS = 200;
/** How close a longer routed span must pass a stop for it to be cut there. */
const CUT_MAX_STOP_OFFSET_METERS = 60;
/** How far a rail stop may be moved onto its track, and how far apart its platforms' track points may be. */
const STOP_ON_TRACK_MAX_MOVE_METERS = 150;
const STOP_ON_TRACK_MAX_SPREAD_METERS = 80;

type HopDraft = { coords: number[][]; source: number; from: number; to: number };
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
/**
 * Below this many points per kilometre a shape is a sketch: Metro do Porto's
 * line D has three. When the hop could be routed along mapped track instead,
 * the track wins.
 */
const MIN_SHAPE_POINTS_PER_KM_WHEN_ROUTABLE = 10;

export function modeOfRouteType(routeType: number): TransitMode {
  if (routeType === 0 || (routeType >= 900 && routeType < 1000)) return "tram";
  if (routeType === 1 || routeType === 12 || (routeType >= 400 && routeType < 500) || routeType === 405) return "metro";
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return "rail";
  if (routeType === 3 || routeType === 11 || (routeType >= 200 && routeType < 300) || (routeType >= 700 && routeType < 900)) return "bus";
  if (routeType === 4 || (routeType >= 1000 && routeType < 1300)) return "ferry";
  if (routeType === 5 || routeType === 6 || (routeType >= 1300 && routeType < 1400)) return "cable";
  if (routeType === 7 || (routeType >= 1400 && routeType < 1500)) return "funicular";
  return "other";
}

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function polylineMeters(coords: number[][]) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return total;
}

type RawStop = { lat: number; lng: number; name: string };
type RawRoute = { shortName: string; longName: string; color: string; textColor: string; mode: TransitMode };
type RawTrip = { routeId: string; serviceId: string; headsign: string; shapeId: string };
type ShapePoint = { lat: number; lng: number; dist: number };
type StopTimeRow = { seq: number; stopId: string; arr: number; dep: number; dist: number; headsign: string };

type PatternTrip = { service: number; times: Int32Array };
type PatternGroup = {
  route: number;
  stops: number[];
  headsign: string;
  trips: PatternTrip[];
  /** Shape and stop distances of a representative trip, for the geometry. */
  shape: ShapePoint[] | null;
  stopDists: number[];
};

function readFile(feed: GtfsFeedInput, name: string, required: boolean): CsvRow[] {
  const text = feed.files[name];
  if (text === undefined) {
    if (required) throw new Error(`GTFS feed "${feed.id}" has no ${name}.`);
    return [];
  }
  return parseCsv(text);
}

const colour = (value: string | undefined) => (value && /^[0-9a-fA-F]{6}$/.test(value.trim()) ? `#${value.trim().toLowerCase()}` : "");

/**
 * Compiles one or more GTFS feeds into a single searchable timetable.
 *
 * Feeds are kept apart by prefixing every stop and route id with the feed id
 * (`metro:5697`), and joined by walking transfers between nearby stops, so a
 * journey can change from one operator to another.
 */
export async function compileTransit(feeds: GtfsFeedInput[], options: CompileTransitOptions = {}): Promise<{ timetable: TransitTimetable; report: TransitCompileReport }> {
  if (feeds.length === 0) throw new Error("compileTransit needs at least one feed.");
  if (feeds.length > 0xffff) throw new Error("Too many feeds.");
  const ids = new Set<string>();
  for (const feed of feeds) {
    if (!/^[A-Za-z0-9_-]+$/.test(feed.id)) throw new Error(`Feed id "${feed.id}" must be letters, digits, "-" or "_".`);
    if (ids.has(feed.id)) throw new Error(`Feed id "${feed.id}" is used twice.`);
    ids.add(feed.id);
  }
  // Options left undefined keep their defaults (a spread would overwrite them).
  const settings = { ...DEFAULTS, ...definedOnly(options) };
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  let interpolated = 0;
  let stopTimeCount = 0;

  // Global tables, filled feed by feed.
  const stopIndex = new Map<string, number>();
  const stopIds: string[] = [];
  const stopNames: string[] = [];
  const stopLat: number[] = [];
  const stopLng: number[] = [];
  const stopFeed: number[] = [];
  const routeIndex = new Map<string, number>();
  const routes: (RawRoute & { id: string; feed: number })[] = [];
  const serviceIndex = new Map<string, number>();
  const serviceDaySets: Set<number>[] = [];
  const serviceFeed: number[] = [];
  const groups = new Map<string, PatternGroup>();
  const feedInfos: TransitFeedInfo[] = [];
  const explicitTransfers: { from: number; to: number; seconds: number; forbidden: boolean }[] = [];
  const servicesWithoutTrips: TransitCompileReport["servicesWithoutTrips"] = [];
  let timezone = "";

  for (let f = 0; f < feeds.length; f += 1) {
    const feed = feeds[f];
    const prefix = `${feed.id}:`;

    const agencies = readFile(feed, "agency.txt", true);
    const feedTimezone = agencies[0]?.agency_timezone?.trim();
    if (!feedTimezone) throw new Error(`GTFS feed "${feed.id}" names no agency_timezone.`);
    if (timezone && timezone !== feedTimezone) {
      throw new Error(`Feeds use different timezones (${timezone}, ${feedTimezone}); compile them separately.`);
    }
    timezone = feedTimezone;
    const info = readFile(feed, "feed_info.txt", false)[0];

    const rawStops = new Map<string, RawStop>();
    for (const row of readFile(feed, "stops.txt", true)) {
      const type = row.location_type?.trim();
      // Stations, entrances and nodes are not where a vehicle stops.
      if (type && type !== "0") continue;
      const lat = Number(row.stop_lat);
      const lng = Number(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
      rawStops.set(row.stop_id, { lat, lng, name: (row.stop_name ?? "").trim() });
    }

    const rawRoutes = new Map<string, RawRoute>();
    for (const row of readFile(feed, "routes.txt", true)) {
      rawRoutes.set(row.route_id, {
        shortName: (row.route_short_name ?? "").trim(),
        longName: (row.route_long_name ?? "").trim(),
        color: colour(row.route_color),
        textColor: colour(row.route_text_color),
        mode: modeOfRouteType(Number(row.route_type)),
      });
    }

    // Calendar: weekly patterns, then single-day exceptions on top.
    const services = new Map<string, Set<number>>();
    for (const row of readFile(feed, "calendar.txt", false)) {
      if (!row.start_date || !row.end_date) continue;
      const days = new Set<number>();
      const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((name) => row[name] === "1");
      for (let day = dayNumber(row.start_date); day <= dayNumber(row.end_date); day += 1) {
        if (weekdays[weekdayOfDay(day)]) days.add(day);
      }
      services.set(row.service_id, days);
    }
    for (const row of readFile(feed, "calendar_dates.txt", false)) {
      if (!row.date) continue;
      let days = services.get(row.service_id);
      if (!days) services.set(row.service_id, (days = new Set()));
      const day = dayNumber(row.date);
      if (row.exception_type === "1") days.add(day);
      else if (row.exception_type === "2") days.delete(day);
    }

    const rawTrips = new Map<string, RawTrip>();
    for (const row of readFile(feed, "trips.txt", true)) {
      rawTrips.set(row.trip_id, { routeId: row.route_id, serviceId: row.service_id, headsign: (row.trip_headsign ?? "").trim(), shapeId: row.shape_id ?? "" });
    }

    const shapes = new Map<string, ShapePoint[]>();
    const shapeSeq = new Map<string, number[]>();
    for (const row of readFile(feed, "shapes.txt", false)) {
      let points = shapes.get(row.shape_id);
      if (!points) {
        shapes.set(row.shape_id, (points = []));
        shapeSeq.set(row.shape_id, []);
      }
      points.push({ lat: Number(row.shape_pt_lat), lng: Number(row.shape_pt_lon), dist: row.shape_dist_traveled === "" || row.shape_dist_traveled === undefined ? NaN : Number(row.shape_dist_traveled) });
      shapeSeq.get(row.shape_id)!.push(Number(row.shape_pt_sequence));
    }
    for (const [id, points] of shapes) {
      const seq = shapeSeq.get(id)!;
      const order = points.map((_, i) => i).sort((a, b) => seq[a] - seq[b]);
      shapes.set(id, order.map((i) => points[i]));
    }

    const stopTimesByTrip = new Map<string, StopTimeRow[]>();
    for (const row of readFile(feed, "stop_times.txt", true)) {
      let rows = stopTimesByTrip.get(row.trip_id);
      if (!rows) stopTimesByTrip.set(row.trip_id, (rows = []));
      rows.push({
        seq: Number(row.stop_sequence),
        stopId: row.stop_id,
        arr: parseGtfsTime(row.arrival_time ?? ""),
        dep: parseGtfsTime(row.departure_time ?? ""),
        dist: row.shape_dist_traveled === "" || row.shape_dist_traveled === undefined ? NaN : Number(row.shape_dist_traveled),
        headsign: (row.stop_headsign ?? "").trim(),
      });
    }

    // frequencies.txt: a template trip repeated every headway seconds.
    const frequencies = new Map<string, { start: number; end: number; headway: number }[]>();
    for (const row of readFile(feed, "frequencies.txt", false)) {
      const list = frequencies.get(row.trip_id) ?? [];
      list.push({ start: parseGtfsTime(row.start_time), end: parseGtfsTime(row.end_time), headway: Number(row.headway_secs) });
      frequencies.set(row.trip_id, list);
    }

    const globalStop = (id: string): number => {
      const key = prefix + id;
      let index = stopIndex.get(key);
      if (index === undefined) {
        const raw = rawStops.get(id)!;
        index = stopIds.length;
        stopIndex.set(key, index);
        stopIds.push(key);
        stopNames.push(raw.name);
        stopLat.push(raw.lat);
        stopLng.push(raw.lng);
        stopFeed.push(f);
      }
      return index;
    };
    const globalRoute = (id: string): number => {
      const key = prefix + id;
      let index = routeIndex.get(key);
      if (index === undefined) {
        index = routes.length;
        routeIndex.set(key, index);
        routes.push({ ...rawRoutes.get(id)!, id: key, feed: f });
      }
      return index;
    };
    const globalService = (id: string): number => {
      const key = prefix + id;
      let index = serviceIndex.get(key);
      if (index === undefined) {
        index = serviceDaySets.length;
        serviceIndex.set(key, index);
        serviceDaySets.push(services.get(id) ?? new Set());
        serviceFeed.push(f);
      }
      return index;
    };

    for (const [tripId, rows] of stopTimesByTrip) {
      const trip = rawTrips.get(tripId);
      if (!trip) { skip("stop times for an unknown trip"); continue; }
      if (!rawRoutes.has(trip.routeId)) { skip("unknown route"); continue; }
      if (!services.get(trip.serviceId)?.size) { skip("service never runs"); continue; }
      rows.sort((a, b) => a.seq - b.seq);
      if (rows.some((r) => !rawStops.has(r.stopId))) { skip("unknown stop"); continue; }
      if (rows.length < 2) { skip("fewer than two stops"); continue; }
      for (const r of rows) {
        if (r.arr < 0) r.arr = r.dep;
        if (r.dep < 0) r.dep = r.arr;
      }
      if (rows[0].dep < 0 || rows[rows.length - 1].arr < 0) { skip("first or last stop has no time"); continue; }
      interpolated += interpolateTimes(rows, rawStops);
      let backwards = false;
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].dep < rows[i].arr || (i > 0 && rows[i].arr < rows[i - 1].dep)) backwards = true;
      }
      if (backwards) { skip("times go backwards"); continue; }

      const stops = rows.map((r) => globalStop(r.stopId));
      const route = globalRoute(trip.routeId);
      const service = globalService(trip.serviceId);
      const key = `${route}|${stops.join(",")}`;
      let group = groups.get(key);
      if (!group) {
        const shape = trip.shapeId ? shapes.get(trip.shapeId) ?? null : null;
        group = { route, stops, headsign: trip.headsign || rows[0].headsign || "", trips: [], shape, stopDists: rows.map((r) => r.dist) };
        groups.set(key, group);
      }
      const base = new Int32Array(rows.length * 2);
      rows.forEach((r, i) => { base[2 * i] = r.arr; base[2 * i + 1] = r.dep; });
      const repeats = frequencies.get(tripId);
      if (repeats) {
        for (const { start, end, headway } of repeats) {
          if (!(headway > 0) || start < 0 || end < start) continue;
          for (let t = start; t < end; t += headway) {
            const shifted = base.map((value) => value - base[1] + t);
            group.trips.push({ service, times: shifted });
            stopTimeCount += rows.length;
          }
        }
      } else {
        group.trips.push({ service, times: base });
        stopTimeCount += rows.length;
      }
    }

    for (const [id, days] of services) {
      if (days.size === 0 || serviceIndex.has(prefix + id)) continue;
      const sorted = [...days].sort((a, b) => a - b);
      servicesWithoutTrips.push({ service: prefix + id, days: days.size, first: dateOfDay(sorted[0]), last: dateOfDay(sorted[sorted.length - 1]) });
    }

    for (const row of readFile(feed, "transfers.txt", false)) {
      const from = stopIndex.get(prefix + row.from_stop_id);
      const to = stopIndex.get(prefix + row.to_stop_id);
      if (from === undefined || to === undefined || from === to) continue;
      const type = row.transfer_type?.trim() || "0";
      explicitTransfers.push({ from, to, seconds: type === "2" ? Number(row.min_transfer_time) || 0 : 0, forbidden: type === "3" });
    }

    feedInfos.push({
      id: feed.id,
      publisher: info?.feed_publisher_name?.trim() || agencies[0]?.agency_name?.trim() || feed.id,
      timezone: feedTimezone,
      firstServiceDate: "",
      lastServiceDate: "",
      version: info?.feed_version?.trim() ?? "",
    });
  }

  if (groups.size === 0) throw new Error("No usable trips in the feeds.");

  // Service calendar, as bit sets over one shared range of days.
  let firstDay = Infinity;
  let lastDay = -Infinity;
  serviceDaySets.forEach((days, s) => {
    for (const day of days) {
      firstDay = Math.min(firstDay, day);
      lastDay = Math.max(lastDay, day);
      const info = feedInfos[serviceFeed[s]];
      const date = dateOfDay(day);
      if (!info.firstServiceDate || date < info.firstServiceDate) info.firstServiceDate = date;
      if (!info.lastServiceDate || date > info.lastServiceDate) info.lastServiceDate = date;
    }
  });
  const dayCount = lastDay - firstDay + 1;
  const bytesPerService = Math.ceil(dayCount / 8);
  const serviceDays = new Uint8Array(bytesPerService * serviceDaySets.length);
  serviceDaySets.forEach((days, s) => {
    for (const day of days) {
      const bit = day - firstDay;
      serviceDays[s * bytesPerService + (bit >> 3)] |= 1 << (bit & 7);
    }
  });

  // Patterns: each group split so that no trip overtakes another.
  const patternRoute: number[] = [];
  const patternHeadsigns: string[] = [];
  const patternStopOffset: number[] = [0];
  const patternStops: number[] = [];
  const patternTripOffset: number[] = [0];
  const patternGeometry: number[] = [];
  const tripService: number[] = [];
  const tripTimeOffset: number[] = [];
  const tripTimes: number[] = [];

  const geometryHopOffset: number[] = [0];
  const hopPointOffset: number[] = [0];
  const hopCoords: number[] = [];
  const hopSource: number[] = [];
  const hopStats = { total: 0, shape: 0, routed: 0, straight: 0 };
  const hopFallbacks: TransitCompileReport["hopFallbacks"] = [];
  const routedCache = new Map<string, Promise<number[][] | null>>();

  const stopCoord = (s: number): Coordinate => ({ lat: stopLat[s], lng: stopLng[s] });

  // Ride geometry for every group first: routed hops show where the track
  // runs past each station, which decides where rail stops are placed.
  const groupHops: HopDraft[][] = [];
  for (const group of groups.values()) groupHops.push(await hopGeometries(group));
  const stopsPlacedOnTrack = placeStopsOnTrack();

  let groupIndex = 0;
  for (const group of groups.values()) {
    const geometry = geometryHopOffset.length - 1;
    for (const hop of groupHops[groupIndex++]) {
      // Routed hops start and end exactly at the stops, so consecutive hops join up.
      const coords = hop.source === HopSource.Routed
        ? dedupe([[stopLng[hop.from], stopLat[hop.from]], ...hop.coords, [stopLng[hop.to], stopLat[hop.to]]])
        : hop.coords;
      for (const [lng, lat] of coords) hopCoords.push(lng, lat);
      hopPointOffset.push(hopCoords.length / 2);
      hopSource.push(hop.source);
    }
    geometryHopOffset.push(hopSource.length);

    const sorted = group.trips.sort((a, b) => a.times[1] - b.times[1] || a.times[a.times.length - 2] - b.times[b.times.length - 2]);
    const lanes: PatternTrip[][] = [];
    for (const trip of sorted) {
      const lane = lanes.find((candidate) => neverOvertakes(candidate[candidate.length - 1], trip));
      if (lane) lane.push(trip);
      else lanes.push([trip]);
    }
    for (const lane of lanes) {
      patternRoute.push(group.route);
      patternHeadsigns.push(group.headsign);
      patternStops.push(...group.stops);
      patternStopOffset.push(patternStops.length);
      patternGeometry.push(geometry);
      for (const trip of lane) {
        tripService.push(trip.service);
        tripTimeOffset.push(tripTimes.length);
        for (const value of trip.times) tripTimes.push(value);
      }
      patternTripOffset.push(tripService.length);
    }
  }

  async function hopGeometries(group: PatternGroup) {
    const mode = routes[group.route].mode;
    const n = group.stops.length;
    const routable = Boolean(settings.routeHop && settings.routeHopModes.includes(mode));
    const shapeUsable = Boolean(
      group.shape &&
      shapeFollowsWay(group, stopLat, stopLng) &&
      !(routable && shapePointsPerKm(group.shape) < MIN_SHAPE_POINTS_PER_KM_WHEN_ROUTABLE),
    );
    const fromShape = shapeUsable ? cutShape(group, stopLat, stopLng) : null;
    const result: HopDraft[] = [];
    for (let i = 0; i < n - 1; i += 1) {
      hopStats.total += 1;
      const a = group.stops[i];
      const b = group.stops[i + 1];
      const cut = fromShape?.[i];
      if (cut) {
        hopStats.shape += 1;
        result.push({ coords: cut, source: HopSource.Shape, from: a, to: b });
        continue;
      }
      const straight = [[stopLng[a], stopLat[a]], [stopLng[b], stopLat[b]]];
      let reason = !group.shape ? "no shape" : !shapeUsable ? "shape too coarse to follow the way" : "stop too far from the shape";
      if (settings.routeHop && settings.routeHopModes.includes(mode)) {
        const routeId = routes[group.route].id;
        const direct = haversineMeters(stopLat[a], stopLng[a], stopLat[b], stopLng[b]);
        const first = await routedBetween(mode, routeId, a, b);
        let coords = first.coords;
        reason = first.reason;
        // At an interchange the station's coordinate can snap to another
        // line's track (Trindade: line D runs beneath the others). Routing on
        // to the stop after, or from the stop before, forces the right track;
        // the result is cut where it passes this hop's stop.
        if (!coords && i + 2 < n) coords = cutAt((await routedBetween(mode, routeId, a, group.stops[i + 2])).coords, b, "end");
        if (!coords && i >= 1) coords = cutAt((await routedBetween(mode, routeId, group.stops[i - 1], b)).coords, a, "start");
        if (coords && polylineMeters(coords) > Math.max(direct * ROUTED_HOP_MAX_STRETCH, direct + ROUTED_HOP_SLACK_METERS)) coords = null;
        if (coords) {
          hopStats.routed += 1;
          result.push({ coords, source: HopSource.Routed, from: a, to: b });
          continue;
        }
      }
      if (hopFallbacks.length < MAX_REPORTED_FALLBACKS) hopFallbacks.push({ route: routes[group.route].id, from: stopIds[a], to: stopIds[b], reason });
      hopStats.straight += 1;
      result.push({ coords: straight, source: HopSource.Straight, from: a, to: b });
    }
    return result;
  }

  /**
   * Moves each stop that only routed rail hops serve onto the track. A feed
   * often places a station at its entrance or its street address (Metro do
   * Porto's Campanhã is on the street, 50 m from the platforms), so a ride
   * drawn along the track would leave it for a stub across the street, and
   * walks would start there. The routed hops already end where the track
   * passes the station; the stop goes to the middle of those points (one per
   * track, so between the platforms of a two-track station).
   */
  function placeStopsOnTrack(): TransitCompileReport["stopsPlacedOnTrack"] {
    const points = new Map<number, number[][]>();
    const offTrack = new Set<number>();
    const add = (stop: number, point: number[] | undefined) => {
      if (!point) return;
      let list = points.get(stop);
      if (!list) points.set(stop, (list = []));
      list.push(point);
    };
    for (const hops of groupHops) {
      for (const hop of hops) {
        if (hop.source === HopSource.Routed) {
          add(hop.from, hop.coords[0]);
          add(hop.to, hop.coords[hop.coords.length - 1]);
        } else {
          offTrack.add(hop.from);
          offTrack.add(hop.to);
        }
      }
    }
    const moved: TransitCompileReport["stopsPlacedOnTrack"] = [];
    for (const [stop, list] of points) {
      if (offTrack.has(stop)) continue;
      const lat = list.reduce((sum, p) => sum + p[1], 0) / list.length;
      const lng = list.reduce((sum, p) => sum + p[0], 0) / list.length;
      // Points far apart are not one station's platforms; leave the stop be.
      if (list.some((p) => haversineMeters(p[1], p[0], lat, lng) > STOP_ON_TRACK_MAX_SPREAD_METERS)) continue;
      const meters = haversineMeters(stopLat[stop], stopLng[stop], lat, lng);
      if (meters > STOP_ON_TRACK_MAX_MOVE_METERS) continue;
      if (meters >= 1) moved.push({ stop: stopIds[stop], name: stopNames[stop], meters: Math.round(meters) });
      stopLat[stop] = round6(lat);
      stopLng[stop] = round6(lng);
    }
    return moved.sort((x, y) => y.meters - x.meters);
  }

  /** A routed path between two stops, or the reason there is no plausible one. */
  async function routedBetween(mode: TransitMode, routeId: string, a: number, b: number): Promise<{ coords: number[][] | null; reason: string }> {
    const key = `${mode}:${a}:${b}`;
    let pending = routedCache.get(key);
    if (!pending) {
      pending = settings.routeHop!({ mode, route: routeId, from: stopCoord(a), to: stopCoord(b) }).catch(() => null);
      routedCache.set(key, pending);
    }
    const coords = await pending;
    const direct = haversineMeters(stopLat[a], stopLng[a], stopLat[b], stopLng[b]);
    if (!coords || coords.length < 2) return { coords: null, reason: "no route on the network" };
    if (polylineMeters(coords) > Math.max(direct * ROUTED_HOP_MAX_STRETCH, direct + ROUTED_HOP_SLACK_METERS)) return { coords: null, reason: "routed path implausibly long" };
    return { coords, reason: "" };
  }

  /**
   * Keeps the part of a routed path before (`"end"`) or after (`"start"`) the
   * point nearest a stop, provided the path really passes that stop.
   */
  function cutAt(coords: number[][] | null, stop: number, keep: "end" | "start"): number[][] | null {
    if (!coords) return null;
    let nearest = -1;
    let nearestMeters = Infinity;
    coords.forEach(([lng, lat], i) => {
      const meters = haversineMeters(lat, lng, stopLat[stop], stopLng[stop]);
      if (meters < nearestMeters) { nearestMeters = meters; nearest = i; }
    });
    if (nearestMeters > CUT_MAX_STOP_OFFSET_METERS) return null;
    return keep === "end" ? coords.slice(0, nearest + 1) : coords.slice(nearest);
  }

  // Walking transfers: every pair of stops within the radius, plus transfers.txt.
  const radius = settings.transferRadiusMeters;
  const links = new Map<number, Map<number, { seconds: number; meters: number }>>();
  const link = (a: number, b: number, seconds: number, meters: number) => {
    let row = links.get(a);
    if (!row) links.set(a, (row = new Map()));
    const existing = row.get(b);
    if (!existing || existing.seconds < seconds) row.set(b, { seconds, meters });
  };
  const cell = radius / 111_320;
  const grid = new Map<string, number[]>();
  for (let s = 0; s < stopIds.length; s += 1) {
    const key = `${Math.floor(stopLat[s] / cell)},${Math.floor(stopLng[s] / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(s);
  }
  for (let s = 0; s < stopIds.length; s += 1) {
    const cy = Math.floor(stopLat[s] / cell);
    const cx = Math.floor(stopLng[s] / cell);
    // Longitude cells are narrower than latitude cells away from the equator,
    // so look further along x to be sure of covering the whole radius.
    const spanX = Math.ceil(1 / Math.max(0.2, Math.cos((stopLat[s] * Math.PI) / 180)));
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -spanX; dx <= spanX; dx += 1) {
        for (const t of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (t === s) continue;
          const meters = haversineMeters(stopLat[s], stopLng[s], stopLat[t], stopLng[t]);
          if (meters > radius) continue;
          link(s, t, Math.ceil((meters * settings.walkDetourFactor) / settings.walkSpeedMps), Math.round(meters * settings.walkDetourFactor));
        }
      }
    }
  }
  for (const transfer of explicitTransfers) {
    if (transfer.forbidden) {
      links.get(transfer.from)?.delete(transfer.to);
      continue;
    }
    const meters = haversineMeters(stopLat[transfer.from], stopLng[transfer.from], stopLat[transfer.to], stopLng[transfer.to]);
    const walk = Math.ceil((meters * settings.walkDetourFactor) / settings.walkSpeedMps);
    link(transfer.from, transfer.to, Math.max(walk, transfer.seconds), Math.round(meters * settings.walkDetourFactor));
  }
  const transferOffset = new Uint32Array(stopIds.length + 1);
  const transferTo: number[] = [];
  const transferSeconds: number[] = [];
  const transferMeters: number[] = [];
  for (let s = 0; s < stopIds.length; s += 1) {
    const row = [...(links.get(s) ?? new Map()).entries()].sort((a, b) => a[1].seconds - b[1].seconds);
    for (const [to, { seconds, meters }] of row) {
      transferTo.push(to);
      transferSeconds.push(seconds);
      transferMeters.push(meters);
    }
    transferOffset[s + 1] = transferTo.length;
  }

  const timetable: TransitTimetable = {
    feeds: feedInfos,
    timezone,
    stopCount: stopIds.length,
    stopIds,
    stopNames,
    stopLat: Float64Array.from(stopLat),
    stopLng: Float64Array.from(stopLng),
    stopFeed: Uint16Array.from(stopFeed),
    routeCount: routes.length,
    routeIds: routes.map((r) => r.id),
    routeShortNames: routes.map((r) => r.shortName),
    routeLongNames: routes.map((r) => r.longName),
    routeColors: routes.map((r) => r.color),
    routeTextColors: routes.map((r) => r.textColor),
    routeModes: routes.map((r) => r.mode),
    routeFeed: Uint16Array.from(routes.map((r) => r.feed)),
    firstDay,
    dayCount,
    serviceCount: serviceDaySets.length,
    serviceFeed: Uint16Array.from(serviceFeed),
    serviceDays,
    patternCount: patternRoute.length,
    patternRoute: Uint32Array.from(patternRoute),
    patternHeadsigns,
    patternStopOffset: Uint32Array.from(patternStopOffset),
    patternStops: Uint32Array.from(patternStops),
    patternTripOffset: Uint32Array.from(patternTripOffset),
    patternGeometry: Uint32Array.from(patternGeometry),
    tripCount: tripService.length,
    tripService: Uint32Array.from(tripService),
    tripTimeOffset: Uint32Array.from(tripTimeOffset),
    tripTimes: Int32Array.from(tripTimes),
    transferOffset,
    transferTo: Uint32Array.from(transferTo),
    transferSeconds: Uint32Array.from(transferSeconds),
    transferMeters: Uint32Array.from(transferMeters),
    geometryCount: geometryHopOffset.length - 1,
    geometryHopOffset: Uint32Array.from(geometryHopOffset),
    hopPointOffset: Uint32Array.from(hopPointOffset),
    hopCoords: Float64Array.from(hopCoords),
    hopSource: Uint8Array.from(hopSource),
  };

  const report: TransitCompileReport = {
    feeds: feedInfos,
    stops: timetable.stopCount,
    routes: timetable.routeCount,
    trips: timetable.tripCount,
    patterns: timetable.patternCount,
    stopTimes: stopTimeCount,
    transfers: transferTo.length,
    skippedTrips: skipped,
    interpolatedStopTimes: interpolated,
    servicesWithoutTrips,
    hops: hopStats,
    hopFallbacks,
    stopsPlacedOnTrack,
  };
  return { timetable, report };
}

export function definedOnly<T extends object>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** True when `later` departs and arrives no earlier than `earlier` at every stop. */
function neverOvertakes(earlier: PatternTrip, later: PatternTrip) {
  for (let i = 0; i < earlier.times.length; i += 1) if (later.times[i] < earlier.times[i]) return false;
  return true;
}

/**
 * Fills stop times a feed leaves blank (allowed for stops that are not
 * timepoints) in proportion to distance: shape_dist_traveled when every stop
 * has one, otherwise the straight-line distance between stops.
 */
function interpolateTimes(rows: StopTimeRow[], stops: Map<string, RawStop>): number {
  if (rows.every((r) => r.arr >= 0)) return 0;
  const useShape = rows.every((r) => Number.isFinite(r.dist));
  const along: number[] = [0];
  for (let i = 1; i < rows.length; i += 1) {
    if (useShape) along.push(rows[i].dist);
    else {
      const a = stops.get(rows[i - 1].stopId)!;
      const b = stops.get(rows[i].stopId)!;
      along.push(along[i - 1] + haversineMeters(a.lat, a.lng, b.lat, b.lng));
    }
  }
  let filled = 0;
  let previous = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].arr >= 0) {
      for (let j = previous + 1; j < i; j += 1) {
        const span = along[i] - along[previous];
        const share = span > 0 ? (along[j] - along[previous]) / span : (j - previous) / (i - previous);
        const time = Math.round(rows[previous].dep + share * (rows[i].arr - rows[previous].dep));
        rows[j].arr = time;
        rows[j].dep = time;
        filled += 1;
      }
      previous = i;
    }
  }
  return filled;
}

/**
 * Whether a trip's shape describes the way it travels, or only joins its
 * stops. Some feeds publish "shapes" that are their stops in order, which
 * draws straight lines and is no better than having none.
 */
function shapeFollowsWay(group: PatternGroup, lat: number[], lng: number[]) {
  const shape = group.shape!;
  if (shape.length < group.stops.length * 1.5) return false;
  let atStops = 0;
  for (const point of shape) {
    for (const s of group.stops) {
      if (haversineMeters(point.lat, point.lng, lat[s], lng[s]) < 15) {
        atStops += 1;
        break;
      }
    }
  }
  return atStops / shape.length < 0.6;
}

/**
 * Cuts a shape into one polyline per hop, from each stop's position along it
 * to the next. Positions come from shape_dist_traveled when both the shape and
 * the stop times carry it, and otherwise from projecting each stop onto the
 * shape, searching only forward of the previous stop so a route that passes
 * the same street twice is cut at the right pass.
 *
 * Returns null for a hop whose stops sit too far from the shape to trust it.
 */
function cutShape(group: PatternGroup, lat: number[], lng: number[]): (number[][] | null)[] {
  const shape = group.shape!;
  const cumulative: number[] = [0];
  for (let i = 1; i < shape.length; i += 1) cumulative.push(cumulative[i - 1] + haversineMeters(shape[i - 1].lat, shape[i - 1].lng, shape[i].lat, shape[i].lng));

  type Position = { segment: number; t: number; lat: number; lng: number; offset: number };
  const positions: Position[] = [];
  const byDistance = shape.every((p) => Number.isFinite(p.dist)) && group.stopDists.every((d) => Number.isFinite(d));
  let from = 0;
  for (let k = 0; k < group.stops.length; k += 1) {
    const s = group.stops[k];
    let best: Position | null = null;
    if (byDistance) {
      const target = group.stopDists[k];
      let seg = from;
      while (seg < shape.length - 2 && shape[seg + 1].dist < target) seg += 1;
      const span = shape[seg + 1].dist - shape[seg].dist;
      const t = span > 0 ? Math.min(1, Math.max(0, (target - shape[seg].dist) / span)) : 0;
      const pLat = shape[seg].lat + t * (shape[seg + 1].lat - shape[seg].lat);
      const pLng = shape[seg].lng + t * (shape[seg + 1].lng - shape[seg].lng);
      best = { segment: seg, t, lat: pLat, lng: pLng, offset: haversineMeters(pLat, pLng, lat[s], lng[s]) };
    } else {
      // First pass within 40 m wins, refined to its local minimum; failing
      // that, the closest point anywhere ahead.
      for (let seg = from; seg < shape.length - 1; seg += 1) {
        const candidate = project(shape[seg], shape[seg + 1], lat[s], lng[s]);
        const position = { segment: seg, ...candidate };
        if (!best || position.offset < best.offset) best = position;
        else if (best.offset < 40) break;
      }
    }
    positions.push(best!);
    from = best!.segment;
  }

  const hops: (number[][] | null)[] = [];
  for (let k = 0; k < positions.length - 1; k += 1) {
    const a = positions[k];
    const b = positions[k + 1];
    if (a.offset > SHAPE_MAX_STOP_OFFSET_METERS || b.offset > SHAPE_MAX_STOP_OFFSET_METERS) {
      hops.push(null);
      continue;
    }
    const coords: number[][] = [[lng[group.stops[k]], lat[group.stops[k]]], [a.lng, a.lat]];
    for (let i = a.segment + 1; i <= b.segment; i += 1) coords.push([shape[i].lng, shape[i].lat]);
    coords.push([b.lng, b.lat], [lng[group.stops[k + 1]], lat[group.stops[k + 1]]]);
    hops.push(dedupe(coords));
  }
  return hops;
}

function shapePointsPerKm(shape: ShapePoint[]) {
  let meters = 0;
  for (let i = 1; i < shape.length; i += 1) meters += haversineMeters(shape[i - 1].lat, shape[i - 1].lng, shape[i].lat, shape[i].lng);
  return meters > 0 ? shape.length / (meters / 1000) : Infinity;
}

function project(a: ShapePoint, b: ShapePoint, pLat: number, pLng: number) {
  // Equirectangular is plenty at the scale of one shape segment.
  const k = Math.cos((pLat * Math.PI) / 180);
  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = pLng * k, py = pLat;
  const dx = bx - ax, dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
  const lat = a.lat + t * (b.lat - a.lat);
  const lng = a.lng + t * (b.lng - a.lng);
  return { t, lat, lng, offset: haversineMeters(lat, lng, pLat, pLng) };
}

/** Drops repeated points: equal at the micro-degree precision the timetable stores. */
function dedupe(coords: number[][]) {
  const same = (x: number, y: number) => Math.round(x * 1e6) === Math.round(y * 1e6);
  return coords.filter((c, i) => i === 0 || !same(c[0], coords[i - 1][0]) || !same(c[1], coords[i - 1][1]));
}
