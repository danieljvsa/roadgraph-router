import { compileTransit, TransitSimulator, type GtfsFeedInput } from "../transit";

/**
 * Two lines east of Porto, as in transit.test.ts but smaller:
 *
 *   A ─── B ─── C        metro M, A→B→C, 2 min between stations, weekdays
 *               │
 *               D        bus 10, C→D northwards along a bent shape, 14 and 15 September only
 */
const A = { lat: 41.15, lng: -8.62 };
const B = { lat: 41.15, lng: -8.61 };
const C = { lat: 41.15, lng: -8.6 };
const D = { lat: 41.158, lng: -8.6 };

const metro: GtfsFeedInput = {
  id: "metro",
  files: {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nM,Metro,https://m.example,Europe/Lisbon\n",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,${A.lat},${A.lng}\nB,Bravo,${B.lat},${B.lng}\nC,Charlie,${C.lat},${C.lng}\n`,
    "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\nM,M,Metro M,1,199FDA\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWD,1,1,1,1,1,0,0,20260914,20260927\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign\nM,WD,m1,Charlie\nM,WD,late,Charlie\n",
    "stop_times.txt": [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      // Waits a minute at B.
      "m1,08:00:00,08:00:00,A,1", "m1,08:02:00,08:03:00,B,2", "m1,08:05:00,08:05:00,C,3",
      "late,24:30:00,24:30:00,A,1", "late,24:32:00,24:32:00,B,2", "late,24:34:00,24:34:00,C,3",
    ].join("\n"),
  },
};

const bus: GtfsFeedInput = {
  id: "bus",
  files: {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nB,Bus,https://b.example,Europe/Lisbon\n",
    "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nC2,Charlie Bus,${C.lat},${C.lng}\nD,Delta,${D.lat},${D.lng}\n`,
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\n10,10,Charlie - Delta,3\n",
    "calendar_dates.txt": "service_id,date,exception_type\nD,20260914,1\nD,20260915,1\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,shape_id\n10,D,b1,Delta,BS\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nb1,08:00:00,08:00:00,C2,1\nb1,08:10:00,08:10:00,D,2\n",
    // North, with a dog-leg west halfway.
    "shapes.txt": [
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
      `BS,${C.lat},${C.lng},1`, `BS,41.154,-8.6,2`, `BS,41.154,-8.601,3`, `BS,${D.lat},-8.601,4`, `BS,${D.lat},${D.lng},5`,
    ].join("\n"),
  },
};

/** Lisbon is UTC+1 in September; 2026-09-14 is a Monday. */
const lisbon = (date: string, time: string) => new Date(`${date}T${time}+01:00`).getTime();

async function simulator(options: ConstructorParameters<typeof TransitSimulator>[1] = {}) {
  const { timetable } = await compileTransit([metro, bus]);
  return new TransitSimulator(timetable, options);
}

function vehicles(sim: TransitSimulator, ms: number) {
  const frame = sim.positions(ms);
  const t = sim.timetable;
  return Array.from({ length: frame.count }, (_, i) => ({
    line: t.routeShortNames[frame.routes[i]],
    trip: frame.trips[i],
    lng: frame.coords[3 * i],
    lat: frame.coords[3 * i + 1],
    heading: frame.coords[3 * i + 2],
    atStop: frame.atStop[i] === 1,
    dayOffset: frame.dayOffsets[i],
  }));
}

describe("simulating vehicles", () => {
  test("a vehicle between two stops is placed in proportion to the time, facing the way it goes", async () => {
    const sim = await simulator();
    const [m] = vehicles(sim, lisbon("2026-09-14", "08:01:00")).filter((v) => v.line === "M");
    expect(m.lng).toBeCloseTo(-8.615, 4);
    expect(m.lat).toBeCloseTo(41.15, 4);
    expect(m.heading).toBeGreaterThan(85);
    expect(m.heading).toBeLessThan(95);
    expect(m.atStop).toBe(false);
  });

  test("a vehicle waits at a stop between arriving and leaving", async () => {
    const sim = await simulator();
    const [m] = vehicles(sim, lisbon("2026-09-14", "08:02:30")).filter((v) => v.line === "M");
    expect(m.atStop).toBe(true);
    expect(m.lng).toBeCloseTo(B.lng, 5);
  });

  test("a bus follows its shape by distance, not a straight line between stops", async () => {
    const sim = await simulator();
    // Halfway in time is halfway along the 1 km shape: on the westward dog-leg.
    const [b] = vehicles(sim, lisbon("2026-09-14", "08:05:00")).filter((v) => v.line === "10");
    expect(b.lat).toBeCloseTo(41.154, 3);
    expect(b.lng).toBeLessThan(-8.6002);
    expect(b.lng).toBeGreaterThan(-8.6010);
    expect(b.heading).toBeGreaterThan(260);
    expect(b.heading).toBeLessThan(280);
    // And heading north further on.
    const [later] = vehicles(sim, lisbon("2026-09-14", "08:07:00")).filter((v) => v.line === "10");
    expect(later.heading < 10 || later.heading > 350).toBe(true);
  });

  test("only trips under way are shown, from first departure to last arrival", async () => {
    const sim = await simulator();
    expect(sim.count(lisbon("2026-09-14", "07:59:59"))).toBe(0);
    expect(sim.count(lisbon("2026-09-14", "08:00:00"))).toBe(2);
    expect(sim.count(lisbon("2026-09-14", "08:06:00"))).toBe(1); // the metro has arrived
    expect(sim.count(lisbon("2026-09-14", "08:10:01"))).toBe(0);
    // Saturday: no weekday metro, no dated bus.
    expect(sim.count(lisbon("2026-09-19", "08:01:00"))).toBe(0);
  });

  test("a trip past midnight runs on the next calendar day, as its service day's", async () => {
    const sim = await simulator();
    // Monday's late trip, at 00:31 on Tuesday.
    const [late] = vehicles(sim, lisbon("2026-09-15", "00:31:00"));
    expect(late.dayOffset).toBe(-1);
    expect(late.lng).toBeCloseTo(-8.615, 4);
    // Saturday's 00:31 is Friday's late trip; Monday's 00:31 has none (Sunday has no service).
    expect(sim.count(lisbon("2026-09-19", "00:31:00"))).toBe(1);
    expect(sim.count(lisbon("2026-09-14", "00:31:00"))).toBe(0);
  });

  test("outside a feed's dates nothing runs, unless a same-weekday fallback is asked for", async () => {
    const monday = lisbon("2026-09-28", "08:01:00");
    expect((await simulator()).count(monday)).toBe(0);
    const fallback = await simulator({ dateFallback: "same-weekday" });
    expect(vehicles(fallback, monday).map((v) => v.line).sort()).toEqual(["10", "M"]);
    // The bus's Monday is the 14th; the metro's the 21st, its last covered Monday.
    const bus = vehicles(fallback, monday).find((v) => v.line === "10")!;
    expect(fallback.tripDetails(bus.trip, monday)!.serviceDate).toBe("20260914");
    const m = vehicles(fallback, monday).find((v) => v.line === "M")!;
    expect(fallback.tripDetails(m.trip, monday)!.serviceDate).toBe("20260921");
  });

  test("mode and feed filters choose whose vehicles are shown", async () => {
    const at = lisbon("2026-09-14", "08:01:00");
    expect(vehicles(await simulator({ modes: ["bus"] }), at).map((v) => v.line)).toEqual(["10"]);
    expect(vehicles(await simulator({ feeds: ["metro"] }), at).map((v) => v.line)).toEqual(["M"]);
  });

  test("trip details give the line, every stop's times and the next stop", async () => {
    const sim = await simulator();
    const at = lisbon("2026-09-14", "08:01:00");
    const m = vehicles(sim, at).find((v) => v.line === "M")!;
    const details = sim.tripDetails(m.trip, at)!;
    expect(details.line).toMatchObject({ shortName: "M", mode: "metro", feed: "metro", color: "#199fda" });
    expect(details.headsign).toBe("Charlie");
    expect(details.stops.map((s) => s.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(details.stops[1]).toMatchObject({ arriveAt: lisbon("2026-09-14", "08:02:00"), departAt: lisbon("2026-09-14", "08:03:00") });
    expect(details.nextStop).toBe(1);
    expect(details.departAt).toBe(lisbon("2026-09-14", "08:00:00"));
    expect(details.arriveAt).toBe(lisbon("2026-09-14", "08:05:00"));
    expect(details.geometry.coordinates[0]).toEqual([A.lng, A.lat]);
    expect(details.serviceDate).toBe("20260914");
    // Past midnight, the late trip's times are on Tuesday's clock.
    const late = vehicles(sim, lisbon("2026-09-15", "00:31:00"))[0];
    const lateDetails = sim.tripDetails(late.trip, lisbon("2026-09-15", "00:31:00"))!;
    expect(lateDetails.departAt).toBe(lisbon("2026-09-15", "00:30:00"));
    expect(lateDetails.serviceDate).toBe("20260914");
    expect(sim.tripDetails(9999, at)).toBeNull();
  });

  test("departures near a point: soonest first, not from a trip's last stop, past midnight too", async () => {
    const sim = await simulator();
    // At B, 07:55 Monday: the metro leaves B at 08:03 (it waits a minute).
    const atB = sim.departures(B, lisbon("2026-09-14", "07:55:00"));
    expect(atB.map((d) => [d.line.shortName, d.headsign, d.departAt])).toEqual([
      ["M", "Charlie", lisbon("2026-09-14", "08:03:00")],
    ]);
    expect(atB[0].stop.name).toBe("Bravo");
    // C is where the metro ends and the bus (60 m away as "Charlie Bus", same point here) starts.
    expect(sim.departures(C, lisbon("2026-09-14", "07:55:00")).map((d) => d.line.shortName)).toEqual(["10"]);
    // Monday's late trip leaves A at 00:30 on Tuesday.
    const late = sim.departures(A, lisbon("2026-09-15", "00:20:00"));
    expect(late.map((d) => d.departAt)).toEqual([lisbon("2026-09-15", "00:30:00")]);
    expect(late[0].serviceDate).toBe("20260914");
    // From Sunday evening, the window reaches Monday's first departures.
    expect(sim.departures(A, lisbon("2026-09-13", "23:00:00"), { windowSeconds: 10 * 3600 }).map((d) => d.departAt)).toEqual([
      lisbon("2026-09-14", "08:00:00"),
    ]);
    // Feeds, radius and window limit what is found.
    expect(sim.departures(C, lisbon("2026-09-14", "07:55:00"), { feeds: ["metro"] })).toEqual([]);
    expect(sim.departures({ lat: 41.16, lng: -8.62 }, lisbon("2026-09-14", "07:55:00"))).toEqual([]);
    expect(sim.departures(B, lisbon("2026-09-14", "07:55:00"), { windowSeconds: 60 })).toEqual([]);
  });
});
