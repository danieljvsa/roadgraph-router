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
