import { compileTransit, decodeTransitTimetable, encodeTransitTimetable, parseCsv, parseGtfsTime, TransitRouter, type GtfsFeedInput, type HopGeometryRequest } from "../transit";
import { serviceDayOrigin, localServiceTime, dayNumber } from "./time";
import { haversineMeters } from "./compile";

/**
 * A small two-operator network laid out east-west along latitude 41.15 in
 * Porto, roughly 840 m between stops:
 *
 *   A ─── B ─── C        metro line M (A→B→C), "shapes" that are just the stations
 *               │
 *               D ─ E    bus line 10 (C→D→E), with a shape that bends north first
 *
 * Bus stop C2 sits 60 m from metro stop C, so changing there is a walk.
 */
const A = { lat: 41.15, lng: -8.62 };
const B = { lat: 41.15, lng: -8.61 };
const C = { lat: 41.15, lng: -8.6 };
const C2 = { lat: 41.15054, lng: -8.6 }; // ≈ 60 m north of C
const D = { lat: 41.158, lng: -8.6 };
const E = { lat: 41.158, lng: -8.59 };

const metroFeed: GtfsFeedInput = {
  id: "metro",
  files: {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nM,Metro,https://m.example,Europe/Lisbon\n",
    // A byte order mark and CRLF line endings, as some producers write.
    "stops.txt": `﻿stop_id,stop_name,stop_lat,stop_lon\r\nA,"Alpha, Station",${A.lat},${A.lng}\r\nB,Bravo,${B.lat},${B.lng}\r\nC,Charlie,${C.lat},${C.lng}\r\n`,
    "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\nM,M,Metro M,1,199FDA\n",
    // Weekdays from Monday 2026-09-14 to Sunday 2026-09-27.
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260914,20260927\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\nM,WD,m1,Charlie,S\nM,WD,m2,Charlie,S\nM,WD,m3,Charlie,S\nM,WD,late,Charlie,S\n",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      // Hours without a leading zero, as the Metro do Porto feed writes them.
      "m1,8:00:00,8:00:00,A,1", "m1,8:02:00,8:02:00,B,2", "m1,8:04:00,8:04:00,C,3",
      "m2,8:10:00,8:10:00,A,1", "m2,,,B,2", "m2,8:14:00,8:14:00,C,3",
      "m3,8:20:00,8:20:00,A,1", "m3,8:22:00,8:22:00,B,2", "m3,8:24:00,8:24:00,C,3",
      // After midnight on the service day.
      "late,24:30:00,24:30:00,A,1", "late,24:32:00,24:32:00,B,2", "late,24:34:00,24:34:00,C,3",
    ].join("\n"),
    // Station-to-station "shape": the compiler should not trust it.
    "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS,${A.lat},${A.lng},1\nS,${B.lat},${B.lng},2\nS,${C.lat},${C.lng},3\n`,
  },
};

const busFeed: GtfsFeedInput = {
  id: "bus",
  files: {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nB,Bus,https://b.example,Europe/Lisbon\n",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nC2,Charlie Bus,${C2.lat},${C2.lng}\nD,Delta,${D.lat},${D.lng}\nE,Echo,${E.lat},${E.lng}\n`,
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\n10,10,Charlie - Echo,3\nX,X,Express,3\n",
    // Only calendar_dates, like the STCP feed: Monday 14 and Tuesday 15 September.
    "calendar_dates.txt": "service_id,date,exception_type\nD,20260914,1\nD,20260915,1\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\n10,D,b1,Echo,BS\n10,D,b2,Echo,BS\n10,D,slow,Echo,BS\n10,D,fast,Echo,BS\n",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled",
      "b1,08:15:00,08:15:00,C2,1,0", "b1,08:20:00,08:20:00,D,2,900", "b1,08:25:00,08:25:00,E,3,1740",
      "b2,08:30:00,08:30:00,C2,1,0", "b2,08:35:00,08:35:00,D,2,900", "b2,08:40:00,08:40:00,E,3,1740",
      // `fast` leaves after `slow` but overtakes it: they must not share a pattern.
      "slow,09:00:00,09:00:00,C2,1,0", "slow,09:20:00,09:20:00,D,2,900", "slow,09:40:00,09:40:00,E,3,1740",
      "fast,09:05:00,09:05:00,C2,1,0", "fast,09:08:00,09:08:00,D,2,900", "fast,09:11:00,09:11:00,E,3,1740",
    ].join("\n"),
    // A shape that leaves C2 northwards in several points before reaching D, then E.
    "shapes.txt": [
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled",
      `BS,${C2.lat},${C2.lng},1,0`, `BS,41.153,-8.6005,2,280`, `BS,41.155,-8.6008,3,500`, `BS,41.157,-8.6004,4,780`,
      `BS,${D.lat},${D.lng},5,900`, `BS,41.1582,-8.596,6,1240`, `BS,41.1581,-8.593,7,1500`, `BS,${E.lat},${E.lng},8,1740`,
    ].join("\n"),
  },
};

/** 2026-09-14 is a Monday; Lisbon is UTC+1 in September. */
const lisbon = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`);

async function compiled(options: Parameters<typeof compileTransit>[1] = {}) {
  return compileTransit([metroFeed, busFeed], options);
}

describe("GTFS reading", () => {
  test("CSV handles quotes, commas in quotes, BOM and CRLF", () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"x, ""y""",\r\n2,plain,z');
    expect(rows).toEqual([{ a: "1", b: 'x, "y"', c: "" }, { a: "2", b: "plain", c: "z" }]);
  });

  test("times may omit the leading zero and run past midnight", () => {
    expect(parseGtfsTime("6:01:00")).toBe(6 * 3600 + 60);
    expect(parseGtfsTime("25:10:30")).toBe(25 * 3600 + 630);
    expect(parseGtfsTime("")).toBe(-1);
    expect(() => parseGtfsTime("8:70:00")).toThrow();
  });

  test("a service day starts at local noon minus twelve hours, also when the clocks change", () => {
    // 29 March 2026: Lisbon moves from UTC+0 to UTC+1 at 01:00 UTC.
    const day = dayNumber("20260329");
    expect(new Date(serviceDayOrigin(day, "Europe/Lisbon")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(serviceDayOrigin(dayNumber("20260914"), "Europe/Lisbon")).toISOString()).toBe("2026-09-13T23:00:00.000Z");
    expect(localServiceTime(lisbon("2026-09-14", "08:05").getTime(), "Europe/Lisbon")).toEqual({ day: dayNumber("20260914"), seconds: 8 * 3600 + 300 });
  });
});

describe("compiling", () => {
  test("merges feeds, interpolates blank times and splits overtaking trips", async () => {
    const { timetable, report } = await compiled();
    expect(timetable.feeds.map((f) => [f.id, f.firstServiceDate, f.lastServiceDate])).toEqual([
      ["metro", "20260914", "20260925"],
      ["bus", "20260914", "20260915"],
    ]);
    expect(timetable.stopIds).toEqual(expect.arrayContaining(["metro:A", "bus:C2"]));
    expect(timetable.stopNames[timetable.stopIds.indexOf("metro:A")]).toBe("Alpha, Station");
    expect(report.interpolatedStopTimes).toBe(1);
    // m2's blank time at B lands halfway between 8:10 and 8:14.
    const m2 = [...timetable.tripTimes.slice(timetable.tripTimeOffset[1], timetable.tripTimeOffset[1] + 6)];
    expect(m2).toEqual([29400, 29400, 29520, 29520, 29640, 29640]);
    // Bus line 10: one stop sequence, but `fast` overtakes `slow`, so two patterns.
    const busPatterns = [...timetable.patternRoute].filter((r) => timetable.routeIds[r] === "bus:10").length;
    expect(busPatterns).toBe(2);
    // Metro and bus stops 60 m apart are linked by a walk.
    const c = timetable.stopIds.indexOf("metro:C");
    const c2 = timetable.stopIds.indexOf("bus:C2");
    const links = [...timetable.transferTo.slice(timetable.transferOffset[c], timetable.transferOffset[c + 1])];
    expect(links).toContain(c2);
  });

  test("uses a shape that follows the way, and routes hops whose shape only joins the stops", async () => {
    const asked: HopGeometryRequest[] = [];
    const { timetable, report } = await compiled({
      routeHop: async (request) => {
        asked.push(request);
        // A gentle curve between the two stations, as a track would take.
        const mid = [(request.from.lng + request.to.lng) / 2, request.from.lat + 0.001];
        return [[request.from.lng, request.from.lat], mid, [request.to.lng, request.to.lat]];
      },
    });
    expect(asked.map((r) => r.mode)).toEqual(["metro", "metro"]);
    expect(report.hops).toEqual({ total: 4, shape: 2, routed: 2, straight: 0 });
    expect(report.hopFallbacks).toEqual([]);
    // The bus hop C2→D keeps the shape's intermediate points.
    const busGeometry = timetable.patternGeometry[[...timetable.patternRoute].findIndex((r) => timetable.routeIds[r] === "bus:10")];
    const hop = timetable.geometryHopOffset[busGeometry];
    expect(timetable.hopPointOffset[hop + 1] - timetable.hopPointOffset[hop]).toBeGreaterThanOrEqual(5);
  });

  test("falls back to a straight line, and says so, when a routed hop is implausible", async () => {
    const { report } = await compiled({
      routeHop: async (request) => [[request.from.lng, request.from.lat], [request.from.lng + 0.5, request.from.lat], [request.to.lng, request.to.lat]],
    });
    expect(report.hops.straight).toBe(2);
    expect(report.hopFallbacks[0]).toMatchObject({ route: "metro:M", reason: "routed path implausibly long" });
  });

  test("encodes and decodes without loss", async () => {
    const { timetable } = await compiled();
    const decoded = await decodeTransitTimetable(await encodeTransitTimetable(timetable));
    expect(decoded.stopIds).toEqual(timetable.stopIds);
    expect([...decoded.tripTimes]).toEqual([...timetable.tripTimes]);
    expect([...decoded.serviceDays]).toEqual([...timetable.serviceDays]);
    expect([...decoded.transferTo]).toEqual([...timetable.transferTo]);
    expect(decoded.hopCoords.length).toBe(timetable.hopCoords.length);
    decoded.hopCoords.forEach((value, i) => expect(value).toBeCloseTo(timetable.hopCoords[i], 6));
    decoded.stopLat.forEach((value, i) => expect(value).toBeCloseTo(timetable.stopLat[i], 6));
  });
});

describe("planning", () => {
  const options = { maxWalkMeters: 150 };

  test("rides the metro, walks across to the bus, and rides on", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const plan = await router.plan(A, E, { ...options, departAt: lisbon("2026-09-14", "08:05") });
    const best = plan.journeys[plan.journeys.length - 1];
    const summary = best.legs.map((leg) => (leg.kind === "ride" ? `${leg.line.shortName} ${leg.from.name}→${leg.to.name}` : "walk"));
    expect(summary).toEqual(["M Alpha, Station→Charlie", "walk", "10 Charlie Bus→Echo"]);
    const [metro, transfer, bus] = best.legs;
    expect(new Date(metro.departAt).toISOString()).toBe("2026-09-14T07:10:00.000Z"); // 08:10 local, m2
    expect(transfer.kind === "walk" && transfer.fromStop?.id).toBe("metro:C");
    expect(new Date(bus.departAt).toISOString()).toBe("2026-09-14T07:30:00.000Z"); // 08:30: 08:15 is too soon after 08:14 + walk
    expect(best.rides).toBe(2);
    expect(metro.kind === "ride" && metro.intermediateStops.map((s) => s.name)).toEqual(["Bravo"]);
    // m2 has no time of its own at Bravo; it was interpolated to 08:12.
    expect(metro.kind === "ride" && new Date(metro.intermediateStops[0].arriveAt).toISOString()).toBe("2026-09-14T07:12:00.000Z");
  });

  test("an overtaking express is found even though it leaves later", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const plan = await router.plan(C2, E, { ...options, departAt: lisbon("2026-09-14", "08:55") });
    const ride = plan.journeys.at(-1)!.legs.find((leg) => leg.kind === "ride")!;
    expect(new Date(ride.arriveAt).toISOString()).toBe("2026-09-14T08:11:00.000Z"); // fast, 09:11 local
  });

  test("mode and operator filters restrict which lines are used", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const at = lisbon("2026-09-14", "08:05");
    const busOnly = await router.plan(A, E, { ...options, departAt: at, modes: ["bus"] });
    expect(busOnly.journeys.every((j) => j.legs.every((leg) => leg.kind !== "ride" || leg.line.mode === "bus"))).toBe(true);
    expect(busOnly.journeys.some((j) => j.rides > 0)).toBe(false); // A is out of reach of every bus stop
    const metroOnly = await router.plan(A, C, { ...options, departAt: at, feeds: ["metro"] });
    expect(metroOnly.journeys.at(-1)!.legs.some((leg) => leg.kind === "ride" && leg.line.feed === "metro")).toBe(true);
    expect(router.modes).toEqual(["metro", "bus"]);
  });

  test("a trip after midnight belongs to the day it set out on", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    // Monday's 24:30 trip, asked for late on Monday and again just after midnight.
    for (const departAt of [lisbon("2026-09-14", "23:50"), lisbon("2026-09-15", "00:10")]) {
      const plan = await router.plan(A, C, { ...options, departAt });
      const ride = plan.journeys.at(-1)!.legs.find((leg) => leg.kind === "ride")!;
      expect(new Date(ride.departAt).toISOString()).toBe("2026-09-14T23:30:00.000Z"); // 00:30 Tuesday local
    }
  });

  test("outside a feed's dates there is no service, unless a same-weekday fallback is asked for", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    // Monday 2 November: both feeds have ended.
    const at = lisbon("2026-11-02", "08:05").getTime() + 3600_000; // UTC+0 by November
    const strict = await router.plan(A, E, { ...options, departAt: at });
    expect(strict.journeys.filter((j) => j.rides > 0)).toEqual([]);
    expect(strict.serviceDates.every((d) => d.used === "")).toBe(true);
    const fallback = await router.plan(A, E, { ...options, departAt: at, dateFallback: "same-weekday" });
    expect(fallback.serviceDates).toEqual([
      { feed: "metro", requested: "20261102", used: "20260921", substituted: true },
      { feed: "bus", requested: "20261102", used: "20260914", substituted: true },
    ]);
    const best = fallback.journeys.at(-1)!;
    expect(best.rides).toBe(2);
    // Times are on the requested day, from the substituted day's timetable.
    expect(new Date(best.legs.find((l) => l.kind === "ride")!.departAt).toISOString()).toBe("2026-11-02T08:10:00.000Z");
  });

  test("walks use the walk router when one is given", async () => {
    const calls: string[] = [];
    const walkRouter = {
      route: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
        calls.push(`${from.lat},${from.lng}`);
        return { distanceMeters: 100, durationSeconds: 80, geometry: { type: "LineString" as const, coordinates: [[from.lng, from.lat], [from.lng, to.lat], [to.lng, to.lat]] } };
      },
    };
    const router = new TransitRouter((await compiled()).timetable, { walkRouter });
    const start = { lat: A.lat + 0.0008, lng: A.lng }; // ≈ 90 m north of A
    const plan = await router.plan(start, C, { ...options, departAt: lisbon("2026-09-14", "08:05") });
    const walk = plan.journeys.at(-1)!.legs[0];
    expect(walk.kind === "walk" && walk.routed).toBe(true);
    expect(walk.durationSeconds).toBe(80);
    expect(walk.geometry.coordinates).toHaveLength(3);
    // Leave just in time for the 08:10 departure.
    expect(new Date(walk.departAt).toISOString()).toBe("2026-09-14T07:08:40.000Z");
    expect(calls.length).toBeGreaterThan(0);
  });
});

test("options passed as undefined keep their defaults", async () => {
  const { timetable } = await compileTransit([metroFeed, busFeed], { transferRadiusMeters: undefined });
  // With the 250 m default only the two Charlie stops are close enough to link.
  expect(timetable.transferTo.length).toBe(2);
});

test("a fallback day must be one the feed runs trips on, and dated services without trips are reported", async () => {
  // Like the STCP export: the latest Tuesday in range (15 September) is listed
  // only for a service no trip uses, so the substitute must be the Tuesday before.
  const broken: GtfsFeedInput = {
    ...busFeed,
    files: { ...busFeed.files, "calendar_dates.txt": "service_id,date,exception_type\nD,20260908,1\nD,20260914,1\nD,20260920,1\nSCHOOL,20260915,1\n" },
  };
  const { timetable, report } = await compileTransit([metroFeed, broken]);
  expect(report.servicesWithoutTrips).toEqual([{ service: "bus:SCHOOL", days: 1, first: "20260915", last: "20260915" }]);
  const router = new TransitRouter(timetable);
  const plan = await router.plan(A, E, { maxWalkMeters: 150, departAt: new Date("2026-11-03T08:05:00Z"), dateFallback: "same-weekday" });
  expect(plan.serviceDates.find((d) => d.feed === "bus")!.used).toBe("20260908");
  expect(plan.journeys.at(-1)!.rides).toBe(2);
});

test("a coarse rail shape gives way to the mapped track when one is available", async () => {
  // Two bend points between each pair of stations: it follows the way, but only roughly (≈ 4 points per km).
  const coarse: GtfsFeedInput = {
    ...metroFeed,
    files: {
      ...metroFeed.files,
      "shapes.txt": `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS,${A.lat},${A.lng},1\nS,41.1512,-8.617,2\nS,41.1512,-8.613,3\nS,${B.lat},${B.lng},4\nS,41.1512,-8.607,5\nS,41.1512,-8.603,6\nS,${C.lat},${C.lng},7\n`,
    },
  };
  const track = async (r: HopGeometryRequest) => [[r.from.lng, r.from.lat], [(r.from.lng + r.to.lng) / 2, r.from.lat + 0.0005], [r.to.lng, r.to.lat]];
  expect((await compileTransit([coarse, busFeed], { routeHop: track })).report.hops).toEqual({ total: 4, shape: 2, routed: 2, straight: 0 });
  // Without a track to route on, the coarse shape is still better than nothing.
  expect((await compileTransit([coarse, busFeed])).report.hops).toEqual({ total: 4, shape: 4, routed: 0, straight: 0 });
});

test("a hop that snaps to another line's track is routed through to the next stop and cut", async () => {
  // B→C routed directly loops far away, as Aliados→Trindade does when Trindade
  // snaps to the surface lines; routed A→C it passes B on the right track.
  const track = async (r: HopGeometryRequest) => {
    const isBtoC = Math.abs(r.from.lng - B.lng) < 1e-9 && Math.abs(r.to.lng - C.lng) < 1e-9;
    if (isBtoC) return [[B.lng, B.lat], [B.lng, B.lat + 0.05], [C.lng, C.lat]];
    return [[r.from.lng, r.from.lat], [(r.from.lng + r.to.lng) / 2, r.from.lat + 0.0003], [r.to.lng, r.to.lat]];
  };
  const reversed: GtfsFeedInput = {
    ...metroFeed,
    files: { ...metroFeed.files, "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nm1,8:00:00,8:00:00,A,1\nm1,8:02:00,8:02:00,B,2\nm1,8:04:00,8:04:00,C,3\n", "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\nM,WD,m1,Charlie,S\n" },
  };
  const { report } = await compileTransit([reversed, busFeed], {
    routeHop: async (r) => {
      // A→C passes right over B.
      if (Math.abs(r.from.lng - A.lng) < 1e-9 && Math.abs(r.to.lng - C.lng) < 1e-9) return [[A.lng, A.lat], [B.lng, B.lat + 0.0002], [C.lng, C.lat]];
      return track(r);
    },
  });
  expect(report.hops).toMatchObject({ routed: 2, straight: 0 });
  expect(report.hopFallbacks).toEqual([]);
});

test("alternatives offers later departures, each once, ordered by when they leave", async () => {
  const router = new TransitRouter((await compileTransit([metroFeed, busFeed])).timetable);
  const plan = await router.plan(A, C, { maxWalkMeters: 150, departAt: lisbon("2026-09-14", "08:05"), alternatives: 2 });
  const departures = plan.journeys.map((j) => new Date(j.legs.find((l) => l.kind === "ride")!.departAt).toISOString());
  // m2 08:10, m3 08:20, then Monday's 24:30 trip.
  expect(departures).toEqual(["2026-09-14T07:10:00.000Z", "2026-09-14T07:20:00.000Z", "2026-09-14T23:30:00.000Z"]);
});

test("walking to a stop and walking on is not a public transport journey", async () => {
  // C and C2 are both within reach of both ends; there is still a real ride to offer.
  const router = new TransitRouter((await compileTransit([metroFeed, busFeed])).timetable);
  const near = { lat: C.lat - 0.0005, lng: C.lng };
  const plan = await router.plan(near, E, { maxWalkMeters: 1000, departAt: lisbon("2026-09-14", "08:05"), alternatives: 2 });
  for (const journey of plan.journeys) {
    // Either the direct walk (one leg) or a journey with a ride in it.
    expect(journey.legs.length === 1 || journey.rides > 0).toBe(true);
  }
  expect(plan.journeys.filter((j) => j.rides > 0).length).toBeGreaterThanOrEqual(3);
});

test("rail stops placed off the track are moved onto it, and their rides end there", async () => {
  // The track runs 50 m south of where the feed puts the stations, as Metro do
  // Porto places Campanhã on the street beside its platforms.
  const offset = (metres: number) => async (r: HopGeometryRequest) => [
    [r.from.lng, r.from.lat - metres / 111_320],
    [(r.from.lng + r.to.lng) / 2, r.from.lat - metres / 111_320],
    [r.to.lng, r.to.lat - metres / 111_320],
  ];
  const { timetable, report } = await compiled({ routeHop: offset(50) });
  expect(report.stopsPlacedOnTrack.map((s) => [s.stop, s.meters])).toEqual([["metro:A", 50], ["metro:B", 50], ["metro:C", 50]]);
  const b = timetable.stopIds.indexOf("metro:B");
  expect(timetable.stopLat[b]).toBeCloseTo(B.lat - 50 / 111_320, 6);
  // The first ride starts exactly at the moved stop, with no stub to the feed's point.
  const metroGeometry = timetable.patternGeometry[[...timetable.patternRoute].findIndex((r) => timetable.routeIds[r] === "metro:M")];
  const first = timetable.hopPointOffset[timetable.geometryHopOffset[metroGeometry]];
  const a = timetable.stopIds.indexOf("metro:A");
  expect([timetable.hopCoords[2 * first], timetable.hopCoords[2 * first + 1]]).toEqual([timetable.stopLng[a], timetable.stopLat[a]]);
  expect(timetable.hopPointOffset[timetable.geometryHopOffset[metroGeometry] + 1] - first).toBe(3);
  // Bus stops, drawn from their own shape, stay where the feed put them.
  expect(timetable.stopLat[timetable.stopIds.indexOf("bus:C2")]).toBe(C2.lat);

  // A track too far away to be the station's is not trusted.
  const far = await compiled({ routeHop: offset(400) });
  expect(far.report.stopsPlacedOnTrack).toEqual([]);
  expect(far.timetable.stopLat[far.timetable.stopIds.indexOf("metro:B")]).toBe(B.lat);
});

test("the night before a feed starts, a plan reaches its first morning", async () => {
  const { timetable } = await compiled();
  const router = new TransitRouter(timetable);
  // Sunday 13 September is before either feed; Monday's first metro leaves A at 08:00.
  const plan = await router.plan(A, C, { departAt: lisbon("2026-09-13", "23:00"), modes: ["metro"], walkRouter: null });
  const ride = plan.journeys.flatMap((j) => j.legs).find((leg) => leg.kind === "ride");
  expect(ride?.departAt).toBe(lisbon("2026-09-14", "08:00").getTime());
});

describe("going to the first station by car or bicycle", () => {
  // 3 km west of A: out of walking reach of every stop.
  const home = { lat: 41.15, lng: -8.656 };
  /** A stand-in road router: the straight line at a fixed speed. */
  const straightAt = (mps: number) => ({
    route: async (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
      return { distanceMeters: meters, durationSeconds: meters / mps, geometry: { type: "LineString" as const, coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } };
    },
  });

  test("drives to a station, parks, and rides on; bus stops are not parking places", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    // 5 min to drive 3 km, 5 to park: 07:45 catches the 08:00.
    const departAt = lisbon("2026-09-14", "07:45");
    const onFoot = await router.plan(home, C, { departAt, walkRouter: null });
    expect(onFoot.journeys.some((j) => j.rides > 0)).toBe(false);

    const plan = await router.plan(home, C, { departAt, walkRouter: null, access: { mode: "car", router: straightAt(10) } });
    expect(plan.journeys.length).toBeGreaterThan(0);
    const [journey] = plan.journeys;
    const [drive, ride] = journey.legs;
    expect(drive.kind).toBe("drive");
    if (drive.kind !== "drive" || ride.kind !== "ride") throw new Error("expected drive then ride");
    expect(drive.toStop?.name).toBe("Alpha, Station");
    expect(drive.parkSeconds).toBe(300);
    // Leaves in time to drive ~3 km, park 5 min and catch the 08:00.
    expect(ride.departAt).toBe(lisbon("2026-09-14", "08:00").getTime());
    expect(drive.arriveAt + drive.parkSeconds * 1000).toBeLessThanOrEqual(ride.departAt);
    expect(ride.departAt - (drive.arriveAt + drive.parkSeconds * 1000)).toBeLessThan(1000);
    // No walking-the-whole-way option is mixed in.
    expect(plan.journeys.every((j) => j.legs[0].kind === "drive")).toBe(true);
  });

  test("by bicycle: a shorter reach and less time to lock up", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const departAt = lisbon("2026-09-14", "07:50");
    const plan = await router.plan(home, C, { departAt, walkRouter: null, access: { mode: "bicycle", router: straightAt(4.5) } });
    const first = plan.journeys[0].legs[0];
    expect(first.kind).toBe("cycle");
    if (first.kind === "cycle") expect(first.parkSeconds).toBe(120);
    // Beyond its reach, nothing.
    const far = { lat: 41.15, lng: -8.72 }; // ~8 km west
    expect((await router.plan(far, C, { departAt, walkRouter: null, access: { mode: "bicycle", router: straightAt(4.5) } })).journeys).toEqual([]);
  });

  test("only stations of the given modes qualify, and failed routes are skipped", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const departAt = lisbon("2026-09-14", "08:10");
    // Bus stops allowed: the car can reach C2 for the bus.
    const toE = await router.plan(home, E, { departAt, walkRouter: null, access: { mode: "car", router: straightAt(10), stationModes: ["bus"] } });
    const drive = toE.journeys[0]?.legs[0];
    expect(drive?.kind === "drive" && drive.toStop?.name).toBe("Charlie Bus");
    const failing = { route: async () => { throw new Error("no road"); } };
    expect((await router.plan(home, C, { departAt, walkRouter: null, access: { mode: "car", router: failing } })).journeys).toEqual([]);
  });

  test("the way back ends at the station where the car was left, then drives home", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const departAt = lisbon("2026-09-14", "08:00");
    const plan = await router.plan(B, home, {
      departAt,
      walkRouter: null,
      modes: ["metro"],
      egress: { mode: "car", router: straightAt(10), station: { ...C, name: "Charlie", id: "metro:C" } },
    });
    expect(plan.journeys.length).toBeGreaterThan(0);
    const journey = plan.journeys[0];
    const last = journey.legs[journey.legs.length - 1];
    const ride = journey.legs.find((leg) => leg.kind === "ride");
    if (last.kind !== "drive" || ride?.kind !== "ride") throw new Error("expected a ride, then a drive");
    expect(ride.to.name).toBe("Charlie");
    expect(last.fromStop?.name).toBe("Charlie");
    // Five minutes back to the car after the 08:05 arrival, then the drive.
    expect(last.departAt).toBe(ride.arriveAt + 300_000);
    expect(journey.arriveAt).toBe(last.arriveAt);
    expect(journey.durationSeconds).toBe(Math.round((last.arriveAt - journey.departAt) / 1000));
    // No road back: no journeys.
    const failing = { route: async () => { throw new Error("no road"); } };
    expect((await router.plan(B, home, { departAt, walkRouter: null, egress: { mode: "car", router: failing, station: C } })).journeys).toEqual([]);
  });

  test("a station's own time to park decides between stations", async () => {
    const router = new TransitRouter((await compiled()).timetable);
    const departAt = lisbon("2026-09-14", "07:40");
    const car = { mode: "car" as const, router: straightAt(10) };
    // Alpha is nearer, but with no space to be found the next station wins.
    const plan = await router.plan(home, C, {
      departAt,
      walkRouter: null,
      access: { ...car, parkSecondsAt: (id) => (id === "metro:A" ? 1800 : 60) },
    });
    const fastest = plan.journeys.reduce((a, b) => (b.arriveAt < a.arriveAt ? b : a));
    const drive = fastest.legs[0];
    expect(drive.kind === "drive" && drive.toStop?.name).toBe("Bravo");
    expect(drive.kind === "drive" && drive.parkSeconds).toBe(60);
  });
});
