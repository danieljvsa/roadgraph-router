# @danieljvsa/roadgraph-router

Browser-safe routing primitives for pre-built directed road graphs. The package calculates car routes locally with A*.

It deliberately does not download OpenStreetMap data or call a directions service. Graph creation belongs to a separate Node-only importer.

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

The package reads the original EFRT v1 format and compact EFR2 v2/v3 chunks.
EFR2 stores latitude/longitude as fixed-point `Int32` values and edge weights as
scaled `Uint16` values. EFR2 v3 adds an optional compact intermediate-geometry
stream per edge, so the routing topology can omit road-shape nodes without
turning returned GeoJSON routes into straight lines. Existing v1 and v2 data
remain supported.

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

## Benchmark a bundle

Use exact or near-road coordinates to measure a representative route without
downloading the whole file. The runner reports bundle size, loaded nodes and
edges, Range bytes, memory delta, graph-load timing, and A* timing:

```sh
npm run benchmark -- path/to/region.efrb \
  --origin 40.4168,-3.7038 \
  --destination 40.4268,-3.6938
```
