# @danieljvsa/roadgraph-router

Browser-safe routing primitives for pre-built directed road graphs. The package calculates car routes locally with A*.

It deliberately does not download OpenStreetMap data or call a directions service. Graph creation belongs to a separate Node-only importer.

## Routing profile

Every tag decision lives behind a `RoutingProfile` rather than in the compiler.
The bundled `car` profile resolves the OSM access hierarchy
(`access` < `vehicle` < `motor_vehicle` < `motorcar`, most specific wins),
direction (`oneway=yes|-1|reverse|no|reversible`, `junction=roundabout|circular`,
and the implicit one-way default on `motorway`/`motorway_link`), and speed from
`maxspeed`, `maxspeed:forward` and `maxspeed:backward`.

`maxspeed` accepts plain km/h, `mph`, `km/h`, `kmh` and `knots`. Any value that
is not a number with an optional unit — `none`, `signals`, `variable`, or a
country code such as `PT:urban` — falls back to the highway class default
rather than to a country-specific table, and `walk` maps to 7 km/h. Speeds are
clamped to the profile range the A* heuristic assumes, so a mistagged
`maxspeed=400` cannot make the heuristic inadmissible.

```ts
import { carRoutingProfile } from "@danieljvsa/roadgraph-router";

carRoutingProfile.evaluateWay({ highway: "primary", maxspeed: "60 mph" });
// { forward: true, backward: true, forwardSpeedKph: 96.56, backwardSpeedKph: 96.56 }
```

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

Use `--padding-km` to tune cross-tile overlap, `--shape-tolerance-m` to simplify
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

## Usage

```ts
import { RoadRouter } from "@danieljvsa/roadgraph-router";

const router = await RoadRouter.open("/routing/manifest.json");
const result = await router.route(
  { lat: 37.0194, lng: -7.9304 },
  { lat: 37.1023, lng: -8.6731 },
);
```

`RoadRouter.open()` also accepts an already-decoded `RoadGraph`, which is useful
for embedded or application-managed graph data.

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
import { withSpatialIndex } from "@danieljvsa/roadgraph-router";

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
desktop machine with default settings (`--tile-size-km 120 --compression gzip`):

| | |
| --- | --- |
| Input PBF | 425.5 MB |
| PBF passes | 2 |
| Compile time | 7 min 36 s |
| Peak RSS | 1.87 GB (ceiling 2 GB) |
| Relevant OSM ways | 860,806 |
| Relevant OSM nodes | 7,165,726 (Bloom estimate) |
| Routing nodes before simplification | 7,768,351 |
| Routing nodes after simplification | 1,243,981 |
| Node reduction | 83.99% |
| Routing edges | 2,757,265 |
| Turn restrictions read / skipped (`via` way) | 24,855 / 1,684 |
| Banned turn pairs emitted | 33,796 |
| EFRB tiles | 28 |
| Uncompressed graph | 114.8 MB |
| Final compressed EFRB | 71.2 MB |
| Compression ratio | 0.620 |

Routes from that bundle, each measured against a fresh reader:

| Route | Tiles | Range bytes | Graph load | A* | Heap | Distance | Duration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Short urban (Lisbon) | 1 | 7.41 MB | 124 ms | 90 ms | 46 MB | 5.37 km | 5.9 min |
| Medium regional (Lisbon–Setúbal) | 2 | 8.04 MB | 398 ms | 152 ms | 34 MB | 48.41 km | 32.4 min |
| Long distance (Porto–Faro) | 16 | 68.34 MB | 2.61 s | 1.59 s | 34 MB | 553.20 km | 284.8 min |
| Cross-tile (Braga–Évora) | 15 | 68.34 MB | 2.78 s | 1.51 s | 20 MB | 460.16 km | 244.3 min |

Short and medium routes are essentially unchanged. A cross-country route now
loads 68 MB rather than 43 MB, because proving no better road exists means
considering most of a country-shaped region — and Portugal's dense tiles lie in
every corridor, so capping `maxDetourFactor` to 1.15 still needs 15 tiles and
67.7 MB. The honest summary is that tile-size independence costs bytes on long
routes and almost nothing on short ones. Tiles are cached per bundle, so an
application routing repeatedly in a region pays it once.

A* time includes building the edge index on a graph loaded for that one route;
an application routing repeatedly in a region pays it once (see above). The
short urban route is longer than the 3.60 km that node snapping used to report,
because its destination sits two thirds of the way along a one-way street:
reaching that point means approaching from the drivable end, where node
snapping delivered you to a different junction 46 m away.

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
