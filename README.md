# roadgraph-router

Compile any OpenStreetMap `.osm.pbf` extract into a compact, range-addressable
routing bundle, then route over it with A* — in Node.js or in the browser, with
no routing service involved.

A 425 MB Portugal extract compiles to a 38 MB bundle. A city route downloads
4.3 MB of it and takes about 270 ms end to end. The browser build is 24.5 kB
gzipped and pulls in no Node built-ins.

Seven profiles ship: `car`, `motorcycle`, `truck`, `bicycle` and `pedestrian`
over roads, and `train` and `metro` over mapped railway infrastructure. The
same Portugal extract compiles to a **294 kB** railway bundle in 73 seconds.
See [Railways](#railways).

## What a route here does and does not mean

A route is a path over roads that the compiled OpenStreetMap data **does not
say are forbidden** to the chosen vehicle. That is weaker than a statement
that the route is legal, or that the vehicle will physically fit, and the gap
matters most for a lorry.

On a railway the gap is different and wider, so it is stated separately:

> **Railway routing represents paths through mapped physical infrastructure.
> It does not establish that passenger services exist, that the track is
> currently operational, or that a real train is authorised or physically
> capable of using the calculated path.**

There is no GTFS support, no timetable, no passenger journey, no arrival time
and no signalling model here, and none is planned. A railway duration is a
line-speed estimate over mapped track. See [Railways](#railways).

Four kinds of rule are read and obeyed: tags on the way, such as access,
direction and signed limits; turn restriction relations; barriers on nodes;
and, when you supply a departure time, conditional restrictions on the way.
Everything below is **not read**, and a road governed only by one of them is
treated as open:

- **Conditional restrictions, unless you pass `departAt`.** Without a
  departure time a street closed to lorries overnight or a square
  pedestrianised on Sundays appears permanently open. See
  [Routing at a time of day](#routing-at-a-time-of-day) for what is read when
  you do pass one, and what is still not.
- **Conditional turn restrictions.** `restriction:conditional` on a turn
  restriction relation is not read, so a no-left-turn that applies only in the
  morning peak is enforced at every hour of the day.
- **Seasonal and weather rules.** Winter closures, snow-chain requirements,
  flood gates. A conditional value resting on weather, such as
  `80 @ (wet)`, is counted but never acted on.
- **Temporary closures.** Roadworks, events, landslides. Nothing in a compiled
  bundle changes after the compile, so a bundle is as current as the extract
  it was built from and no more.
- **Legal limits not expressed on the way.** National or urban default speed
  limits, lorry bans covering a zone rather than a road, designated freight
  routes, low-emission zones, tolls, permits.
- **Axle load, hazardous goods and trailer rules.** `maxaxleload`, `hazmat`
  and trailer-specific access are not read.
- **An untagged limit.** `maxheight` is tagged on a minority of bridges
  worldwide. Absence of a tag is not a measurement, and a road stating no
  limit is treated as passable by any vehicle.

For a lorry this means a route may pass under a bridge too low for it, over a
structure too weak for it, or along a street banned to it by a rule nobody
tagged on the way. **Do not use this engine as the sole basis for dispatching
a heavy vehicle.** Anything safety-critical needs a surveyed freight dataset.

The compiler reports what it understood. `turnRestrictionsRead` against
`turnRestrictionsSkipped`, `barriersRead` and
`edgesWithConditionalRestrictions`, in `<output>.json`, tell you how much of a
region's restriction data was used.

## Install

```sh
npm install roadgraph-router
```

**Requirements.** The routing engine runs on Node.js 18+ and in any browser
with `fetch` and `DecompressionStream` (Chrome 103+, Firefox 113+, Safari 16.4+).
The `roadgraph-compile` CLI needs **Node.js 22.5 or newer**, because it indexes
coordinates through the built-in `node:sqlite` module.

The package's `engines` field states the lower of the two, because installing
this package usually means using the library. Running the CLI on an older Node
is refused at startup with that explanation rather than part-way through an
extract.

## Quick start

Compile an extract, then route over it:

```sh
npx roadgraph-compile monaco.osm.pbf --output monaco.efrb
```

```ts
import { RoadRouter } from "roadgraph-router";

const router = await RoadRouter.open("/routing/monaco.efrb");
const result = await router.route(
  { lat: 43.7384, lng: 7.4246 },
  { lat: 43.7325, lng: 7.4189 },
);

result.distanceMeters; // 1210.17
result.durationSeconds; // 108.68
result.geometry; // a GeoJSON LineString of 38 points following the roads
```

`RoadRouter.open()` also accepts an already-decoded `RoadGraph`, which is
useful for embedded or application-managed data.

## Vehicles

Every tag decision lives behind a `RoutingProfile` rather than in the compiler.
Seven ship. Five travel by road and are described here; `train` and `metro`
travel by rail and are described under [Railways](#railways), because almost
none of the rules below survive the move to a railway.

`car`, `motorcycle` and `truck` read the same tags in the same order and
differ in the mode name at the bottom of each hierarchy, so a car resolves
`motorcar` where a motorcycle resolves `motorcycle` and a lorry resolves
`hgv`. `bicycle` and `pedestrian` are a different shape, described below.

| | `car` | `motorcycle` | `truck` |
| --- | --- | --- | --- |
| Access key | `motorcar` | `motorcycle` | `hgv` |
| Speed ceiling | 150 km/h | 150 km/h | **90 km/h**, applied to every road |
| Mode-specific tags | `oneway:motorcar`, `maxspeed:motorcar`, `restriction:motorcar` | `oneway:motorcycle`, `maxspeed:motorcycle`, `restriction:motorcycle` | `oneway:hgv`, `maxspeed:hgv`, `restriction:hgv` |
| Physical limits | — | — | `maxheight`, `maxwidth`, `maxlength`, `maxweight` |

| | `bicycle` | `pedestrian` |
| --- | --- | --- |
| Access keys | `access`, `vehicle`, `bicycle` | `access`, `foot` |
| Speed | 7–18 km/h by way class | 2–5 km/h by way class |
| Ceiling | 30 km/h | 7 km/h |
| One-way signs | obeyed, lifted by `oneway:bicycle=no` | ignored, unless `oneway:foot` |
| Reads `maxspeed` | only to go slower | only to go slower |

Walking and cycling are not motor vehicles with different numbers; three rules
change shape. A posted limit never makes anyone pedal harder, so the way class
decides the pace and `maxspeed` can only lower it. A one-way sign restrains
traffic, which a pedestrian is not and a cyclist often has a signed contraflow
out of. And the network itself differs: a footway or a path is the road here,
while a motorway is not part of it at all.

Steps are walkable at 2 km/h and not cyclable at all. Shared paths tagged as a
cycleway are walkable, because where walking is genuinely forbidden `foot=no`
says so.

A lorry is capped below the posted limit nearly everywhere, so `truck` caps
every speed rather than only bounding the A* heuristic: a truck graph reusing
car durations would give wrong arrival times on roads it is entitled to use.

`maxspeed` accepts plain km/h, `mph`, `km/h`, `kmh` and `knots`. Any value that
is not a number with an optional unit — `none`, `signals`, `variable`, or a
country code such as `PT:urban` — falls back to the highway class default
rather than to a country-specific table, and `walk` maps to 7 km/h. Speeds are
clamped to the profile range the A* heuristic assumes, so a mistagged
`maxspeed=400` cannot make the heuristic inadmissible.

```ts
import { carRoutingProfile, truckRoutingProfile } from "roadgraph-router";

carRoutingProfile.evaluateWay({ highway: "primary", maxspeed: "60 mph" });
// { forward: true, backward: true, forwardSpeedKph: 96.56, backwardSpeedKph: 96.56 }

truckRoutingProfile.evaluateWay({ highway: "motorway", maxheight: "4.2" });
// { ..., forwardSpeedKph: 90, forwardLimits: { heightMeters: 4.2 }, ... }
```

### Compiling for several vehicles

One bundle can serve several vehicles. Nearly nine tenths of a compiled tile —
geometry, node coordinates, topology and distances — is the same whichever
vehicle is routing, so it is stored once and each vehicle adds only its own
durations, access mask, restriction mask and limits.

```sh
roadgraph-compile portugal.osm.pbf --output portugal.efrb --profile car,truck,motorcycle
```

The extract is read once however many vehicles are asked for, and a reader
downloads the shared half of a tile plus the one vehicle it wants. On Portugal
that is 40.2 MB for three vehicles where three separate bundles would be about
114 MB, and switching vehicle mid-session costs about 2 MB rather than another
38.

A single vehicle with no physical limits still compiles to the one-chunk layout
it always has, byte for byte.

**Walking and cycling need their own bundle.** They use footways, paths, steps
and cycleways that a road graph correctly leaves out, so they are not another
column on the same network but a larger network. Compiled together, Portugal is
96.1 MB against 42.8 MB for the three motor vehicles — putting them in the same
file would have made every driver download the footpaths.

```sh
roadgraph-compile portugal.osm.pbf --output portugal-active.efrb --profile bicycle,pedestrian --max-memory-mb 3000
```

### Choosing a vehicle at runtime

```ts
const router = await RoadRouter.open("portugal.efrb");
router.profiles;            // ["car", "truck", "motorcycle"]
router.profile;             // "car"

const lorry = router.withProfile("truck");
await lorry.route(origin, destination);
```

`withProfile` reuses every shared chunk already downloaded, which is what makes
switching cheap.

### Lorry size and weight

A truck bundle carries the height, width, length and weight limits its roads
state, and the vehicle decides which roads are usable. Limits are quantised
downwards, so a stored limit never permits what the sign forbids, and roads
stating no limit stay open.

```ts
await RoadRouter.open("portugal.efrb", undefined, { profile: "truck", vehicle: "us-semi" });
await RoadRouter.open("portugal.efrb", undefined, { profile: "truck", vehicle: { preset: "articulated", heightMeters: 4.3 } });
await RoadRouter.open("portugal.efrb", undefined, { profile: "truck", vehicle: null }); // no filtering
```

| Preset | Height | Width | Length | Weight |
| --- | --- | --- | --- | --- |
| `van` | 2.6 m | 2.1 m | 6.0 m | 3.5 t |
| `rigid` | 3.8 m | 2.55 m | 10.0 m | 18 t |
| `articulated` *(default)* | 4.0 m | 2.55 m | 16.5 m | 40 t |
| `road-train` | 4.0 m | 2.55 m | 18.75 m | 44 t |
| `us-semi` | 4.11 m | 2.59 m | 22.0 m | 36.3 t |

A caller who says nothing still gets a vehicle, because refusing to route until
four dimensions are filled in is worse than routing for a stated default. The
resolved dimensions are on `router.vehicle`, so the default is visible rather
than hidden. The order is: whatever the caller passed, then whatever the bundle
was compiled to suggest with `--default-vehicle`, then `articulated`.

There is no globally neutral lorry — EU general circulation is 2.55 m wide,
16.5 m long and 40 t at no more than 4 m tall, while a US semi is wider and
taller but lighter — so `--default-vehicle us-semi` lets whoever compiles a
North American extract say so once, knowingly, instead of the library guessing
from the bounding box. A truck does not change shape when it crosses a border.

> **A truck route here is a route over roads not known to forbid the vehicle,
> which is weaker than a guarantee of legality or of physical fit.**
> `maxheight` is tagged on a minority of bridges worldwide and an untagged
> road is treated as open; time-dependent lorry bans, zone restrictions, axle
> load and hazardous goods rules are not read at all. See
> [What a route here does and does not mean](#what-a-route-here-does-and-does-not-mean)
> before relying on one of these routes for a heavy vehicle.

## Railways

Two more profiles route over mapped railway infrastructure rather than over
roads: `train` for conventional railway, and `metro` for metro and light rail.
They use the same compiler, the same A\*, the same bundle format and the same
`RoadRouter` as every road profile. What changes is which OSM tags decide
anything, because almost none of the road rules survive the move to a railway.

> **A railway route here is a path through mapped physical infrastructure. It
> does not establish that passenger services exist, that the track is
> currently operational, or that a real train is authorised or physically
> capable of using the calculated path.**
>
> This library reads OpenStreetMap and nothing else. It has no timetable, no
> GTFS feed, no signalling model, no knowledge of possessions, gradients,
> loading gauge, train length, axle load, braking curves or route knowledge.
> A reported duration is a line-speed estimate over mapped track, not a
> journey time; see [Speed on a railway](#speed-on-a-railway).

### Compiling a railway graph

```bash
roadgraph-compile portugal.osm.pbf --output portugal-rail.efrb --profile train
roadgraph-compile porto.osm.pbf    --output porto-metro.efrb  --profile metro
```

Railway data is kept out of road bundles and road data out of railway bundles.
A bundle holds one *network*: several road profiles, or several railway
profiles, never both. Asking for both is refused rather than quietly obeyed:

```bash
$ roadgraph-compile portugal.osm.pbf --output mixed.efrb --profile car,train
roadgraph-compile: --profile cannot mix road and railway profiles in one
bundle: they share no topology, and a combined bundle would make every road
user download the track. Compile them separately.
```

Two *railway* profiles can share one bundle, because they do share topology —
the same node coordinates, the same shared chunk, the same geometry table:

```bash
roadgraph-compile portugal.osm.pbf --output portugal-rail.efrb --profile train,metro
```

This stores the track once and adds a small per-profile chunk, exactly as
`--profile car,truck` does for roads. It does **not** join the two networks:
an edge belongs to one of them and is closed to the other by the profile's
access mask, so a train cannot run onto a metro line that happens to touch it.
On the Portugal extract the combined bundle holds 26,052 edges against the
23,273 and 2,777 of the two separate ones — 26,050. The two extra edges are
not duplication. At exactly two nodes in Portugal a light-rail way runs
through the *end* of a conventional rail way: compiled on its own, the metro's
node there is interior to a single way and is simplified away, and compiled
alongside the railway it is a junction between two ways, so the light-rail way
is split at it. The node counts match exactly either way (12,413). Nothing was
merged, and the access masks still keep a train off the light rail; the shared
topology is simply, and correctly, a little more detailed.

### Which track is included

Inclusion is an allowlist of `railway=` values, never a denylist. The key
carries dozens of values that are not track at all — `platform`, `station`,
`turntable`, `ventilation_shaft`, `workshop` — and a denylist would route
trains along station platforms the first time OpenStreetMap invented a new
value.

| `railway=` | `train` | `metro` | Why |
| --- | --- | --- | --- |
| `rail` | **yes** | no | Conventional railway. |
| `subway` | no | **yes** | Metro. |
| `light_rail` | no | **yes** | Also metro: Porto's system is tagged this way and Lisbon's is `subway`. |
| `narrow_gauge` | opt-in | no | Real infrastructure, but track a standard or Iberian-gauge train cannot use. |
| `tram` | no | opt-in | A tram shares the street with road traffic, which is a different thing to route over. |
| `funicular`, `monorail` | opt-in | opt-in | Not a general network. |
| `disused` | opt-in | opt-in | See below. |
| `abandoned`, `razed`, `dismantled`, `demolished`, `proposed` | **no** | **no** | Where a railway used to be, or might one day be. Not opt-in. |
| `construction` | **no** | **no** | Cannot yet carry anything. Not opt-in. |
| anything else | **no** | **no** | Not track. |

`disused` is the one genuinely arguable case, and it is **excluded by default
and available as an explicit opt-in**. The rails are still there and the
alignment is intact, but nothing has run over it, sometimes for decades, and
OSM does not say whether anything could. Including it silently would offer
routes over track whose usability nobody has asserted; refusing it outright
would be wrong for infrastructure analysis. So you ask for it:

```bash
roadgraph-compile portugal.osm.pbf --output rail.efrb --profile train \
  --railway-include disused,narrow_gauge
```

The inclusion set is a property of the compile, not of the bundle: it decides
what went in, and a bundle does not record which set was used. The compile
report beside the bundle (`portugal-rail.efrb.json`) does record it.

### Routing over it

The public API is the one you already have:

```ts
import { RoadRouter } from "roadgraph-router";

const router = await RoadRouter.open("portugal-rail.efrb", undefined, { profile: "train" });

const result = await router.route(
  { lat: 41.1496, lng: -8.5853 },  // Porto Campanhã
  { lat: 38.7139, lng: -9.1225 },  // Lisboa Santa Apolónia
  "shortest",
);
// 336.5 km along the Linha do Norte
```

```ts
const metro = await RoadRouter.open("porto-metro.efrb", undefined, { profile: "metro" });
const trip = await metro.route(trindade, matosinhos, "shortest"); // 11.1 km
```

There is no `RailRouter`. A railway bundle is a bundle, a railway profile is a
profile, and everything that already worked — snapping, alternative routes,
range-addressed tiles, browser decoding, `withProfile`, tile budgets — works
unchanged, because none of it ever knew what a road was.

### What the track says about itself, and what you can ask of it

These are the OSM keys a railway profile reads off a way:

| OSM key | Read as | Used for |
| --- | --- | --- |
| `railway` | class of track | whether the way is in the network at all |
| `oneway` | direction | `yes` / `-1` restrict a track to one direction |
| `access`, `train` | `no`, `private`, `military` close the track | whether the track is usable |
| `access:conditional`, `train:conditional` | a time-dependent closure | [routing at a time of day](#routing-at-a-time-of-day) |
| `maxspeed`, `maxspeed:forward`, `maxspeed:backward` | line speed in km/h | duration estimates |
| `gauge` | millimetres, `1000;1668` for dual gauge | the `gaugeMm` constraint |
| `electrified` | `no` / `contact_line` / `rail` / `yes` | the `requireElectrification` constraint |
| `voltage` | volts, tolerating the `750v` form | the `voltage` constraint |
| `frequency` | hertz; `0` is direct current | the `frequency` constraint |
| `usage` | `main`, `branch`, `industrial`, `military`, `tourism`, `freight` | default line speed, the `usage` constraint |
| `service` | `siding`, `yard`, `spur`, `crossover` | siding speed, the `excludeServiceTracks` constraint |

A train that cannot run on everything says so, either for the whole router or
for one route:

```ts
const router = await RoadRouter.open("portugal-rail.efrb", undefined, {
  profile: "train",
  railway: { gaugeMm: 1668, requireElectrification: true },
});

// ...or per route, which overrides the router's own:
const result = await router.route(origin, destination, "shortest", {
  railway: { gaugeMm: 1668, voltage: 25000, frequency: "50" },
});
```

| Option | Means |
| --- | --- |
| `gaugeMm` | the vehicle's gauge; a list for a dual-gauge or gauge-changing vehicle |
| `requireElectrification` | keep to track stated to be electrified |
| `voltage` | contact voltages the vehicle can take; a list for a multi-system vehicle |
| `frequency` | `"dc"`, `"16.7"`, `"25"`, `"50"`, `"60"`; a list for a multi-system vehicle |
| `excludeServiceTracks` | keep sidings, yards, spurs and crossovers out of the route |
| `usage` | only these usages |
| `strictUnknown` | treat an unstated attribute as incompatible rather than as unknown |

Constraints narrow the same access mask the vehicle and the departure time
narrow, so the search and the snapping agree: a track a constraint closes is
one no route can start on, finish on, or pass along.

### The policy for a tag that is not there

**A constraint excludes a track only where the track's own tags contradict
it.** Track that says nothing about the attribute being constrained stays
usable.

This is a deliberate choice and it cuts both ways. OpenStreetMap silence is an
absence of survey, not a statement of incompatibility, and excluding every
unstated track would reduce most networks to nothing. But a route over
unstated track is not evidence of anything either, and this library never
reports it as though it were:

- **Every railway route carries the answer on the result itself**, as
  `result.railway`. It reports how many metres ran on track that stated every
  constrained attribute, how many ran on track that did not, which attributes
  were missing, how far the route ran over service track, and every distinct
  gauge it crossed — including a gauge *change* mid-route, which no constraint
  was asked to catch.

  ```ts
  const result = await router.route(porto, lisboa, "shortest");
  result.railway;
  // { statedMeters: 336_792, unstatedMeters: 0, unstated: [],
  //   serviceTrackMeters: 9_349, gauges: [1668] }
  ```

  A road route has no `railway` field at all, and a *railway* route always has
  one — including a route over track that states nothing, which reports itself
  as entirely unstated. The absence of the field means one thing only: this
  was not a route over track. (`railwayCertainty(graph, edgeIds, constraints)`
  is the same calculation, for the low-level `route(graph, …)` API.)
- `strictUnknown: true` reverses the default and excludes unstated track. It
  will refuse routes over track nobody has surveyed, which on many networks is
  a great deal of it. It is the right setting when a route that might not be
  runnable is worse than no route at all. It holds for a whole graph as well
  as for one track: a railway bundle whose tracks describe nothing is closed
  entirely rather than quietly accepted.

One exception, because OSM defines it that way: an absent `service` tag means
a running line, not an unsurveyed one.

A stated fact always outranks strictness. On the Porto–Lisboa corridor,
`{ gaugeMm: 1668, requireElectrification: true, strictUnknown: true }` returns
the same 336.5 km route as without `strictUnknown`, because every way along
the Linha do Norte really does state its gauge and its electrification.

### Speed on a railway

**A railway duration from this library is a line-speed estimate over mapped
infrastructure. It is not a timetable, and it is not a journey time.**

Where a way carries `maxspeed`, that is used. Where it does not, the speed
comes from what the line is for — not from a single global guess:

| Situation | Assumed km/h |
| --- | --- |
| `service=siding`, `yard`, `spur`, `crossover` | 25 |
| `usage=main` | 100 |
| `usage=branch`, `freight` | 80 |
| `usage=industrial`, `military`, `tourism` | 40 |
| `railway=rail`, nothing else stated | 100 |
| `railway=subway` | 60 |
| `railway=light_rail` | 50 |
| `railway=tram` | 30 |
| `railway=disused` (opt-in) | 25 |

These are engineering-plausible speeds for the class of infrastructure. They
ignore every reason a real train is slower: station dwell time, acceleration
and braking, signalling headway, speed restrictions, pathing and crossing
delays. Porto–Lisboa comes back as an estimated 2 h 28 m against a real Alfa
Pendular timetable of about 2 h 45 m; Metro do Porto's Linha A comes back as
19 minutes against a timetabled 25. **Treat the gap as the floor of the error,
not the size of it.**

Sidings are the one place the speed table does routing work rather than
reporting: a yard that looked as quick as the main line would be chosen as a
shortcut through a station. At 25 km/h it is not, which is what keeps sidings
out of ordinary routes without removing track that genuinely connects things.

### Topology: what connects to what

Connectivity on a railway comes from one thing and one thing only: **two ways
share an OSM node.** That is the compiler's existing rule and it is already
the right one, so no railway-specific topology code was added.

What follows from it, and what is covered by tests that run the real compiler
over real PBF files:

- Two tracks that meet at a shared node are joined.
- Two tracks that cross on the map without sharing a node are **not** joined.
  On the ground that is a flyover, a tunnel, or two lines that simply do not
  meet.
- A bridge and the line beneath it are not joined, and neither are a tunnel
  and the line above it.
- Parallel tracks stay separate for their whole length, however close, until a
  mapped crossover joins them.
- A dead-end spur is routable to its end and not beyond.
- Disconnected networks report `NO_ROUTE` rather than being bridged.
- No switch or junction is ever invented. If OSM does not have it, neither
  does the graph.

OpenStreetMap does not describe railway junctions with turn-restriction
relations, so a railway profile requests none and obeys none, and barrier
nodes are not read either — a bollard is not a thing that happens to a
railway, and reading the road barrier table for a train would let a gate
across a footpath cut a main line.

In the whole Portugal extract, exactly **4 nodes** are shared between two
different classes of railway (2 `rail`+`tram`, 2 `rail`+`light_rail`), and
**0 nodes** are places where `railway=rail` changes gauge. The networks really
are separate in the data; the access mask keeps them separate in the bundle.

### Direction

`oneway=yes` and `oneway=-1` restrict a track to one direction. Nothing else
does. In the Portugal extract 906 of the 1,139 Metro do Porto `light_rail`
ways carry `oneway=yes`, so assuming bidirectional running would route trains
the wrong way down most of that network.

`railway:preferred_direction` is **not** read. It describes which way trains
are normally run, not which way the track permits, and treating it as a ban
would invent a restriction OpenStreetMap never stated.

### Known limitations

- No timetable, service pattern, operator, platform or station model. This
  routes track, not trains.
- No signalling, block, headway, gradient, curve, loading gauge, train length,
  axle load or traction model.
- No electrification *section* model: a neutral section or a system changeover
  part-way along a way is not represented, because OSM tags the way, not the
  point.
- A route may cross a gauge change where two different-gauge tracks share a
  node, unless a `gaugeMm` constraint is given. `railwayCertainty` reports
  every gauge a route crossed, so this is visible rather than silent. It does
  not occur in the Portugal extract.
- Turn restrictions and barriers are not modelled on a railway at all.
- A bundle does not record which `--railway-include` set it was compiled with.
- `train` and `metro` are intentionally coarse. A system tagged in some other
  way needs `--railway-include`, and the profiles will not guess.

## Routing at a time of day

Some roads are only closed at certain hours. A street may be shut to lorries
overnight, a square pedestrianised on Sundays, a bridge limited by weight in
one season. OpenStreetMap writes these as `*:conditional` tags, and this
library reads them when — and only when — you say when the journey starts.

```js
const router = await RoadRouter.open("portugal.efrb");

const route = await router.route(origin, destination, "fastest", {
  departAt: new Date("2026-10-15T08:00:00"),
});

const alternatives = await router.routeAlternatives(origin, destination, "fastest", {
  count: 3,
  maxStretch: 1.4,
  maxSharing: 0.75,
});
```

Both work the same way in Node and in a browser: the only difference is that
a browser needs `fetch` and `DecompressionStream`, which it has.

`departAt` is in the **local time of the roads being travelled**. This library
does not convert time zones and does not consult a clock: a `Date` is read for
its weekday, hour, minute and month as your runtime reports them, so a caller
routing in a region other than its own must do the conversion first. You can
pass the parts directly instead of a `Date`:

```js
// Monday, 08:00, in March.
await router.route(from, to, "fastest", {
  departAt: { weekday: 0, minutes: 8 * 60, month: 3 },
});
```

A restriction is written in the local time of the road it is on. Where the
roads and the code are in different places, name the zone:

```js
await router.route(from, to, "fastest", {
  departAt: new Date("2026-10-15T08:00:00Z"),
  timeZone: "Europe/Lisbon",
});
```

Public holidays are a calendar this library does not carry, so a rule written
`no @ (PH)` applies only if you say the day is one:

```js
await router.route(from, to, "fastest", { departAt, publicHoliday: true });
```

### What is read

Every bundle carries them, whether it holds one vehicle or several: a
one-vehicle bundle keeps them in its single chunk, and a multi-vehicle bundle
in the per-vehicle half of each tile, since the same road can be shut to a
lorry and open to a car.

A `value @ condition` list is read from the way's access tags — `access`,
`vehicle`, `motor_vehicle` and the profile's own key, such as `hgv` — and from
`maxspeed`. Where several rules match the same moment, the **last** one wins,
which is what OpenStreetMap specifies and why the tagging convention is
general first and specific last.

Conditions resting on time of day, weekday, month and the vehicle's own
dimensions are answered. `no @ (Mo-Fr 07:00-19:00)`,
`no @ (22:00-06:00)`, `no @ (Nov-Feb)` and `no @ (weight>7.5)` all work, as do
several windows in one rule and conditions combined with `AND`.

An access rule evaluating to `no`, `private`, `destination` or a permit-style
value closes the road. `destination` counts as closed because this library has
no notion of a journey's purpose, and treating "only if you live here" as open
would route strangers down a residents' street.

A conditional `maxspeed` slows the edges it applies to, and the route reports
the slower duration rather than the one it was planned against. A conditional
limit can only **slow** a road, never speed it up: the search's bound is built
from the profile's ceiling, and an edge quicker than the graph says would
break the guarantee that the route found is the best one.

### What is not

- **Nothing happens without `departAt`.** Leaving it out ignores conditional
  restrictions entirely, which is how this library behaved before it could
  read them.
- **Only closures are applied.** A road the plain tags already forbid stays
  forbidden even where a conditional value would open it, because the compiled
  mask has already dropped it. This errs towards refusing a road that is in
  fact usable, which is the direction this library errs in everywhere else.
- **One moment, not an arrival time per edge.** This is the limitation to
  understand before relying on any of it. Every road on the route is judged by
  the moment the journey *starts*, not by when it would be reached. Leave
  Lisbon at 07:00 on a six-hour drive and the roads near Porto are judged at
  07:00, though you would arrive at one in the afternoon. A restriction that
  lifts at 10:00 therefore still closes a road you would reach at noon, and
  one that begins at 10:00 is missed entirely.

  Doing better means a time-dependent shortest path, where each edge is
  evaluated at the arrival time the search has accumulated. That changes the
  cost function, the A* bound and the corridor logic together, and it is a
  piece of work in its own right rather than something to bolt on. It is not
  in this release, and **this engine should not be described as doing
  time-dependent routing**: it applies a departure time, which is a weaker
  thing. The gap matters most on long journeys and least on urban ones, where
  the whole route is driven inside the hour it began.
- **Conditions only you can answer wait for you to answer them.** Whether it
  is raining, who is driving and what the journey is for are not things a
  compiled graph knows. Tell it, and the rules resting on them apply:

  ```js
  await router.route(from, to, "fastest", {
    departAt,
    circumstances: { conditions: ["wet"], purposes: ["delivery"] },
  });
  ```

  Unanswered, such a rule never holds, so a road shut `@ (wet)` stays open
  until someone says it is wet. A stay duration is still not read at all. A rule resting on one — `80 @ (wet)` — is parsed, counted and then
  ignored, leaving the road open. `unreadableConditions` reports how many of a
  tag's rules fell into this.
- **Turn restriction relations are not conditional.** See the list in
  [What a route here does and does not mean](#what-a-route-here-does-and-does-not-mean).

### Everything a route can be told

| Option | Meaning |
| --- | --- |
| `departAt` | When the journey starts, as a `Date` or as `{ weekday, minutes, month, dayOfMonth }`. Without it, conditional restrictions are ignored. |
| `timeZone` | The IANA zone the roads are in, such as `"Europe/Lisbon"`. Without it a `Date` is read as this machine reads it. |
| `publicHoliday` | Whether that day is one where the roads are. |
| `circumstances` | What the map cannot know: `{ conditions, userGroups, purposes }`. |
| `avoid` | Circles of road that are shut, as `{ lat, lng, radiusMeters }`. |
| `vehicle` | The lorry being routed, where the graph states physical limits. |
| `finishOnANearbyRoad` | `false` to be refused outright when the point cannot be reached. |

```js
const route = await router.route(origin, destination, "fastest", {
  departAt: new Date("2026-10-15T08:00:00Z"),
  timeZone: "Europe/Lisbon",
  circumstances: { conditions: ["wet"] },
  avoid: [{ lat: 38.7223, lng: -9.1393, radiusMeters: 150 }],
});
```

## More than one way there

`routeAlternatives` returns several routes, best first, for offering a choice
rather than a single answer.

```js
const routes = await router.routeAlternatives(from, to, "fastest", { count: 3 });
// routes[0] is exactly what route() would have returned.
```

The method is the straightforward one: find the best route, make the roads it
used dearer to the search than they really are, and search again. A road that
is the only sensible way through survives the penalty and is used again; one
that was merely convenient gives way to its neighbour. **The penalty never
reaches the answer** — every route is reported at the graph's own cost, so an
alternative's distance and duration are what it would really take.

Candidates are filtered rather than trusted. One that is much worse than the
best, or that is mostly the same road, is not an alternative anybody wants:

Each is checked rather than trusted: a `count` that is not a whole number
between 1 and 10, a `maxStretch` below 1, a `maxSharing` outside nought to
one, or a `penaltyFactor` below 1 raises a `RangeError` rather than searching
forever or returning something arbitrary.

| Option | Default | Meaning |
| --- | --- | --- |
| `count` | 3 | How many routes to return at most, the best one included. |
| `maxStretch` | 1.4 | How much worse than the best an alternative may be. |
| `maxSharing` | 0.75 | How much of the routes already offered it may reuse, by distance. |
| `penaltyFactor` | 2 | How much dearer a road already used is made to look. |
| `searchWiderCorridor` | `true` | Whether to fetch the wider corridor an alternative might lie in. `false` keeps the download to what one route needed. |

Routes come back in the order they would be driven: the best first, then the
rest by what they really cost. The penalties steer the search and never reach
the figures, so an alternative's distance and duration are its own.

Two routes count as the same road where they travel the same tarmac, measured
by distance travelled rather than by edges in common. A road driven in the
opposite direction is the same road. Two roads that merely join the same pair
of junctions are not: a slip road beside the road it leaves, or a lane round
the far side of a square, is a genuine second way there, and the compiled
graph holds a great many of them — 12,015 such pairs in the Porto to Lisbon
corridor alone. A junction two routes pass through costs no distance and so
does not make them similar. The roads a route only part-drives at its two
ends count for exactly what it drives of them, which
`RouteSnap.travelledMeters` reports.

**Fewer routes than you asked for is the normal answer.** A road network
usually has one obvious way through, and returning a second route that is
three-quarters the same road, or an hour longer, would be worse than
returning one. `routeAlternatives` always returns at least the best route, and
raises whatever `route` would raise when there is none.

Alternatives cost roughly one search each. Measured on the Portugal bundle,
Porto to Lisbon returned three routes — 312.0 km, 319.0 km and 350.5 km — in
3.4 s against 2.5 s for the single route, downloading 3.0 MB more than the
29.2 MB the first route needed. A short urban route in Lisbon returned two in
79 ms with nothing further to download.

Over a bundle this deliberately downloads a wider corridor than one route
needs: an alternative may be worse than the best by as much as `maxStretch`,
and the tiles holding it lie outside the corridor that proved the best route.

Everything a single route obeys, these obey: access, turn restrictions,
barriers, a lorry's dimensions, and conditional restrictions when you pass a
departure time.

## Roads you know are shut

A bundle is as current as the extract it was compiled from. Roadworks, an
incident, a street closed for a market: none of them is in it, and none of
them can be. What a caller reading a feed of such things can do is say so:

```js
const route = await router.route(from, to, "fastest", {
  avoid: [{ lat: 38.7223, lng: -9.1393, radiusMeters: 150 }],
});
```

Anything a circle touches is closed to the search and to snapping, so a route
neither drives through a closure nor starts in the middle of one. It outranks
whatever the map says about the road being open, it applies to every
alternative, and it lasts only for that call — the graph is left as it was.

An area rather than a road, because a feed gives a place and a radius, not an
edge number. Only the roads near each circle are looked at, so closing a
junction costs the same whether the graph holds a town or a country.

## Turn restrictions

The compiler reads OSM `type=restriction` relations and the routing graph
enforces them. `no_left_turn`, `no_right_turn`, `no_straight_on`, `no_u_turn`,
`no_entry` and `no_exit` become banned turns directly; `only_left_turn`,
`only_right_turn`, `only_straight_on` and `only_u_turn` are expanded at compile
time into bans on every other exit from the via node, including the u-turn back
along the approach. `restriction:motorcar`, `restriction:motor_vehicle` and
`restriction:vehicle` override the generic `restriction` key, and a relation
whose `except` list names a car mode is ignored.

A restriction is stored as an ordered pair of directed edges: having arrived
along edge *f*, a vehicle may not leave along edge *t*. When a graph carries
restrictions, `route()` switches from node-labelled to edge-labelled A*, whose
search state is "arrived at this node along this edge" — the smallest state that
can express a banned turn. A* therefore cannot return a route that violates one;
it detours, and will re-approach the same junction from a permitted arm if that
is the only way through. Graphs without restrictions keep the cheaper
node-labelled search.

Restrictions whose `via` is a **way** rather than a node ban a whole run of
edges, which a single pair cannot express. They are stored as banned
*sequences*: a run of three or more directed edges that may not be driven one
after another. The search carries the partial match along only while a run is
actually being driven, so the ordinary case still costs one array slot per
edge, and the ban applies to the whole run rather than to any pair inside it —
driving the link is still allowed, only continuing off it is not.

A `via`-way run is enforced against the path actually taken, not against an
approximation. In a Portugal extract they are 541 runs against 33,796 pairs,
and they add 5 KB to a 71 MB bundle.

### When the nearest road is the wrong road

Snapping finds the nearest road, and near a disconnected stub — a path behind a
fence, a service road in a compound, a stretch clipped at the edge of a tile —
that is the stub. A route to a point beside one used to fail although a usable
road was a few metres further.

A failed route is now tried once more. The two ends are compared, and if they
sit in different pieces of the network, the end in the smaller piece is snapped
again, this time only to roads joined to the other end. Labelling the network
costs a pass over it, so it runs only after a failure and an ordinary route
never pays for it.

It bites hardest on walking and cycling, where small fragments are common: in
Monaco the pedestrian network is 97.6% one piece, and the remaining 2.4% is
enough to lose a route between two points a kilometre apart.

### When the nearest road cannot be reached

The road nearest a point is not always one the rest of the network can get to.
A pocket of one-way streets behind banned turns can be driven out of but never
into; an island of service roads around a terminal joins nothing at all. Asked
for a point on one of those, this library used to report no route.

It now finishes on a road a little further off, trying the nearest few in turn
and taking the first that works. `destinationSnap.distanceMeters` says how far
short of the point it finished, and `originSnap.distanceMeters` the same for
the start:

```js
const route = await router.route(from, to);
if (route.destinationSnap.distanceMeters > 100) {
  // Finished on the nearest road it could reach, not at the point asked for.
}
```

This only happens after a route has already failed, so a reachable road
nearest the point is still always the one used. To be told plainly that a
point cannot be reached, turn it off:

```js
await router.route(from, to, "fastest", { finishOnANearbyRoad: false });
```

Evora's walled centre is the case this was found on: `no_left_turn` and
`no_right_turn` relations on Rua de Serpa Pinto seal the only entry to a
street, so OpenStreetMap says no car may legally enter it. Routing Lisbon to a
point in that street now finishes 23 m away on the nearest road a car can
reach, rather than reporting no route across 133 km of motorway.

## Snapping to the road, not to the junction

Topology simplification keeps only junctions and way endpoints as routing
nodes, so on a rural road the nearest node can be more than a kilometre away.
Snapping to nodes therefore fails on roads that are plainly there: measured on
a compiled Portugal bundle, **3.9% of points lying exactly on a routable road
in the Arouca region could not snap within 500 m** (p99 704 m, max 1,140 m),
while Lisbon never failed.

`route()` snaps to the nearest *road* instead, projecting the coordinate onto
edge geometry that the bundle already stores. The same measurement after the
change is **0.0% in both regions**. A point that lands within a metre of an
endpoint is still reported as that node, so routing between exact node
coordinates is unchanged.

Starting part-way along a road is not a special case for the search: the
edge-labelled A* state is already "arrived at this node along edge *e*", which
is exactly what a mid-edge start provides. One-ways therefore work for free —
a mid-road start may only set off in a direction the graph allows — and a turn
restriction applies to the first turn after the start and the last turn before
the finish.

`RouteResult` carries `originSnap` and `destinationSnap` describing where each
coordinate met the network and how far away it was. Route geometry begins and
ends at those snapped points rather than at a junction, so `distanceMeters`
includes the partial first and last edges. Those partial edges are deliberately
absent from `edgeIds`, which lists only whole hops between two nodes.

The edge index this needs is built on first use and cached per graph, not at
decode, so loading a graph costs nothing extra and repeated routes amortise it:

| | |
| --- | --- |
| First route on a freshly loaded tile | 102 ms |
| Each route after that, same tile | 7–13 ms |

## Choosing which tiles to load

A route is not confined to the rectangle between its endpoints: the quickest
road often bulges well outside it. Rather than loading that rectangle plus a
ring of neighbours — a rule that changes meaning when a region is recompiled at
a different tile size — the router asks a geometric question.

Any route passing through a tile is at least
`distance(origin, tile) + distance(tile, destination)` long. Compare that
against the route already found and a tile either could hold something better,
or provably could not and is never downloaded. The test is a ground distance,
so the set of tiles considered does not depend on how the bundle was cut. On a
Portugal extract, 120 km and 40 km tilings now return the identical
Braga–Évora route (460.16 km / 244.3 min) where they previously disagreed by
22 minutes.

The confirmation pass carries the cost of the route already found, so it
abandons anything no better almost immediately and is much cheaper than the
first search.

This is insurance, and on a long route it is not free: see the measurements
below. `maxDetourFactor` caps how far off the straight line the search will
reach, as a multiple of the direct distance, trading the guarantee for a
smaller download while staying independent of tile size:

```ts
const router = await RoadRouter.open("/routing/region.efrb", undefined, { maxDetourFactor: 1.15 });
```

## Compile any region

The package includes a Node 22.5+ streaming PBF compiler. It discovers bounds,
partitions the extract automatically, preserves one-way edges, and emits an
EFRB bundle that can be opened by `RoadRouter`. No country, region name, or
fixed grid is built into the command:

```sh
roadgraph-compile input.osm.pbf --output region.efrb \
  --profile car --tile-size-km 120 --compression gzip
```

Use `--padding-km` to tune cross-tile overlap (2 km by default; the router
picks neighbouring tiles by ground distance, so a large overlap is no longer
needed and mostly duplicated data), `--shape-tolerance-m` to simplify
display-only shape points, and `--bbox minLon,minLat,maxLon,maxLat` to compile a
smaller area from a larger extract. Compilation uses two PBF passes regardless
of tile count: one global topology/way pass and one pass for referenced node
coordinates. The compiler writes a `region.efrb.json` report with input size,
global OSM-road counts, routing-node reduction, edges, bundle size, peak RSS,
PBF passes, and elapsed time.

To keep compiler RAM bounded for country extracts, referenced coordinates are
stored in a temporary on-disk SQLite index and deleted once the bundle is
written. Global ID tracking uses conservative bounded Bloom filters, so the reported
`relevantOsmNodes` is a conservative Bloom-filter estimate (`relevantOsmNodesExact`
is `false`). Routing ways, output topology nodes, and edges are counted exactly.

The first importer targets `.osm.pbf`, because PBF supports country-scale
streaming. Convert XML `.osm` extracts to PBF before compiling; this avoids
loading a whole XML document into memory. The runtime format is unchanged:
EFR2 chunks inside EFRB.

## Using it in a browser

The routing engine has no Node built-ins in it. Bundled for the browser it is
19.7 kB gzipped on its own, or 24.5 kB for everything this package exports,
and it needs only `fetch` and `DecompressionStream`:

```ts
import { RoadRouter } from "roadgraph-router";

// Served as application/octet-stream, without whole-file content encoding,
// so the byte offsets in the bundle directory stay valid.
const router = await RoadRouter.open("/routing/region.efrb");
const result = await router.route(origin, destination);
```

Routing a long distance merges a lot of tiles, so run it off the main thread
when the region is large:

```ts
import RoutingWorker from "roadgraph-router/worker?worker";
```

The `roadgraph-compile` CLI is Node-only and is never imported by the browser
entry point, so bundlers do not pull it in.

### Coordinates in a shared chunk

Nodes are numbered with locality, so each sits close to the one before. A
shared chunk writes the difference rather than the coordinate, which costs a
few bytes where the coordinate itself costs eight, and takes 6% off a
multi-vehicle bundle with nothing lost — the coordinates come back exactly.

The single-chunk layout a car bundle still uses is untouched, so a bundle
compiled for one vehicle stays byte-comparable and a 0.1.0 reader still opens
it.

## How a chunk is stored

EFR2 v6 keeps the same graph as earlier versions but writes it far more
tightly. Every choice below was measured on a compiled Portugal extract rather
than assumed, by profiling which sections of a chunk actually cost bytes:

- **Shared geometry.** A two-way road used to store its shape twice, once per
  direction. 47.1% of all shape points were a mirror of the opposite
  direction's, so each road's geometry is now stored once and mirrored back
  when the reverse edge is read.
- **Differences instead of positions.** Shape points are written as a step from
  the previous point, and an edge's target as a step from its own source node.
- **Variable-length integers.** Those steps are small, so they take one or two
  bytes instead of four.
- **Degrees instead of offsets.** The per-node edge offsets are a running total
  rebuilt on load, so only each node's edge count is stored.

Together these cut the uncompressed chunk by 46% and the gzipped bundle by 35%,
with the decoded graph identical in every array. Decoding costs one pass of
varint reads, which is more than paid back by having less to decompress: graph
load time went down, not up.

`encodeCompactGraph(graph, { layout: "legacy" })` still writes the older v2-v5
layout, and every version from EFRT v1 onwards still decodes.

## Graph formats

The package reads the original EFRT v1 format and compact EFR2 v2/v3/v4 chunks.
EFR2 stores latitude/longitude as fixed-point `Int32` values and edge weights as
scaled `Uint16` values. EFR2 v3 adds an optional compact intermediate-geometry
stream per edge, so the routing topology can omit road-shape nodes without
turning returned GeoJSON routes into straight lines. EFR2 v4 appends two
parallel `Uint32` arrays of banned directed-edge pairs, costing eight bytes per
restriction and nothing at all for a tile that has none. Existing v1, v2 and v3
data remain supported, and a chunk is written at the lowest version that can
represent it.

A v7 profile chunk can carry one more section: **what the track is**, for a
railway profile. It is shaped the other way round from the sparse limit and
condition tables beside it, because nearly every railway edge states something
and a whole line states the same thing. So it is a dictionary of the distinct
combinations that occur — gauge, second gauge, voltage, electrification,
frequency, usage, service — plus one 16-bit row index per edge. Row 0 always
states nothing.

Gauge, voltage and frequency each keep a *second* stated value, because a
dual-gauge or changeover track really does state two and a train matching
either can run over it: `gauge=1000;1668` is on Portuguese track and
`frequency=0;16.7` on 176 Swiss ways.

All of Portugal's `railway=rail` network collapses onto **20 distinct rows**
across 25,569 directed edges, and all of its metro onto 11. The whole section
costs 2.08 bytes per edge raw and **0.31 bytes per edge gzipped** — 7.9 kB for
every railway edge in Portugal. The row count lives in four header bytes that
were zero in every chunk written before, so a road chunk is unchanged.

For fast snapping, add a local index after loading a graph:

```ts
import { withSpatialIndex } from "roadgraph-router";

const indexedGraph = withSpatialIndex(graph);
```

The spatial index is built locally after a chunk has been loaded, avoiding a
full graph scan when snapping a coordinate to the road network.

## Range-addressable bundles

`encodeRoadGraphBundle()` creates a single `.efrb` file with a fixed-size
directory followed by independently readable EFR2 tile chunks. Opening an
`.efrb` URL downloads its 32-byte header and directory first, then requests
only the route-relevant tile byte ranges:

```ts
const router = await RoadRouter.open("/routing/region.efrb");
```

Serve bundles as `application/octet-stream` without whole-file HTTP content
encoding so byte offsets remain stable. The bundle reader already supports
individually gzip-compressed chunks; use
`encodeCompressedRoadGraphBundle()` when creating one in a browser-compatible
runtime. Spatial indexes are runtime structures for now, rather than part of
the on-disk format.

`roadgraph-compile` starts its worker with a 2 GB heap ceiling by default and
checks RSS during every compiler stage. Use `--max-memory-mb` to set a lower
ceiling; values above 3072 are intentionally rejected.

## Measured on a real extract

Portugal from Geofabrik (`portugal-latest.osm.pbf`, 425 MB) compiled on one
desktop machine with default settings. "Before" is the same pipeline prior to
the v6 storage layout and the smaller tile overlap:

| | Before | Now | |
| --- | --- | --- | --- |
| PBF passes | 2 | 2 | unchanged |
| Compile time | 8 min 04 s | 7 min 46 s | −4% |
| Peak RSS | 1.80 GB | **1.11 GB** | −38% |
| Uncompressed graph | 114.85 MB | **51.17 MB** | −55% |
| Final EFRB | 71.23 MB | **38.03 MB** | −47% |
| Compression ratio | 0.620 | 0.743 | denser input compresses less |
| Routing edges | 2,757,265 | 2,757,265 | identical graph |
| Banned turn pairs / runs | 33,796 / 541 | 28,344 / 468 | fewer duplicate copies across tiles |

Routes from that bundle, each measured against a fresh reader:

| Route | Tiles | Range bytes | Graph load | A* | Distance | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| Short urban (Lisbon) | 1 | **4.93 MB** | 118 ms | 86 ms | 5.37 km | 5.9 min |
| Medium regional (Lisbon–Setúbal) | 2 | **5.00 MB** | 340 ms | 152 ms | 48.41 km | 32.4 min |
| Long distance (Porto–Faro) | 15 | **36.41 MB** | 1.99 s | 1.47 s | 553.20 km | 284.8 min |
| Cross-tile (Braga–Évora) | 15 | **36.41 MB** | 2.09 s | 1.35 s | 460.16 km | 244.3 min |

Downloads are roughly 35% smaller for short routes and 47% smaller for long
ones, and graph load is *faster* than before despite the varint decoding,
because there is less to decompress.

### What conditional restrictions cost, and what they catch

Portugal compiled for car, truck and motorcycle, before and after the
restrictions were read:

Both compiled back to back on the same machine, so the two columns are
comparable:

| | 0.2.0 compiler | 0.3.0 compiler | |
| --- | --- | --- | --- |
| Final EFRB | 40.17 MB | **40.18 MB** | +14.8 kB, or +0.04% |
| Compile time | 8 min 01 s | 8 min 05 s | +1% |
| Peak RSS | 1.35 GB | 1.52 GB | +0.17 GB, holding the tag text |
| Routing edges | 2,760,171 | 2,760,171 | identical graph |
| Edges with a conditional restriction | 0 | **3,328** | |

Compiled for a car alone, where the whole graph is one chunk, the same extract
grows by 4,187 bytes — 38,037,856 to 38,042,043 — for 1,087 restrictions.

A region whose roads carry no conditional restriction compiles to the same
file as before, byte for byte, in either layout: Monaco for a car is 26,177
bytes from either compiler.

Asking for a departure time costs nothing measurable. Routing Porto to Lisbon
by car, three runs each: 2,294 ms cold and 208 ms repeated without one,
2,252 ms and 206 ms with one — a difference smaller than the spread between
runs.

The **Ponte 25 de Abril**, the bridge carrying the A2 into Lisbon, is tagged
`hgv:conditional = no @ (05:00-02:00)`: lorries may use it for three hours a
night. Routing Almada to Lisbon across it:

| Vehicle | Departure | Distance | Duration | Crossing |
| --- | --- | --- | --- | --- |
| Car | any hour | 12.2 km | 12 min | Ponte 25 de Abril |
| Truck | none given | 13.0 km | 14 min | Ponte 25 de Abril |
| Truck | 10:00 | **63.4 km** | **51 min** | Ponte Vasco da Gama |
| Truck | 03:00 | 13.0 km | 14 min | Ponte 25 de Abril |

The lorry without a departure time takes a bridge it is banned from for
twenty-one hours of the day. That is the gap this reads, and the 51-minute
detour is what obeying the sign actually costs.

Of Portugal's conditional values, the ones this library cannot answer are
left alone rather than guessed at. 555 trunk and primary roads carry
`maxspeed:conditional` values such as `90 @ sun`, which is not a condition
OpenStreetMap defines; they keep their posted limit.

### Against the earlier versions

0.1.0, 0.2.0 and this release reading the same file — the car bundle 0.1.0
published, 38.03 MB — so the comparison is of the engines rather than of
formats that changed alongside them. Cold is a fresh reader; repeated is the
same route asked for twice.

| Journey | 0.1.0 | 0.2.0 | 0.3.0 |
| --- | --- | --- | --- |
| Opening the bundle | 1 ms | 1 ms | 1 ms |
| Lisbon, across town | 245 / 14 ms | 289 / 8 ms | 290 / 9 ms |
| Bragança, rural | 269 / 140 ms | 251 / 4 ms | 281 / 3 ms |
| Porto to Lisbon | 2,715 / 2,104 ms | 1,991 / 281 ms | 1,976 / 284 ms |
| Porto to Faro | 3,653 / 3,258 ms | 2,253 / 427 ms | 2,244 / 416 ms |
| Braga to Évora | no route | no route | 6,176 / 3,166 ms |

Every version that can read a bundle finds the same roads: 312.02 km from
Porto to Lisbon and 553.20 km from Porto to Faro, on all three.

0.2.0 is where the long routes improved, and the gain is almost entirely in
asking twice: the corridor it has already stitched is kept, so a repeated
Porto–Faro route went from 3.3 s to 0.4 s. **0.3.0 routes at the same speed as
0.2.0** — the differences above are smaller than the spread between runs of
the same binary.

Braga to Évora is the exception, and it is not a slowdown: both earlier
versions spent their time failing. 0.2.0 widened its corridor to the whole
country over 7.9 s before reporting no route; 0.3.0 finishes on the nearest
road it can reach in 2.3 s. A point genuinely off the network still fails
about as fast as it always did, 810 ms against 866 ms.

### What each version can read

| | 0.1.0 bundle | 0.2.0 bundle | 0.3.0 bundle | 0.4.0 road bundle | 0.4.0 railway bundle |
| --- | --- | --- | --- | --- | --- |
| 0.1.0 | yes | no | no | no | no |
| 0.2.0 | yes | yes | no | no | no |
| 0.3.0 | yes | yes | yes | **yes** | no |
| 0.4.0 | yes | yes | yes | yes | yes |

A 0.2.0 reader opens a 0.3.0 bundle and then fails on the first tile whose
roads carry a conditional restriction — the chunk is longer than it expects.
A bundle without any reads as before.

**0.4.0 changes nothing about a road bundle.** A road bundle compiled by
0.4.0 is byte for byte the file 0.3.0 wrote, and a 0.3.0 reader opens it: the
railway table lives in four header bytes of the profile chunk that no chunk
had ever written, and a road chunk leaves them zero. This is pinned by a test
that holds the hashes 0.3.0 produced for all five chunk layouts.

A 0.3.0 reader handed a *railway* bundle refuses it by name, rather than
routing with the wrong rules:

```
This routing bundle was compiled for a profile this build does not support (id 6).
```

### What the package costs

| | 0.1.0 | 0.2.0 | 0.3.0 | 0.4.0 |
| --- | --- | --- | --- | --- |
| Tarball | 46.4 kB | 75.9 kB | 91.0 kB | 128.7 kB |
| Unpacked | 182.8 kB | 289.3 kB | 342.1 kB | 453.7 kB |
| Bundled for a browser, gzipped | 13.6 kB | 21.1 kB | 24.8 kB | **31.0 kB** |

Railways cost a road-only application about **3.5 kB gzipped** that it will
not use, measured as the whole public surface bundled with esbuild: 27.5 kB
before, 31.0 kB after. It is not zero and it is not tree-shakeable, because
`routingProfiles` is a registry that names every profile, and the constraint
module is reached from `route()` itself. Hiding it behind a dynamic import
would make profile lookup asynchronous, which is a worse trade than 3.4 kB.
Runtime dependencies are unchanged: still the one, and only for the compiler.

### Nothing routes differently

`tools/compare-bundles.mjs` routes the same random pairs through two bundles
and reports any disagreement. Comparing the previous bundle against this one
over 145 routes drawn from real node positions in the densest tile:

```
routes_compared 145   identical_duration 145   differing 0   worst_duration_drift 0.0000%
```

`scripts/validate-bundle.mjs` separately confirms that none of 300 sampled
routes uses a banned turn pair or a banned via-way run.

### Compression: gzip stays

Measured on the three densest tiles (58.8 MB uncompressed):

| Codec | Size | vs gzip | Compress | Decompress | Browser |
| --- | --- | --- | --- | --- | --- |
| gzip −9 (current) | 37.10 MB | — | 1.6 s | 285 ms | yes |
| brotli q5 | 30.39 MB | −18.1% | 1.8 s | 294 ms | no |
| brotli q11 | 25.37 MB | −31.6% | 140 s | 336 ms | no |
| zstd level 3 | 37.79 MB | +1.8% | 0.3 s | 93 ms | no |
| zstd level 19 | 32.47 MB | −12.5% | 14 s | 142 ms | no |

Brotli and Zstandard both beat gzip on size, and Zstandard is three times
faster to decode. Neither is reachable from `DecompressionStream`, which only
offers gzip and deflate, so adopting one would mean shipping a decoder and
giving up browser support for an 18% saving. gzip stays.

### Tile size is the main lever

The same extract at `--tile-size-km 40` produces 126 tiles and a 105.3 MB
bundle (compile time 8 min 9 s, same two passes, peak RSS 2.04 GB). Local routes get much
cheaper, because a tile is the unit a route pays for:

| Route | 120 km tiles | 40 km tiles |
| --- | --- | --- |
| Short urban | 7.41 MB, 182 ms load | 3.44 MB, 62 ms load |
| Medium regional | 7.41 MB, 156 ms load | 4.73 MB, 267 ms load |
| Long distance | 42.66 MB, 1.48 s load | 48.18 MB, 1.26 s load |

Smaller tiles also narrow the corridor a long route loads, which can cost
optimality at the edges: Braga–Évora comes back as 460 km / 244 min at 120 km
tiles and 430 km / 266 min at 40 km — a shorter but slower road, because the
faster motorway link fell outside the narrower corridor. Pick the tile size
for the routes an application actually serves.

Smaller tiles also cost compiler memory, because padding duplicates each
boundary road into every tile that overlaps it: 40 km tiles peaked at 2.04 GB
against the default 2 GB ceiling. Raise `--max-memory-mb` (up to 3072) before
going below that, or the memory guard will stop the compile rather than let it
swap.

### Restrictions checked against the compiled data

`scripts/validate-bundle.mjs` checks the restriction invariant on real
compiled data rather than on hand-built graphs. It samples routes between
junctions that a restriction constrains and asserts that no returned route uses
a banned pair:

```sh
node scripts/validate-bundle.mjs region.efrb --samples 300 [--merge]
```

Across 300 routes in the densest tile (386k nodes, 853k edges, 7,120 banned
pairs) there were no violations, and 102 of those routes differ from what the
same search returns with the restrictions removed — so the restrictions are
being enforced, not merely stored. Repeating it over two merged tiles (568k
nodes, 11,604 banned pairs) also finds no violations, so restrictions survive
the cross-tile merge.

## Supported OSM features and limitations

What the bundled profiles read, and what they deliberately do not.

**Supported**

| Area | Detail |
| --- | --- |
| Highway classes | `motorway` through `service` and `road`, including `_link` variants |
| Access | `access`, `vehicle`, `motor_vehicle`, then the vehicle's own key (`motorcar`, `motorcycle`, `hgv`); most specific wins |
| Direction | `oneway=yes/no/-1/reverse/true/false/1/0`, `junction=roundabout/circular`, implicit one-way on motorways |
| Speed | `maxspeed`, `maxspeed:forward`, `maxspeed:backward`, `maxspeed:<mode>`; km/h, `mph`, `km/h`, `kmh`, `knots`, `walk` |
| Lorry limits | `maxheight`, `maxwidth`, `maxlength`, `maxweight`, each with `:forward`, `:backward` and `:hgv` forms, plus `maxheight:physical` and `maxwidth:physical`; metric and feet-and-inches |
| Barriers | `barrier` on a node, with `locked` and the access ladder; a bollard stops a car, a stile stops everything but walking, a gate is open unless it says otherwise |
| Turn restrictions | `no_left_turn`, `no_right_turn`, `no_straight_on`, `no_u_turn`, `no_entry`, `no_exit`, `only_left_turn`, `only_right_turn`, `only_straight_on`, `only_u_turn` |
| Alternative routes | `routeAlternatives` returns several routes, best first, filtered by how much worse and how much the same they are |
| Conditional restrictions | `*:conditional` on the access ladder and on `maxspeed`, applied when a route supplies `departAt`; time of day, weekday, month, public holiday and vehicle dimensions; last matching rule wins |
| Restriction scope | `via` node and `via` way; `restriction:<mode>`, `restriction:motor_vehicle` and `restriction:vehicle` override the generic key; `except` listing one of this vehicle's modes drops the relation for that vehicle alone |
| Railway classes | `railway=rail` for `train`; `railway=subway` and `railway=light_rail` for `metro`; `narrow_gauge`, `tram`, `monorail`, `funicular` and `disused` on request via `--railway-include` |
| Railway access | `access` and `train`, where `no`, `private` and `military` close the track; most specific wins. Road keys such as `vehicle` and `motor_vehicle` are deliberately **not** read |
| Railway direction | `oneway=yes/-1` only |
| Railway speed | `maxspeed`, `maxspeed:forward`, `maxspeed:backward`; otherwise a default from `service`, then `usage`, then the class |
| Railway track | `gauge` including dual gauge, `electrified`, `voltage`, `frequency`, `usage`, `service`, filtered per route through the `railway` option |

**Not supported**

| Area | Behaviour |
| --- | --- |
| A one-way trap | Two points joined on the map but not reachable in the direction asked for still cannot be joined. The route finishes on the nearest road it can reach instead, which `destinationSnap.distanceMeters` reports; `finishOnANearbyRoad: false` asks to be refused outright. |
| Surface, gradient and steps beyond a flat penalty | A cycling speed comes from the way class alone. `surface`, `smoothness` and elevation are not read, so a cobbled climb costs the same as smooth level tarmac. |
| Untagged limits | A road stating no `maxheight` or `maxweight` is treated as open to any lorry. Absence of a tag is not a measurement. |
| Axle load, trailer and hazmat rules | `maxaxleload`, `hazmat` and trailer-specific access are not read. |
| Conditional restrictions at the time a road is reached | Every road is judged by the moment the journey starts, not by when it would be reached. See [Routing at a time of day](#routing-at-a-time-of-day). This is not time-dependent routing. |
| Conditional restrictions without `departAt` | Read only when a route supplies a departure time; without one a time-limited restriction is treated as absent, as before. See [Routing at a time of day](#routing-at-a-time-of-day). |
| Conditional turn restrictions | `restriction:conditional` on a relation is not read, so a morning-peak no-left-turn is enforced at every hour. It is rare enough to be worth measuring rather than guessing at: 1 relation in 26,599 across Portugal. The compile report counts them as `conditionalTurnRestrictionsIgnored`. |
| Conditions resting on weather, user group or purpose | Read, but only a caller knows the answer. `circumstances: { conditions: ["wet"] }` makes `80 @ (wet)` apply; unanswered, the road stays open. A stay duration is still not read at all. |
| More than 65,536 distinct conditional values in one tile | The compile stops rather than dropping the surplus, which would turn a restricted road into an open one. Compile in smaller tiles with `--tile-size-km`. |
| Temporary closures in the bundle | Roadworks, events and incidents happen after a bundle is compiled, so none of them is in it. A caller reading a feed of them can pass `avoid` areas per route instead; see [Roads you know are shut](#roads-you-know-are-shut). |
| Reopening a road | Only closures are applied. `access=no` with `access:conditional=yes @ (...)` stays closed at every hour. |
| Time zones | `departAt` is taken as the local time of the roads travelled; no conversion is done and no clock is consulted. |
| Temporary closures | Roadworks, events and incidents are not modelled. A bundle is as current as the extract it was compiled from. |
| Zone-level rules | Lorry bans, low-emission zones, permit areas and tolls that apply to an area rather than to a way are not read. |
| `via` ways longer than four edges | Skipped rather than approximated, and counted as `turnRestrictionsSkipped` in the compile report. |
| Restrictions spanning a tile boundary | Dropped for tiles that do not hold every edge of the run, rather than enforced in a shortened form. |
| Turn costs and traffic signals | Not modelled; a turn costs nothing beyond the roads it joins. |
| Timetables, services and GTFS | Not supported, and not planned. A railway route is a path through mapped track; it says nothing about whether a train runs over it, when, or for whom. |
| Railway signalling, blocks and headway | Not modelled. `railway:etcs` and signal nodes are not read. |
| Railway gradient, curve, loading gauge, train length, axle load | Not modelled. A railway route says nothing about whether a particular train physically fits or can be hauled over the path. |
| `railway:preferred_direction` | Not read. It describes how trains are normally run, not what the track permits, and treating it as a ban would invent a restriction OSM never stated. |
| Railway turn restrictions and barriers | Not modelled, because OSM does not describe railway junctions with restriction relations. No switch or junction is ever invented from geometry. |
| Electrification sections | A neutral section or a system changeover part-way along a way is not represented: OSM tags the way, not the point. |
| A gauge change mid-route | Two different-gauge tracks sharing a node can be crossed unless a `gaugeMm` constraint is given. `railwayCertainty` reports every gauge a route crossed, so it is visible rather than silent. It does not occur in the Portugal extract. |
| Which `--railway-include` set a bundle used | Not recorded in the bundle. The compile report beside it records it. |
| Live traffic, elevation, ferries as a distinct mode | Not modelled. Ferry ways are excluded with everything that is not a road. |
| Toll avoidance | Not read. |
| A barrier this table has not met | Treated as passable. Inventing a closure severs a road that is probably open, and the tag may simply be unfamiliar; an `access` tag on the node still decides. |
| EFRT v1 | Carries topology only: encoding to it drops geometry and turn restrictions. Use EFR2 for anything that needs them. |

The compiler reports what it skipped. `turnRestrictionsRead` against
`turnRestrictionsSkipped`, and `edgesWithConditionalRestrictions`, in
`<output>.json` tell you how much of a region's restriction data was
understood.

## Upgrading from 0.1.0

Nothing in the 0.1.0 API changed, and bundles compiled by 0.1.0 still open and
route identically — the published Portugal bundle was re-read under 0.2.0 and
returns the same 313.10 km Porto-to-Lisbon route.

What is worth knowing:

- **`engines.node` is now `>=18`**, matching the library rather than the
  compiler. The CLI still needs Node 22.5 for `node:sqlite` and says so at
  startup instead of part-way through an extract.
- **Repeated routes are about eight times faster**, and first routes two to
  three times. The stitched corridor is cached between routes, one per vehicle
  a bundle holds; `mergedCacheSize: 0` restores the old behaviour of holding
  nothing, at the cost of re-stitching every time.
- **Journey times rise by a fraction of a percent on a recompile.** A short
  edge whose duration rounded to zero used to be free to travel; it is now
  charged for. The route is the same, the estimate is honest. Reading an old
  bundle is unaffected, because the correction is in the data.
- **Car graphs keep their layout.** A single-vehicle compile with no physical
  limits still writes the one-chunk layout, so an older reader opens a bundle
  compiled today. It does grow very slightly, because barriers now contribute
  banned turns.
- **Barriers are read for the first time.** Gates, bollards and stiles were
  invisible to every profile before, so some routes that passed through one
  no longer do.
- **New formats are additive.** EFR2 v7 and EFRB v2 appear only when a bundle
  holds several vehicles or a vehicle whose routes depend on its size; a 0.1.0
  reader cannot open those, which is why single-vehicle output stays v1.
- **The car profile reads a few more tags** — `oneway:motor_vehicle`,
  `oneway:motorcar`, `maxspeed:motorcar` — so a route changes only where the
  data said it should all along.

## Benchmarks

Portugal, `portugal-latest.osm.pbf` at 425 MB, on one machine:

| | 0.1.0 car | 0.2.0 car | 0.2.0 car + truck + motorcycle |
| --- | --- | --- | --- |
| Bundle | 38.03 MB | 38.04 MB | **40.17 MB** |
| Peak compile memory | 1.11 GB | 1.10 GB | 1.64 GB |
| Compile time | 7m 46s | 7m 58s | 7m 48s |
| Routing nodes | 1,244,119 | 1,244,119 | 1,244,263 |
| Routing edges | 2,757,478 | 2,757,478 | 2,760,171 |
| Barriers read | — | — | 33,236, giving 8,790 bans |

Three vehicles cost 5.6% more than one and compile in the same time, because
the extract is read once however many are asked for. The same three as separate
bundles would be about 114 MB.

Walking and cycling, compiled together into their own bundle:

| | bicycle + pedestrian |
| --- | --- |
| Bundle | 96.10 MB |
| Peak compile memory | 2.71 GB |
| Compile time | 16m 54s |
| Routing nodes | 2,721,847 |
| Routing edges | 6,870,455 |
| Barriers read | 13,102, giving 9,409 bans |

Two and a half times the edges of the motor-vehicle bundle, because footways
and paths exist where roads do not. It needs `--max-memory-mb 3000`.

### Railways, on the same extract

| | `train` | `metro` | `train,metro` | `car`, for scale |
| --- | --- | --- | --- | --- |
| Bundle | **293.9 kB** | 39.7 kB | 373.4 kB | 38.04 MB |
| Uncompressed graph | 423.2 kB | 57.2 kB | 586.1 kB | 51.23 MB |
| Peak compile memory | 0.3–0.6 GB | 0.3–0.5 GB | 0.5 GB | 1.47 GB |
| Compile time | **1m 18s** | 1m 07s | 1m 14s | 8m 02s |
| Tiles | 12 | 4 | 12 | 25 |
| Routing nodes | 10,657 | 1,756 | 12,413 | 1,245,339 |
| Routing edges | 23,273 | 2,777 | **26,052** | 2,759,810 |
| OSM ways read | 8,809 | 1,485 | 10,294 | 860,908 |
| Distinct track descriptions | 20 | 11 | 20 | — |

A railway bundle is about **1/130th** the size of the road bundle for the same
country, and compiles in a seventh of the time — nearly all of which is the
two passes over the 425 MB extract rather than anything to do with the graph.
Peak memory is well under half the road compile's, because the graph being
built is tiny. It is quoted as a range because it varies by a factor of two
between runs of the same compile: at this size the figure is dominated by when
the garbage collector happens to run during the PBF scan, not by the graph.

`train,metro` holds 26,052 edges against 23,273 + 2,777 = 26,050 compiled
separately, and the same 12,413 nodes. The two extra edges are the two places
in Portugal where a light-rail way crosses the end of a rail way: a junction
in the combined topology, and a node simplified away when the metro is
compiled alone. Nothing was merged and nothing duplicated — the two networks
share the shared chunk and the geometry table, and each profile's access mask
closes the other's track.

### Railway routing

Real journeys over `portugal-rail.efrb`, served over HTTP Range from disk, a
fresh router per route so the cold figure is genuinely cold:

| Journey | Distance | Estimated | Cold | Warm | Range |
| --- | --- | --- | --- | --- | --- |
| Porto Campanhã → Lisboa Santa Apolónia | 336.5 km | 2h 28m | 65 ms | 2.1 ms | 22 reqs, 265 kB |
| Lisboa Santa Apolónia → Faro | 300.8 km | 2h 30m | 19 ms | 2.3 ms | 14 reqs, 169 kB |
| Porto Campanhã → Valença (Linha do Minho) | 129.7 km | 1h 27m | 8 ms | 0.7 ms | 10 reqs, 112 kB |
| Porto Campanhã → Guimarães | 55.1 km | 46m | 38 ms | 1.2 ms | 10 reqs, 112 kB |
| Porto São Bento → Braga | 56.0 km | 37m | 14 ms | 1.0 ms | 10 reqs, 112 kB |

And over `porto-metro.efrb`, a 17.3 kB bundle:

| Journey | Distance | Estimated | Cold | Warm |
| --- | --- | --- | --- | --- |
| Trindade → Matosinhos (Linha A) | 11.1 km | 19m | 14 ms | 0.6 ms |
| Trindade → Aeroporto (Linha E) | 13.2 km | 14m | 5 ms | 1.1 ms |
| Trindade → Póvoa de Varzim (Linha B) | 30.0 km | 30m | 3 ms | 0.8 ms |

The distances are the check that matters, and they are checked against the
real network rather than against each other: the Linha do Norte between those
two stations is about 336 km, the Linha de Guimarães about 55, Linha A about
11. The *estimates* are line-speed estimates and are optimistic against every
real timetable, by design — see [Speed on a railway](#speed-on-a-railway).

Constraints behave as they should on the real network. Portugal's main line is
1,668 mm Iberian gauge, so:

| Constraint | Porto → Lisboa |
| --- | --- |
| none | 336.5 km |
| `{ gaugeMm: 1668, requireElectrification: true }` | 336.5 km |
| `{ gaugeMm: 1668, requireElectrification: true, strictUnknown: true }` | 336.5 km |
| `{ gaugeMm: 1435 }` | **`NO_ROUTE`** |

`strictUnknown` changes nothing here because every way along that corridor
really does state its gauge and its electrification. On a less thoroughly
surveyed network it would.

### A second network, to find the Portugal-shaped assumptions

Portugal alone would have taught this library several things that are not
true. Ireland and Northern Ireland (`ireland-and-northern-ireland-latest`,
416 MB) and Switzerland were compiled and surveyed for exactly that reason,
and each contradicted something Portugal implied.

| | Portugal | Ireland | Switzerland |
| --- | --- | --- | --- |
| Dominant `gauge` | 1668 | **1600** | 1435 |
| Dominant `electrified` | `contact_line` | **`no`**, on 4,813 of 5,430 ways | `contact_line` |
| Dominant `frequency` | `50` | — | **`16.7`**, on 29,992 ways |
| `maxspeed` written as | `80` | **`70 mph`** | `80` |
| Direction mapped as | `oneway` (metro) | **`railway:preferred_direction`** on 2,048 ways | — |
| Multi-value tags | `gauge=1000;1668` | — | **`frequency=0;16.7`**, `gauge=1000;1435` |

What each one caught:

- **Gauge is data, not a constant.** Dublin to Cork routes under
  `{ gaugeMm: 1600 }` and returns `NO_ROUTE` under `{ gaugeMm: 1668 }` —
  Portugal's gauge, on Irish track.
- **`maxspeed` in mph.** Irish track is signed in miles per hour. The existing
  road speed parser already handled it, which is why railways reuse it rather
  than parsing speed again.
- **Not reading `railway:preferred_direction` was right.** Irish heavy rail
  barely uses `oneway` and carries `preferred_direction` on 2,048 ways, 803 of
  them `forward`. Treating it as a restriction would have made a large part of
  the Irish network one-way, incorrectly.
- **Electrification discriminates, it does not blanket-refuse.** Ireland's
  network is mostly unelectrified, so Dublin to Cork under
  `{ requireElectrification: true }` correctly returns `NO_ROUTE` — the track
  says `electrified=no`, which is a known refusal and not a missing tag —
  while the electrified DART from Connolly to Dún Laoghaire still routes,
  11.4 km over 1,500 V contact line.
- **A changeover line states two systems.** Switzerland's `frequency=0;16.7`
  and `gauge=1000;1435` are why gauge, voltage and frequency each keep a
  second stated value. Keeping only the first would refuse a train that can
  run on either.

Ireland compiles to a 151 kB bundle in 1m 13s: 5,430 ways, 12,296 edges, 22
distinct track descriptions. Dublin Connolly to Cork Kent comes back as
272.3 km and Dublin to Belfast as 183.3 km, against a real Dublin–Belfast
line of about 181 km.

### Routing

Urban, rural and long journeys over the two Portugal bundles, each measured
cold and then repeated with nothing left to fetch:

| Journey | Vehicle | Result | First | Repeat | Downloaded |
| --- | --- | --- | --- | --- | --- |
| central Lisbon, 2 km | car | 2.4 km, 3 min | 270 ms | 9 ms | 4.3 MB |
| | truck | 3.7 km, 5 min | 128 ms | 7 ms | 0.3 MB |
| | motorcycle | 2.4 km, 3 min | 103 ms | 7 ms | 0.3 MB |
| rural Bragança, 40 km | car | 41.0 km, 32 min | 238 ms | 5 ms | 3.0 MB |
| | truck | 41.0 km, 35 min | 187 ms | 4 ms | 0.2 MB |
| | motorcycle | 41.0 km, 32 min | 127 ms | 4 ms | 0.2 MB |
| Porto to Lisbon, 313 km | car | 313.1 km, 165 min | 2245 ms | 257 ms | 22.2 MB |
| | truck | 313.1 km, 218 min | 1767 ms | 140 ms | 1.5 MB |
| | motorcycle | 313.1 km, 165 min | 1754 ms | 209 ms | 1.5 MB |
| central Lisbon, 2 km | bicycle | 2.2 km, 8 min | 510 ms | 31 ms | 10.0 MB |
| | pedestrian | 1.9 km, 23 min | 339 ms | 36 ms | 1.2 MB |
| rural Bragança, 33 km | bicycle | 33.6 km, 146 min | 692 ms | 9 ms | 10.6 MB |
| | pedestrian | 32.5 km, 411 min | 466 ms | 7 ms | 0.9 MB |

The lorry is 32% slower than the car over the same roads, which is the 90 km/h
cap on motorways. The second and third vehicles cost a fraction of the first,
because the road network was already downloaded and only their own columns
remain. Opening a bundle costs two requests and about 4 kB, whatever its size,
so a reader knows which vehicles are on offer before fetching anything.

A route repeated costs almost nothing: the stitched corridor is kept, one per
vehicle the bundle holds, so moving between vehicles does not discard it.

Repeated routes against 0.1.0, which had none of this:

| | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| Porto to Lisbon | 2107 ms | **257 ms** |
| Lisbon to Faro | 2170 ms | **~140 ms** |

Three things account for it: the corridor is no longer re-stitched for every
route, the stitch itself no longer builds a string key per node, and the search
no longer remembers how it arrived at every junction in the country — only at
the 1.3% that ban a turn.

Physical limits on Portugal: 7,652 of 2,760,171 edges state one, which is
0.28%. That is why they are a side table rather than four columns — columns
would cost about 11 MB to say nothing almost everywhere, against 61 kB.

### Tile size matters more for walking and cycling

A short urban bicycle route downloads 10 MB above, where the same journey by
car downloads 4.3. Both fetch the tile they start in, and a tile of footpaths
holds far more than a tile of roads.

Tile size is the lever: `--tile-size-km` trades a larger file, from more
overlap between tiles, against a smaller first download. The default of 120 km
suits a road network, and an active-travel bundle for a city is better served
by something smaller.

At country scale this is currently out of reach. Compiling Portugal for
walking and cycling at 40 km tiles exceeds the compiler's memory ceiling of
3 GB and is refused rather than attempted — the guard does its job, but the
measurement is one this release cannot make. A city-sized extract has no such
trouble.

## Licence

MIT. See [LICENSE](LICENSE).

## Benchmark a bundle

Use exact or near-road coordinates to measure representative routes without
downloading the whole file. Each `--route` is measured against a fresh bundle
reader, so nothing is reused between them. The runner reports bundle size,
compression ratio, nodes, edges and banned turns for the whole bundle, then
per route: tiles loaded, Range bytes, graph-load time, A* time, memory delta,
distance and duration.

```sh
npm run benchmark -- path/to/region.efrb \
  --route "short urban=38.7223,-9.1393>38.7369,-9.1427" \
  --route "long distance=41.1496,-8.6109>37.0194,-7.9304"
```

Large `.osm.pbf` extracts are external benchmark inputs. Download one from a
provider such as Geofabrik when you want to reproduce these numbers; none is
committed to, or depended on by, this package.
