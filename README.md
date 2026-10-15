# roadgraph-router

Compile any OpenStreetMap `.osm.pbf` extract into a compact, range-addressable
routing bundle, then route over it with A* — in Node.js or in the browser, with
no routing service involved.

A 425 MB Portugal extract compiles to a 38 MB bundle. A city route downloads
4.3 MB of it and takes about 270 ms end to end. The browser build is 28 kB
gzipped and pulls in no Node built-ins.

## What a route here does and does not mean

A route is a path over roads that the compiled OpenStreetMap data **does not
say are forbidden** to the chosen vehicle. That is weaker than a statement
that the route is legal, or that the vehicle will physically fit, and the gap
matters most for a lorry.

Three kinds of rule are read and obeyed: tags on the way, such as access,
direction and signed limits; turn restriction relations; and barriers on
nodes. Everything below is **not read at all**, and a road governed only by
one of them is treated as open:

- **Time-dependent access.** `access:conditional`, `restriction:conditional`,
  `hgv:conditional` and every other time-of-day or day-of-week rule. A street
  closed to lorries overnight, a bus lane that is shared outside peak hours,
  a market square pedestrianised on Sundays — all appear permanently open.
- **Seasonal and weather rules.** Winter closures, snow-chain requirements,
  flood gates.
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
structure too weak for it, or along a street it is banned from at the hour you
travel. **Do not use this engine as the sole basis for dispatching a heavy
vehicle.** Anything safety-critical needs a surveyed freight dataset and a
routing engine that reads conditional restrictions.

The compiler reports what it understood. `turnRestrictionsRead` against
`turnRestrictionsSkipped`, and `barriersRead`, in `<output>.json` tell you how
much of a region's restriction data was used.

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
Five ship. `car`, `motorcycle` and `truck` read the same tags in the same
order and differ in the mode name at the bottom of each hierarchy, so a car
resolves `motorcar` where a motorcycle resolves `motorcycle` and a lorry
resolves `hgv`. `bicycle` and `pedestrian` are a different shape, described
below.

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
about 18 kB gzipped, and it needs only `fetch` and `DecompressionStream`:

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
| Restriction scope | `via` node and `via` way; `restriction:<mode>`, `restriction:motor_vehicle` and `restriction:vehicle` override the generic key; `except` listing one of this vehicle's modes drops the relation for that vehicle alone |

**Not supported**

| Area | Behaviour |
| --- | --- |
| A one-way trap | Two points joined on the map but not reachable in the direction asked for — a one-way loop with no way back — still report no route. Snapping again cannot mend that, because both ends are already in the same piece of the network. |
| Surface, gradient and steps beyond a flat penalty | A cycling speed comes from the way class alone. `surface`, `smoothness` and elevation are not read, so a cobbled climb costs the same as smooth level tarmac. |
| Alternative routes | Not in 0.2.0. `routeAlternatives` is planned for 0.3.0. |
| Untagged limits | A road stating no `maxheight` or `maxweight` is treated as open to any lorry. Absence of a tag is not a measurement. |
| Axle load, trailer and hazmat rules | `maxaxleload`, `hazmat` and trailer-specific access are not read. |
| Conditional restrictions | `restriction:conditional`, `access:conditional`, `hgv:conditional` and every time-of-day, day-of-week or seasonal rule are ignored, so a time-limited restriction is treated as absent. See [What a route here does and does not mean](#what-a-route-here-does-and-does-not-mean). |
| Temporary closures | Roadworks, events and incidents are not modelled. A bundle is as current as the extract it was compiled from. |
| Zone-level rules | Lorry bans, low-emission zones, permit areas and tolls that apply to an area rather than to a way are not read. |
| `via` ways longer than four edges | Skipped rather than approximated, and counted as `turnRestrictionsSkipped` in the compile report. |
| Restrictions spanning a tile boundary | Dropped for tiles that do not hold every edge of the run, rather than enforced in a shortened form. |
| Turn costs and traffic signals | Not modelled; a turn costs nothing beyond the roads it joins. |
| Live traffic, elevation, ferries as a distinct mode | Not modelled. Ferry ways are excluded with everything that is not a road. |
| `motor_vehicle:conditional`, toll avoidance | Not read. |
| A barrier this table has not met | Treated as passable. Inventing a closure severs a road that is probably open, and the tag may simply be unfamiliar; an `access` tag on the node still decides. |
| EFRT v1 | Carries topology only: encoding to it drops geometry and turn restrictions. Use EFR2 for anything that needs them. |

The compiler reports what it skipped. `turnRestrictionsRead` against
`turnRestrictionsSkipped` in `<output>.json` tells you how much of a region's
restriction data was understood.

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
